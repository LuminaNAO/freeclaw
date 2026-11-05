// `/focus` (docs/design/focus-mode.md §7.4), operator only (§4 authority: the
// existing command authorization plus owner status):
//   /focus                                   status
//   /focus here|<session key> [normal|hyper] set a tier (default normal)
//   /focus off here|<session key>            that session back to none
//   /focus off                               clear all focus
// `/focusmode` is the old name, kept as a hidden alias for one release: it does the
// same and names `/focus` in its reply.
import { logVerbose } from "../../globals.js";
import {
  formatFocusReportLines,
  parseFocusCommandArgs,
  runFocusOp,
} from "../../infra/focus-mode-actions.js";
import { rejectNonOwnerCommand, rejectUnauthorizedCommand } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";

const COMMAND_RE = /^\/(focus|focusmode)(?:\s+([\s\S]*))?$/i;

export const FOCUSMODE_RENAMED_NOTICE = "Note: /focusmode is now /focus.";

export const handleFocusCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const match = COMMAND_RE.exec(params.command.commandBodyNormalized.trim());
  if (!match) {
    return null;
  }
  const label = `/${match[1].toLowerCase()}`;
  const unauthorized =
    rejectUnauthorizedCommand(params, label) ?? rejectNonOwnerCommand(params, label);
  if (unauthorized) {
    return unauthorized;
  }
  const lines: string[] = [];
  try {
    const request = parseFocusCommandArgs(match[2] ?? "", params.sessionKey ?? "");
    const by = params.command.senderId?.trim() || params.command.channel || "operator";
    const { report } = runFocusOp({ cfg: params.cfg, request, by });
    lines.push(...formatFocusReportLines(report));
  } catch (err) {
    logVerbose(`${label} failed: ${String(err)}`);
    lines.push(`⚠️ /focus: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (label === "/focusmode") {
    lines.push(FOCUSMODE_RENAMED_NOTICE);
  }
  return { shouldContinue: false, reply: { text: lines.join("\n") } };
};
