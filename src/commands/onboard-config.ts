import type { OpenClawConfig } from "../config/config.js";
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
