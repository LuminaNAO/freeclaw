import {
  type LeadingCommandPrefixOptions,
  splitLeadingCommandPrefix,
} from "./directive-parsing.js";
import { collapseInlineHorizontalWhitespace } from "./reply-inline-whitespace.js";

const LEADING_SIMPLE_COMMAND_ALIASES = new Map<string, string>([
  ["/help", "/help"],
  ["/commands", "/commands"],
  ["/whoami", "/whoami"],
  ["/id", "/whoami"],
]);
// Anchored: only a message that starts with the command qualifies
// (docs/design/no-embedded-slash-commands.md §2.1-§2.3).
const LEADING_SIMPLE_COMMAND_RE = /^\/(help|commands|whoami|id)(?=$|\s|:)(?:\s*:)?/i;

/**
 * Detect `/help`, `/commands`, `/whoami` or `/id` at the start of a message.
 * A message that does not start with `/` never matches; `/word` tokens later in the
 * message are plain text and are left untouched.
 */
export function extractLeadingSimpleCommand(
  body?: string,
  options?: LeadingCommandPrefixOptions,
): {
  command: string;
  cleaned: string;
} | null {
  if (!body) {
    return null;
  }
  const { head, rest } = splitLeadingCommandPrefix(body, { skipEnvelope: true, ...options });
  const match = rest.match(LEADING_SIMPLE_COMMAND_RE);
  if (!match) {
    return null;
  }
  const command = LEADING_SIMPLE_COMMAND_ALIASES.get(`/${match[1].toLowerCase()}`);
  if (!command) {
    return null;
  }
  const remainder = rest.slice(match[0].length);
  const cleaned = collapseInlineHorizontalWhitespace(`${head} ${remainder}`).trim();
  const hasContent = remainder.trim().length > 0;
  return { command, cleaned: hasContent ? cleaned : "" };
}
