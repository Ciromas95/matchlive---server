import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import { NextFunction, Request, Response } from "express";
import { requestStarted } from "./telemetry";
import { recordOperationalError } from "./errorCenter";

type Context = { requestId: string; userId?: string };
const context = new AsyncLocalStorage<Context>();

const SECRET_KEYS = /password|secret|token|authorization|api[-_]?key|firebase/i;

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitize(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEYS.test(key) ? "[redacted]" : sanitize(item, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 1500) return `${value.slice(0, 1500)}…`;
  return value;
}

export function currentRequestId(): string | undefined {
  return context.getStore()?.requestId;
}

export function log(
  level: "debug" | "info" | "warn" | "error",
  module: string,
  message: string,
  fields: Record<string, unknown> = {},
) {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    service: process.env.SERVICE_NAME ?? "brainlive-api",
    module,
    requestId: currentRequestId(),
    message,
    ...sanitize(fields) as Record<string, unknown>,
  };
  const output = JSON.stringify(record);
  if (level === "error") recordOperationalError({
    service: String(record.service), module, errorCode: fields.errorCode == null ? null : String(fields.errorCode),
    message, requestId:record.requestId, fixtureId:typeof fields.fixtureId==="number"?fields.fixtureId:undefined,
    endpoint:typeof fields.path==="string"?fields.path:undefined, method:typeof fields.method==="string"?fields.method:undefined,
    status:typeof fields.status==="number"?fields.status:undefined, durationMs:typeof fields.durationMs==="number"?fields.durationMs:undefined,
    stack:typeof fields.stack==="string"?fields.stack.slice(0,2000):undefined,
  });
  (level === "error" ? process.stderr : process.stdout).write(`${output}\n`);
}

export function requestContext(
  observe: (data: { path: string; method: string; status: number; durationMs: number; bytes: number }) => void,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    requestStarted();
    const incoming = String(req.header("x-request-id") ?? "").trim();
    const requestId = /^[A-Za-z0-9._:-]{8,128}$/.test(incoming)
      ? incoming
      : crypto.randomUUID();
    res.setHeader("x-request-id", requestId);
    const started = process.hrtime.bigint();
    context.run({ requestId }, () => {
      res.once("finish", () => {
        const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
        const bytes = Number(res.getHeader("content-length") ?? 0) || 0;
        observe({ path: req.path, method: req.method, status: res.statusCode, durationMs, bytes });
        log(res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info", "http", "request", {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Math.round(durationMs * 10) / 10,
          bytes,
        });
      });
      next();
    });
  };
}
