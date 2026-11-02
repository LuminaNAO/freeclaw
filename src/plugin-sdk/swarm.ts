// Narrow plugin-sdk surface for the bundled swarm plugin.
// Keep this list additive and scoped to symbols used under extensions/swarm.

export type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginServiceContext,
  OpenClawPluginToolContext,
  PluginHookAgentContext,
  PluginHookAgentEndEvent,
  PluginHookBeforeToolCallEvent,
  PluginHookLlmInputEvent,
  PluginHookMessageContext,
  PluginHookMessageReceivedEvent,
  PluginHookMessageSendingEvent,
  PluginHookToolContext,
} from "../plugins/types.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";
export { callGateway } from "../gateway/call.js";
export { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
export { resolveStateDir } from "../config/paths.js";
// ARCH §10a.3: holon groups on Signal go through freeclaw's own client, resolved by account.
export type { OpenClawConfig } from "../config/config.js";
export { resolveSignalAccount } from "../signal/accounts.js";
export { signalRpcRequest } from "../signal/client.js";
