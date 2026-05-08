import type { OpenClawConfig } from "../config/config.js";
import {
  buildAgentSessionKey,
  deriveLastRoutePolicy,
  resolveAgentRoute,
  type ResolvedAgentRoute,
} from "../routing/resolve-route.js";

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
  const sessionKey = buildAgentSessionKey({
    agentId: route.agentId,
    channel: "signal",
    accountId: route.accountId,
    peer: { kind: "direct", id: params.senderPeerId },
    dmScope: "per-channel-peer",
  }).toLowerCase();

  return {
    ...route,
    sessionKey,
    lastRoutePolicy: deriveLastRoutePolicy({
      sessionKey,
      mainSessionKey: route.mainSessionKey,
    }),
  };
}
