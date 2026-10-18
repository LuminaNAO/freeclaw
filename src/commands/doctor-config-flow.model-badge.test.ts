import { describe, expect, it } from "vitest";
import { loadAndMaybeMigrateDoctorConfig } from "./doctor-config-flow.js";
import { runDoctorConfigWithInput } from "./doctor-config-flow.test-utils.js";

// ARCH model-badge §2c.12: only onboarding of a NEW config enables the badge. Doctor on an
// existing config (an upgrade) never adds the entry, with or without --repair.
describe("doctor config flow: model-badge new installs only (§2c.12)", () => {
  it("doctor on an existing config without a model-badge entry does not add it", async () => {
    for (const repair of [false, true]) {
      const result = await runDoctorConfigWithInput({
        config: { channels: { signal: { account: "+15550001111" } } },
        repair,
        run: loadAndMaybeMigrateDoctorConfig,
      });
      const plugins = (result.cfg as { plugins?: { entries?: Record<string, unknown> } }).plugins;
      expect(plugins?.entries?.["model-badge"]).toBeUndefined();
    }
  });
});
