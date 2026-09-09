import crypto from "node:crypto";
import { features } from "./featureFlags";
import { postgresReady, query } from "./postgresInfrastructure";
import { log } from "./logger";

type Source = { type: string; key: string; payload: unknown; version: number; sourceUpdatedAt: string };
const latest = new Map<string, Source>();
let writesOk = 0, writesFailed = 0, validations = 0;
let readsOk = 0, readsMissed = 0, readsFailed = 0, fallbacks = 0;
const mismatches = new Map<string, { type: string; key: string; reason: string; detectedAt: string }>();

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
function checksum(value: unknown) { return crypto.createHash("sha256").update(stable(value)).digest("hex"); }

export async function readShadowDocument<T>(type: string, key: string, expectedVersion: number): Promise<T | null> {
  if (!postgresReady()) { fallbacks += 1; return null; }
  try {
    const result = await query("SELECT schema_version, checksum, payload FROM legacy_shadow_documents WHERE document_type=$1 AND document_key=$2", [type, key]);
    const row = result.rows[0];
    if (!row) { readsMissed += 1; fallbacks += 1; return null; }
    if (Number(row.schema_version) !== expectedVersion || row.checksum !== checksum(row.payload)) {
      readsFailed += 1; fallbacks += 1;
      mismatches.set(`${type}:${key}`, { type, key, reason: Number(row.schema_version) !== expectedVersion ? "schema_version" : "checksum", detectedAt: new Date().toISOString() });
      return null;
    }
    readsOk += 1;
    mismatches.delete(`${type}:${key}`);
    return row.payload as T;
  } catch (error: any) {
    readsFailed += 1; fallbacks += 1;
    log("warn", "shadow-storage", "postgres read failed; using legacy JSON fallback", { module: type, errorCode: error?.code });
    return null;
  }
}

export async function readLatestShadowDocument<T>(type: string, expectedVersion: number): Promise<T | null> {
  if (!postgresReady()) { fallbacks += 1; return null; }
  try {
    const result = await query("SELECT document_key, schema_version, checksum, payload FROM legacy_shadow_documents WHERE document_type=$1 ORDER BY source_updated_at DESC LIMIT 1", [type]);
    const row = result.rows[0];
    if (!row) { readsMissed += 1; fallbacks += 1; return null; }
    const key = String(row.document_key);
    if (Number(row.schema_version) !== expectedVersion || row.checksum !== checksum(row.payload)) {
      readsFailed += 1; fallbacks += 1;
      mismatches.set(`${type}:${key}`, { type, key, reason: Number(row.schema_version) !== expectedVersion ? "schema_version" : "checksum", detectedAt: new Date().toISOString() });
      return null;
    }
    readsOk += 1;
    mismatches.delete(`${type}:${key}`);
    return row.payload as T;
  } catch (error: any) {
    readsFailed += 1; fallbacks += 1;
    log("warn", "shadow-storage", "latest postgres read failed; using legacy JSON fallback", { module: type, errorCode: error?.code });
    return null;
  }
}

export function rememberShadowSource(type: string, key: string, payload: unknown, version = 1, sourceUpdatedAt = new Date().toISOString()) {
  latest.set(`${type}:${key}`, { type, key, payload, version, sourceUpdatedAt });
}

export async function shadowWriteDocument(type: string, key: string, payload: unknown, version = 1, sourceUpdatedAt = new Date().toISOString()) {
  rememberShadowSource(type, key, payload, version, sourceUpdatedAt);
  if (!features.postgresShadowWrite || !postgresReady()) return false;
  try {
    await query(`INSERT INTO legacy_shadow_documents(document_type, document_key, schema_version, checksum, source_updated_at, payload)
      VALUES($1,$2,$3,$4,$5,$6::jsonb)
      ON CONFLICT(document_type, document_key) DO UPDATE SET schema_version=EXCLUDED.schema_version, checksum=EXCLUDED.checksum,
      source_updated_at=EXCLUDED.source_updated_at, payload=EXCLUDED.payload, shadow_updated_at=now()`,
      [type, key, version, checksum(payload), sourceUpdatedAt, JSON.stringify(payload)]);
    writesOk += 1; return true;
  } catch (error: any) {
    writesFailed += 1; log("warn", "shadow-storage", "shadow write failed; legacy JSON is unaffected", { module: type, errorCode: error?.code }); return false;
  }
}

export async function validateShadowStorage() {
  if (!features.postgresShadowWrite || !postgresReady()) return;
  for (const source of latest.values()) {
    validations += 1;
    const id = `${source.type}:${source.key}`;
    try {
      const result = await query("SELECT schema_version, checksum, source_updated_at FROM legacy_shadow_documents WHERE document_type=$1 AND document_key=$2", [source.type, source.key]);
      const row = result.rows[0];
      const storedAt = row?.source_updated_at == null ? null : new Date(row.source_updated_at).toISOString();
      const expectedAt = new Date(source.sourceUpdatedAt).toISOString();
      const reason = !row ? "missing" : Number(row.schema_version) !== source.version ? "schema_version" : row.checksum !== checksum(source.payload) ? "checksum" : storedAt !== expectedAt ? "timestamp" : null;
      if (reason) mismatches.set(id, { type: source.type, key: source.key, reason, detectedAt: new Date().toISOString() });
      else mismatches.delete(id);
    } catch { mismatches.set(id, { type: source.type, key: source.key, reason: "validation_error", detectedAt: new Date().toISOString() }); }
  }
}

export function shadowStorageSnapshot() { return { enabled: features.postgresShadowWrite, writesOk, writesFailed, readsOk, readsMissed, readsFailed, fallbacks, validations, trackedDocuments: latest.size, mismatchCount: mismatches.size, mismatches: [...mismatches.values()].slice(0,100) }; }
export function resetShadowStorageForTest() {
  if (process.env.NODE_ENV !== "test") throw new Error("shadow_reset_test_only");
  latest.clear(); mismatches.clear(); writesOk = 0; writesFailed = 0; readsOk = 0; readsMissed = 0; readsFailed = 0; fallbacks = 0; validations = 0;
}
