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
 * "none": every mention of the token is omitted for this surface.
 *
 * Local models tend to bundle NO_REPLY with real text in group chats; where the
 * operator disallows silent replies, the safest fix is to never teach the token.
 */
export type SilentReplyPromptMode = "generic" | "none";

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
