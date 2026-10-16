// Narrow plugin-sdk surface for the bundled model-badge plugin.
// Keep this list additive and scoped to symbols used under extensions/model-badge.

export type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginServiceContext,
  OpenClawPluginToolContext,
  PluginCommandContext,
  PluginHookGroupMemoryCreatedEvent,
  PluginRuntime,
} from "../plugins/types.js";
export type { OpenClawConfig } from "../config/config.js";
export type { SecretRef } from "../config/types.secrets.js";
export { parseConfigJson5, resolveConfigPath } from "../config/config.js";
export { resolveStateDir } from "../config/paths.js";
export { resolveStorePath } from "../config/sessions/paths.js";
export { resolveAgentDir } from "../agents/agent-scope.js";
export { parseAgentSessionKey } from "../sessions/session-key-utils.js";
export { resolveSecretRefString } from "../secrets/resolve.js";
// freeclaw's own Signal client: account → daemon endpoint resolution and the JSON-RPC
// client that works over both the HTTP and the unix-socket transport.
export { resolveSignalAccount } from "../signal/accounts.js";
export { signalRpcRequest } from "../signal/client.js";
