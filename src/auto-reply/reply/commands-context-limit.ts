import { logVerbose } from "../../globals.js";
import {
  formatSessionContextLimitLines,
  resolveSessionContextWindowSummary,
} from "../../sessions/context-limit-summary.js";
import {
  applyContextLimitToEntry,
  CONTEXT_LIMIT_CLEAR_WORD,
  parseContextLimitValue,
} from "../../sessions/context-limit.js";
import { formatTokenCount } from "../../utils/usage-format.js";
import type { ReplyPayload } from "../types.js";
import { persistSessionEntry } from "./commands-session-store.js";
import type { HandleCommandsParams } from "./commands-types.js";

export const CONTEXT_LIMIT_SUBCOMMAND = "limit";

const CONTEXT_LIMIT_USAGE = `Usage: /context limit [<tokens>|${CONTEXT_LIMIT_CLEAR_WORD}] (example: /context limit 256k)`;

/**
 * Session context limit ARCH §2.1: `/context limit` shows the limit and the effective window with
 * its source; `/context limit <n>|default` sets or clears it for this chat. Operator (owner)
 * senders only; others get a one-line refusal. Validation is shared with `sessions.patch` and the
 * `session_status` tool.
 */
export async function handleContextLimitCommand(
  params: HandleCommandsParams,
  args: string[],
): Promise<ReplyPayload> {
  if (!params.command.senderIsOwner) {
    logVerbose(
      `Ignoring /context limit from non-operator sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { text: "⚠️ Only an operator can change this chat's context limit." };
  }
  const entry = params.sessionEntry;
  if (!entry || !params.sessionKey) {
    return { text: "⚠️ No session to configure here." };
  }
  const describe = () =>
    formatSessionContextLimitLines(
      resolveSessionContextWindowSummary({
        cfg: params.cfg,
        provider: params.provider,
        model: params.model,
        entry,
      }),
    );
  if (args.length === 0) {
    return { text: [`Session ${params.sessionKey}`, ...describe()].join("\n") };
  }
  if (args.length > 1) {
    return { text: CONTEXT_LIMIT_USAGE };
  }
  const parsed = parseContextLimitValue(args[0]);
  if (!parsed.ok) {
    return { text: `⚠️ ${parsed.error}\n${CONTEXT_LIMIT_USAGE}` };
  }
  applyContextLimitToEntry(entry, parsed.value);
  await persistSessionEntry(params);
  const headline =
    parsed.value === null
      ? "✅ Context limit cleared"
      : `✅ Context limit set to ${formatTokenCount(parsed.value)} (${parsed.value} tokens)`;
  return {
    text: [`${headline}; applies from the next turn.`, ...describe()].join("\n"),
  };
}
