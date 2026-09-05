import { isApiEcoMode } from "./runtimeMode";
export { isApiEcoMode } from "./runtimeMode";

export function liveTtlMs(liveCount: number) {
  if (isApiEcoMode()) {
    return liveCount <= 0 ? 5 * 60_000 : 60_000;
  }
  return 15_000;
}
