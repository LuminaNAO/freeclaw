import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "./config.js";
import { CONTROL_UI_ENABLE_COMMAND, isControlUiEnabled } from "./control-ui-enabled.js";

describe("isControlUiEnabled", () => {
  it("is off when the config is missing or the key is unset", () => {
    expect(isControlUiEnabled(undefined)).toBe(false);
    expect(isControlUiEnabled(null)).toBe(false);
    expect(isControlUiEnabled({})).toBe(false);
    expect(isControlUiEnabled({ gateway: {} })).toBe(false);
    expect(isControlUiEnabled({ gateway: { controlUi: {} } })).toBe(false);
    expect(isControlUiEnabled({ gateway: { controlUi: { basePath: "/ui" } } })).toBe(false);
  });

  it("is off when explicitly disabled", () => {
    expect(isControlUiEnabled({ gateway: { controlUi: { enabled: false } } })).toBe(false);
  });

  it("is on only when explicitly enabled", () => {
    const cfg: OpenClawConfig = { gateway: { controlUi: { enabled: true } } };
    expect(isControlUiEnabled(cfg)).toBe(true);
  });

  it("documents the opt-in command", () => {
    expect(CONTROL_UI_ENABLE_COMMAND).toBe("openclaw config set gateway.controlUi.enabled true");
  });
});
