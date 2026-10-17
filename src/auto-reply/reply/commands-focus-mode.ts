// `/focusmode <session-key|here>`, `/focusmode off`, `/focusmode` (docs/design/focus-mode.md §4).
// Distinct from `/focus` (Discord/Telegram thread binding), which is unchanged.
// Operator authority only: the existing command authorization plus owner status.
import { logVerbose } from "../../globals.js";
import { runFocusAction } from "../../infra/focus-mode-actions.js";
import { formatFocusStatusLines } from "../../infra/focus-mode.js";
import { rejectNonOwnerCommand, rejectUnauthorizedCommand } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";

const COMMAND_RE = /^\/focusmode(?:\s+([\s\S]*))?$/i;

export const handleFocusModeCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const match = COMMAND_RE.exec(params.command.commandBodyNormalized.trim());
  if (!match) {
    return null;
  }
  const unauthorized =
    rejectUnauthorizedCommand(params, "/focusmode") ?? rejectNonOwnerCommand(params, "/focusmode");
  if (unauthorized) {
    return unauthorized;
  }
  const arg = (match[1] ?? "").trim();
  const by = params.command.senderId?.trim() || params.command.channel || "operator";
  try {
    if (!arg) {
      const result = runFocusAction({ cfg: params.cfg, action: "status", by });
      if (result.action !== "status") {
        return null;
      }
      return {
        shouldContinue: false,
        reply: { text: formatFocusStatusLines(result.status).join("\n") },
      };
    }
    if (arg.toLowerCase() === "off") {
      const result = runFocusAction({ cfg: params.cfg, action: "off", by });
      if (result.action !== "off") {
        return null;
      }
      if (!result.ended) {
        return { shouldContinue: false, reply: { text: "Focus mode is already off." } };
      }
      return {
        shouldContinue: false,
        reply: {
          text:
            result.replaying > 0
              ? `Focus mode off. Replaying waiting messages for ${result.replaying} session(s).`
              : "Focus mode off. No messages were waiting.",
        },
      };
    }
    const target = arg.toLowerCase() === "here" ? params.sessionKey : arg;
    const result = runFocusAction({ cfg: params.cfg, action: "set", target, by });
    if (result.action !== "set") {
      return null;
    }
    return {
      shouldContinue: false,
      reply: { text: `Focus mode on ${result.focus.target}. Other sessions' messages wait.` },
    };
  } catch (err) {
    logVerbose(`/focusmode failed: ${String(err)}`);
    return {
      shouldContinue: false,
      reply: { text: `⚠️ /focusmode: ${err instanceof Error ? err.message : String(err)}` },
    };
  }
};
