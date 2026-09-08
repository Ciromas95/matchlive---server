import crypto from "node:crypto";
import { getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { NextFunction, Request, Response } from "express";
import { postgresReady, query } from "./postgresInfrastructure";
import { log } from "./logger";
import { features } from "./featureFlags";

export type VerifiedUser = { uid: string };
let testVerifier: ((token: string) => Promise<VerifiedUser>) | null = null;

export async function verifiedFirebaseUser(req: Request): Promise<VerifiedUser | null> {
  const auth = String(req.header("authorization") ?? "");
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!token) return null;
  if (!testVerifier && !getApps().length) return null;
  try {
    if (testVerifier) return await testVerifier(token);
    const decoded = await getAuth().verifyIdToken(token, true); return { uid: decoded.uid };
  }
  catch (error: any) { log("warn", "firebase-auth", "token verification failed", { errorCode: error?.code }); return null; }
}

export function configureFirebaseVerifierForTest(value: ((token:string)=>Promise<VerifiedUser>) | null) {
  if (process.env.NODE_ENV !== "test") throw new Error("firebase_verifier_test_only");
  testVerifier = value;
}

export async function upsertUserActivity(uid: string, platform: string) {
  if (!postgresReady()) return;
  const id = crypto.createHash("sha256").update(`brainlive-user:${uid}`).digest("hex");
  const uuid = `${id.slice(0,8)}-${id.slice(8,12)}-4${id.slice(13,16)}-a${id.slice(17,20)}-${id.slice(20,32)}`;
  await query(`INSERT INTO app_users(id,firebase_uid,platform,last_active_at)
    VALUES($1,$2,$3,now()) ON CONFLICT(firebase_uid) DO UPDATE SET platform=EXCLUDED.platform,last_active_at=now()`,
    [uuid, uid, ["ios","android","web"].includes(platform) ? platform : "unknown"]);
}

export async function requireVerifiedFirebaseUser(req: Request, res: Response, next: NextFunction) {
  if (!features.firebaseTokenVerification) return next();
  const user = await verifiedFirebaseUser(req);
  if (!user) return res.status(401).json({ error: "firebase_auth_required" });
  (res.locals as any).firebaseUser = user;
  return next();
}

export async function requirePremiumEntitlement(req: Request, res: Response, next: NextFunction) {
  if (!features.premiumEnforcement) return next();
  const user = (res.locals as any).firebaseUser as VerifiedUser | undefined;
  if (!user || !postgresReady()) return res.status(503).json({ error: "entitlement_service_unavailable" });
  try {
    const result = await query(`SELECT EXISTS(SELECT 1 FROM app_users u JOIN user_entitlements e ON e.user_id=u.id
      WHERE u.firebase_uid=$1 AND e.status='active' AND (e.expires_at IS NULL OR e.expires_at>now())) allowed`, [user.uid]);
    return result.rows[0]?.allowed === true ? next() : res.status(403).json({ error: "premium_required" });
  } catch { return res.status(503).json({ error: "entitlement_service_unavailable" }); }
}
