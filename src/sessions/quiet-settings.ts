import { loadSessionStore, updateSessionStore } from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";

/**
 * Quiet sessions ARCH §3: two optional, operator-only per-session settings.
 * - `errorReplies: false`: a failed turn posts nothing to the chat.
 * - `slashCommands: false`: inbound `/...` text is ordinary text, except an operator's `/session`.
 * Stored on the session entry like other overrides; unset means today's behaviour.
 */
export type QuietSessionSettings = {
  errorReplies: boolean;
  slashCommands: boolean;
};

/** A requested change: `false` turns the quiet behaviour on, `true` clears it, absent keeps it. */
export type QuietSessionPatch = {
  errorReplies?: boolean;
  slashCommands?: boolean;
};

export function resolveQuietSessionSettings(
  entry: Pick<SessionEntry, "errorReplies" | "slashCommands"> | undefined,
): QuietSessionSettings {
  return {
    errorReplies: entry?.errorReplies !== false,
    slashCommands: entry?.slashCommands !== false,
  };
}

export function isErrorRepliesDisabled(entry: Pick<SessionEntry, "errorReplies"> | undefined) {
  return entry?.errorReplies === false;
}

export function isSlashCommandsDisabled(entry: Pick<SessionEntry, "slashCommands"> | undefined) {
  return entry?.slashCommands === false;
}

/** Apply a patch in place. `false` stores the setting, `true` deletes it (back to unset). */
export function applyQuietSessionPatch(entry: SessionEntry, patch: QuietSessionPatch): void {
  if (patch.errorReplies === false) {
    entry.errorReplies = false;
  } else if (patch.errorReplies === true) {
    delete entry.errorReplies;
    delete entry.lastSuppressedError;
  }
  if (patch.slashCommands === false) {
    entry.slashCommands = false;
  } else if (patch.slashCommands === true) {
    delete entry.slashCommands;
  }
}

/** Carry the quiet settings across a session reset (they are overrides, not per-run state). */
export function pickQuietSessionSettings(
  entry: SessionEntry | undefined,
): Pick<SessionEntry, "errorReplies" | "slashCommands"> {
  return {
    ...(entry?.errorReplies === false ? { errorReplies: false as const } : {}),
    ...(entry?.slashCommands === false ? { slashCommands: false as const } : {}),
  };
}

export function formatQuietSessionSettings(entry: SessionEntry | undefined): string[] {
  const settings = resolveQuietSessionSettings(entry);
  return [
    `errorReplies: ${settings.errorReplies ? "on (default)" : "off"}`,
    `slashCommands: ${settings.slashCommands ? "on (default)" : "off"}`,
  ];
}

const SUPPRESSED_ERROR_MAX_CHARS = 500;

/**
 * Quiet sessions ARCH §3.1: record an error that `errorReplies: false` kept out of the chat, so it
 * stays visible in `openclaw status`. Best effort; never throws.
 */
export async function recordSuppressedSessionError(params: {
  storePath?: string;
  sessionKey?: string;
  text: string;
  now?: number;
}): Promise<void> {
  const { storePath, sessionKey } = params;
  if (!storePath || !sessionKey) {
    return;
  }
  const text = params.text.trim().slice(0, SUPPRESSED_ERROR_MAX_CHARS);
  try {
    await updateSessionStore(storePath, (store) => {
      const entry = store[sessionKey];
      if (!entry) {
        return;
      }
      entry.lastSuppressedError = { at: params.now ?? Date.now(), text };
    });
  } catch {
    // Logging already happened; status visibility is best effort.
  }
}

export type SetQuietSessionResult =
  | { ok: true; key: string; entry: SessionEntry; changed: boolean }
  | { ok: false; error: string };

/**
 * Quiet sessions ARCH §3.1: the single writer behind the CLI (`openclaw sessions set`), the gateway
 * method (`sessions.setQuiet`) and the operator-only `/session` command. Only touches an existing
 * session entry.
 */
export async function setQuietSessionSettings(params: {
  storePath: string;
  /** Store keys to try, canonical first. */
  storeKeys: readonly string[];
  patch: QuietSessionPatch;
}): Promise<SetQuietSessionResult> {
  if (params.patch.errorReplies === undefined && params.patch.slashCommands === undefined) {
    return { ok: false, error: "nothing to set (errorReplies and/or slashCommands)" };
  }
  const existing = loadSessionStore(params.storePath, { skipCache: true });
  if (!params.storeKeys.some((candidate) => Boolean(existing[candidate]))) {
    // Never create or rewrite the store for an unknown session.
    return { ok: false, error: `session not found: ${params.storeKeys[0] ?? ""}` };
  }
  return await updateSessionStore(params.storePath, (store) => {
    const key = params.storeKeys.find((candidate) => Boolean(store[candidate]));
    if (!key) {
      return { ok: false as const, error: `session not found: ${params.storeKeys[0] ?? ""}` };
    }
    const entry = store[key];
    const before = JSON.stringify(pickQuietSessionSettings(entry));
    applyQuietSessionPatch(entry, params.patch);
    const changed = JSON.stringify(pickQuietSessionSettings(entry)) !== before;
    if (changed) {
      entry.updatedAt = Math.max(entry.updatedAt ?? 0, Date.now());
    }
    return { ok: true as const, key, entry: { ...entry }, changed };
  });
}
