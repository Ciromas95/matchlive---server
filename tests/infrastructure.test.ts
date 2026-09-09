import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";

process.env.NODE_ENV = "test";

test("Phase 1: feature flags shared storage are safe-by-default", async () => {
  const { features } = await import("../src/featureFlags");
  assert.equal(features.redis, false);
  assert.equal(features.postgres, false);
  assert.equal(features.postgresShadowWrite, false);
});

test("Phase 1: Redis disabled degrades to a cache miss without throwing", async () => {
  const redis = await import("../src/redisInfrastructure");
  assert.equal(await redis.initializeRedis(), false);
  assert.deepEqual(await redis.getRedisCache("test"), { state: "miss", value: null, ageMs: null });
  assert.equal((await redis.redisSnapshot()).state, "disabled");
});

test("Phase 1: Redis cache, JSON and TTL work with an available adapter", async () => {
  const { features, overrideFeatureForTest } = await import("../src/featureFlags");
  const redis = await import("../src/redisInfrastructure");
  const values = new Map<string,string>();
  const fake = {
    isReady: true,
    set: async (key:string,value:string) => { values.set(key,value); return "OK"; },
    get: async (key:string) => values.get(key) ?? null,
    ping: async () => "PONG", dbSize: async()=>values.size,
    info: async (section:string)=>section==="memory"?"used_memory:128\n":"connected_clients:1\n",
  };
  overrideFeatureForTest("redis", true); overrideFeatureForTest("redisCache", true);
  redis.configureRedisClientForTest(fake);
  await redis.setRedisCache("fixture:1", { score: "1-0" }, 10, 10);
  const found = await redis.getRedisCache<{score:string}>("fixture:1");
  assert.equal(found.state, "fresh"); assert.equal(found.value?.score, "1-0");
  redis.configureRedisClientForTest(null); overrideFeatureForTest("redis", false); overrideFeatureForTest("redisCache", false);
  assert.equal(features.redis, false);
});

test("Phase 1: Redis single-flight lets only one instance perform shared work", async () => {
  const { overrideFeatureForTest } = await import("../src/featureFlags");
  const redis = await import("../src/redisInfrastructure");
  const locks = new Map<string,string>();
  const fake = { isReady:true,
    set:async(key:string,value:string,options:any)=>{if(options?.NX&&locks.has(key))return null;locks.set(key,value);return "OK";},
    eval:async(_sql:string,args:any)=>{locks.delete(args.keys[0]);return 1;}, get:async()=>null };
  overrideFeatureForTest("redis",true); overrideFeatureForTest("redisLock",true);
  redis.configureRedisClientForTest(fake);
  let shared:string|null=null, executions=0;
  const task=()=>redis.withRedisSingleFlight("same-key",async()=>shared,async()=>{executions+=1;await new Promise((resolve)=>setTimeout(resolve,80));shared="ready";return shared;});
  const values=await Promise.all([task(),task()]);
  assert.deepEqual(values,["ready","ready"]); assert.equal(executions,1);
  redis.configureRedisClientForTest(null); overrideFeatureForTest("redis",false); overrideFeatureForTest("redisLock",false);
});

test("Phase 1: PostgreSQL unavailable never blocks shadow state", async () => {
  const shadow = await import("../src/shadowStorage");
  shadow.rememberShadowSource("test", "one", { ok: true }, 1);
  assert.equal(await shadow.shadowWriteDocument("test", "one", { ok: true }), false);
  assert.equal(shadow.shadowStorageSnapshot().trackedDocuments >= 1, true);
});

test("Phase 1: shadow write and validation match with an available PostgreSQL adapter", async () => {
  const { overrideFeatureForTest } = await import("../src/featureFlags");
  const postgres = await import("../src/postgresInfrastructure");
  const shadow = await import("../src/shadowStorage");
  shadow.resetShadowStorageForTest();
  const rows = new Map<string,any>();
  const fakePool = { totalCount:1,idleCount:1,waitingCount:0,
    query: async (sql:string,args:any[]) => {
      if (sql.includes("INSERT INTO legacy_shadow_documents")) { rows.set(`${args[0]}:${args[1]}`,{schema_version:args[2],checksum:args[3],source_updated_at:args[4]}); return {rows:[]}; }
      if (sql.includes("SELECT schema_version")) return {rows:[rows.get(`${args[0]}:${args[1]}`)].filter(Boolean)};
      if (sql.includes("pg_database_size")) return {rows:[{bytes:1024}]};
      return {rows:[]};
    }, end: async()=>undefined };
  overrideFeatureForTest("postgres",true); overrideFeatureForTest("postgresShadowWrite",true);
  postgres.configurePostgresPoolForTest(fakePool);
  assert.equal(await shadow.shadowWriteDocument("prematch_scan","2026-09-08",{version:1}),true);
  await shadow.validateShadowStorage();
  assert.equal(shadow.shadowStorageSnapshot().mismatchCount,0);
  postgres.configurePostgresPoolForTest(null); overrideFeatureForTest("postgres",false); overrideFeatureForTest("postgresShadowWrite",false);
});

test("Phase 1: shadow validation reports a checksum mismatch without changing the source", async () => {
  const { overrideFeatureForTest } = await import("../src/featureFlags");
  const postgres = await import("../src/postgresInfrastructure");
  const shadow = await import("../src/shadowStorage");
  shadow.resetShadowStorageForTest();
  const fakePool = { totalCount:1,idleCount:1,waitingCount:0,
    query: async (sql:string) => sql.includes("SELECT schema_version")
      ? { rows:[{ schema_version:1, checksum:"different" }] } : { rows:[] }, end:async()=>undefined };
  overrideFeatureForTest("postgres",true); overrideFeatureForTest("postgresShadowWrite",true);
  postgres.configurePostgresPoolForTest(fakePool);
  shadow.rememberShadowSource("live_state","current",{ revision:8 },1);
  await shadow.validateShadowStorage();
  const result = shadow.shadowStorageSnapshot();
  assert.equal(result.mismatchCount,1); assert.equal(result.mismatches[0]?.reason,"checksum");
  postgres.configurePostgresPoolForTest(null); overrideFeatureForTest("postgres",false); overrideFeatureForTest("postgresShadowWrite",false);
});

test("Phase 2: PostgreSQL shadow reads validate payloads and fall back safely", async () => {
  const { overrideFeatureForTest } = await import("../src/featureFlags");
  const postgres = await import("../src/postgresInfrastructure");
  const shadow = await import("../src/shadowStorage");
  const crypto = await import("node:crypto");
  shadow.resetShadowStorageForTest();
  const payload = { version: 2, picks: [{ fixtureId: 42 }] };
  const stable = (value: any): string => Array.isArray(value)
    ? `[${value.map(stable).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${stable(v)}`).join(",")}}`
      : JSON.stringify(value);
  const validChecksum = crypto.createHash("sha256").update(stable(payload)).digest("hex");
  let valid = true;
  const fakePool = { totalCount:1,idleCount:1,waitingCount:0,
    query: async (sql:string) => sql.includes("legacy_shadow_documents")
      ? { rows:[{ schema_version:2, checksum: valid ? validChecksum : "invalid", payload }] }
      : { rows:[] }, end:async()=>undefined };
  overrideFeatureForTest("postgres",true);
  postgres.configurePostgresPoolForTest(fakePool);
  assert.deepEqual(await shadow.readShadowDocument("prematch_publications","2026-09-09",2),payload);
  valid = false;
  assert.equal(await shadow.readShadowDocument("prematch_publications","2026-09-09",2),null);
  const snapshot = shadow.shadowStorageSnapshot();
  assert.equal(snapshot.readsOk,1);
  assert.equal(snapshot.readsFailed,1);
  assert.equal(snapshot.fallbacks,1);
  assert.equal(snapshot.fallbackReasons.checksum,1);
  postgres.configurePostgresPoolForTest(null); overrideFeatureForTest("postgres",false);
});

test("Phase 1: provider retries transient failures and opens its circuit", async () => {
  const resilience = await import("../src/providerResilience");
  const previous = { retries:process.env.PROVIDER_MAX_RETRIES, base:process.env.PROVIDER_RETRY_BASE_MS, threshold:process.env.PROVIDER_CIRCUIT_FAILURE_THRESHOLD };
  try {
    process.env.PROVIDER_MAX_RETRIES="1"; process.env.PROVIDER_RETRY_BASE_MS="25"; process.env.PROVIDER_CIRCUIT_FAILURE_THRESHOLD="2";
    resilience.resetProviderResilienceForTest();
    let invoked=0;
    const value = await resilience.executeProviderRequest(async()=>{ invoked+=1; if(invoked===1){const e:any=new Error("timeout");e.code="ETIMEDOUT";throw e;} return "ok"; });
    assert.equal(value,"ok"); assert.equal(resilience.providerResilienceSnapshot().retries,1);
    process.env.PROVIDER_MAX_RETRIES="0"; resilience.resetProviderResilienceForTest();
    const fail=async()=>{const e:any=new Error("upstream");e.response={status:503};throw e;};
    await assert.rejects(()=>resilience.executeProviderRequest(fail));
    await assert.rejects(()=>resilience.executeProviderRequest(fail));
    await assert.rejects(()=>resilience.executeProviderRequest(fail),(error:any)=>error.code==="provider_circuit_open");
    assert.equal(resilience.providerResilienceSnapshot().circuit.state,"open");
  } finally {
    if(previous.retries==null)delete process.env.PROVIDER_MAX_RETRIES;else process.env.PROVIDER_MAX_RETRIES=previous.retries;
    if(previous.base==null)delete process.env.PROVIDER_RETRY_BASE_MS;else process.env.PROVIDER_RETRY_BASE_MS=previous.base;
    if(previous.threshold==null)delete process.env.PROVIDER_CIRCUIT_FAILURE_THRESHOLD;else process.env.PROVIDER_CIRCUIT_FAILURE_THRESHOLD=previous.threshold;
    resilience.resetProviderResilienceForTest();
  }
});

test("Phase 1: migration contains all durable domains and a reversible script", () => {
  const up = fs.readFileSync(path.resolve("migrations/001_phase1_foundations.sql"),"utf8");
  const down = fs.readFileSync(path.resolve("migrations/001_phase1_foundations.down.sql"),"utf8");
  for (const table of ["app_users","user_entitlements","user_favorites","fixtures","prematch_publications","prematch_scans","lineup_predictions","official_lineups","notification_log","event_outbox","admin_audit_log","operational_metrics","legacy_shadow_documents"]) assert.match(up,new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  assert.match(down,/DROP TABLE IF EXISTS legacy_shadow_documents/);
});

test("Phase 1: SSE clients are closed cleanly during shutdown", async () => {
  const stream = await import("../src/stream");
  class FakeResponse extends EventEmitter { ended=false; status(){return this;} json(){return this;} write(){return true;} end(){this.ended=true;} }
  const response = new FakeResponse();
  assert.equal(stream.addClient(response as any,["live_delta"]),true);
  stream.closeAllClients("test_shutdown");
  assert.equal(response.ended,true); assert.equal(stream.clientsCount(),0);
});

test("Control Room separates provider and BrainLive live latency", async () => {
  const live = await import("../src/livePipelineTelemetry");
  live.resetLivePipelineTelemetryForTest();
  live.recordLiveProvider(12,88); live.recordLiveRedis(4); live.recordLiveSse(2);
  live.completeLiveCycle({processingMs:20,fixtures:7});
  const snapshot=live.livePipelineSnapshot();
  assert.equal(snapshot.latest.providerDelayMs,100); assert.equal(snapshot.latest.internalLatencyMs,26);
  assert.equal(snapshot.attribution,"provider");
  assert.ok(snapshot.latest.providerRequestStartedAt);
  assert.ok(snapshot.latest.providerResponseReceivedAt);
  assert.ok(snapshot.latest.redisPublishedAt);
  assert.ok(snapshot.latest.ssePublishedAt);
});

test("Control Room normalizes CPU against the assigned capacity", async () => {
  const telemetry=await import("../src/telemetry");
  const node=telemetry.telemetrySnapshot().node;
  assert.equal(node.cpuPct>=0&&node.cpuPct<=100,true);
  assert.equal(node.allocatedCpuCores>0,true);
});

test("Phase 1: admin sessions expire and old persisted sessions remain bounded", async () => {
  const { AdminSessionStore } = await import("../src/adminSessions");
  const file = path.join(process.cwd(),"data","admin-expiry-test.json");
  try { const store = new AdminSessionStore(file,-1); const token=store.create(); assert.equal(store.has(token),false); }
  finally { fs.rmSync(file,{force:true}); }
});

test("Phase 1: Firebase tokens are verified server-side without exposing the token", async () => {
  const auth = await import("../src/firebaseAuth");
  const request = { header:(name:string)=>name.toLowerCase()==="authorization"?"Bearer valid-token":"" } as any;
  auth.configureFirebaseVerifierForTest(async(token)=>{ assert.equal(token,"valid-token"); return {uid:"firebase-user"}; });
  assert.deepEqual(await auth.verifiedFirebaseUser(request),{uid:"firebase-user"});
  auth.configureFirebaseVerifierForTest(async()=>{throw Object.assign(new Error("invalid"),{code:"auth/invalid-token"});});
  assert.equal(await auth.verifiedFirebaseUser(request),null);
  auth.configureFirebaseVerifierForTest(null);
});

test("Phase 1: the server becomes ready and exits cleanly on SIGTERM", { timeout:15_000 }, async () => {
  const port = 34000 + Math.floor(Math.random()*1000);
  const compiledServer = path.resolve("dist/index.js");
  assert.equal(fs.existsSync(compiledServer),true,"Run npm run build before the smoke test");
  const child = spawn(process.execPath,[compiledServer],{
    cwd:process.cwd(), stdio:["ignore","pipe","pipe"], env:{...process.env,NODE_ENV:"test",PORT:String(port),
      REQUIRE_KEY:"false",REDIS_ENABLED:"false",POSTGRES_ENABLED:"false",ENABLE_POLLER:"false",ADMIN_PIN:"2468",
      ADMIN_SESSIONS_FILE:path.join("/tmp",`brainlive-admin-smoke-${port}.json`),ADMIN_LOGIN_RATE_LIMIT_MAX:"10",
      TEST_ACTIVE_JOB_MS:"5000",
      ENABLE_BRAIN_LIVE_POLLER:"false",ENABLE_PREMATCH_SCHEDULER:"false",LINEUP_PRECOMPUTE_ENABLED:"false"},
  });
  let stderr=""; child.stderr?.on("data",(chunk)=>{stderr+=String(chunk);});
  try {
    let ready=false;
    for(let attempt=0;attempt<40;attempt+=1){
      try { const response=await fetch(`http://127.0.0.1:${port}/health/ready`); if(response.ok){ready=true;break;} } catch {}
      await new Promise((resolve)=>setTimeout(resolve,100));
    }
    assert.equal(ready,true,stderr);
    const denied = await fetch(`http://127.0.0.1:${port}/health/details`);
    assert.equal(denied.status,401);
    const login = await fetch(`http://127.0.0.1:${port}/api/admin/login`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({pin:"2468"})});
    assert.equal(login.status,200,stderr);
    const token = String((await login.json() as any).token);
    const details = await fetch(`http://127.0.0.1:${port}/health/details`,{headers:{authorization:`Bearer ${token}`}});
    assert.equal(details.status,200);
    const dashboard = await fetch(`http://127.0.0.1:${port}/api/admin/infrastructure`,{headers:{authorization:`Bearer ${token}`}});
    assert.equal(dashboard.status,200); assert.equal(typeof (await dashboard.json() as any).systemStatus,"string");
    const wrongStatuses=[];
    for(let count=0;count<11;count+=1){const response=await fetch(`http://127.0.0.1:${port}/api/admin/login`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({pin:"wrong"})});wrongStatuses.push(response.status);}
    assert.equal(wrongStatuses.includes(429),true);
    const shutdownStarted=Date.now(); child.kill("SIGTERM");
    const exitCode = await new Promise<number|null>((resolve,reject)=>{child.once("exit",resolve);child.once("error",reject);});
    assert.equal(exitCode,0,stderr);
    assert.equal(Date.now()-shutdownStarted>=150,true,"shutdown did not wait for the active critical job");
  } finally { if(child.exitCode==null)child.kill("SIGKILL"); }
});
