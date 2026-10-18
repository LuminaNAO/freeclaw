import { describe, expect, it } from "vitest";
import { resolveHeartbeatCompactionThreshold } from "./heartbeat-compaction-threshold.js";

describe("resolveHeartbeatCompactionThreshold (ARCH §3)", () => {
  it.each([
    ["1M model", 1_000_000, 100_000],
    ["200k model", 200_000, 100_000],
    ["128k model", 128_000, 64_000],
  ])("default threshold on a %s", (_label, window, expected) => {
    expect(resolveHeartbeatCompactionThreshold({ contextWindowTokens: window })).toBe(expected);
  });

  it("keeps an explicit 140k on a 1M model", () => {
    expect(
      resolveHeartbeatCompactionThreshold({ contextWindowTokens: 1_000_000, compactAt: 140_000 }),
    ).toBe(140_000);
  });

  it("clamps an explicit 200k to 150k", () => {
    expect(
      resolveHeartbeatCompactionThreshold({ contextWindowTokens: 1_000_000, compactAt: 200_000 }),
    ).toBe(150_000);
  });

  it("clamps an explicit 140k on a 200k model to 100k", () => {
    expect(
      resolveHeartbeatCompactionThreshold({ contextWindowTokens: 200_000, compactAt: 140_000 }),
    ).toBe(100_000);
  });

  it("keeps an explicit value below the default", () => {
    expect(
      resolveHeartbeatCompactionThreshold({ contextWindowTokens: 200_000, compactAt: 40_000 }),
    ).toBe(40_000);
  });

  it("returns null when compactAt is off", () => {
    expect(
      resolveHeartbeatCompactionThreshold({ contextWindowTokens: 200_000, compactAt: "off" }),
    ).toBeNull();
  });

  it("returns null when the window is unknown", () => {
    expect(resolveHeartbeatCompactionThreshold({ contextWindowTokens: undefined })).toBeNull();
    expect(resolveHeartbeatCompactionThreshold({ contextWindowTokens: 0 })).toBeNull();
  });
});
