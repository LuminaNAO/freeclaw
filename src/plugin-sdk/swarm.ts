// Narrow plugin-sdk surface for the bundled swarm plugin.
// Keep this list additive and scoped to symbols used under extensions/swarm.

export type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginServiceContext,
  OpenClawPluginToolContext,
  PluginHookAgentContext,
  PluginHookAgentEndEvent,
  PluginHookLlmInputEvent,
} from "../plugins/types.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";
export { callGateway } from "../gateway/call.js";
export { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
