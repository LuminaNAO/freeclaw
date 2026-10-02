import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SignalConfigSchema } from "../../config/zod-schema.providers-core.js";
import { createSignalTrustGate, isSignalTrustGateEnforced, SIGNAL_TRUST_GATE_ENV } from "./gate.js";

const runtime = { log: () => {}, error: () => {}, exit: () => {} };
let stateDir = "";

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-trust-switch-"));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("trust gate switch (ARCH §5.9)", () => {
  it("is off when the env var is unset and every sender passes", async () => {
    const gate = createSignalTrustGate({ accountId: "default", runtime, env: {} });
    expect(gate.enforced).toBe(false);
    expect(
      (await gate.evaluate({ envelope: { sourceNumber: "+15550000009" }, kind: "dm" })).allow,
    ).toBe(true);
  });

  it("only the exact value enforce (case-insensitive) turns it on", () => {
    for (const value of ["", "1", "true", "on", "enforcing"]) {
      expect(isSignalTrustGateEnforced({ [SIGNAL_TRUST_GATE_ENV]: value })).toBe(false);
    }
    expect(isSignalTrustGateEnforced({ [SIGNAL_TRUST_GATE_ENV]: "ENFORCE" })).toBe(true);
  });

  it("is enforced with no store (deny all) when the env var is set", async () => {
    const gate = createSignalTrustGate({
      accountId: "default",
      runtime,
      env: { OPENCLAW_STATE_DIR: stateDir, [SIGNAL_TRUST_GATE_ENV]: "enforce" },
    });
    expect(gate.enforced).toBe(true);
    expect(
      (await gate.evaluate({ envelope: { sourceNumber: "+15550000001" }, kind: "dm" })).allow,
    ).toBe(false);
  });

  it("has no channels.signal config key: the strict schema rejects any attempt to add one", () => {
    for (const key of ["trustGate", "trust", "trustGateEnforce", "signalTrustGate"]) {
      const result = SignalConfigSchema.safeParse({ [key]: "off" });
      expect(result.success).toBe(false);
    }
  });

  it("gate construction never consults config, only the process env it is given", () => {
    const params = { accountId: "default", runtime, env: { [SIGNAL_TRUST_GATE_ENV]: "enforce" } };
    expect(Object.keys(params)).not.toContain("cfg");
    expect(createSignalTrustGate(params).enforced).toBe(true);
  });
});
