type CircuitState = "closed" | "open" | "half_open";

let state: CircuitState = "closed";
let consecutiveFailures = 0;
let openedAt = 0;
let halfOpenRunning = false;
let attempts = 0;
let retries = 0;
let successes = 0;
let failures = 0;
let timeouts = 0;
let rateLimited = 0;
let rejectedByCircuit = 0;
let lastSuccessAt: string | null = null;
let lastFailureAt: string | null = null;

const failureThreshold = () => Math.max(2, Number(process.env.PROVIDER_CIRCUIT_FAILURE_THRESHOLD ?? "5"));
const openMs = () => Math.max(1_000, Number(process.env.PROVIDER_CIRCUIT_OPEN_MS ?? "20000"));
const maxRetries = () => Math.max(0, Math.min(4, Number(process.env.PROVIDER_MAX_RETRIES ?? "2")));
const baseDelayMs = () => Math.max(25, Number(process.env.PROVIDER_RETRY_BASE_MS ?? "250"));

export class ProviderCircuitOpenError extends Error {
  status = 503;
  code = "provider_circuit_open";
  constructor() { super("Provider temporarily unavailable"); }
}

function statusOf(error: any): number | null {
  const value = Number(error?.response?.status ?? error?.status);
  return Number.isFinite(value) ? value : null;
}

function isTimeout(error: any) {
  return error?.code === "ECONNABORTED" || error?.code === "ETIMEDOUT" || /timeout/i.test(String(error?.message ?? ""));
}

export function providerErrorIsRetryable(error: any) {
  const status = statusOf(error);
  return isTimeout(error) || status === 408 || status === 425 || status === 429 || (status != null && status >= 500) || status == null;
}

function beforeAttempt() {
  if (state === "open") {
    if (Date.now() - openedAt < openMs()) {
      rejectedByCircuit += 1;
      throw new ProviderCircuitOpenError();
    }
    state = "half_open";
  }
  if (state === "half_open") {
    if (halfOpenRunning) {
      rejectedByCircuit += 1;
      throw new ProviderCircuitOpenError();
    }
    halfOpenRunning = true;
  }
}

function recordSuccess() {
  successes += 1;
  consecutiveFailures = 0;
  state = "closed";
  halfOpenRunning = false;
  lastSuccessAt = new Date().toISOString();
}

function recordFailure(error: any) {
  failures += 1;
  consecutiveFailures += 1;
  halfOpenRunning = false;
  lastFailureAt = new Date().toISOString();
  if (isTimeout(error)) timeouts += 1;
  if (statusOf(error) === 429) rateLimited += 1;
  if (consecutiveFailures >= failureThreshold() || state === "half_open") {
    state = "open";
    openedAt = Date.now();
  }
}

export async function executeProviderRequest<T>(task: (attempt: number) => Promise<T>): Promise<T> {
  beforeAttempt();
  const limit = maxRetries();
  let lastError: any;
  for (let attempt = 0; attempt <= limit; attempt += 1) {
    attempts += 1;
    try {
      const result = await task(attempt);
      recordSuccess();
      return result;
    } catch (error: any) {
      lastError = error;
      const retryable = providerErrorIsRetryable(error);
      if (!retryable || attempt >= limit) {
        recordFailure(error);
        throw error;
      }
      retries += 1;
      const exponential = baseDelayMs() * (2 ** attempt);
      const jitter = Math.floor(Math.random() * Math.max(10, exponential * 0.35));
      await new Promise((resolve) => setTimeout(resolve, exponential + jitter));
    }
  }
  recordFailure(lastError);
  throw lastError;
}

export function providerResilienceSnapshot() {
  return {
    circuit: { state, consecutiveFailures, failureThreshold: failureThreshold(), openMs: openMs(), rejected: rejectedByCircuit },
    attempts, retries, successes, failures, timeouts, rateLimited, lastSuccessAt, lastFailureAt,
    lastValidResponseAgeMs: lastSuccessAt ? Math.max(0, Date.now() - Date.parse(lastSuccessAt)) : null,
    timeoutMs: Number(process.env.PROVIDER_TIMEOUT_MS ?? "10000"), maxRetries: maxRetries(),
  };
}

export function resetProviderResilienceForTest() {
  if (process.env.NODE_ENV !== "test") throw new Error("provider_resilience_test_only");
  state = "closed"; consecutiveFailures = 0; openedAt = 0; halfOpenRunning = false;
  attempts = 0; retries = 0; successes = 0; failures = 0; timeouts = 0; rateLimited = 0;
  rejectedByCircuit = 0; lastSuccessAt = null; lastFailureAt = null;
}
