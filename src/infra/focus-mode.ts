// Focus mode state (docs/design/focus-mode.md §2).
// One gateway-wide value in <stateDir>/focus.json (0600, temp file + rename), or none.
// No timeout, no timer: focus lasts until cleared.
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { isCronRunSessionKey } from "../sessions/session-key-utils.js";
import { listStack } from "./session-stack.js";

export type FocusState = {
  /** The one session that runs while focused. */
  target: string;
  /** Epoch ms when focus was set. */
  since: number;
  /** Who set it (operator sender id, client id or "cli"). */
  by: string;
  /**
   * Sessions already sent the busy notice this focus period (§3.2). Kept on disk
   * so a restart during focus does not send a second notice.
   */
  notified?: string[];
};

export function resolveFocusFile(stateDir: string = resolveStateDir()): string {
  return path.join(stateDir, "focus.json");
}

function isFocusState(value: unknown): value is FocusState {
  const v = value as Partial<FocusState> | null;
  return (
    !!v &&
    typeof v === "object" &&
    typeof v.target === "string" &&
    v.target.trim().length > 0 &&
    typeof v.since === "number" &&
    typeof v.by === "string"
  );
}

/** The current focus, or undefined when none (missing or unreadable file = no focus). */
export function readFocusState(stateDir?: string): FocusState | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(resolveFocusFile(stateDir), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isFocusState(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeFocusFile(state: FocusState, stateDir?: string): void {
  const file = resolveFocusFile(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(file), `.focus.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** §2: a cron run is refused as a target (it is not addressable by a person). */
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

export function setFocusState(params: {
  target: string;
  by: string;
  stateDir?: string;
  now?: number;
}): FocusState {
  const error = validateFocusTarget(params.target);
  if (error) {
    throw new Error(error);
  }
  const state: FocusState = {
    target: params.target.trim(),
    since: params.now ?? Date.now(),
    by: params.by.trim() || "unknown",
  };
  writeFocusFile(state, params.stateDir);
  return state;
}

/** §5.1: clear the state. Returns the focus that was on, if any. */
export function clearFocusState(stateDir?: string): FocusState | undefined {
  const previous = readFocusState(stateDir);
  try {
    fs.unlinkSync(resolveFocusFile(stateDir));
  } catch {
    // Already none.
  }
  return previous;
}

/**
 * §3.2: record that a session got the busy notice this focus period. Returns true
 * when the notice should be sent now (first time), false when already sent or when
 * focus is no longer on.
 */
export function markFocusNotified(sessionKey: string, stateDir?: string): boolean {
  const state = readFocusState(stateDir);
  if (!state) {
    return false;
  }
  const notified = state.notified ?? [];
  if (notified.includes(sessionKey)) {
    return false;
  }
  writeFocusFile({ ...state, notified: [...notified, sessionKey] }, stateDir);
  return true;
}

/**
 * The focus that holds a message for `sessionKey`, or undefined when it runs
 * (§3.1: no focus, or the key equals the target).
 */
export function focusHolding(
  sessionKey: string | undefined,
  stateDir?: string,
): FocusState | undefined {
  const state = readFocusState(stateDir);
  if (!state || !sessionKey) {
    return undefined;
  }
  return sameSessionKey(sessionKey, state.target) ? undefined : state;
}

export function sameSessionKey(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export const FOCUS_BUSY_NOTICE = "Busy right now, I'll reply later.";
export const FOCUS_COMBINED_HEADER = "These messages arrived while I was busy (oldest first):";

/** True for a `/focusmode` command (§3.4 escape hatch detection, normalized command text). */
export function isFocusModeCommandText(text: string | undefined): boolean {
  if (typeof text !== "string") {
    return false;
  }
  return /^\/focusmode(?:\s|$)/i.test(text.trim());
}

// Held prompts (§3.2, §5.4): the stack files kept on disk because focus is on.
// Only these are replayed (combined) when focus ends; a file bound to a turn that
// is still running is never in here. Process-wide (bundled copies share it); after
// a restart the startup replay refills it with the files it skips.
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

/** Take every held file (the held set is empty afterwards). */
export function takeHeldFocusFiles(): Map<string, Set<string>> {
  const map = heldFiles();
  const taken = new Map(map);
  map.clear();
  return taken;
}

// End of focus (§5): the gateway registers the combined replay at start, so the
// chat command, the gateway method and the agent tool all end focus the same way.
export type FocusReplayer = () => { sessions: number; done: Promise<void> };

const FOCUS_REPLAYER = Symbol.for("openclaw.focusReplayer");

export function registerFocusReplayer(replayer: FocusReplayer | undefined): void {
  (globalThis as Record<PropertyKey, unknown>)[FOCUS_REPLAYER] = replayer;
}

export type EndFocusResult = {
  ended: FocusState | undefined;
  /** Sessions whose waiting prompts are being replayed as one combined prompt each. */
  replaying: number;
  done: Promise<void>;
};

/** §5.1-§5.2: clear the state first, then replay each session's waiting prompts combined. */
export function endFocusMode(stateDir?: string): EndFocusResult {
  const ended = clearFocusState(stateDir);
  const replayer = (globalThis as Record<PropertyKey, unknown>)[FOCUS_REPLAYER] as
    | FocusReplayer
    | undefined;
  if (!replayer) {
    return { ended, replaying: 0, done: Promise.resolve() };
  }
  const { sessions, done } = replayer();
  return { ended, replaying: sessions, done };
}

export type FocusWaiting = { sessionKey: string; count: number };

/** §4 status: per session (other than the target), the inbound prompts waiting on disk. */
export function listFocusWaiting(target: string | undefined, stateDir?: string): FocusWaiting[] {
  return listStack(stateDir)
    .filter((session) => !target || !sameSessionKey(session.sessionKey, target))
    .map((session) => ({
      sessionKey: session.sessionKey,
      count: session.entries.filter((entry) => entry.content.source === "inbound").length,
    }))
    .filter((session) => session.count > 0);
}

export type FocusStatus = {
  focus: FocusState | undefined;
  waiting: FocusWaiting[];
};

export function readFocusStatus(stateDir?: string): FocusStatus {
  const focus = readFocusState(stateDir);
  return { focus, waiting: focus ? listFocusWaiting(focus.target, stateDir) : [] };
}

export function formatFocusStatusLines(status: FocusStatus): string[] {
  const { focus, waiting } = status;
  if (!focus) {
    return ["Focus mode is off."];
  }
  const lines = [
    `Focus mode: on ${focus.target}`,
    `since ${new Date(focus.since).toISOString()} by ${focus.by}`,
  ];
  if (waiting.length === 0) {
    lines.push("No messages waiting.");
  } else {
    lines.push("Waiting:");
    for (const entry of waiting) {
      lines.push(`  ${entry.sessionKey}  waiting=${entry.count}`);
    }
  }
  return lines;
}
