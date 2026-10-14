import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { maybeSeedControlUiAllowedOriginsAtStartup } from "./startup-control-ui-origins.js";

function run(config: OpenClawConfig) {
  const writeConfig = vi.fn(async (_cfg: OpenClawConfig) => {});
  const log = { info: vi.fn(), warn: vi.fn() };
  return {
    writeConfig,
    log,
    result: maybeSeedControlUiAllowedOriginsAtStartup({ config, writeConfig, log }),
  };
}

describe("maybeSeedControlUiAllowedOriginsAtStartup", () => {
  it("writes nothing when the Control UI is unset (off by default)", async () => {
    const config: OpenClawConfig = { gateway: { bind: "lan", port: 18789 } };
    const { writeConfig, result } = run(config);
    expect(await result).toBe(config);
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it("writes nothing when the Control UI is explicitly disabled", async () => {
    const config: OpenClawConfig = {
      gateway: { bind: "lan", port: 18789, controlUi: { enabled: false } },
    };
    const { writeConfig, result } = run(config);
    expect(await result).toBe(config);
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it("seeds allowed origins for a non-loopback bind when enabled", async () => {
    const config: OpenClawConfig = {
      gateway: { bind: "lan", port: 18789, controlUi: { enabled: true } },
    };
    const { writeConfig, result } = run(config);
    const seeded = await result;
    expect(seeded.gateway?.controlUi?.allowedOrigins).toEqual([
      "http://localhost:18789",
      "http://127.0.0.1:18789",
    ]);
    expect(seeded.gateway?.controlUi?.enabled).toBe(true);
    expect(writeConfig).toHaveBeenCalledTimes(1);
  });
});
