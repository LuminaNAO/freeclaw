import { normalizeProviderId } from "./model-selection.js";

// A usage/quota window is exhausted (as opposed to a short per-minute rate limit).
const QUOTA_EXHAUSTED_RE =
  /usage limit|quota (?:exceeded|exhausted|limit)|exceeded your (?:current )?quota|insufficient[_ ]quota|resource(?:_| has been )exhausted|(?:daily|weekly|monthly|hourly)(?: usage)? limit|(?:usage|quota|plan|subscription) (?:limit )?(?:reached|exhausted)|(?:rolling|quota) (?:time )?window|you(?:'ve| have) (?:hit|reached) your (?:usage|quota|plan|daily|weekly|monthly)/i;
// Unambiguous long-window signals: these win even when the text also mentions a per-minute limit.
const LONG_WINDOW_RE =
  /(?:daily|weekly|monthly)(?: usage)? limit|usage limit|subscription quota|(?:rolling|quota) (?:time )?window|insufficient[_ ]quota|exceeded your (?:current )?quota/i;
// Per-second/per-minute throttles are ordinary rate limits; retrying soon is fine.
const SHORT_RATE_WINDOW_RE =
  /per (?:second|minute|min)\b|\/\s*(?:s|sec|m|min)\b|requests per min|\brpm\b|\btpm\b|tokens per minute/i;

/** Default skip window when a quota error carries no reset hint. */
const DEFAULT_QUOTA_WINDOW_MS = 15 * 60_000;
const MAX_QUOTA_WINDOW_MS = 7 * 24 * 60 * 60_000;

const UNIT_MS: Record<string, number> = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
};

export function isQuotaExhaustedErrorMessage(raw: string | undefined): boolean {
  if (!raw || !QUOTA_EXHAUSTED_RE.test(raw)) {
    return false;
  }
  return LONG_WINDOW_RE.test(raw) || !SHORT_RATE_WINDOW_RE.test(raw);
}

/**
 * Whether a failure should open a provider quota window. The detector is authoritative for quota text; the
 * failover reason only vetoes classes that have their own handling (auth problems, billing disables).
 * Unclassified (`null`/`unknown`) quota text still opens a window.
 */
export function shouldOpenQuotaWindow(
  reason: string | null | undefined,
  raw: string | undefined,
): boolean {
  if (!isQuotaExhaustedErrorMessage(raw)) {
    return false;
  }
  return reason !== "auth" && reason !== "auth_permanent" && reason !== "billing";
}

function sumDurationMs(text: string): number {
  let total = 0;
  for (const part of text.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) {
    const unitMs = UNIT_MS[part[2].toLowerCase()];
    if (unitMs) {
      total += Number(part[1]) * unitMs;
    }
  }
  return total;
}

function parseAbsoluteReset(token: string): number {
  if (/^\d+(?:\.\d+)?$/.test(token)) {
    const n = Number(token);
    // Unix seconds vs milliseconds.
    return n < 1e12 ? n * 1_000 : n;
  }
  return Date.parse(token);
}

const HTTP_DATE =
  "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \\d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \\d{4} \\d{2}:\\d{2}:\\d{2} GMT";
const ISO_TIME = "[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9:.]+(?:Z|[+-][0-9:]+)?";

/**
 * Parse a reset hint from a provider error. Returns an absolute epoch ms (the latest hint found), or undefined.
 * Supported: `Retry-After: <seconds>` or `Retry-After: <HTTP-date>`, `retry_after`/`retryAfter` numbers,
 * `x-ratelimit-reset*` (epoch, ISO, or duration like `6m0s`), Google `retryDelay: "37s"`,
 * "try again in 2h 30m", "resets in 45 minutes", "quota will reset after 2 hours",
 * and "resets at <ISO|epoch>".
 */
export function parseQuotaResetAt(raw: string | undefined, now = Date.now()): number | undefined {
  if (!raw) {
    return undefined;
  }
  const hints: number[] = [];
  const add = (value: number) => {
    if (Number.isFinite(value) && value > now) {
      hints.push(value);
    }
  };

  const retryAfterDate = raw.match(
    new RegExp(`retry[-_ ]?after["']?\\s*[:=]\\s*["']?(${HTTP_DATE})`, "i"),
  );
  if (retryAfterDate) {
    add(Date.parse(retryAfterDate[1]));
  }
  const retryAfter = raw.match(/retry[-_ ]?after["']?\s*[:=]?\s*["']?(\d+(?:\.\d+)?)\s*(ms|s)?\b/i);
  if (retryAfter) {
    add(now + Number(retryAfter[1]) * (retryAfter[2]?.toLowerCase() === "ms" ? 1 : 1_000));
  }
  const retryDelay = raw.match(/retry[-_ ]?delay["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)(ms|s)?/i);
  if (retryDelay) {
    add(now + Number(retryDelay[1]) * (retryDelay[2]?.toLowerCase() === "ms" ? 1 : 1_000));
  }
  for (const m of raw.matchAll(
    new RegExp(
      `x-ratelimit-reset[a-z-]*["']?\\s*[:=]\\s*["']?(${ISO_TIME}|\\d+(?:\\.\\d+)?(?:ms|[smhd])?(?:\\d+(?:\\.\\d+)?(?:ms|[smhd]))*)`,
      "gi",
    ),
  )) {
    const token = m[1];
    if (/^\d+(?:\.\d+)?$/.test(token) && Number(token) >= 1e9) {
      add(parseAbsoluteReset(token));
    } else if (/[smhd]$/i.test(token)) {
      add(now + sumDurationMs(token.replace(/(ms|[smhd])/gi, "$1 ")));
    } else if (/^\d+(?:\.\d+)?$/.test(token)) {
      add(now + Number(token) * 1_000);
    } else {
      add(Date.parse(token));
    }
  }
  const relative = raw.match(
    /(?:try again|retry|resets?|will reset|available again|refresh(?:es)?)\s+(?:in|after)\s+((?:\d+(?:\.\d+)?\s*[a-z]+[\s,]*(?:and\s+)?)+)/i,
  );
  if (relative) {
    const total = sumDurationMs(relative[1]);
    if (total > 0) {
      add(now + total);
    }
  }
  const absolute = raw.match(
    new RegExp(
      `(?:resets?|reset_at|resets_at|available again|try again)["']?\\s*(?:at|on|after|:|=)\\s*["']?(${ISO_TIME}|${HTTP_DATE}|\\d{10,13})`,
      "i",
    ),
  );
  if (absolute) {
    add(parseAbsoluteReset(absolute[1]));
  }
  return hints.length > 0 ? Math.max(...hints) : undefined;
}

export function resolveQuotaWindowUntil(raw: string | undefined, now = Date.now()): number {
  const hinted = parseQuotaResetAt(raw, now);
  const until = hinted ?? now + DEFAULT_QUOTA_WINDOW_MS;
  return Math.min(until, now + MAX_QUOTA_WINDOW_MS);
}

// Process-wide: fallback in any run skips a provider whose quota window is still open.
const quotaWindows = new Map<string, number>();

export function markProviderQuotaExhausted(params: {
  provider: string;
  message?: string;
  now?: number;
}): number {
  const now = params.now ?? Date.now();
  const key = normalizeProviderId(params.provider);
  const until = resolveQuotaWindowUntil(params.message, now);
  const existing = quotaWindows.get(key);
  // Keep the later reset: a hinted absolute reset should not be shortened by a hintless repeat.
  const next = existing && existing > until ? existing : until;
  quotaWindows.set(key, next);
  return next;
}

export function getProviderQuotaWindowUntil(
  provider: string,
  now = Date.now(),
): number | undefined {
  const key = normalizeProviderId(provider);
  const until = quotaWindows.get(key);
  if (until === undefined) {
    return undefined;
  }
  if (until <= now) {
    quotaWindows.delete(key);
    return undefined;
  }
  return until;
}

export function resetProviderQuotaWindowsForTest(): void {
  quotaWindows.clear();
}
