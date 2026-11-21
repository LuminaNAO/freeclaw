import { CONTEXT_WINDOW_HARD_MIN_TOKENS } from "../agents/context-window-constants.js";
import {
  CONTEXT_LIMIT_CLEAR_WORD,
  normalizeSessionContextLimit,
} from "../agents/session-context-limit.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import {
  loadSessionStore,
  resolveSessionStoreEntry,
  updateSessionStore,
} from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { formatTokenCount } from "../utils/usage-format.js";

/**
 * Session context limit ARCH §1-§2: one optional, operator-only number on the session entry
 * (`contextLimit`, tokens) that can only lower the effective context window. The chat command,
 * `sessions.patch` and the `session_status` tool all validate with {@link parseContextLimitValue}
 * and write with {@link applyContextLimitToEntry}, so they behave identically.
 */

export { CONTEXT_LIMIT_CLEAR_WORD };

export const CONTEXT_LIMIT_OPERATOR_ONLY_ERROR =
  "Only an operator can change a session's context limit.";

export type ParsedContextLimit = { ok: true; value: number | null } | { ok: false; error: string };

export function formatContextLimitMinimumError(): string {
  return `contextLimit must be a whole number of tokens, at least ${CONTEXT_WINDOW_HARD_MIN_TOKENS} (${formatTokenCount(CONTEXT_WINDOW_HARD_MIN_TOKENS)})`;
}

const TOKEN_TEXT_RE = /^(\d+(?:\.\d+)?|\.\d+)\s*([km])?$/;
// Decimal suffix input ("0.3m") is multiplied in floating point; accept results this close to a
// whole number and round them, refuse anything else as a fraction of a token.
const FRACTION_TOLERANCE = 1e-6;

function validateTokenCount(value: number): ParsedContextLimit {
  if (!Number.isSafeInteger(value) || value < CONTEXT_WINDOW_HARD_MIN_TOKENS) {
    return { ok: false, error: formatContextLimitMinimumError() };
  }
  return { ok: true, value };
}

/**
 * Session context limit ARCH §1.3: the single validator. Accepts a number, a token string
 * (`256000`, `256k`, `0.5m`), the clear word `default`, or `null` (clear). Anything below
 * `CONTEXT_WINDOW_HARD_MIN_TOKENS` or not a whole number of tokens is refused with the minimum
 * named.
 */
export function parseContextLimitValue(raw: unknown): ParsedContextLimit {
  if (raw === null) {
    return { ok: true, value: null };
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      return { ok: false, error: formatContextLimitMinimumError() };
    }
    return validateTokenCount(raw);
  }
  if (typeof raw !== "string") {
    return { ok: false, error: formatContextLimitMinimumError() };
  }
  const text = raw.trim().toLowerCase().replace(/_/g, "");
  if (text === CONTEXT_LIMIT_CLEAR_WORD) {
    return { ok: true, value: null };
  }
  const match = TOKEN_TEXT_RE.exec(text);
  if (!match) {
    return {
      ok: false,
      error: `invalid contextLimit "${raw.trim()}" (use a token count like 256000, 256k or 0.5m, or ${CONTEXT_LIMIT_CLEAR_WORD})`,
    };
  }
  const base = Number(match[1]);
  const multiplier = match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
  const scaled = base * multiplier;
  const rounded = Math.round(scaled);
  if (!Number.isFinite(scaled) || Math.abs(scaled - rounded) > FRACTION_TOLERANCE) {
    return { ok: false, error: formatContextLimitMinimumError() };
  }
  return validateTokenCount(rounded);
}

/**
 * Session context limit ARCH §2: the one entry mutation behind the command, `sessions.patch` and
 * the tool. `null` clears. When the value changes, the recorded `contextTokens` (derived from the
 * old ceiling) is dropped so the next turn and every display re-resolve it.
 */
export function applyContextLimitToEntry(entry: SessionEntry, value: number | null): boolean {
  const changed = entry.contextLimit !== (value ?? undefined);
  if (value === null) {
    delete entry.contextLimit;
  } else {
    entry.contextLimit = value;
  }
  if (changed) {
    delete entry.contextTokens;
  }
  return changed;
}

/** Session context limit ARCH §1.1: carry the limit across /new, /reset and idle resets. */
export function pickSessionContextLimit(
  entry: Pick<SessionEntry, "contextLimit"> | undefined,
): Pick<SessionEntry, "contextLimit"> {
  const limit = normalizeSessionContextLimit(entry?.contextLimit);
  return limit === undefined ? {} : { contextLimit: limit };
}

export type SetSessionContextLimitResult =
  | { ok: true; entry: SessionEntry; changed: boolean }
  | { ok: false; error: string };

/** Persist a validated value onto an existing entry inside the store lock. */
export async function setSessionContextLimit(params: {
  storePath: string;
  sessionKey: string;
  value: number | null;
  /** Used when the store does not hold the key yet (a chat whose first turn is the command). */
  fallbackEntry?: SessionEntry;
}): Promise<SetSessionContextLimitResult> {
  return await updateSessionStore(params.storePath, (store) => {
    const current = store[params.sessionKey] ?? params.fallbackEntry;
    if (!current) {
      return { ok: false as const, error: `session not found: ${params.sessionKey}` };
    }
    const changed = applyContextLimitToEntry(current, params.value);
    if (changed) {
      current.updatedAt = Math.max(current.updatedAt ?? 0, Date.now());
    }
    store[params.sessionKey] = current;
    return { ok: true as const, entry: { ...current }, changed };
  });
}

/**
 * Session context limit ARCH §1.2/§3.1: the limit stored for `sessionKey`, read fresh at the start
 * of a run or compaction so a change takes effect on the next turn with no restart. Keyed by the
 * session's own key, so sub-agent, cron and other sessions never pick up a parent's limit (§1.4).
 * Best effort: any read problem means no limit (today's behaviour).
 */
export function readSessionContextLimit(params: {
  cfg: OpenClawConfig | undefined;
  sessionKey: string | undefined;
}): number | undefined {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return undefined;
  }
  try {
    const storePath = resolveStorePath(params.cfg?.session?.store, {
      agentId: resolveAgentIdFromSessionKey(sessionKey),
    });
    const store = loadSessionStore(storePath);
    const { existing } = resolveSessionStoreEntry({ store, sessionKey });
    return normalizeSessionContextLimit(existing?.contextLimit);
  } catch {
    return undefined;
  }
}
