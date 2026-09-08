import { Server } from "node:http";
import { closePostgres } from "./postgresInfrastructure";
import { closeRedis } from "./redisInfrastructure";
import { closeAllClients } from "./stream";
import { setAcceptingTraffic, setShuttingDown } from "./health";
import { log } from "./logger";
import { stopTelemetry } from "./telemetry";

type StopTask = { name: string; run: () => void | Promise<void> };
const tasks: StopTask[] = [];
const activeJobs = new Set<Promise<unknown>>();
let shuttingDown = false;

export function registerStopTask(name: string, run: () => void | Promise<void>) { tasks.push({ name, run }); }
export function canStartJobs() { return !shuttingDown; }
export function trackJob<T>(promise: Promise<T>): Promise<T> {
  activeJobs.add(promise);
  promise.finally(() => activeJobs.delete(promise)).catch(() => undefined);
  return promise;
}

export function installGracefulShutdown(server: Server) {
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true; setShuttingDown(true);
    const timeoutMs = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? "15000");
    log("info", "lifecycle", "shutdown started", { signal, activeJobs: activeJobs.size, timeoutMs });
    const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
    for (const task of tasks.reverse()) {
      try { await task.run(); } catch (error: any) { log("warn", "lifecycle", "stop task failed", { task: task.name, errorCode: error?.code }); }
    }
    closeAllClients("server_shutdown");
    if (activeJobs.size) {
      await Promise.race([
        Promise.allSettled([...activeJobs]),
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    }
    await Promise.race([serverClosed, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
    await Promise.allSettled([closeRedis(), closePostgres()]);
    stopTelemetry();
    log("info", "lifecycle", "shutdown complete", { signal, remainingJobs: activeJobs.size });
    process.exit(activeJobs.size ? 1 : 0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  return shutdown;
}

export function markStartupReady() { setAcceptingTraffic(true); }
