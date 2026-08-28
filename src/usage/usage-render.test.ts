import { describe, expect, it } from "vitest";
import {
  formatTimeframeLabel,
  renderAgentUsageDetail,
  renderUsageReport,
  usageTimeframeHint,
} from "./usage-render.js";
import { aggregateAgentDetail, aggregateUsage, type UsageTurn } from "./usage-stats.js";

const NOW = Date.parse("2026-08-27T12:00:00.000Z");

function turn(over: Partial<UsageTurn> = {}): UsageTurn {
  return {
    agentId: "main",
    sessionId: "session-a",
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

  it("never wraps a cell onto a continuation row, at any width", () => {
    const long = "Qwen3.6-27B-NEO-CODE-HERE-2T-OT-Q5_K_M-extra-long.gguf";
    const turns = [
      turn({ model: long }),
      turn({ model: `/abs/path/${long}` }),
      turn({ agentId: "another-agent-with-a-long-id", model: long }),
    ];
    for (const width of [120, 100, 80, 64]) {
      const out = renderUsageReport(aggregateUsage(turns, { timeframe: "all", now: NOW }), {
        width,
      });
      for (const line of out.split("\n")) {
        expect(line.length).toBeLessThanOrEqual(width);
      }
      expect(out.split("\n").filter((line) => /^│\s+│/.test(line))).toEqual([]);
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

  it("omits the cost column when nothing is priced", () => {
    const out = render([turn()]);
    expect(out).not.toContain("cost");
    expect(out).not.toContain("$");
  });

  it("shows a cost column for priced models and a dash for unpriced ones", () => {
    const lookup = (provider: string, _model: string) =>
      provider === "cloudburst" ? { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 } : undefined;
    const out = renderUsageReport(
      aggregateUsage(
        [
          turn({
            provider: "cloudburst",
            model: "grok-4.6",
            input: 1_000_000,
            output: 0,
          }),
          turn({ provider: "llama.cpp", model: "a.gguf", input: 10 }),
        ],
        { timeframe: "all", now: NOW, costLookup: lookup },
      ),
      { width: 120 },
    );
    expect(out).toContain("cost");
    expect(out).toContain("$3.00");
    const localRow = out.split("\n").find((l) => l.includes("llama.cpp/a.gguf"));
    expect(localRow).toContain("-");
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

const DAY_MS = 24 * 60 * 60 * 1000;
const UTC = "UTC";

function renderDetail(
  turns: UsageTurn[],
  timeframe: "24h" | "7d" | "all" = "7d",
  agentId = "main",
): string {
  return renderAgentUsageDetail(
    aggregateAgentDetail(turns, { agentId, timeframe, now: NOW, timeZone: UTC }),
    { width: 110 },
  );
}

describe("renderAgentUsageDetail", () => {
  it("renders a scoped header with the agent id and timeframe", () => {
    const out = renderDetail([turn({ timestamp: NOW })]);
    expect(out).toContain("Usage — main — last 7 days");
  });

  it("renders per-model, per-session, and per-day tables", () => {
    const out = renderDetail([
      turn({ timestamp: NOW, model: "a.gguf", input: 100, sessionId: "session-a" }),
      turn({ timestamp: NOW - DAY_MS, model: "b.gguf", input: 50, sessionId: "session-b" }),
    ]);
    expect(out).toContain("llama.cpp/a.gguf");
    expect(out).toContain("llama.cpp/b.gguf");
    expect(out).toContain("By session (2):");
    expect(out).toContain("session-a");
    expect(out).toContain("session-b");
    expect(out).toContain("By day (2):");
    expect(out).toContain("2026-08-27");
    expect(out).toContain("2026-08-26");
  });

  it("lists the models active on each day", () => {
    const out = renderDetail([
      turn({ timestamp: NOW, model: "a.gguf" }),
      turn({ timestamp: NOW, model: "b.gguf" }),
    ]);
    const dayRow = out.split("\n").find((l) => l.includes("2026-08-27"));
    expect(dayRow).toContain("llama.cpp/a.gguf");
  });

  it("adds a TOTAL row only when several models are present", () => {
    expect(renderDetail([turn({ timestamp: NOW })])).not.toContain("TOTAL");
    const multi = renderDetail([
      turn({ timestamp: NOW, model: "a.gguf" }),
      turn({ timestamp: NOW, model: "b.gguf" }),
    ]);
    expect(multi).toContain("TOTAL");
  });

  it("reports an unknown agent distinctly from a quiet window", () => {
    const unknown = renderDetail([turn({ timestamp: NOW, agentId: "main" })], "7d", "ghost");
    expect(unknown).toContain("No usage recorded for this agent.");
    expect(unknown).not.toContain("┌");

    const quiet = renderDetail([turn({ timestamp: NOW - 90 * DAY_MS })], "24h");
    expect(quiet).toContain("No usage recorded for this agent in this window.");
  });

  it("notes undated turns excluded from the day view", () => {
    const out = renderDetail([turn({ timestamp: NOW }), turn({ timestamp: undefined })], "all");
    expect(out).toContain("1 turn(s) without timestamps excluded from the day view.");
  });

  it("shows cost on both the model table and the day table", () => {
    const lookup = () => ({ input: 3, output: 15, cacheRead: 0, cacheWrite: 0 });
    const out = renderAgentUsageDetail(
      aggregateAgentDetail(
        [
          turn({
            timestamp: NOW,
            provider: "cloudburst",
            model: "grok-4.6",
            input: 1_000_000,
            output: 0,
          }),
        ],
        { agentId: "main", timeframe: "7d", now: NOW, timeZone: UTC, costLookup: lookup },
      ),
      { width: 120 },
    );
    expect(out).toContain("cost");
    expect(out).toContain("$3.00");
  });

  it("keeps rows on one line for long model names at any width", () => {
    const long = "Qwen3.6-27B-NEO-CODE-HERE-2T-OT-Q5_K_M-very-long-name.gguf";
    const turns = [
      turn({ timestamp: NOW, model: long }),
      turn({ timestamp: NOW, model: `${long}-second` }),
      turn({ timestamp: NOW - DAY_MS, model: `/abs/path/to/${long}` }),
    ];
    for (const width of [120, 100, 80, 64]) {
      const out = renderAgentUsageDetail(
        aggregateAgentDetail(turns, {
          agentId: "main",
          timeframe: "7d",
          now: NOW,
          timeZone: UTC,
        }),
        { width },
      );
      for (const line of out.split("\n")) {
        expect(line.length).toBeLessThanOrEqual(width);
      }
      // A wrapped cell leaves a continuation row whose leading column is blank.
      expect(out.split("\n").filter((line) => /^│\s+│/.test(line))).toEqual([]);
    }
  });
});
