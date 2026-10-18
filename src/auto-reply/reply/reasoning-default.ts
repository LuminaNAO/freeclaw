import { resolveAgentConfig } from "../../agents/agent-scope.js";
import { normalizeChatChannelId } from "../../channels/registry.js";
import type { OpenClawConfig } from "../../config/config.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import type { ReasoningLevel } from "../thinking.js";

/**
 * Channel plugins bundled with the repo. Listed so a channel inbound is still recognised when the
 * plugin registry is not loaded (tests, early startup). Registered plugins are always honoured too.
 */
const BUNDLED_PLUGIN_CHANNEL_IDS = new Set<string>([
  "bluebubbles",
  "feishu",
  "matrix",
  "mattermost",
  "msteams",
  "nextcloud-talk",
  "nostr",
  "synology-chat",
  "tlon",
  "twitch",
  "zalo",
  "zalouser",
]);

function isMessagingChannelId(raw: unknown): boolean {
  if (typeof raw !== "string") {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  if (!normalized || normalized === INTERNAL_MESSAGE_CHANNEL) {
    return false;
  }
  if (normalizeChatChannelId(normalized)) {
    return true;
  }
  if (BUNDLED_PLUGIN_CHANNEL_IDS.has(normalized)) {
    return true;
  }
  const registry = getActivePluginRegistry();
  return Boolean(
    registry?.channels.some(
      (entry) =>
        entry.plugin.id.toLowerCase() === normalized ||
        (entry.plugin.meta.aliases ?? []).some(
          (alias) => alias.trim().toLowerCase() === normalized,
        ),
    ),
  );
}

/**
 * True when the inbound has a messaging-channel surface (Signal, WhatsApp, Telegram, Discord, Slack,
 * Teams, iMessage, ...), either as its source or as the route the reply is delivered to.
 * Internal surfaces (webchat/TUI, CLI, heartbeat/cron/exec events without a channel route) are not.
 * (reasoning-display ARCH §2.1)
 */
export function isMessagingChannelInbound(ctx: {
  OriginatingChannel?: unknown;
  Surface?: unknown;
  Provider?: unknown;
}): boolean {
  return (
    isMessagingChannelId(ctx.OriginatingChannel) ||
    isMessagingChannelId(ctx.Surface) ||
    isMessagingChannelId(ctx.Provider)
  );
}

function asReasoningDefault(raw: unknown): ReasoningLevel | undefined {
  return raw === "on" || raw === "off" || raw === "stream" ? raw : undefined;
}

/**
 * Explicitly configured reasoning display default: per-agent `reasoningDefault`, then
 * `agents.defaults.reasoningDefault`. Undefined when neither is set. (reasoning-display ARCH §2.2)
 */
export function resolveConfiguredReasoningDefault(
  cfg: OpenClawConfig,
  agentId?: string,
): ReasoningLevel | undefined {
  const perAgent = agentId
    ? asReasoningDefault(resolveAgentConfig(cfg, agentId)?.reasoningDefault)
    : undefined;
  return perAgent ?? asReasoningDefault(cfg.agents?.defaults?.reasoningDefault);
}

/**
 * Reasoning display level when neither an inline directive nor the session set one.
 * 1. A configured default (per-agent, then agents.defaults) wins.
 * 2. Messaging channels: off. Never turned on automatically.
 * 3. Non-channel surfaces (CLI, TUI, gateway `agent`): the model-catalog default, unless thinking is
 *    active (internal thinking blocks would otherwise surface as visible "Reasoning:" messages).
 * (reasoning-display ARCH §2)
 */
export async function resolveUnsetReasoningLevel(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  ctx: { OriginatingChannel?: unknown; Surface?: unknown; Provider?: unknown };
  thinkingActive: boolean;
  resolveCatalogDefault: () => Promise<ReasoningLevel>;
}): Promise<ReasoningLevel> {
  const configured = resolveConfiguredReasoningDefault(params.cfg, params.agentId);
  if (configured) {
    return configured;
  }
  if (isMessagingChannelInbound(params.ctx)) {
    return "off";
  }
  if (params.thinkingActive) {
    return "off";
  }
  return params.resolveCatalogDefault();
}
