import type { OpenClawConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveSessionStoreEntry,
  resolveStorePath,
} from "../config/sessions.js";
import { isSubagentSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import { SESSION_LABEL_MAX_LENGTH } from "../sessions/session-label.js";

export const SUBAGENT_SLUG_MAX_WORDS = 6;
export const SUBAGENT_SLUG_MAX_CHARS = 40;
export const SUBAGENT_REQUESTER_NAME_MAX_CHARS = 24;
export const SUBAGENT_DISPLAY_NAME_SEPARATOR = " › ";
const SUBAGENT_SLUG_FALLBACK = "subagent";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const WORD_RE = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

function isIdLikeWord(word: string): boolean {
  if (/^\d{5,}$/.test(word)) {
    return true;
  }
  if (word.length >= 8 && /^[0-9a-f]+$/.test(word) && /\d/.test(word)) {
    return true;
  }
  // Mixed letters and digits of any real length are tokens, keys or ids.
  return word.length >= 8 && /\d/.test(word) && /[a-z]/.test(word);
}

function isNonWordToken(token: string): boolean {
  return (
    token.includes("://") ||
    token.startsWith("www.") ||
    token.includes("/") ||
    // session keys and other colon-joined ids (agent:main:subagent:)
    token.includes(":") ||
    token.includes("\\") ||
    token.includes("@") ||
    token.startsWith("~") ||
    // file names and host names (foo.ts, example.com)
    /[\p{L}\p{N}]\.[\p{L}\p{N}]/u.test(token)
  );
}

/**
 * Short slug for a spawned session, taken from the first non-empty line of the
 * task: lowercase words joined by "-", at most 6 words / 40 chars, never a
 * path, URL, e-mail address or id.
 */
export function slugifySubagentTask(task: string | undefined): string {
  const firstLine =
    (task ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  const words: string[] = [];
  let length = 0;
  for (const rawToken of firstLine.replace(UUID_RE, " ").split(/\s+/)) {
    const token = rawToken.toLowerCase().replace(/[.,;:!?)\]}>"'`]+$/u, "");
    if (!token || isNonWordToken(token)) {
      continue;
    }
    for (const word of token.match(WORD_RE) ?? []) {
      if (isIdLikeWord(word)) {
        continue;
      }
      const nextLength = length + (words.length > 0 ? 1 : 0) + word.length;
      if (words.length >= SUBAGENT_SLUG_MAX_WORDS || nextLength > SUBAGENT_SLUG_MAX_CHARS) {
        if (words.length === 0) {
          words.push(word.slice(0, SUBAGENT_SLUG_MAX_CHARS));
        }
        return words.join("-");
      }
      words.push(word);
      length = nextLength;
    }
  }
  return words.length > 0 ? words.join("-") : SUBAGENT_SLUG_FALLBACK;
}

function trimName(value: string, max: number): string {
  const chars = Array.from(value.replace(/\s+/g, " ").trim());
  if (chars.length <= max) {
    return chars.join("");
  }
  return `${chars
    .slice(0, max - 1)
    .join("")
    .trimEnd()}…`;
}

export function resolveSubagentLabel(params: { label?: string; task?: string }): string {
  const explicit = params.label?.trim();
  if (explicit) {
    return Array.from(explicit).slice(0, SESSION_LABEL_MAX_LENGTH).join("");
  }
  return slugifySubagentTask(params.task);
}

type RequesterNameEntry = { displayName?: string; subject?: string; label?: string } | undefined;

function readRequesterEntry(params: {
  cfg: OpenClawConfig;
  requesterSessionKey: string;
}): RequesterNameEntry {
  try {
    const agentId = parseAgentSessionKey(params.requesterSessionKey)?.agentId;
    const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
    return resolveSessionStoreEntry({
      store: loadSessionStore(storePath),
      sessionKey: params.requesterSessionKey,
    }).existing;
  } catch {
    return undefined;
  }
}

/**
 * `<requester short name> › <label>`. The requester name is its own
 * displayName/subject trimmed to 24 chars; a subagent requester contributes its
 * own label instead, so nested names chain once.
 */
export function buildSubagentDisplayName(params: {
  cfg: OpenClawConfig;
  requesterSessionKey: string;
  label: string;
}): string {
  const entry = readRequesterEntry(params);
  const requesterName = isSubagentSessionKey(params.requesterSessionKey)
    ? entry?.label?.trim()
    : entry?.displayName?.trim() || entry?.subject?.trim();
  if (!requesterName) {
    return params.label;
  }
  return `${trimName(requesterName, SUBAGENT_REQUESTER_NAME_MAX_CHARS)}${SUBAGENT_DISPLAY_NAME_SEPARATOR}${params.label}`;
}
