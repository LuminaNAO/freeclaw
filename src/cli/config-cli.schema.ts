import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { listChannelPlugins } from "../channels/plugins/index.js";
import { buildConfigSchema, type ConfigSchemaResponse } from "../config/schema.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";

/**
 * Core + plugin config schema for CLI path hints (ARCH config-path-hints §2.1).
 * Plugin schemas come from manifests (no plugin code is executed); channel
 * schemas come from whatever channel plugins are already registered.
 * Falls back to the core schema when plugin discovery fails.
 */
export function loadCliConfigSchema(config: OpenClawConfig): ConfigSchemaResponse {
  try {
    const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
    const registry = loadPluginManifestRegistry({ config, workspaceDir });
    return buildConfigSchema({
      plugins: registry.plugins.map((plugin) => ({
        id: plugin.id,
        name: plugin.name,
        description: plugin.description,
        configUiHints: plugin.configUiHints,
        configSchema: plugin.configSchema,
      })),
      channels: listChannelPlugins().map((entry) => ({
        id: entry.id,
        label: entry.meta.label,
        description: entry.meta.blurb,
        configSchema: entry.configSchema?.schema,
        configUiHints: entry.configSchema?.uiHints,
      })),
    });
  } catch {
    return buildConfigSchema();
  }
}
