import { normalizeAgentId } from "../routing/session-key.js";
import type { OpenClawConfig } from "./types.openclaw.js";

/** Whether the model may answer with the silent token (NO_REPLY) on a surface. */
export type SilentReplyPolicy = "allow" | "disallow";

export type SurfaceSilentReplyConfig = {
  group?: SilentReplyPolicy;
  direct?: SilentReplyPolicy;
};

/** Per-channel surface policies, keyed by channel id (e.g. "signal"). */
export type SurfacesConfig = Record<string, { silentReply?: SurfaceSilentReplyConfig }>;

/**
 * "generic": the system prompt teaches the model NO_REPLY.
 * "tool": the system prompt teaches the `no_reply` tool (no-reply-tool §6); the token is not taught.
 * "none": every mention of the token is omitted for this surface.
 *
 * Local models tend to bundle NO_REPLY with real text in group chats; where the
 * operator disallows silent replies, the safest fix is to never teach the token.
 */
export type SilentReplyPromptMode = "generic" | "tool" | "none";

export function resolveSilentReplyPromptMode(params: {
  cfg?: OpenClawConfig;
  channel?: string | null;
  chatType?: string | null;
}): SilentReplyPromptMode {
  const channel = params.channel?.trim().toLowerCase();
  if (!channel) {
    return "generic";
  }
  const surface = params.cfg?.surfaces?.[channel]?.silentReply;
  if (!surface) {
    return "generic";
  }
  const policy = params.chatType === "group" ? surface.group : surface.direct;
  return policy === "disallow" ? "none" : "generic";
}

/** How an agent stays silent (no-reply-tool §5.4): "tool" (default) or "token". */
export type AgentSilentReplyMode = "tool" | "token";

/** `agents.list[].silentReply` overrides `agents.defaults.silentReply`; default "tool". */
export function resolveAgentSilentReplyMode(params: {
  cfg?: OpenClawConfig;
  agentId?: string | null;
}): AgentSilentReplyMode {
  const agentId = params.agentId ? normalizeAgentId(params.agentId) : undefined;
  const list = params.cfg?.agents?.list;
  const entry =
    agentId && Array.isArray(list)
      ? list.find(
          (candidate) =>
            candidate &&
            typeof candidate === "object" &&
            normalizeAgentId(candidate.id) === agentId,
        )
      : undefined;
  const mode = entry?.silentReply ?? params.cfg?.agents?.defaults?.silentReply;
  return mode === "token" ? "token" : "tool";
}
