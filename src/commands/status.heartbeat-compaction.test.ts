import { describe, expect, it } from "vitest";
import { formatHeartbeatCompactionValue } from "./status.format.js";

describe("formatHeartbeatCompactionValue (heartbeat-compaction ARCH §2.5)", () => {
  const base = { enabled: true, every: "30m", everyMs: 1_800_000 };

  it("shows size, threshold and last compaction time", () => {
    const value = formatHeartbeatCompactionValue(
      [
        {
          ...base,
          agentId: "main",
          compaction: {
            sessionKey: "agent:main:main",
            totalTokens: 42_000,
            threshold: 100_000,
            lastCompactedAt: 1_000_000 - 3 * 60 * 60 * 1000,
          },
        },
      ],
      1_000_000,
    );
    expect(value).toBe("42k / compacts at 100k · last compacted 3h ago (main)");
  });

  it("handles unknown size, compaction off and never compacted", () => {
    const value = formatHeartbeatCompactionValue([
      {
        ...base,
        agentId: "ops",
        compaction: {
          sessionKey: "agent:ops:main",
          totalTokens: null,
          threshold: null,
          lastCompactedAt: null,
        },
      },
    ]);
    expect(value).toBe("unknown / compaction off · never compacted (ops)");
  });

  it("returns null when no agent reports compaction", () => {
    expect(formatHeartbeatCompactionValue([{ ...base, agentId: "main" }])).toBeNull();
  });
});
