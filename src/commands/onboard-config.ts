import type { OpenClawConfig } from "../config/config.js";
import { isChannelConfigured } from "../config/plugin-auto-enable.js";
import { ensurePluginAllowlisted } from "../config/plugins-allowlist.js";
import type { DmScope } from "../config/types.base.js";
import type { ToolProfileId } from "../config/types.tools.js";
import { FRESH_INSTALL_EXEC_ASK, FRESH_INSTALL_EXEC_SECURITY } from "../infra/exec-approvals.js";

export const ONBOARDING_DEFAULT_DM_SCOPE: DmScope = "per-channel-peer";
export const ONBOARDING_DEFAULT_TOOLS_PROFILE: ToolProfileId = "coding";

/**
 * Host exec defaults for a config file that is being created for the first time (onboard, setup,
 * configure). Only fills gaps; explicit values are kept. Never call this for an existing config file.
 */
export function applyFreshInstallExecDefaults(cfg: OpenClawConfig): OpenClawConfig {
  return {
    ...cfg,
    tools: {
      ...cfg.tools,
      exec: {
        ...cfg.tools?.exec,
        security: cfg.tools?.exec?.security ?? FRESH_INSTALL_EXEC_SECURITY,
        ask: cfg.tools?.exec?.ask ?? FRESH_INSTALL_EXEC_ASK,
      },
    },
  };
}

/**
 * `freshInstall`: no config existed (or the user reset it). Only then are the host exec defaults written
 * (security="full", ask="off"); re-running onboarding over an existing config never changes exec policy.
 */
export function applyOnboardingLocalWorkspaceConfig(
  baseConfig: OpenClawConfig,
  workspaceDir: string,
  opts?: { freshInstall?: boolean },
): OpenClawConfig {
  const seeded = opts?.freshInstall ? applyFreshInstallExecDefaults(baseConfig) : baseConfig;
  const tools: OpenClawConfig["tools"] = {
    ...seeded.tools,
    profile: seeded.tools?.profile ?? ONBOARDING_DEFAULT_TOOLS_PROFILE,
  };
  return {
    ...baseConfig,
    agents: {
      ...baseConfig.agents,
      defaults: {
        ...baseConfig.agents?.defaults,
        workspace: workspaceDir,
      },
    },
    gateway: {
      ...baseConfig.gateway,
      mode: "local",
    },
    session: {
      ...baseConfig.session,
      dmScope: baseConfig.session?.dmScope ?? ONBOARDING_DEFAULT_DM_SCOPE,
    },
    tools,
  };
}

// ARCH model-badge §2c.12: the badge is on by default for NEW installs only. The bundled
// default stays off (BUNDLED_ENABLED_BY_DEFAULT does not list it), so an upgrade never
// turns it on; onboarding writes the entry into a config it is creating.
export const MODEL_BADGE_PLUGIN_ID = "model-badge";
/** Channels the model-badge extension has a provider for (its provider registry ids). */
export const MODEL_BADGE_CHANNELS: readonly string[] = ["signal"];

function channelConfiguredForBadge(cfg: OpenClawConfig, channelId: string): boolean {
  const entry = (cfg.channels as Record<string, unknown> | undefined)?.[channelId];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return false;
  }
  if ((entry as { enabled?: unknown }).enabled === false) {
    return false;
  }
  return isChannelConfigured(cfg, channelId);
}

/**
 * Enables model-badge in a config that onboarding is creating (§2c.12), with `providers` set to the
 * channels onboarding configured that the badge supports (possibly none). Only call this for a fresh
 * install. Leaves the config alone when plugins are off, the badge is denied, or an entry exists.
 */
export function applyFreshInstallModelBadge(cfg: OpenClawConfig): OpenClawConfig {
  if (cfg.plugins?.enabled === false || cfg.plugins?.deny?.includes(MODEL_BADGE_PLUGIN_ID)) {
    return cfg;
  }
  if (cfg.plugins?.entries?.[MODEL_BADGE_PLUGIN_ID] !== undefined) {
    return cfg;
  }
  const providers = MODEL_BADGE_CHANNELS.filter((id) => channelConfiguredForBadge(cfg, id));
  const next: OpenClawConfig = {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      entries: {
        ...cfg.plugins?.entries,
        [MODEL_BADGE_PLUGIN_ID]: { enabled: true, config: { providers } },
      },
    },
  };
  return ensurePluginAllowlisted(next, MODEL_BADGE_PLUGIN_ID);
}
