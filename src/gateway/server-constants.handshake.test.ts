import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_HANDSHAKE_TIMEOUT_MS, getHandshakeTimeoutMs } from "./server-constants.js";

describe("gateway handshake timeout", () => {
  const prev = { ...process.env };
  afterEach(() => {
    process.env = { ...prev };
  });
  it("defaults to 30 s so loaded hosts don't drop local CLI connections", () => {
    delete process.env.OPENCLAW_HANDSHAKE_TIMEOUT_MS;
    delete process.env.OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS;
    expect(DEFAULT_HANDSHAKE_TIMEOUT_MS).toBe(30_000);
    expect(getHandshakeTimeoutMs()).toBe(30_000);
  });
  it("still honours the env override", () => {
    delete process.env.OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS;
    process.env.OPENCLAW_HANDSHAKE_TIMEOUT_MS = "45000";
    expect(getHandshakeTimeoutMs()).toBe(45_000);
  });
});
