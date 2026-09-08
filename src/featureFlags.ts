function enabled(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

export const features = {
  redis: enabled("REDIS_ENABLED"),
  redisCache: enabled("REDIS_CACHE_ENABLED"),
  redisLock: enabled("REDIS_LOCK_ENABLED"),
  redisRateLimit: enabled("REDIS_RATE_LIMIT_ENABLED"),
  redisLiveState: enabled("REDIS_LIVE_STATE_ENABLED"),
  redisRequiredForReady: enabled("REDIS_REQUIRED_FOR_READY"),
  postgres: enabled("POSTGRES_ENABLED"),
  postgresShadowWrite: enabled("POSTGRES_SHADOW_WRITE"),
  postgresAutoMigrate: enabled("POSTGRES_AUTO_MIGRATE"),
  postgresRequiredForReady: enabled("POSTGRES_REQUIRED_FOR_READY"),
  postgresReadPrematch: enabled("POSTGRES_READ_PREMATCH"),
  postgresReadLineup: enabled("POSTGRES_READ_LINEUP"),
  postgresReadLive: enabled("POSTGRES_READ_LIVE"),
  observability: enabled("OBSERVABILITY_ENABLED", true),
  newAdminDashboard: enabled("NEW_ADMIN_DASHBOARD_ENABLED", true),
  firebaseTokenVerification: enabled("FIREBASE_TOKEN_VERIFICATION_ENABLED"),
  premiumEnforcement: enabled("PREMIUM_ENFORCEMENT_ENABLED"),
  lineupPrecompute: enabled("LINEUP_PRECOMPUTE_ENABLED"),
} as const;

export function publicFeatureSnapshot() {
  return { ...features };
}

/** Test-only override; production configuration always comes from environment variables. */
export function overrideFeatureForTest(name: keyof typeof features, value: boolean) {
  if (process.env.NODE_ENV !== "test") throw new Error("feature_override_test_only");
  (features as Record<string, boolean>)[name] = value;
}
