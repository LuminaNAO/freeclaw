import type { OpenClawConfig } from "../config/config.js";
import {
  buildAgentSessionKey,
  deriveLastRoutePolicy,
  resolveAgentRoute,
  type ResolvedAgentRoute,
} from "../routing/resolve-route.js";

/**
 * Signal DM session key for a peer id (`uuid:<uuid>` or, for legacy/phone-only
 * senders, the E.164 number). Shared by inbound routing and the §4 re-key.
 */
export function buildSignalDirectSessionKey(params: {
  agentId: string;
  accountId?: string | null;
  peerId: string;
}): string {
  return buildAgentSessionKey({
    agentId: params.agentId,
    channel: "signal",
    accountId: params.accountId,
    peer: { kind: "direct", id: params.peerId },
    dmScope: "per-channel-peer",
  }).toLowerCase();
}

export function resolveSignalInboundRoute(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  isGroup: boolean;
  groupId?: string;
  senderPeerId: string;
}): ResolvedAgentRoute {
  const route = resolveAgentRoute({
    cfg: params.cfg,
    channel: "signal",
    accountId: params.accountId,
    peer: {
      kind: params.isGroup ? "group" : "direct",
      id: params.isGroup ? (params.groupId ?? "unknown") : params.senderPeerId,
    },
  });
  if (params.isGroup) {
    return route;
  }

  // Signal DMs default to sender-scoped sessions so independent senders do not
  // share and pollute the agent main session.
  const sessionKey = buildSignalDirectSessionKey({
    agentId: route.agentId,
    accountId: route.accountId,
    peerId: params.senderPeerId,
  });

  return {
    ...route,
    sessionKey,
    lastRoutePolicy: deriveLastRoutePolicy({
      sessionKey,
      mainSessionKey: route.mainSessionKey,
    }),
  };
}
