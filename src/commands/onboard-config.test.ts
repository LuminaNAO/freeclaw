import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyFreshInstallModelBadge,
  applyOnboardingLocalWorkspaceConfig,
  ONBOARDING_DEFAULT_DM_SCOPE,
  ONBOARDING_DEFAULT_TOOLS_PROFILE,
} from "./onboard-config.js";

describe("applyOnboardingLocalWorkspaceConfig", () => {
  it("defaults local onboarding tool profile to coding", () => {
    expect(ONBOARDING_DEFAULT_TOOLS_PROFILE).toBe("coding");
  });

  it("sets secure dmScope default when unset", () => {
    const baseConfig: OpenClawConfig = {};
    const result = applyOnboardingLocalWorkspaceConfig(baseConfig, "/tmp/workspace");

    expect(result.session?.dmScope).toBe(ONBOARDING_DEFAULT_DM_SCOPE);
    expect(result.gateway?.mode).toBe("local");
    expect(result.agents?.defaults?.workspace).toBe("/tmp/workspace");
    expect(result.tools?.profile).toBe(ONBOARDING_DEFAULT_TOOLS_PROFILE);
  });

  it("preserves existing dmScope when already configured", () => {
    const baseConfig: OpenClawConfig = {
      session: {
        dmScope: "main",
      },
    };
    const result = applyOnboardingLocalWorkspaceConfig(baseConfig, "/tmp/workspace");

    expect(result.session?.dmScope).toBe("main");
  });

  it("preserves explicit non-main dmScope values", () => {
    const baseConfig: OpenClawConfig = {
      session: {
        dmScope: "per-account-channel-peer",
      },
    };
    const result = applyOnboardingLocalWorkspaceConfig(baseConfig, "/tmp/workspace");

    expect(result.session?.dmScope).toBe("per-account-channel-peer");
  });

  it("preserves an explicit tools.profile when already configured", () => {
    const baseConfig: OpenClawConfig = {
      tools: {
        profile: "full",
      },
    };
    const result = applyOnboardingLocalWorkspaceConfig(baseConfig, "/tmp/workspace");

    expect(result.tools?.profile).toBe("full");
  });

  it("writes host exec defaults security=full, ask=off on a fresh install", () => {
    const result = applyOnboardingLocalWorkspaceConfig({}, "/tmp/workspace", {
      freshInstall: true,
    });
    expect(result.tools?.exec?.security).toBe("full");
    expect(result.tools?.exec?.ask).toBe("off");
  });

  it("keeps explicit exec values even on a fresh install", () => {
    const result = applyOnboardingLocalWorkspaceConfig(
      { tools: { exec: { security: "allowlist", host: "gateway" } } },
      "/tmp/workspace",
      { freshInstall: true },
    );
    expect(result.tools?.exec?.security).toBe("allowlist");
    expect(result.tools?.exec?.ask).toBe("off");
    expect(result.tools?.exec?.host).toBe("gateway");
  });

  it("never touches exec policy when re-onboarding an existing config", () => {
    const result = applyOnboardingLocalWorkspaceConfig(
      { tools: { profile: "coding" } },
      "/tmp/workspace",
    );
    expect(result.tools?.exec).toBeUndefined();
  });
});

describe("applyFreshInstallModelBadge (ARCH model-badge §2c.12)", () => {
  const signal = { channels: { signal: { account: "+15550001111" } } } as OpenClawConfig;

  it("enables the badge with the supported channels onboarding configured", () => {
    const result = applyFreshInstallModelBadge(signal);
    expect(result.plugins?.entries?.["model-badge"]).toEqual({
      enabled: true,
      config: { providers: ["signal"] },
    });
  });

  it("writes an empty providers list when no supported channel was configured", () => {
    const result = applyFreshInstallModelBadge({
      channels: { telegram: { botToken: "x" } },
    } as OpenClawConfig);
    expect(result.plugins?.entries?.["model-badge"]).toEqual({
      enabled: true,
      config: { providers: [] },
    });
  });

  it("skips a configured but disabled channel", () => {
    const result = applyFreshInstallModelBadge({
      channels: { signal: { account: "+15550001111", enabled: false } },
    } as OpenClawConfig);
    expect(result.plugins?.entries?.["model-badge"]?.config).toEqual({ providers: [] });
  });

  it("adds itself to an explicit plugins.allow list", () => {
    const result = applyFreshInstallModelBadge({ ...signal, plugins: { allow: ["x"] } });
    expect(result.plugins?.allow).toEqual(["x", "model-badge"]);
  });

  it("leaves an existing entry, a denylist and plugins-off alone", () => {
    const off = { plugins: { entries: { "model-badge": { enabled: false } } } } as OpenClawConfig;
    expect(applyFreshInstallModelBadge(off)).toBe(off);
    const denied = { plugins: { deny: ["model-badge"] } } as OpenClawConfig;
    expect(applyFreshInstallModelBadge(denied)).toBe(denied);
    const disabled = { plugins: { enabled: false } } as OpenClawConfig;
    expect(applyFreshInstallModelBadge(disabled)).toBe(disabled);
  });

  it("an upgrade leaves the badge off: the bundled default does not enable it", async () => {
    const { BUNDLED_ENABLED_BY_DEFAULT, normalizePluginsConfig, resolveEnableState } =
      await import("../plugins/config-state.js");
    expect(BUNDLED_ENABLED_BY_DEFAULT.has("model-badge")).toBe(false);
    // An existing (upgraded) config with no model-badge entry.
    const state = resolveEnableState(
      "model-badge",
      "bundled",
      normalizePluginsConfig({ entries: {} }),
    );
    expect(state.enabled).toBe(false);
  });
});
