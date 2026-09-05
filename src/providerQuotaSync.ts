import axios from "axios";
import { syncProviderQuota } from "./stats";

type StatusResponse = { data: any; headers: any };

/** Shared and throttled across admin sessions; never return account details. */
export function createProviderQuotaSync(
  fetchStatus: () => Promise<StatusResponse>,
  applyQuota = syncProviderQuota,
  now = () => Date.now(),
) {
  let lastAttempt = -Infinity;
  let pending: Promise<void> | null = null;
  return function refresh(): Promise<void> {
    if (pending) return pending;
    const startedAt = now();
    if (startedAt - lastAttempt < 60_000) return Promise.resolve();
    lastAttempt = startedAt;
    pending = (async () => {
      try {
        const result = await fetchStatus();
        const errors = result.data?.errors;
        if (errors && (typeof errors !== "object" || Object.keys(errors).length > 0)) return;
        const requests = result.data?.response?.requests;
        const count = requests?.current;
        const limit = requests?.limit_day;
        const integer = (value: unknown) =>
          (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) &&
          Number.isSafeInteger(Number(value));
        if (!integer(count) || !integer(limit) || Number(count) < 0 || Number(limit) <= 0) return;
        // Use only quota fields. The /status payload also contains private account data.
        applyQuota({
          date: result.headers?.get?.("date") ?? result.headers?.date,
          "x-ratelimit-requests-limit": Number(limit),
          "x-ratelimit-requests-remaining": Number(limit) - Number(count),
        }, startedAt);
      } catch {
        // Offline, expired key or quota rejection: preserve the last confirmed reading.
      }
    })().finally(() => { pending = null; });
    return pending;
  };
}

export const refreshProviderQuota = createProviderQuotaSync(async () => {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) throw new Error("Provider key unavailable");
  return axios.get("https://v3.football.api-sports.io/status", {
    headers: { "x-apisports-key": key },
    timeout: 3000,
  });
});
