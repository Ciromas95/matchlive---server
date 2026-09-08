CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  name text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_users (
  id uuid PRIMARY KEY,
  firebase_uid text UNIQUE NOT NULL,
  display_name text,
  platform text CHECK (platform IN ('ios','android','web','unknown')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS app_users_last_active_idx ON app_users(last_active_at DESC);

CREATE TABLE IF NOT EXISTS user_entitlements (
  id bigserial PRIMARY KEY, user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  entitlement text NOT NULL, status text NOT NULL, source text,
  starts_at timestamptz, expires_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, entitlement)
);
CREATE TABLE IF NOT EXISTS user_favorites (
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  favorite_type text NOT NULL, favorite_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, favorite_type, favorite_id)
);
CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id uuid PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb, updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fixtures (
  fixture_id bigint PRIMARY KEY, provider text NOT NULL DEFAULT 'api-football', league_id bigint,
  season integer, kickoff_at timestamptz, status text, revision bigint NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb, provider_updated_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fixtures_kickoff_idx ON fixtures(kickoff_at);
CREATE INDEX IF NOT EXISTS fixtures_league_status_idx ON fixtures(league_id, status);

CREATE TABLE IF NOT EXISTS prematch_publications (
  id bigserial PRIMARY KEY, fixture_id bigint NOT NULL, publication_date date NOT NULL,
  algorithm_version text NOT NULL, version integer NOT NULL DEFAULT 1, market text, prediction jsonb NOT NULL,
  published_at timestamptz NOT NULL, resolved_at timestamptz,
  UNIQUE(fixture_id, algorithm_version, version)
);
CREATE INDEX IF NOT EXISTS prematch_publications_date_idx ON prematch_publications(publication_date DESC);
CREATE TABLE IF NOT EXISTS prematch_scans (
  id bigserial PRIMARY KEY, scan_date date NOT NULL, algorithm_version text NOT NULL, phase text NOT NULL,
  started_at timestamptz NOT NULL, completed_at timestamptz, summary jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS prematch_scan_decisions (
  id bigserial PRIMARY KEY, scan_id bigint REFERENCES prematch_scans(id) ON DELETE CASCADE,
  fixture_id bigint, decision text NOT NULL, reason_code text, reason text, details jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS prematch_decisions_fixture_idx ON prematch_scan_decisions(fixture_id);
CREATE TABLE IF NOT EXISTS prediction_performance (
  id bigserial PRIMARY KEY, engine text NOT NULL, fixture_id bigint, algorithm_version text NOT NULL,
  market text, outcome text, stake numeric, profit numeric, accuracy numeric, evaluated_at timestamptz,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS lineup_predictions (
  fixture_id bigint NOT NULL, team_id bigint NOT NULL, algorithm_version text NOT NULL,
  version integer NOT NULL DEFAULT 1, formation text, prediction jsonb NOT NULL,
  generated_at timestamptz NOT NULL, expires_at timestamptz,
  PRIMARY KEY(fixture_id, team_id, algorithm_version, version)
);
CREATE TABLE IF NOT EXISTS official_lineups (
  fixture_id bigint NOT NULL, team_id bigint NOT NULL, lineup jsonb NOT NULL,
  provider_updated_at timestamptz, received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(fixture_id, team_id)
);
CREATE TABLE IF NOT EXISTS lineup_evaluations (
  fixture_id bigint NOT NULL, team_id bigint NOT NULL, algorithm_version text NOT NULL,
  player_accuracy numeric, formation_accuracy numeric, details jsonb NOT NULL DEFAULT '{}'::jsonb,
  evaluated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(fixture_id, team_id, algorithm_version)
);

CREATE TABLE IF NOT EXISTS notification_log (
  id bigserial PRIMARY KEY, idempotency_key text UNIQUE NOT NULL, fixture_id bigint,
  notification_type text NOT NULL, topic_hash text, status text NOT NULL,
  queued_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz, error_code text, metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS notification_status_idx ON notification_log(status, queued_at);
CREATE TABLE IF NOT EXISTS event_outbox (
  id bigserial PRIMARY KEY, aggregate_type text NOT NULL, aggregate_id text NOT NULL,
  event_type text NOT NULL, idempotency_key text UNIQUE NOT NULL, payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), available_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz, attempts integer NOT NULL DEFAULT 0, last_error text
);
CREATE INDEX IF NOT EXISTS event_outbox_pending_idx ON event_outbox(available_at) WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id bigserial PRIMARY KEY, actor_hash text, action text NOT NULL, request_id text,
  ip_hash text, target_type text, target_id text, metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_audit_created_idx ON admin_audit_log(created_at DESC);
CREATE TABLE IF NOT EXISTS scheduler_state (
  scheduler_name text PRIMARY KEY, algorithm_version text, state text NOT NULL,
  lease_owner text, lease_expires_at timestamptz, last_started_at timestamptz,
  last_completed_at timestamptz, last_error_code text, metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS operational_metrics (
  bucket_at timestamptz NOT NULL, metric_name text NOT NULL, labels jsonb NOT NULL DEFAULT '{}'::jsonb,
  value double precision NOT NULL, source text NOT NULL DEFAULT 'brainlive',
  PRIMARY KEY(bucket_at, metric_name, labels)
);
CREATE INDEX IF NOT EXISTS operational_metrics_name_time_idx ON operational_metrics(metric_name, bucket_at DESC);

CREATE TABLE IF NOT EXISTS legacy_shadow_documents (
  document_type text NOT NULL, document_key text NOT NULL, schema_version integer NOT NULL,
  checksum text NOT NULL, source_updated_at timestamptz NOT NULL, shadow_updated_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL, PRIMARY KEY(document_type, document_key)
);

INSERT INTO schema_migrations(version, name) VALUES(1, 'phase1_foundations')
ON CONFLICT(version) DO NOTHING;
