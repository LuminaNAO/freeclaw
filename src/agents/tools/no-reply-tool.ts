import { Type } from "@sinclair/typebox";
import {
  HEARTBEAT_PROMPT_ACK_SENTENCE,
  HEARTBEAT_PROMPT_ACK_TOOL_SENTENCE,
} from "../../auto-reply/heartbeat.js";
import {
  buildGroupSilenceLine,
  GROUP_SILENCE_TOOL_LINE,
} from "../../auto-reply/silent-reply-wording.js";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveAgentSilentReplyMode,
  type SilentReplyPromptMode,
} from "../../config/silent-reply.js";
import { isSubagentSessionKey } from "../../sessions/session-key-utils.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

// no-reply-tool §3: silence is a tool call, not a text token.
export const NO_REPLY_TOOL_NAME = "no_reply";
export const NO_REPLY_REASON_MAX_CHARS = 200;
export const NO_REPLY_TOOL_DESCRIPTION =
  "Stay silent: end this turn without sending a reply. Call it alone, as the first and only thing you do, when you have nothing to add. Anything you already sent with the message tool still goes out.";

const NoReplyToolSchema = Type.Object({
  reason: Type.Optional(
    Type.String({
      description: `Why you are staying silent (max ${NO_REPLY_REASON_MAX_CHARS} chars). Logged and kept in the transcript, never sent.`,
    }),
  ),
});

export function createNoReplyTool(opts: {
  /** Called when the model chose silence; the runner ends the run after the tool results. */
  onNoReply: (reason: string | undefined) => void;
}): AnyAgentTool {
  return {
    label: "No reply",
    name: NO_REPLY_TOOL_NAME,
    description: NO_REPLY_TOOL_DESCRIPTION,
    parameters: NoReplyToolSchema,
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const reason = readStringParam(params, "reason")?.slice(0, NO_REPLY_REASON_MAX_CHARS);
      opts.onNoReply(reason || undefined);
      return jsonResult({ status: "silent" });
    },
  };
}

/** True when an assistant message contains a `no_reply` tool call. */
export function hasNoReplyToolCall(message: unknown): boolean {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some(
    (block) =>
      Boolean(block) &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "toolCall" &&
      typeof (block as { name?: unknown }).name === "string" &&
      (block as { name: string }).name.trim().toLowerCase() === NO_REPLY_TOOL_NAME,
  );
}

/**
 * no-reply-tool §5: whether a run is offered the `no_reply` tool.
 * Only runs with a reply target, on surfaces that allow silence, with a tool-capable model, in "tool" mode.
 */
export function shouldOfferNoReplyTool(params: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  /** Run has a reply target: inbound channel message, heartbeat, cron with delivery (§5.1). */
  hasReplyTarget?: boolean;
  /** Surface silent-reply prompt mode; "none" = the surface disallows silence (§5.2). */
  surfaceMode: SilentReplyPromptMode;
  /** `supportsModelTools(model)` (§5.3). */
  modelSupportsTools: boolean;
  toolsDisabled?: boolean;
}): boolean {
  if (params.hasReplyTarget !== true) {
    return false;
  }
  if (isSubagentSessionKey(params.sessionKey)) {
    return false;
  }
  if (params.surfaceMode === "none") {
    return false;
  }
  if (!params.modelSupportsTools || params.toolsDisabled) {
    return false;
  }
  return resolveAgentSilentReplyMode({ cfg: params.config, agentId: params.agentId }) === "tool";
}

/**
 * no-reply-tool §6: in tool mode, the other places that teach the token (group intro, default heartbeat
 * prompt) teach the tool instead. Only the exact built-in sentences are rewritten; custom text is left alone.
 */
export function applyNoReplyToolWording(text: string): string;
export function applyNoReplyToolWording(text: string | undefined): string | undefined;
export function applyNoReplyToolWording(text: string | undefined): string | undefined {
  if (!text) {
    return text;
  }
  return text
    .split(buildGroupSilenceLine(SILENT_REPLY_TOKEN))
    .join(GROUP_SILENCE_TOOL_LINE)
    .split(HEARTBEAT_PROMPT_ACK_SENTENCE)
    .join(HEARTBEAT_PROMPT_ACK_TOOL_SENTENCE);
}
