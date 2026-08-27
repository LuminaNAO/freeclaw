import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { resolveStateDir } from "../config/paths.js";

/** Timeframe windows offered by the usage view. */
export const USAGE_TIMEFRAMES = ["1h", "24h", "7d", "30d", "all"] as const;

export type UsageTimeframe = (typeof USAGE_TIMEFRAMES)[number];

export const DEFAULT_USAGE_TIMEFRAME: UsageTimeframe = "24h";

const TIMEFRAME_MS: Record<Exclude<UsageTimeframe, "all">, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

/** A single assistant turn's usage, already tied to an agent/provider/model. */
export type UsageTurn = {
  agentId: string;
  provider: string;
  model: string;
  /** Epoch milliseconds. Turns without a parsable timestamp get `undefined`. */
  timestamp?: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type UsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  turns: number;
};

export type ModelUsage = UsageTotals & {
  provider: string;
  model: string;
  /** `provider/model`, the label shown in the TUI. */
  key: string;
};

export type AgentUsage = UsageTotals & {
  agentId: string;
  models: ModelUsage[];
};

export type UsageReport = {
  timeframe: UsageTimeframe;
  /** Inclusive lower bound in epoch ms; `undefined` for the `all` timeframe. */
  since?: number;
  agents: AgentUsage[];
  totals: UsageTotals;
  /** Turns skipped because they carried no parsable timestamp but a window was set. */
  skippedUndated: number;
};

export function isUsageTimeframe(value: string): value is UsageTimeframe {
  return (USAGE_TIMEFRAMES as readonly string[]).includes(value);
}

/**
 * Lower bound for a timeframe. `all` has no bound.
 * `now` is injected so tests stay deterministic.
 */
export function resolveSince(timeframe: UsageTimeframe, now: number): number | undefined {
  if (timeframe === "all") {
    return undefined;
  }
  return now - TIMEFRAME_MS[timeframe];
}

function toCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function emptyTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };
}

function addTurn(totals: UsageTotals, turn: UsageTurn): void {
  totals.input += turn.input;
  totals.output += turn.output;
  totals.cacheRead += turn.cacheRead;
  totals.cacheWrite += turn.cacheWrite;
  totals.turns += 1;
}

export function totalTokens(totals: UsageTotals): number {
  return totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
}

/**
 * Parse one transcript line into a usage turn.
 * Returns `undefined` for any line that is not an assistant message carrying usage,
 * so callers can feed raw JSONL straight through.
 */
export function parseUsageLine(line: string, agentId: string): UsageTurn | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  let record: unknown;
  try {
    record = JSON.parse(trimmed);
  } catch {
    // Transcripts can end mid-write; a torn last line is expected, not an error.
    return undefined;
  }
  if (!record || typeof record !== "object") {
    return undefined;
  }
  const row = record as Record<string, unknown>;
  const message = row.message;
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const msg = message as Record<string, unknown>;
  const usage = msg.usage;
  if (!usage || typeof usage !== "object") {
    return undefined;
  }
  const u = usage as Record<string, unknown>;
  const input = toCount(u.input);
  const output = toCount(u.output);
  const cacheRead = toCount(u.cacheRead);
  const cacheWrite = toCount(u.cacheWrite);
  // A record with a usage object but no positive counters carries no signal.
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) {
    return undefined;
  }
  const rawTs = typeof row.timestamp === "string" ? row.timestamp : undefined;
  const fallbackTs = typeof msg.timestamp === "string" ? msg.timestamp : undefined;
  const parsedTs = Date.parse(rawTs ?? fallbackTs ?? "");
  return {
    agentId,
    provider: typeof msg.provider === "string" && msg.provider ? msg.provider : "unknown",
    model: typeof msg.model === "string" && msg.model ? msg.model : "unknown",
    timestamp: Number.isFinite(parsedTs) ? parsedTs : undefined,
    input,
    output,
    cacheRead,
    cacheWrite,
  };
}

/**
 * Model ids are sometimes absolute paths to a local weights file. Show the
 * basename so the table stays readable, but keep provider scoping intact.
 */
export function formatModelKey(provider: string, model: string): string {
  const compact = model.includes("/") ? (model.split("/").pop() ?? model) : model;
  return `${provider}/${compact || model}`;
}

/** Aggregate turns per agent and per model. Pure: no I/O, no clock reads. */
export function aggregateUsage(
  turns: Iterable<UsageTurn>,
  options: { timeframe: UsageTimeframe; now: number },
): UsageReport {
  const since = resolveSince(options.timeframe, options.now);
  const byAgent = new Map<string, { totals: UsageTotals; models: Map<string, ModelUsage> }>();
  const totals = emptyTotals();
  let skippedUndated = 0;

  for (const turn of turns) {
    if (since !== undefined) {
      if (turn.timestamp === undefined) {
        skippedUndated += 1;
        continue;
      }
      if (turn.timestamp < since) {
        continue;
      }
    }
    let agent = byAgent.get(turn.agentId);
    if (!agent) {
      agent = { totals: emptyTotals(), models: new Map() };
      byAgent.set(turn.agentId, agent);
    }
    const key = formatModelKey(turn.provider, turn.model);
    let model = agent.models.get(key);
    if (!model) {
      model = { ...emptyTotals(), provider: turn.provider, model: turn.model, key };
      agent.models.set(key, model);
    }
    addTurn(model, turn);
    addTurn(agent.totals, turn);
    addTurn(totals, turn);
  }

  const agents: AgentUsage[] = [...byAgent.entries()]
    .map(([agentId, entry]) => ({
      agentId,
      ...entry.totals,
      models: [...entry.models.values()].toSorted((a, b) => totalTokens(b) - totalTokens(a)),
    }))
    .toSorted((a, b) => totalTokens(b) - totalTokens(a));

  return { timeframe: options.timeframe, since, agents, totals, skippedUndated };
}

/**
 * Locate transcript files. Agent id is the directory under `agents/`, which is
 * how sessions are partitioned on disk.
 */
export function listTranscriptFiles(stateDir: string): Array<{ file: string; agentId: string }> {
  const agentsDir = path.join(stateDir, "agents");
  let agentIds: string[] = [];
  try {
    agentIds = fs
      .readdirSync(agentsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const out: Array<{ file: string; agentId: string }> = [];
  for (const agentId of agentIds.toSorted()) {
    const sessionsDir = path.join(agentsDir, agentId, "sessions");
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      // Skip `.deleted.*` / `.reset.*` tombstones; only live transcripts count.
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      out.push({ file: path.join(sessionsDir, entry.name), agentId });
    }
  }
  return out;
}

/** Stream one transcript line-by-line so large sessions never load fully into memory. */
async function* readTurns(file: string, agentId: string): AsyncGenerator<UsageTurn> {
  let stream: fs.ReadStream;
  try {
    stream = fs.createReadStream(file, { encoding: "utf8" });
  } catch {
    return;
  }
  try {
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      const turn = parseUsageLine(line, agentId);
      if (turn) {
        yield turn;
      }
    }
  } catch {
    // An unreadable transcript should not sink the whole report.
  } finally {
    stream.destroy();
  }
}

/** Collect every recorded usage turn from disk. */
export async function collectUsageTurns(stateDir = resolveStateDir()): Promise<UsageTurn[]> {
  const files = listTranscriptFiles(stateDir);
  const turns: UsageTurn[] = [];
  for (const { file, agentId } of files) {
    for await (const turn of readTurns(file, agentId)) {
      turns.push(turn);
    }
  }
  return turns;
}

/** Read from disk and aggregate. */
export async function buildUsageReport(options: {
  timeframe?: UsageTimeframe;
  stateDir?: string;
  now?: number;
}): Promise<UsageReport> {
  const timeframe = options.timeframe ?? DEFAULT_USAGE_TIMEFRAME;
  const turns = await collectUsageTurns(options.stateDir ?? resolveStateDir());
  return aggregateUsage(turns, { timeframe, now: options.now ?? Date.now() });
}
