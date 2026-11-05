// Focus mode state (docs/design/focus-mode.md §7.1, replacing the single target of §2).
// Focus is an attribute of a session: each session may carry a tier above `none`.
// Stored in <stateDir>/focus.json as { sessions: { <key>: { tier, since, by } } }
// (0600, temp file + rename). No timeout, no timer: focus lasts until cleared.
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { isCronRunSessionKey } from "../sessions/session-key-utils.js";
import { listStack } from "./session-stack.js";

/** §7.1: ordered lowest first. A new tier is added here; the rule (§7.2) does not change. */
export const FOCUS_TIERS = ["none", "normal", "hyper"] as const;

export type FocusTier = (typeof FOCUS_TIERS)[number];

/** `/focus <key>` without a tier (§7.4). */
export const DEFAULT_FOCUS_TIER: FocusTier = "normal";

export function focusTierRank(tier: FocusTier): number {
  return FOCUS_TIERS.indexOf(tier);
}

export function parseFocusTier(raw: unknown): FocusTier | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const lowered = raw.trim().toLowerCase();
  return (FOCUS_TIERS as readonly string[]).includes(lowered) ? (lowered as FocusTier) : undefined;
}

export type FocusSessionEntry = {
  /** Always above `none` on disk; `none` is the absence of an entry. */
  tier: FocusTier;
  /** Epoch ms when this session's tier was set. */
  since: number;
  /** Who set it (operator sender id, client id or "cli"). */
  by: string;
};

export type FocusState = {
  sessions: Record<string, FocusSessionEntry>;
  /**
   * Sessions already sent the busy notice this focus period (§3.2). Kept on disk
   * so a restart during focus does not send a second notice. A session leaves the
   * list when it is allowed again (its waiting period ended).
   */
  notified?: string[];
};

/** Alias kept for callers written against the v2 name. */
export type FocusStateV2 = FocusState;

export function resolveFocusFile(stateDir: string = resolveStateDir()): string {
  return path.join(stateDir, "focus.json");
}

function parseSessionEntry(value: unknown): FocusSessionEntry | undefined {
  const v = value as Partial<FocusSessionEntry> | null;
  if (!v || typeof v !== "object") {
    return undefined;
  }
  const tier = parseFocusTier(v.tier);
  if (!tier || focusTierRank(tier) <= 0 || typeof v.since !== "number") {
    return undefined;
  }
  return { tier, since: v.since, by: typeof v.by === "string" ? v.by : "unknown" };
}

function parseNotified(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const list = value.filter((item): item is string => typeof item === "string");
  return list.length > 0 ? list : undefined;
}

/**
 * The stored state in v2 form. A v1 file `{ target, since, by }` is read as one
 * `normal` session (§7.1); it is rewritten in v2 form the next time it is saved.
 */
function parseFocusFile(value: unknown): FocusState | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const notified = parseNotified(raw.notified);
  if (typeof raw.target === "string" && raw.sessions === undefined) {
    const target = raw.target.trim();
    if (!target || typeof raw.since !== "number" || typeof raw.by !== "string") {
      return undefined;
    }
    return {
      sessions: { [target]: { tier: "normal", since: raw.since, by: raw.by } },
      ...(notified ? { notified } : {}),
    };
  }
  if (!raw.sessions || typeof raw.sessions !== "object" || Array.isArray(raw.sessions)) {
    return undefined;
  }
  const sessions: Record<string, FocusSessionEntry> = {};
  for (const [key, entryRaw] of Object.entries(raw.sessions as Record<string, unknown>)) {
    const trimmed = key.trim();
    const entry = parseSessionEntry(entryRaw);
    if (trimmed && entry) {
      sessions[trimmed] = entry;
    }
  }
  return { sessions, ...(notified ? { notified } : {}) };
}

/**
 * The current focus, or undefined when no session holds a tier above `none`
 * (missing, empty or unreadable file = no focus).
 */
export function readFocusState(stateDir?: string): FocusState | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(resolveFocusFile(stateDir), "utf8");
  } catch {
    return undefined;
  }
  let parsed: FocusState | undefined;
  try {
    parsed = parseFocusFile(JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
  return parsed && Object.keys(parsed.sessions).length > 0 ? parsed : undefined;
}

/** Save, or remove the file when no session is focused (no focus = no file, as before). */
function writeFocusFile(state: FocusState, stateDir?: string): void {
  const file = resolveFocusFile(stateDir);
  if (Object.keys(state.sessions).length === 0) {
    try {
      fs.unlinkSync(file);
    } catch {
      // Already none.
    }
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(file), `.focus.json.${process.pid}.tmp`);
  const out: FocusState = { sessions: state.sessions };
  if (state.notified && state.notified.length > 0) {
    out.notified = state.notified;
  }
  fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function sameSessionKey(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function findSessionKey(state: FocusState | undefined, sessionKey: string): string | undefined {
  if (!state) {
    return undefined;
  }
  return Object.keys(state.sessions).find((key) => sameSessionKey(key, sessionKey));
}

/** The tier a session holds (`none` when it holds none). */
export function sessionFocusTier(state: FocusState | undefined, sessionKey: string): FocusTier {
  const key = findSessionKey(state, sessionKey);
  return key && state ? state.sessions[key].tier : "none";
}

/** §7.2: the highest tier any session holds, or `none`. */
export function activeFocusLevel(state: FocusState | undefined): FocusTier {
  let rank = 0;
  for (const entry of Object.values(state?.sessions ?? {})) {
    rank = Math.max(rank, focusTierRank(entry.tier));
  }
  return FOCUS_TIERS[rank];
}

/** §7.2: a person's inbound message for the session runs iff tier(S) ≥ active level. */
export function focusAllows(state: FocusState | undefined, sessionKey: string): boolean {
  return (
    focusTierRank(sessionFocusTier(state, sessionKey)) >= focusTierRank(activeFocusLevel(state))
  );
}

/**
 * The focus that holds a message for `sessionKey`, or undefined when it runs
 * (§7.2: no focus anywhere, or the session's tier meets the active level).
 */
export function focusHolding(
  sessionKey: string | undefined,
  stateDir?: string,
): FocusState | undefined {
  const state = readFocusState(stateDir);
  if (!state || !sessionKey) {
    return undefined;
  }
  return focusAllows(state, sessionKey) ? undefined : state;
}

/** §2, §7.1: a cron run is refused as a target (it is not addressable by a person). */
export function validateFocusTarget(target: string): string | undefined {
  const trimmed = target.trim();
  if (!trimmed) {
    return "focus target is required";
  }
  if (isCronRunSessionKey(trimmed)) {
    return "a cron run session cannot be a focus target";
  }
  return undefined;
}

// Held prompts (§3.2, §5.4): the stack files kept on disk because focus holds their
// session. Only these are replayed (combined) when their session is allowed again;
// a file bound to a turn that is still running is never in here. Process-wide
// (bundled copies share it); after a restart the startup replay refills it with the
// files it skips.
const HELD_FILES = Symbol.for("openclaw.focusHeldFiles");

type HeldFiles = Map<string, Set<string>>;

function heldFiles(): HeldFiles {
  const store = globalThis as Record<PropertyKey, unknown>;
  let map = store[HELD_FILES] as HeldFiles | undefined;
  if (!map) {
    map = new Map();
    store[HELD_FILES] = map;
  }
  return map;
}

export function holdFocusFiles(sessionKey: string, files: string[]): void {
  if (files.length === 0) {
    return;
  }
  const map = heldFiles();
  const set = map.get(sessionKey) ?? new Set<string>();
  for (const file of files) {
    set.add(file);
  }
  map.set(sessionKey, set);
}

/**
 * Take the held files of the sessions `allow` accepts (all when omitted); those
 * sessions are no longer held afterwards, the others stay held.
 */
export function takeHeldFocusFiles(
  allow?: (sessionKey: string) => boolean,
): Map<string, Set<string>> {
  const map = heldFiles();
  const taken = new Map<string, Set<string>>();
  for (const [sessionKey, files] of map) {
    if (!allow || allow(sessionKey)) {
      taken.set(sessionKey, files);
    }
  }
  for (const sessionKey of taken.keys()) {
    map.delete(sessionKey);
  }
  return taken;
}

/** Session keys with held files right now (for status and tests). */
export function listHeldFocusSessions(): string[] {
  return [...heldFiles().keys()];
}

// Release (§7.3): the gateway registers the combined replay at start, so the chat
// command, the gateway method and the CLI all release sessions the same way. The
// replayer replays the held sessions `allow` accepts (§5.2-§5.3).
export type FocusReplayer = (allow: (sessionKey: string) => boolean) => {
  sessions: number;
  done: Promise<void>;
};

const FOCUS_REPLAYER = Symbol.for("openclaw.focusReplayer");

export function registerFocusReplayer(replayer: FocusReplayer | undefined): void {
  (globalThis as Record<PropertyKey, unknown>)[FOCUS_REPLAYER] = replayer;
}

export type FocusRelease = {
  /** Sessions whose waiting prompts are being replayed as one combined prompt each. */
  replaying: number;
  done: Promise<void>;
};

/**
 * §7.3: every held session that is allowed at the current level gets the §5
 * combined replay. Called after every change, once the new state is on disk (§5.1),
 * so it covers both a dropped active level and a tier that rose to meet it.
 */
export function releaseAllowedFocus(stateDir?: string): FocusRelease {
  const replayer = (globalThis as Record<PropertyKey, unknown>)[FOCUS_REPLAYER] as
    | FocusReplayer
    | undefined;
  if (!replayer) {
    return { replaying: 0, done: Promise.resolve() };
  }
  const state = readFocusState(stateDir);
  const { sessions, done } = replayer((sessionKey) => focusAllows(state, sessionKey));
  return { replaying: sessions, done };
}

/** Write the new sessions; sessions now allowed leave the notified list (§3.2). */
function saveSessions(
  sessions: Record<string, FocusSessionEntry>,
  previous: FocusState | undefined,
  stateDir?: string,
): void {
  const next: FocusState = { sessions };
  const notified = (previous?.notified ?? []).filter((key) => !focusAllows(next, key));
  if (notified.length > 0) {
    next.notified = notified;
  }
  writeFocusFile(next, stateDir);
}

export type SetSessionFocusResult = FocusRelease & {
  /** The new entry, or undefined when the tier was set to `none`. */
  entry: FocusSessionEntry | undefined;
  /** The entry the session held before, if any. */
  previous: FocusSessionEntry | undefined;
  /** The stored session key. */
  sessionKey: string;
};

/** §7.4 `/focus <key> [tier]`: set one session's tier (`none` clears it), then release (§7.3). */
export function setSessionFocus(params: {
  sessionKey: string;
  tier?: FocusTier;
  by: string;
  stateDir?: string;
  now?: number;
}): SetSessionFocusResult {
  const error = validateFocusTarget(params.sessionKey);
  if (error) {
    throw new Error(error);
  }
  const tier = params.tier ?? DEFAULT_FOCUS_TIER;
  if (!(FOCUS_TIERS as readonly string[]).includes(tier)) {
    throw new Error(`unknown focus tier: ${tier as string}`);
  }
  const sessionKey = params.sessionKey.trim();
  const state = readFocusState(params.stateDir);
  const existingKey = findSessionKey(state, sessionKey);
  const previous = existingKey && state ? state.sessions[existingKey] : undefined;
  const sessions = { ...state?.sessions };
  if (existingKey) {
    delete sessions[existingKey];
  }
  let entry: FocusSessionEntry | undefined;
  if (focusTierRank(tier) > 0) {
    entry = {
      tier,
      since: params.now ?? Date.now(),
      by: params.by.trim() || "unknown",
    };
    sessions[sessionKey] = entry;
  }
  saveSessions(sessions, state, params.stateDir);
  return { entry, previous, sessionKey, ...releaseAllowedFocus(params.stateDir) };
}

/** §7.4 `/focus off <key>`: that session back to `none`, then release (§7.3). */
export function clearSessionFocus(
  sessionKey: string,
  stateDir?: string,
): FocusRelease & { ended: FocusSessionEntry | undefined } {
  const state = readFocusState(stateDir);
  const existingKey = findSessionKey(state, sessionKey);
  if (!existingKey || !state) {
    return { ended: undefined, replaying: 0, done: Promise.resolve() };
  }
  const ended = state.sessions[existingKey];
  const sessions = { ...state.sessions };
  delete sessions[existingKey];
  saveSessions(sessions, state, stateDir);
  return { ended, ...releaseAllowedFocus(stateDir) };
}

/**
 * §7.4 `/focus off`: clear all focus. The state is cleared first (§5.1), so new
 * messages flow from that instant; then every waiting session is replayed (§7.3).
 */
export function clearAllFocus(
  stateDir?: string,
): FocusRelease & { ended: Record<string, FocusSessionEntry> } {
  const state = readFocusState(stateDir);
  writeFocusFile({ sessions: {} }, stateDir);
  return { ended: { ...state?.sessions }, ...releaseAllowedFocus(stateDir) };
}

/**
 * §3.2: record that a session got the busy notice this focus period. Returns true
 * when the notice should be sent now (first time), false when already sent or when
 * focus no longer holds the session.
 */
export function markFocusNotified(sessionKey: string, stateDir?: string): boolean {
  const state = readFocusState(stateDir);
  if (!state || focusAllows(state, sessionKey)) {
    return false;
  }
  const notified = state.notified ?? [];
  if (notified.some((key) => sameSessionKey(key, sessionKey))) {
    return false;
  }
  writeFocusFile({ ...state, notified: [...notified, sessionKey] }, stateDir);
  return true;
}

export const FOCUS_BUSY_NOTICE = "Busy right now, I'll reply later.";
export const FOCUS_COMBINED_HEADER = "These messages arrived while I was busy (oldest first):";

/**
 * True for the operator's focus command, `/focus` or its alias `/focusmode`
 * (§3.4, §7.2: always handled, normalized command text).
 */
export function isFocusCommandText(text: string | undefined): boolean {
  if (typeof text !== "string") {
    return false;
  }
  return /^\/focus(?:mode)?(?:\s|$)/i.test(text.trim());
}

export type FocusWaiting = { sessionKey: string; count: number };

/** Status (§7.4): per session that focus holds now, the inbound prompts waiting on disk. */
export function listFocusWaiting(stateDir?: string): FocusWaiting[] {
  const state = readFocusState(stateDir);
  if (!state) {
    return [];
  }
  return listStack(stateDir)
    .filter((session) => !focusAllows(state, session.sessionKey))
    .map((session) => ({
      sessionKey: session.sessionKey,
      count: session.entries.filter((entry) => entry.content.source === "inbound").length,
    }))
    .filter((session) => session.count > 0);
}

export type FocusSessionView = FocusSessionEntry & { sessionKey: string };

export type FocusStatus = {
  /** §7.2 active level (`none` when no focus). */
  active: FocusTier;
  /** Focused sessions, highest tier first, then oldest first. */
  sessions: FocusSessionView[];
  waiting: FocusWaiting[];
};

export function readFocusStatus(stateDir?: string): FocusStatus {
  const state = readFocusState(stateDir);
  const sessions = Object.entries(state?.sessions ?? {})
    .map(([sessionKey, entry]) => ({ sessionKey, ...entry }))
    .toSorted(
      (a, b) =>
        focusTierRank(b.tier) - focusTierRank(a.tier) ||
        a.since - b.since ||
        a.sessionKey.localeCompare(b.sessionKey),
    );
  return {
    active: activeFocusLevel(state),
    sessions,
    waiting: state ? listFocusWaiting(stateDir) : [],
  };
}

export function formatFocusStatusLines(status: FocusStatus): string[] {
  if (status.sessions.length === 0) {
    return ["Focus is off."];
  }
  const lines = [`Focus: active level ${status.active}`];
  for (const session of status.sessions) {
    lines.push(
      `  ${session.sessionKey}  ${session.tier}  since ${new Date(session.since).toISOString()} by ${session.by}`,
    );
  }
  if (status.waiting.length === 0) {
    lines.push("No messages waiting.");
  } else {
    lines.push("Waiting:");
    for (const entry of status.waiting) {
      lines.push(`  ${entry.sessionKey}  waiting=${entry.count}`);
    }
  }
  return lines;
}
