import { withTimeout } from "../../node-host/with-timeout.js";

export const EMBEDDED_COMPACTION_TIMEOUT_MS = 1_200_000; // Changed from 300s to 20min - TODO: make configurable via config

export async function compactWithSafetyTimeout<T>(
  compact: () => Promise<T>,
  timeoutMs: number = EMBEDDED_COMPACTION_TIMEOUT_MS,
): Promise<T> {
  return await withTimeout(() => compact(), timeoutMs, "Compaction");
}
