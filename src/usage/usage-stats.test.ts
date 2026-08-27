import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  aggregateUsage,
  buildUsageReport,
  collectUsageTurns,
  formatModelKey,
  isUsageTimeframe,
  listTranscriptFiles,
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
