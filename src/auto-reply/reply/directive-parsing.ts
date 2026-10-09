import { CURRENT_MESSAGE_MARKER } from "./mentions.js";

export function skipDirectiveArgPrefix(raw: string): number {
  let i = 0;
  const len = raw.length;
  while (i < len && /\s/.test(raw[i])) {
    i += 1;
  }
  if (raw[i] === ":") {
    i += 1;
    while (i < len && /\s/.test(raw[i])) {
      i += 1;
    }
  }
  return i;
}

export function takeDirectiveToken(
  raw: string,
  startIndex: number,
): { token: string | null; nextIndex: number } {
  let i = startIndex;
  const len = raw.length;
  while (i < len && /\s/.test(raw[i])) {
    i += 1;
  }
  if (i >= len) {
    return { token: null, nextIndex: i };
  }
  const start = i;
  while (i < len && !/\s/.test(raw[i])) {
    i += 1;
  }
  if (start === i) {
    return { token: null, nextIndex: i };
  }
  const token = raw.slice(start, i);
  while (i < len && /\s/.test(raw[i])) {
    i += 1;
  }
  return { token, nextIndex: i };
}

export type LeadingCommandPrefixOptions = {
  /** Skip single-line bracketed envelope groups such as an injected `[Wed 2026-10-07 18:18 GMT+8]`. */
  skipEnvelope?: boolean;
  /**
   * Skip one `Name: ` sender label, but only when a `/` follows it. Use this only on prompt
   * bodies whose clean command text is already known to start with `/`.
   */
  skipSenderLabel?: boolean;
  /** Leading tokens that are not content (e.g. group mentions of the bot). */
  isIgnorableToken?: (token: string) => boolean;
};

const SENDER_LABEL_RE = /^[A-Za-z0-9+()\-_. ]+:[^\S\n]+(?=\/)/;

/**
 * Split `body` into a non-content prefix (`head`) and the text starting at the first
 * meaningful token (`rest`).
 *
 * Only a message whose first non-whitespace character is `/` is a command or directive
 * message (docs/design/no-embedded-slash-commands.md §2.1). Callers test `rest.startsWith("/")`.
 * When `body` is a history wrapper, only the part after the current-message marker counts;
 * the history context is always part of `head`.
 */
export function splitLeadingCommandPrefix(
  body: string,
  options?: LeadingCommandPrefixOptions,
): { head: string; rest: string } {
  const markerIndex = body.indexOf(CURRENT_MESSAGE_MARKER);
  const len = body.length;
  let i = markerIndex < 0 ? 0 : markerIndex + CURRENT_MESSAGE_MARKER.length;
  const skipWhitespace = () => {
    while (i < len && /\s/.test(body[i])) {
      i += 1;
    }
  };
  skipWhitespace();
  if (options?.skipEnvelope) {
    while (i < len && body[i] === "[") {
      const close = body.indexOf("]", i + 1);
      if (close < 0 || body.slice(i + 1, close).includes("\n")) {
        break;
      }
      i = close + 1;
      skipWhitespace();
    }
  }
  if (options?.skipSenderLabel && body[i] !== "/") {
    const label = body.slice(i).match(SENDER_LABEL_RE);
    if (label) {
      i += label[0].length;
    }
  }
  const isIgnorableToken = options?.isIgnorableToken;
  if (isIgnorableToken) {
    // A mention may span a few words; try short token runs from the current position.
    const maxTokens = 4;
    let progressed = true;
    while (progressed && i < len && body[i] !== "/") {
      progressed = false;
      let j = i;
      for (let count = 0; count < maxTokens && j < len; count += 1) {
        while (j < len && !/\s/.test(body[j])) {
          j += 1;
        }
        if (isIgnorableToken(body.slice(i, j))) {
          i = j;
          skipWhitespace();
          progressed = true;
          break;
        }
        while (j < len && /\s/.test(body[j])) {
          j += 1;
        }
      }
    }
  }
  return { head: body.slice(0, i), rest: body.slice(i) };
}
