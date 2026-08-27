import { describe, expect, it } from "vitest";
import { formatTimeframeLabel, renderUsageReport, usageTimeframeHint } from "./usage-render.js";
import { aggregateUsage, type UsageTurn } from "./usage-stats.js";

const NOW = Date.parse("2026-08-27T12:00:00.000Z");

function turn(over: Partial<UsageTurn> = {}): UsageTurn {
  return {
    agentId: "main",
    provider: "llama.cpp",
    model: "a.gguf",
    timestamp: NOW - 1000,
    input: 100,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
    ...over,
  };
}

function render(turns: UsageTurn[], timeframe: "1h" | "24h" | "all" = "24h"): string {
  return renderUsageReport(aggregateUsage(turns, { timeframe, now: NOW }), { width: 100 });
}

describe("renderUsageReport", () => {
  it("renders a header, agent row, and indented model rows", () => {
    const out = render([turn(), turn({ model: "b.gguf", input: 5 })]);
    expect(out).toContain("Usage — last 24 hours");
    expect(out).toContain("main  (2 models)");
    expect(out).toContain("└ llama.cpp/a.gguf");
    expect(out).toContain("└ llama.cpp/b.gguf");
  });

  it("uses singular wording for a single model", () => {
    expect(render([turn()])).toContain("main  (1 model)");
  });

  it("omits the grand total for a single agent but adds it for several", () => {
    expect(render([turn()])).not.toContain("TOTAL");
    const multi = render([turn(), turn({ agentId: "worker" })]);
    expect(multi).toContain("TOTAL");
  });

  it("shows a dash when no cache tokens were recorded", () => {
    const out = render([turn({ cacheRead: 0, cacheWrite: 0 })]);
    const modelRow = out.split("\n").find((l) => l.includes("llama.cpp/a.gguf"));
    expect(modelRow).toContain("-");
  });

  it("formats cache as read/write when present", () => {
    const out = render([turn({ cacheRead: 2000, cacheWrite: 1000 })]);
    expect(out).toContain("2.0k/1.0k");
  });

  it("middle-truncates long model names to keep rows on one line", () => {
    const long = "Qwen3.6-27B-NEO-CODE-HERE-2T-OT-Q5_K_M-extra-long.gguf";
    const out = render([turn({ model: long })]);
    expect(out).toContain("…");
    for (const line of out.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(101);
    }
  });

  it("reports an empty window without a table", () => {
    const out = render([], "24h");
    expect(out).toContain("No recorded usage found.");
    expect(out).not.toContain("┌");
  });

  it("explains when the window has only undated turns", () => {
    const out = render([turn({ timestamp: undefined })], "24h");
    expect(out).toContain("No timestamped usage in this window.");
  });

  it("notes undated turns excluded from a bounded window", () => {
    const out = render([turn(), turn({ timestamp: undefined })], "24h");
    expect(out).toContain("1 turn(s) without timestamps excluded");
  });

  it("does not note exclusions for the all timeframe", () => {
    const out = render([turn(), turn({ timestamp: undefined })], "all");
    expect(out).not.toContain("excluded");
    expect(out).toContain("Usage — all time");
  });
});

describe("labels", () => {
  it("maps timeframes to friendly labels", () => {
    expect(formatTimeframeLabel("1h")).toBe("last hour");
    expect(formatTimeframeLabel("30d")).toBe("last 30 days");
    expect(formatTimeframeLabel("all")).toBe("all time");
    expect(formatTimeframeLabel("weird")).toBe("weird");
  });

  it("lists selectable timeframes in the hint", () => {
    expect(usageTimeframeHint()).toBe("timeframes: 1h | 24h | 7d | 30d | all");
  });
});
