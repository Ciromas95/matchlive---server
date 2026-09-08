import crypto from "node:crypto";
import { postgresReady, query } from "./postgresInfrastructure";
import { currentRequestId } from "./logger";

function digest(value: string) { return value ? crypto.createHash("sha256").update(value).digest("hex") : null; }
export async function auditAdmin(action: string, input: { token?: string; ip?: string; targetType?: string; targetId?: string; metadata?: Record<string,unknown> } = {}) {
  if (!postgresReady()) return;
  try { await query(`INSERT INTO admin_audit_log(actor_hash,action,request_id,ip_hash,target_type,target_id,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`, [digest(input.token??""),action,currentRequestId()??null,digest(input.ip??""),input.targetType??null,input.targetId??null,JSON.stringify(input.metadata??{})]); }
  catch {}
}
