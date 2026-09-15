import { withTimeout } from "../../node-host/with-timeout.js";

// setTimeout's largest safe delay (2^31 - 1 ms ≈ 24.8 days). Anything bigger
// overflows to ~1 ms and would abort every compaction immediately.
const MAX_TIMER_MS = 2_147_483_647;

// Compaction on slow local inference (llama.cpp / vLLM, minute-scale prompt
// processing) can legitimately take a long time; a short cap turns a working
// compaction into a wedged session. Default is therefore effectively unbounded
// — the SDK/undici timeout patches already keep the request itself alive — and
// operators can tighten it per gateway with OPENCLAW_COMPACTION_TIMEOUT_MS.
function resolveCompactionTimeoutMs(): number {
  const raw = process.env.OPENCLAW_COMPACTION_TIMEOUT_MS?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.min(Math.floor(parsed), MAX_TIMER_MS);
  }
  return MAX_TIMER_MS;
}

export const EMBEDDED_COMPACTION_TIMEOUT_MS = resolveCompactionTimeoutMs();

export async function compactWithSafetyTimeout<T>(
  compact: () => Promise<T>,
  timeoutMs: number = EMBEDDED_COMPACTION_TIMEOUT_MS,
): Promise<T> {
  return await withTimeout(() => compact(), timeoutMs, "Compaction");
}
