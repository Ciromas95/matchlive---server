# BrainLive Phase 1 infrastructure

Phase 1 is additive. JSON files remain authoritative and the public mobile API contract is unchanged.

## Safe activation order

1. Deploy with every Redis/PostgreSQL flag disabled.
2. Provision PostgreSQL and run `migrations/001_phase1_foundations.sql` against a non-production database.
3. Enable `POSTGRES_ENABLED`, leaving every read flag and shadow write disabled.
4. Enable `POSTGRES_SHADOW_WRITE`; inspect the admin Database panel for failures/mismatches.
5. Provision Redis and enable `REDIS_ENABLED` only.
6. Enable Redis cache, live snapshot, lock and global provider limiter one at a time.
7. Keep `*_REQUIRED_FOR_READY=false` until the shared services are proven stable.

`POSTGRES_AUTO_MIGRATE` is intentionally false by default. Production migrations should be an explicit deployment step.

## Redis key space

- `brainlive:v1:cache:<provider-cache-key>` — shared cache envelope with fresh/stale timestamps.
- `brainlive:v1:live:snapshot` — current compact live snapshot, TTL 180 seconds.
- `brainlive:v1:brain-live:state` — operational Brain LIVE state, TTL 20 hours.
- `brainlive:v1:lock:<name>` — distributed lock; every lock has a TTL.
- `brainlive:v1:lock:singleflight:<provider-cache-key>` — coalescenza tra istanze, con attesa limitata e fallback locale.
- `brainlive:v1:lock:job:<name>` — scheduler lease.
- `brainlive:v1:provider:next-slot` — global API-Football start slot, TTL 10 seconds.

No Redis key is the only durable source of business data.

## PostgreSQL

The first migration creates users, entitlements, favorites, notification preferences, fixtures, prematch publications/scans/decisions, performance, lineup prediction/official/evaluation, notification log, event outbox, admin audit, scheduler state, operational metrics and generic legacy shadow documents.

Shadow writes currently cover live state, Brain LIVE operational state, PREMATCH publications, scan reports, performance and lineup prediction storage. A failed shadow write never blocks the legacy JSON save.

## Health

- `GET /health/live`: process liveness, public and secret-free.
- `GET /health/ready`: traffic readiness, public and secret-free.
- `GET /health/details`: detailed protected dependency status.

Redis/PostgreSQL can initially be degraded while readiness stays true. Set the corresponding `*_REQUIRED_FOR_READY` flag only after validation.

## Rollback

- Redis incident: disable the Redis feature flags; local cache and JSON remain active.
- PostgreSQL incident: disable shadow write/PostgreSQL; JSON remains authoritative.
- Dashboard incident: disable `NEW_ADMIN_DASHBOARD_ENABLED`; public APIs and engines are independent.
- Schema rollback: use `001_phase1_foundations.down.sql` only after confirming that no read flag uses PostgreSQL.

## Security

Admin sessions expire, PIN comparison is timing-safe, admin requests are rate limited, Express identification is disabled, request bodies are capped, CORS is configurable and Helmet security headers are active. Firebase and premium enforcement remain feature-gated so an incomplete rollout cannot lock out current clients.

## Provider resilience

API-Football usa timeout limitato, massimo due nuovi tentativi soltanto per timeout, HTTP 429 e 5xx, attesa esponenziale con jitter e circuit breaker. Gli errori 4xx ordinari non vengono ripetuti. Ogni tentativo fisico passa dal limitatore globale e viene conteggiato nella quota del provider.
