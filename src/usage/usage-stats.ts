import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { resolveStateDir } from "../config/paths.js";
import { estimateUsageCost, type ModelCostConfig } from "../utils/usage-format.js";

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
  /** Transcript/session filename without the `.jsonl` suffix. */
  sessionId: string;
  provider: string;
  model: string;
  /** Epoch milliseconds. Turns without a parsable timestamp get `undefined`. */
  timestamp?: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Recorded USD cost when the provider billed a positive amount. */
  cost?: number;
};

export type UsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  turns: number;
  /**
   * Sum of priced turns only. Absent when nothing in the bucket has a rate
   * or a recorded cost, so the renderer can hide the column for local-only use.
   */
  cost?: number;
};

/** Optional per-model rate table (USD per million tokens). */
export type CostLookup = (provider: string, model: string) => ModelCostConfig | undefined;

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

export type SessionUsage = UsageTotals & {
  sessionId: string;
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

/** One local-calendar day of activity for a single agent. */
export type DayUsage = UsageTotals & {
  /** Local-calendar day key, `YYYY-MM-DD`. */
  day: string;
  /** Model keys active that day, busiest first. */
  models: ModelUsage[];
};

export type AgentUsageDetail = {
  agentId: string;
  timeframe: UsageTimeframe;
  since?: number;
  /** Per-model rollup across the whole window, busiest first. */
  models: ModelUsage[];
  /** Per-session rollup across the selected window, busiest first. */
  sessions: SessionUsage[];
  /** Per-day rollup across the window, most recent first. */
  days: DayUsage[];
  totals: UsageTotals;
  skippedUndated: number;
  /** False when the agent has no recorded turns at all (bad id vs quiet window). */
  agentExists: boolean;
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

function addTurn(totals: UsageTotals, turn: UsageTurn, cost?: number): void {
  totals.input += turn.input;
  totals.output += turn.output;
  totals.cacheRead += turn.cacheRead;
  totals.cacheWrite += turn.cacheWrite;
  totals.turns += 1;
  if (cost !== undefined) {
    totals.cost = (totals.cost ?? 0) + cost;
  }
}

/** Positive finite USD only — zero-rate local models stay unpriced, not "$0.00". */
export function pricedCost(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function resolveTurnCost(turn: UsageTurn, lookup?: CostLookup): number | undefined {
  const recorded = pricedCost(turn.cost);
  if (recorded !== undefined) {
    return recorded;
  }
  if (!lookup) {
    return undefined;
  }
  return pricedCost(
    estimateUsageCost({
      usage: {
        input: turn.input,
        output: turn.output,
        cacheRead: turn.cacheRead,
        cacheWrite: turn.cacheWrite,
      },
      cost: lookup(turn.provider, turn.model),
    }),
  );
}

export function totalTokens(totals: UsageTotals): number {
  return totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
}

/**
 * Parse one transcript line into a usage turn.
 * Returns `undefined` for any line that is not an assistant message carrying usage,
 * so callers can feed raw JSONL straight through.
 */
export function parseUsageLine(
  line: string,
  agentId: string,
  sessionId = "unknown-session",
): UsageTurn | undefined {
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
  const rawCost = u.cost;
  const recordedTotal =
    rawCost && typeof rawCost === "object" ? (rawCost as Record<string, unknown>).total : undefined;
  const recordedCost = pricedCost(typeof recordedTotal === "number" ? recordedTotal : undefined);
  return {
    agentId,
    sessionId,
    provider: typeof msg.provider === "string" && msg.provider ? msg.provider : "unknown",
    model: typeof msg.model === "string" && msg.model ? msg.model : "unknown",
    timestamp: Number.isFinite(parsedTs) ? parsedTs : undefined,
    input,
    output,
    cacheRead,
    cacheWrite,
    cost: recordedCost,
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

/**
 * Local-calendar day key for a turn, matching the `en-CA` (`YYYY-MM-DD`) convention
 * used elsewhere in the repo. Timezone is injectable so tests are deterministic
 * regardless of the host clock.
 */
export function formatDayKey(timestamp: number, timeZone?: string): string {
  return new Date(timestamp).toLocaleDateString("en-CA", {
    timeZone: timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
}

/** Accumulate a turn into a model map keyed by `provider/model`. */
function accumulateModel(models: Map<string, ModelUsage>, turn: UsageTurn, cost?: number): void {
  const key = formatModelKey(turn.provider, turn.model);
  let model = models.get(key);
  if (!model) {
    model = { ...emptyTotals(), provider: turn.provider, model: turn.model, key };
    models.set(key, model);
  }
  addTurn(model, turn, cost);
}

const byTokensDesc = (a: UsageTotals, b: UsageTotals): number => totalTokens(b) - totalTokens(a);

/** Aggregate turns per agent and per model. Pure: no I/O, no clock reads. */
export function aggregateUsage(
  turns: Iterable<UsageTurn>,
  options: { timeframe: UsageTimeframe; now: number; costLookup?: CostLookup },
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
    const cost = resolveTurnCost(turn, options.costLookup);
    accumulateModel(agent.models, turn, cost);
    addTurn(agent.totals, turn, cost);
    addTurn(totals, turn, cost);
  }

  const agents: AgentUsage[] = [...byAgent.entries()]
    .map(([agentId, entry]) => ({
      agentId,
      ...entry.totals,
      models: [...entry.models.values()].toSorted(byTokensDesc),
    }))
    .toSorted(byTokensDesc);

  return { timeframe: options.timeframe, since, agents, totals, skippedUndated };
}

/**
 * Aggregate one agent's turns into a per-model rollup plus a per-day breakdown.
 * Pure: no I/O, no clock reads. `timeZone` is injectable for deterministic tests.
 */
export function aggregateAgentDetail(
  turns: Iterable<UsageTurn>,
  options: {
    agentId: string;
    timeframe: UsageTimeframe;
    now: number;
    timeZone?: string;
    costLookup?: CostLookup;
  },
): AgentUsageDetail {
  const since = resolveSince(options.timeframe, options.now);
  const models = new Map<string, ModelUsage>();
  const sessions = new Map<string, { totals: UsageTotals; models: Map<string, ModelUsage> }>();
  const days = new Map<string, { totals: UsageTotals; models: Map<string, ModelUsage> }>();
  const totals = emptyTotals();
  let skippedUndated = 0;
  let agentExists = false;

  for (const turn of turns) {
    if (turn.agentId !== options.agentId) {
      continue;
    }
    // Seen at all, even outside the window — distinguishes a typo'd id from a quiet window.
    agentExists = true;
    if (since !== undefined) {
      if (turn.timestamp === undefined) {
        skippedUndated += 1;
        continue;
      }
      if (turn.timestamp < since) {
        continue;
      }
    }
    const cost = resolveTurnCost(turn, options.costLookup);
    accumulateModel(models, turn, cost);
    addTurn(totals, turn, cost);
    let session = sessions.get(turn.sessionId);
    if (!session) {
      session = { totals: emptyTotals(), models: new Map() };
      sessions.set(turn.sessionId, session);
    }
    accumulateModel(session.models, turn, cost);
    addTurn(session.totals, turn, cost);
    if (turn.timestamp === undefined) {
      // Counts toward model totals, but cannot be placed on a calendar day.
      skippedUndated += 1;
      continue;
    }
    const day = formatDayKey(turn.timestamp, options.timeZone);
    let bucket = days.get(day);
    if (!bucket) {
      bucket = { totals: emptyTotals(), models: new Map() };
      days.set(day, bucket);
    }
    accumulateModel(bucket.models, turn, cost);
    addTurn(bucket.totals, turn, cost);
  }

  const dayRows: DayUsage[] = [...days.entries()]
    .map(([day, entry]) => ({
      day,
      ...entry.totals,
      models: [...entry.models.values()].toSorted(byTokensDesc),
    }))
    // Most recent first; day keys are zero-padded so lexical order is chronological.
    .toSorted((a, b) => b.day.localeCompare(a.day));

  return {
    agentId: options.agentId,
    timeframe: options.timeframe,
    since,
    models: [...models.values()].toSorted(byTokensDesc),
    sessions: [...sessions.entries()]
      .map(([sessionId, entry]) => ({
        sessionId,
        ...entry.totals,
        models: [...entry.models.values()].toSorted(byTokensDesc),
      }))
      .toSorted(byTokensDesc),
    days: dayRows,
    totals,
    skippedUndated,
    agentExists,
  };
}

/** Agent ids that have at least one recorded usage turn, for error hints. */
export function listAgentIds(turns: Iterable<UsageTurn>): string[] {
  return [...new Set([...turns].map((turn) => turn.agentId))].toSorted((a, b) =>
    a.localeCompare(b),
  );
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
  const sessionId = path.basename(file, ".jsonl");
  let stream: fs.ReadStream;
  try {
    stream = fs.createReadStream(file, { encoding: "utf8" });
  } catch {
    return;
  }
  try {
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      const turn = parseUsageLine(line, agentId, sessionId);
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

export type UsageCommandArgs =
  | { kind: "summary"; timeframe: UsageTimeframe }
  | { kind: "agent"; agentId: string; timeframe: UsageTimeframe }
  | { kind: "invalid"; token: string };

/**
 * Parse `/usagestats [agentId] [timeframe]`. Both are optional and order does not
 * matter, since a timeframe is never a valid agent id. A second non-timeframe
 * token is rejected rather than silently ignored.
 */
export function parseUsageCommandArgs(raw: string): UsageCommandArgs {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  let timeframe: UsageTimeframe | undefined;
  let agentId: string | undefined;

  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (isUsageTimeframe(lower)) {
      if (timeframe) {
        return { kind: "invalid", token };
      }
      timeframe = lower;
      continue;
    }
    if (agentId) {
      return { kind: "invalid", token };
    }
    agentId = token;
  }

  const resolved = timeframe ?? DEFAULT_USAGE_TIMEFRAME;
  return agentId
    ? { kind: "agent", agentId, timeframe: resolved }
    : { kind: "summary", timeframe: resolved };
}

/**
 * Agent ids that have transcript directories on disk. Cheaper than reading every
 * transcript when all we need is a "did you mean" hint.
 */
export function listKnownAgentIds(stateDir = resolveStateDir()): string[] {
  return [...new Set(listTranscriptFiles(stateDir).map((entry) => entry.agentId))].toSorted(
    (a, b) => a.localeCompare(b),
  );
}

/** Build a lookup from config `models.providers[].models[].cost` rates. */
export function costLookupFromConfig(
  config:
    | {
        models?: {
          providers?: Record<string, { models?: Array<{ id: string; cost?: ModelCostConfig }> }>;
        };
      }
    | undefined,
): CostLookup | undefined {
  if (!config?.models?.providers) {
    return undefined;
  }
  const providers = config.models.providers;
  return (provider, model) => {
    const entry = providers[provider]?.models?.find((item) => item.id === model);
    const cost = entry?.cost;
    if (!cost) {
      return undefined;
    }
    // All-zero rates are the default for local models; treat them as unpriced.
    if (cost.input === 0 && cost.output === 0 && cost.cacheRead === 0 && cost.cacheWrite === 0) {
      return undefined;
    }
    return cost;
  };
}

/** Read from disk and aggregate one agent's detail view. */
export async function buildAgentUsageDetail(options: {
  agentId: string;
  timeframe?: UsageTimeframe;
  stateDir?: string;
  now?: number;
  timeZone?: string;
  costLookup?: CostLookup;
}): Promise<AgentUsageDetail> {
  const timeframe = options.timeframe ?? DEFAULT_USAGE_TIMEFRAME;
  const turns = await collectUsageTurns(options.stateDir ?? resolveStateDir());
  return aggregateAgentDetail(turns, {
    agentId: options.agentId,
    timeframe,
    now: options.now ?? Date.now(),
    timeZone: options.timeZone,
    costLookup: options.costLookup,
  });
}

/** Read from disk and aggregate. */
export async function buildUsageReport(options: {
  timeframe?: UsageTimeframe;
  stateDir?: string;
  now?: number;
  costLookup?: CostLookup;
}): Promise<UsageReport> {
  const timeframe = options.timeframe ?? DEFAULT_USAGE_TIMEFRAME;
  const turns = await collectUsageTurns(options.stateDir ?? resolveStateDir());
  return aggregateUsage(turns, {
    timeframe,
    now: options.now ?? Date.now(),
    costLookup: options.costLookup,
  });
}
