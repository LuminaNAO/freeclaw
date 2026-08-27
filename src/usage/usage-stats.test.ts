import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  aggregateAgentDetail,
  aggregateUsage,
  buildAgentUsageDetail,
  buildUsageReport,
  collectUsageTurns,
  formatDayKey,
  formatModelKey,
  isUsageTimeframe,
  listAgentIds,
  listKnownAgentIds,
  listTranscriptFiles,
  costLookupFromConfig,
  parseUsageCommandArgs,
  parseUsageLine,
  resolveSince,
  totalTokens,
  type UsageTurn,
} from "./usage-stats.js";

const NOW = Date.parse("2026-08-27T12:00:00.000Z");

function line(overrides: {
  ts?: string | null;
  provider?: string;
  model?: string;
  usage?: Record<string, unknown> | null;
  type?: string;
  role?: string;
}): string {
  const message: Record<string, unknown> = {
    role: overrides.role ?? "assistant",
    content: "hi",
    provider: overrides.provider ?? "llama.cpp",
    model: overrides.model ?? "Qwen3.6-27B-UD-Q4_K_XL.gguf",
  };
  if (overrides.usage !== null) {
    message.usage = overrides.usage ?? {
      input: 100,
      output: 10,
      cacheRead: 5,
      cacheWrite: 1,
      totalTokens: 116,
    };
  }
  const record: Record<string, unknown> = { type: overrides.type ?? "message", message };
  if (overrides.ts !== null) {
    record.timestamp = overrides.ts ?? "2026-08-27T11:00:00.000Z";
  }
  return JSON.stringify(record);
}

function turn(over: Partial<UsageTurn> = {}): UsageTurn {
  return {
    agentId: "main",
    provider: "llama.cpp",
    model: "m.gguf",
    timestamp: NOW - 1000,
    input: 10,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    ...over,
  };
}

const tmpDirs: string[] = [];

function makeStateDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-stats-"));
  tmpDirs.push(dir);
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("parseUsageLine", () => {
  it("parses an assistant message carrying usage", () => {
    const parsed = parseUsageLine(line({}), "main");
    expect(parsed).toMatchObject({
      agentId: "main",
      provider: "llama.cpp",
      model: "Qwen3.6-27B-UD-Q4_K_XL.gguf",
      input: 100,
      output: 10,
      cacheRead: 5,
      cacheWrite: 1,
    });
    expect(parsed?.timestamp).toBe(Date.parse("2026-08-27T11:00:00.000Z"));
  });

  it("ignores blank lines, malformed JSON, and non-message records", () => {
    expect(parseUsageLine("", "main")).toBeUndefined();
    expect(parseUsageLine("   ", "main")).toBeUndefined();
    expect(parseUsageLine("{not json", "main")).toBeUndefined();
    expect(parseUsageLine(JSON.stringify({ type: "session", id: "x" }), "main")).toBeUndefined();
    expect(parseUsageLine(JSON.stringify({ type: "message" }), "main")).toBeUndefined();
  });

  it("ignores messages without a usage object", () => {
    expect(parseUsageLine(line({ usage: null }), "main")).toBeUndefined();
  });

  it("treats missing usage counters as zero and drops empty usage", () => {
    const partial = parseUsageLine(line({ usage: { input: 42 } }), "main");
    expect(partial).toMatchObject({ input: 42, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(parseUsageLine(line({ usage: {} }), "main")).toBeUndefined();
    expect(
      parseUsageLine(line({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }), "main"),
    ).toBeUndefined();
  });

  it("ignores non-numeric and negative counters", () => {
    const parsed = parseUsageLine(
      line({ usage: { input: "lots", output: -5, cacheRead: null, cacheWrite: 7 } }),
      "main",
    );
    expect(parsed).toMatchObject({ input: 0, output: 0, cacheRead: 0, cacheWrite: 7 });
  });

  it("falls back to the message timestamp and tolerates unparsable dates", () => {
    const record = JSON.parse(line({ ts: null }));
    record.message.timestamp = "2026-08-27T09:30:00.000Z";
    expect(parseUsageLine(JSON.stringify(record), "main")?.timestamp).toBe(
      Date.parse("2026-08-27T09:30:00.000Z"),
    );
    expect(parseUsageLine(line({ ts: "not-a-date" }), "main")?.timestamp).toBeUndefined();
  });

  it("defaults missing provider and model to unknown", () => {
    const record = JSON.parse(line({}));
    delete record.message.provider;
    delete record.message.model;
    expect(parseUsageLine(JSON.stringify(record), "main")).toMatchObject({
      provider: "unknown",
      model: "unknown",
    });
  });

  it("keeps a positive recorded cost and drops a zero-cost object", () => {
    const billed = parseUsageLine(
      line({
        usage: { input: 10, output: 1, cost: { total: 0.42, input: 0.4, output: 0.02 } },
      }),
      "main",
    );
    expect(billed?.cost).toBeCloseTo(0.42);
    const free = parseUsageLine(
      line({ usage: { input: 10, output: 1, cost: { total: 0 } } }),
      "main",
    );
    expect(free?.cost).toBeUndefined();
  });
});

describe("formatModelKey", () => {
  it("keeps plain model ids scoped by provider", () => {
    expect(formatModelKey("cloudburst", "grok-4.6")).toBe("cloudburst/grok-4.6");
  });

  it("compacts absolute weights paths to the file name", () => {
    expect(formatModelKey("llama.cpp", "/usr/local/share/models/Qwen3.6-27B.gguf")).toBe(
      "llama.cpp/Qwen3.6-27B.gguf",
    );
  });

  it("keeps provider-style model ids readable", () => {
    expect(formatModelKey("openrouter", "anthropic/claude-opus-5")).toBe(
      "openrouter/claude-opus-5",
    );
  });
});

describe("resolveSince", () => {
  it("returns no bound for all", () => {
    expect(resolveSince("all", NOW)).toBeUndefined();
  });

  it("computes bounds per window", () => {
    expect(resolveSince("1h", NOW)).toBe(NOW - 3_600_000);
    expect(resolveSince("24h", NOW)).toBe(NOW - 86_400_000);
    expect(resolveSince("7d", NOW)).toBe(NOW - 7 * 86_400_000);
    expect(resolveSince("30d", NOW)).toBe(NOW - 30 * 86_400_000);
  });

  it("validates timeframe strings", () => {
    expect(isUsageTimeframe("24h")).toBe(true);
    expect(isUsageTimeframe("90d")).toBe(false);
  });
});

describe("aggregateUsage", () => {
  it("groups per agent and per model with totals", () => {
    const report = aggregateUsage(
      [
        turn({ agentId: "main", model: "a.gguf", input: 100, output: 10 }),
        turn({ agentId: "main", model: "a.gguf", input: 50, output: 5, cacheRead: 20 }),
        turn({ agentId: "main", model: "b.gguf", input: 7, output: 1 }),
        turn({ agentId: "worker", model: "a.gguf", input: 3, output: 1 }),
      ],
      { timeframe: "24h", now: NOW },
    );

    expect(report.agents.map((a) => a.agentId)).toEqual(["main", "worker"]);
    const main = report.agents[0];
    expect(main).toMatchObject({ input: 157, output: 16, cacheRead: 20, turns: 3 });
    expect(main.models.map((m) => m.key)).toEqual(["llama.cpp/a.gguf", "llama.cpp/b.gguf"]);
    expect(main.models[0]).toMatchObject({ input: 150, output: 15, cacheRead: 20, turns: 2 });
    expect(report.totals).toMatchObject({ input: 160, output: 17, turns: 4 });
  });

  it("keeps identical model names from different providers separate", () => {
    const report = aggregateUsage(
      [
        turn({ provider: "llama.cpp", model: "claude-opus-5", input: 10 }),
        turn({ provider: "cloudburst", model: "claude-opus-5", input: 20 }),
      ],
      { timeframe: "all", now: NOW },
    );
    expect(report.agents[0].models.map((m) => m.key).toSorted()).toEqual([
      "cloudburst/claude-opus-5",
      "llama.cpp/claude-opus-5",
    ]);
  });

  it("filters turns outside the window", () => {
    const turns = [
      turn({ timestamp: NOW - 30 * 60 * 1000, input: 1 }),
      turn({ timestamp: NOW - 5 * 60 * 60 * 1000, input: 10 }),
      turn({ timestamp: NOW - 10 * 24 * 60 * 60 * 1000, input: 100 }),
    ];
    expect(aggregateUsage(turns, { timeframe: "1h", now: NOW }).totals.input).toBe(1);
    expect(aggregateUsage(turns, { timeframe: "24h", now: NOW }).totals.input).toBe(11);
    expect(aggregateUsage(turns, { timeframe: "30d", now: NOW }).totals.input).toBe(111);
    expect(aggregateUsage(turns, { timeframe: "all", now: NOW }).totals.input).toBe(111);
  });

  it("counts undated turns only for the all timeframe", () => {
    const turns = [turn({ timestamp: undefined, input: 5 }), turn({ input: 1 })];
    const windowed = aggregateUsage(turns, { timeframe: "24h", now: NOW });
    expect(windowed.totals.input).toBe(1);
    expect(windowed.skippedUndated).toBe(1);

    const all = aggregateUsage(turns, { timeframe: "all", now: NOW });
    expect(all.totals.input).toBe(6);
    expect(all.skippedUndated).toBe(0);
  });

  it("sorts agents and models by total tokens descending", () => {
    const report = aggregateUsage(
      [
        turn({ agentId: "small", input: 1 }),
        turn({ agentId: "big", input: 1000 }),
        turn({ agentId: "big", model: "z.gguf", input: 5000 }),
      ],
      { timeframe: "all", now: NOW },
    );
    expect(report.agents.map((a) => a.agentId)).toEqual(["big", "small"]);
    expect(report.agents[0].models[0].key).toBe("llama.cpp/z.gguf");
  });

  it("returns an empty report for no turns", () => {
    const report = aggregateUsage([], { timeframe: "24h", now: NOW });
    expect(report.agents).toEqual([]);
    expect(totalTokens(report.totals)).toBe(0);
  });

  it("sums recorded positive costs and leaves unpriced models without a cost", () => {
    const report = aggregateUsage(
      [
        turn({ provider: "cloudburst", model: "grok-4.6", input: 1000, cost: 0.12 }),
        turn({ provider: "cloudburst", model: "grok-4.6", input: 500, cost: 0.04 }),
        turn({ provider: "llama.cpp", model: "a.gguf", input: 9000 }),
      ],
      { timeframe: "all", now: NOW },
    );
    expect(report.totals.cost).toBeCloseTo(0.16);
    const grok = report.agents[0].models.find((m) => m.key === "cloudburst/grok-4.6");
    const local = report.agents[0].models.find((m) => m.key === "llama.cpp/a.gguf");
    expect(grok?.cost).toBeCloseTo(0.16);
    expect(local?.cost).toBeUndefined();
  });

  it("estimates cost from a lookup when the transcript recorded none", () => {
    const lookup = (provider: string, model: string) =>
      provider === "cloudburst" && model === "grok-4.6"
        ? { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
        : undefined;
    const report = aggregateUsage(
      [
        turn({
          provider: "cloudburst",
          model: "grok-4.6",
          input: 1_000_000,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        }),
        turn({ provider: "llama.cpp", model: "a.gguf", input: 1_000_000 }),
      ],
      { timeframe: "all", now: NOW, costLookup: lookup },
    );
    expect(report.totals.cost).toBeCloseTo(3);
    expect(report.agents[0].models.find((m) => m.provider === "llama.cpp")?.cost).toBeUndefined();
  });

  it("prefers recorded cost over the estimated rate", () => {
    const lookup = () => ({ input: 99, output: 99, cacheRead: 99, cacheWrite: 99 });
    const report = aggregateUsage([turn({ input: 1_000_000, cost: 0.5 })], {
      timeframe: "all",
      now: NOW,
      costLookup: lookup,
    });
    expect(report.totals.cost).toBeCloseTo(0.5);
  });

  it("treats recorded zero cost as unpriced so local models stay blank", () => {
    const report = aggregateUsage([turn({ cost: 0 })], { timeframe: "all", now: NOW });
    expect(report.totals.cost).toBeUndefined();
  });
});

describe("costLookupFromConfig", () => {
  it("returns rates for priced models and ignores all-zero defaults", () => {
    const lookup = costLookupFromConfig({
      models: {
        providers: {
          cloudburst: {
            models: [
              { id: "grok-4.6", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
            ],
          },
          "llama.cpp": {
            models: [{ id: "a.gguf", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
          },
        },
      },
    });
    expect(lookup?.("cloudburst", "grok-4.6")?.input).toBe(3);
    expect(lookup?.("llama.cpp", "a.gguf")).toBeUndefined();
    expect(lookup?.("missing", "x")).toBeUndefined();
  });

  it("returns undefined when config has no providers", () => {
    expect(costLookupFromConfig(undefined)).toBeUndefined();
    expect(costLookupFromConfig({})).toBeUndefined();
  });
});

describe("transcript discovery and reading", () => {
  it("finds live transcripts per agent and skips tombstones", () => {
    const dir = makeStateDir({
      "agents/main/sessions/a.jsonl": "",
      "agents/main/sessions/b.jsonl": "",
      "agents/main/sessions/old.jsonl.deleted.2026-06-09T07-54-23.292Z": "",
      "agents/main/sessions/reset.jsonl.reset.2026-04-22T09-44-51.837Z": "",
      "agents/worker/sessions/c.jsonl": "",
      "agents/main/agent/notes.txt": "",
    });
    const found = listTranscriptFiles(dir);
    expect(found.map((f) => `${f.agentId}:${path.basename(f.file)}`).toSorted()).toEqual([
      "main:a.jsonl",
      "main:b.jsonl",
      "worker:c.jsonl",
    ]);
  });

  it("returns nothing when the state dir has no agents", () => {
    expect(listTranscriptFiles(makeStateDir({}))).toEqual([]);
    expect(listTranscriptFiles(path.join(os.tmpdir(), "definitely-missing-usage-dir"))).toEqual([]);
  });

  it("reads turns across agents and tolerates a torn trailing line", async () => {
    const dir = makeStateDir({
      "agents/main/sessions/a.jsonl": `${line({})}\n${line({
        model: "b.gguf",
      })}\n{"type":"message","mess`,
      "agents/worker/sessions/c.jsonl": `${line({ provider: "cloudburst", model: "grok-4.6" })}\n`,
    });
    const collected = await collectUsageTurns(dir);
    expect(collected).toHaveLength(3);
    expect(collected.filter((t) => t.agentId === "main")).toHaveLength(2);
    expect(collected.find((t) => t.agentId === "worker")?.provider).toBe("cloudburst");
  });

  it("builds a report end to end from disk", async () => {
    const recent = new Date(NOW - 60 * 1000).toISOString();
    const old = new Date(NOW - 40 * 24 * 60 * 60 * 1000).toISOString();
    const dir = makeStateDir({
      "agents/main/sessions/a.jsonl": [
        line({ ts: recent, usage: { input: 10, output: 2 } }),
        line({ ts: old, usage: { input: 999, output: 999 } }),
      ].join("\n"),
    });
    const report = await buildUsageReport({ timeframe: "24h", stateDir: dir, now: NOW });
    expect(report.totals).toMatchObject({ input: 10, output: 2, turns: 1 });

    const allTime = await buildUsageReport({ timeframe: "all", stateDir: dir, now: NOW });
    expect(allTime.totals.turns).toBe(2);
  });
});

const UTC = "UTC";
const DAY = 24 * 60 * 60 * 1000;

/** Midnight-anchored so day bucketing does not straddle a boundary by accident. */
const NOON = Date.parse("2026-08-27T12:00:00.000Z");

function detail(
  turns: UsageTurn[],
  over: { timeframe?: "1h" | "24h" | "7d" | "30d" | "all" } = {},
) {
  return aggregateAgentDetail(turns, {
    agentId: "main",
    timeframe: over.timeframe ?? "7d",
    now: NOON,
    timeZone: UTC,
  });
}

describe("formatDayKey", () => {
  it("formats a local-calendar day as YYYY-MM-DD", () => {
    expect(formatDayKey(Date.parse("2026-08-27T12:00:00.000Z"), UTC)).toBe("2026-08-27");
  });

  it("respects the supplied timezone across a day boundary", () => {
    const lateUtc = Date.parse("2026-08-27T23:30:00.000Z");
    expect(formatDayKey(lateUtc, UTC)).toBe("2026-08-27");
    expect(formatDayKey(lateUtc, "Asia/Tokyo")).toBe("2026-08-28");
    const earlyUtc = Date.parse("2026-08-27T00:30:00.000Z");
    expect(formatDayKey(earlyUtc, "America/Los_Angeles")).toBe("2026-08-26");
  });
});

describe("aggregateAgentDetail", () => {
  it("rolls up per model and per day for one agent", () => {
    const result = detail([
      turn({ timestamp: NOON, model: "a.gguf", input: 100, output: 10 }),
      turn({ timestamp: NOON - DAY, model: "a.gguf", input: 50, output: 5 }),
      turn({ timestamp: NOON - DAY, model: "b.gguf", input: 7, output: 1 }),
    ]);

    expect(result.agentId).toBe("main");
    expect(result.totals).toMatchObject({ input: 157, output: 16, turns: 3 });
    expect(result.models.map((m) => m.key)).toEqual(["llama.cpp/a.gguf", "llama.cpp/b.gguf"]);
    expect(result.models[0]).toMatchObject({ input: 150, output: 15, turns: 2 });

    expect(result.days.map((d) => d.day)).toEqual(["2026-08-27", "2026-08-26"]);
    expect(result.days[0]).toMatchObject({ input: 100, output: 10, turns: 1 });
    expect(result.days[1]).toMatchObject({ input: 57, output: 6, turns: 2 });
    expect(result.days[1].models.map((m) => m.key)).toEqual([
      "llama.cpp/a.gguf",
      "llama.cpp/b.gguf",
    ]);
  });

  it("orders days most recent first and models busiest first", () => {
    const result = detail([
      turn({ timestamp: NOON - 2 * DAY, input: 1 }),
      turn({ timestamp: NOON, input: 5 }),
      turn({ timestamp: NOON - DAY, input: 3 }),
      turn({ timestamp: NOON, model: "big.gguf", input: 9000 }),
    ]);
    expect(result.days.map((d) => d.day)).toEqual(["2026-08-27", "2026-08-26", "2026-08-25"]);
    expect(result.models[0].key).toBe("llama.cpp/big.gguf");
  });

  it("ignores turns belonging to other agents", () => {
    const result = detail([
      turn({ agentId: "main", input: 10 }),
      turn({ agentId: "worker", input: 999 }),
    ]);
    expect(result.totals).toMatchObject({ input: 10, turns: 1 });
    expect(result.days).toHaveLength(1);
  });

  it("applies the timeframe window", () => {
    const turns = [
      turn({ timestamp: NOON, input: 1 }),
      turn({ timestamp: NOON - 3 * DAY, input: 10 }),
      turn({ timestamp: NOON - 20 * DAY, input: 100 }),
    ];
    expect(detail(turns, { timeframe: "24h" }).totals.input).toBe(1);
    expect(detail(turns, { timeframe: "7d" }).totals.input).toBe(11);
    expect(detail(turns, { timeframe: "30d" }).totals.input).toBe(111);
    expect(detail(turns, { timeframe: "all" }).totals.input).toBe(111);
  });

  it("counts undated turns in model totals but leaves them out of the day view", () => {
    const result = detail(
      [turn({ timestamp: NOON, input: 5 }), turn({ timestamp: undefined, input: 7 })],
      { timeframe: "all" },
    );
    expect(result.totals).toMatchObject({ input: 12, turns: 2 });
    expect(result.models[0].input).toBe(12);
    expect(result.days).toHaveLength(1);
    expect(result.days[0].input).toBe(5);
    expect(result.skippedUndated).toBe(1);
  });

  it("excludes undated turns entirely from a bounded window", () => {
    const result = detail(
      [turn({ timestamp: NOON, input: 5 }), turn({ timestamp: undefined, input: 7 })],
      { timeframe: "7d" },
    );
    expect(result.totals).toMatchObject({ input: 5, turns: 1 });
    expect(result.skippedUndated).toBe(1);
  });

  it("groups turns on the same day into one row", () => {
    const result = detail([
      turn({ timestamp: Date.parse("2026-08-27T01:00:00.000Z"), input: 1 }),
      turn({ timestamp: Date.parse("2026-08-27T22:00:00.000Z"), input: 2 }),
    ]);
    expect(result.days).toHaveLength(1);
    expect(result.days[0]).toMatchObject({ day: "2026-08-27", input: 3, turns: 2 });
  });

  it("carries priced cost onto the matching day", () => {
    const result = aggregateAgentDetail(
      [
        turn({ timestamp: NOON, cost: 0.1, input: 10 }),
        turn({ timestamp: NOON - DAY, cost: 0.2, input: 20 }),
        turn({ timestamp: NOON - DAY, input: 5 }),
      ],
      { agentId: "main", timeframe: "7d", now: NOON, timeZone: UTC },
    );
    expect(result.totals.cost).toBeCloseTo(0.3);
    expect(result.days[0].cost).toBeCloseTo(0.1);
    expect(result.days[1].cost).toBeCloseTo(0.2);
  });

  it("flags a completely unknown agent separately from a quiet window", () => {
    const unknown = aggregateAgentDetail([turn({ agentId: "main" })], {
      agentId: "ghost",
      timeframe: "all",
      now: NOON,
      timeZone: UTC,
    });
    expect(unknown.agentExists).toBe(false);
    expect(unknown.totals.turns).toBe(0);

    const quiet = detail([turn({ timestamp: NOON - 60 * DAY })], { timeframe: "24h" });
    expect(quiet.agentExists).toBe(true);
    expect(quiet.totals.turns).toBe(0);
    expect(quiet.days).toEqual([]);
  });

  it("keeps same-named models from different providers separate within a day", () => {
    const result = detail([
      turn({ timestamp: NOON, provider: "llama.cpp", model: "claude-opus-5", input: 1 }),
      turn({ timestamp: NOON, provider: "cloudburst", model: "claude-opus-5", input: 2 }),
    ]);
    expect(result.days[0].models.map((m) => m.key).toSorted()).toEqual([
      "cloudburst/claude-opus-5",
      "llama.cpp/claude-opus-5",
    ]);
  });
});

describe("detail vs summary consistency", () => {
  const turns = [
    turn({ agentId: "main", timestamp: NOON, model: "a.gguf", input: 100, output: 5 }),
    turn({ agentId: "main", timestamp: NOON - DAY, model: "b.gguf", input: 40, cacheRead: 9 }),
    turn({ agentId: "main", timestamp: NOON - 2 * DAY, model: "a.gguf", input: 7 }),
    turn({ agentId: "worker", timestamp: NOON, model: "a.gguf", input: 999 }),
  ];

  it("reports the same per-model numbers as the all-agents summary", () => {
    for (const timeframe of ["24h", "7d", "30d", "all"] as const) {
      const summary = aggregateUsage(turns, { timeframe, now: NOON });
      const fromSummary = summary.agents.find((a) => a.agentId === "main");
      const detail = aggregateAgentDetail(turns, {
        agentId: "main",
        timeframe,
        now: NOON,
        timeZone: UTC,
      });
      expect(detail.totals.turns).toBe(fromSummary?.turns ?? 0);
      expect(detail.totals.input).toBe(fromSummary?.input ?? 0);
      expect(detail.models.map((m) => [m.key, totalTokens(m)])).toEqual(
        (fromSummary?.models ?? []).map((m) => [m.key, totalTokens(m)]),
      );
    }
  });

  it("day rows re-sum to the window totals", () => {
    const detail = aggregateAgentDetail(turns, {
      agentId: "main",
      timeframe: "all",
      now: NOON,
      timeZone: UTC,
    });
    const summed = detail.days.reduce(
      (acc, day) => ({
        input: acc.input + day.input,
        output: acc.output + day.output,
        cacheRead: acc.cacheRead + day.cacheRead,
        turns: acc.turns + day.turns,
      }),
      { input: 0, output: 0, cacheRead: 0, turns: 0 },
    );
    expect(summed).toEqual({
      input: detail.totals.input,
      output: detail.totals.output,
      cacheRead: detail.totals.cacheRead,
      turns: detail.totals.turns,
    });
  });
});

describe("parseUsageCommandArgs", () => {
  it("defaults to the summary view over the default timeframe", () => {
    expect(parseUsageCommandArgs("")).toEqual({ kind: "summary", timeframe: "24h" });
    expect(parseUsageCommandArgs("   ")).toEqual({ kind: "summary", timeframe: "24h" });
  });

  it("reads a bare timeframe as a summary request", () => {
    expect(parseUsageCommandArgs("7d")).toEqual({ kind: "summary", timeframe: "7d" });
    expect(parseUsageCommandArgs("ALL")).toEqual({ kind: "summary", timeframe: "all" });
  });

  it("reads a bare agent id as a detail request on the default timeframe", () => {
    expect(parseUsageCommandArgs("main")).toEqual({
      kind: "agent",
      agentId: "main",
      timeframe: "24h",
    });
  });

  it("accepts agent and timeframe in either order", () => {
    expect(parseUsageCommandArgs("main 7d")).toEqual({
      kind: "agent",
      agentId: "main",
      timeframe: "7d",
    });
    expect(parseUsageCommandArgs("7d main")).toEqual({
      kind: "agent",
      agentId: "main",
      timeframe: "7d",
    });
  });

  it("preserves agent id case while normalizing the timeframe", () => {
    expect(parseUsageCommandArgs("MyAgent 30D")).toEqual({
      kind: "agent",
      agentId: "MyAgent",
      timeframe: "30d",
    });
  });

  it("rejects a duplicate timeframe or a stray extra token", () => {
    expect(parseUsageCommandArgs("7d 24h")).toEqual({ kind: "invalid", token: "24h" });
    expect(parseUsageCommandArgs("main worker")).toEqual({ kind: "invalid", token: "worker" });
    expect(parseUsageCommandArgs("main 7d extra")).toEqual({ kind: "invalid", token: "extra" });
  });

  it("tolerates extra whitespace between tokens", () => {
    expect(parseUsageCommandArgs("  main   7d  ")).toEqual({
      kind: "agent",
      agentId: "main",
      timeframe: "7d",
    });
  });
});

describe("agent id listing", () => {
  it("lists distinct agent ids from turns, sorted", () => {
    expect(listAgentIds([turn({ agentId: "worker" }), turn({ agentId: "main" }), turn()])).toEqual([
      "main",
      "worker",
    ]);
    expect(listAgentIds([])).toEqual([]);
  });

  it("lists agent ids from disk without reading transcripts", () => {
    const dir = makeStateDir({
      "agents/worker/sessions/a.jsonl": "",
      "agents/main/sessions/b.jsonl": "",
    });
    expect(listKnownAgentIds(dir)).toEqual(["main", "worker"]);
  });

  it("builds an agent detail end to end from disk", async () => {
    const dir = makeStateDir({
      "agents/main/sessions/a.jsonl": [
        line({ ts: new Date(NOON).toISOString(), usage: { input: 10, output: 2 } }),
        line({ ts: new Date(NOON - DAY).toISOString(), usage: { input: 4, output: 1 } }),
      ].join("\n"),
      "agents/worker/sessions/b.jsonl": line({
        ts: new Date(NOON).toISOString(),
        usage: { input: 999 },
      }),
    });
    const result = await buildAgentUsageDetail({
      agentId: "main",
      timeframe: "7d",
      stateDir: dir,
      now: NOON,
      timeZone: UTC,
    });
    expect(result.totals).toMatchObject({ input: 14, output: 3, turns: 2 });
    expect(result.days.map((d) => d.day)).toEqual(["2026-08-27", "2026-08-26"]);
  });
});
