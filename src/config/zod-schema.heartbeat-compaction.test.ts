import { describe, expect, it } from "vitest";
import { HeartbeatSchema } from "./zod-schema.agent-runtime.js";

describe("HeartbeatSchema compaction fields", () => {
  it("accepts token counts, off, and compactInstructions", () => {
    expect(HeartbeatSchema.safeParse({ compactAt: 140_000 }).success).toBe(true);
    expect(HeartbeatSchema.safeParse({ compactAt: "off" }).success).toBe(true);
    expect(HeartbeatSchema.safeParse({ compactInstructions: "keep decisions" }).success).toBe(true);
  });

  it("rejects non-positive or non-integer thresholds and unknown strings", () => {
    expect(HeartbeatSchema.safeParse({ compactAt: 0 }).success).toBe(false);
    expect(HeartbeatSchema.safeParse({ compactAt: -5 }).success).toBe(false);
    expect(HeartbeatSchema.safeParse({ compactAt: 1.5 }).success).toBe(false);
    expect(HeartbeatSchema.safeParse({ compactAt: "never" }).success).toBe(false);
  });
});
