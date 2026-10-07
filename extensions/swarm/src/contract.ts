import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import {
  ANY,
  ROLE_PLACEHOLDER,
  TASKMASTER,
  TEMPLATES,
  UPSTREAM,
  type RouteRow,
} from "./routing.js";

// Task contract (ARCH §3).

export class SwarmContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwarmContractError";
  }
}

export type WorkerSpec = {
  count: 1;
  model?: string;
  thinking?: string;
};

export type UpstreamChannel = { kind: string; to: string };

export type UpstreamSpec = {
  sessionKey?: string;
  channel?: UpstreamChannel;
  events: string[];
};

export type Contract = {
  id: string;
  kind: string;
  input: string;
  done_when: string;
  workers: Record<string, WorkerSpec>;
  routes: RouteRow[];
  upstream: UpstreamSpec;
  /** `step_silence` is accepted in old contracts and ignored (ARCH §7). */
  budget: { wall: string };
  repo?: string;
};

export type ContractDefaults = {
  defaultModel?: string;
  defaultThinking?: string;
  upstream?: {
    sessionKey?: string;
    channel?: UpstreamChannel;
    events?: string[];
  };
  budget?: { wall?: string; step_silence?: string };
};

export const TASK_ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const ROLE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const RESERVED_ROLES = new Set([TASKMASTER, UPSTREAM]);
const DEFAULT_UPSTREAM_EVENTS = ["DONE", "BLOCKED", "FAILED"];
const DEFAULT_WALL = "4h";
const TOP_LEVEL_KEYS = new Set([
  "id",
  "kind",
  "input",
  "done_when",
  "workers",
  "routes",
  "upstream",
  "budget",
  "repo",
]);
const CHILD_TASK_KEYS = ["parent", "children", "child_tasks", "childTasks"];
const WORKER_KEYS = new Set(["count", "model", "thinking", "join"]);

const DURATION_RE = /^(\d+)\s*(ms|s|m|h|d)$/;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseDuration(value: string): number {
  const match = DURATION_RE.exec(value.trim());
  if (!match) {
    throw new SwarmContractError(`invalid duration "${value}" (use e.g. 90s, 30m, 4h)`);
  }
  const ms = Number(match[1]) * (UNIT_MS[match[2] ?? ""] ?? 0);
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new SwarmContractError(`invalid duration "${value}": must be positive`);
  }
  return ms;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(obj: Record<string, unknown>, key: string, where = "contract"): string {
  const value = obj[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new SwarmContractError(`${where}.${key} is required and must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, where: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new SwarmContractError(`${where} must be a non-empty string`);
  }
  return value.trim();
}

function parseWorkers(raw: unknown, defaults: ContractDefaults): Record<string, WorkerSpec> {
  if (!isRecord(raw) || Object.keys(raw).length === 0) {
    throw new SwarmContractError("contract.workers must declare at least one role");
  }
  const workers: Record<string, WorkerSpec> = {};
  for (const [role, spec] of Object.entries(raw)) {
    const where = `contract.workers.${role}`;
    if (!ROLE_RE.test(role) || RESERVED_ROLES.has(role)) {
      throw new SwarmContractError(`${where}: invalid role name`);
    }
    const value = spec ?? {};
    if (!isRecord(value)) {
      throw new SwarmContractError(`${where} must be a mapping`);
    }
    for (const key of Object.keys(value)) {
      if (!WORKER_KEYS.has(key)) {
        throw new SwarmContractError(`${where}.${key} is not a known worker field`);
      }
    }
    if ("join" in value) {
      throw new SwarmContractError(
        `${where}.join is reserved for fan-out/join (ARCH §6) and not supported in the MVP`,
      );
    }
    const count = value.count ?? 1;
    if (count !== 1) {
      throw new SwarmContractError(
        `${where}.count must be 1; count > 1 is reserved for fan-out (ARCH §6)`,
      );
    }
    workers[role] = {
      count: 1,
      model: optionalString(value.model, `${where}.model`) ?? defaults.defaultModel,
      thinking: optionalString(value.thinking, `${where}.thinking`) ?? defaults.defaultThinking,
    };
  }
  return workers;
}

function parseRoutes(raw: unknown, kind: string, roles: Set<string>): RouteRow[] {
  if (raw === undefined || raw === null) {
    const template = TEMPLATES[kind];
    if (!template) {
      throw new SwarmContractError(`contract.kind "${kind}" has no template; supply routes`);
    }
    return template as RouteRow[];
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new SwarmContractError("contract.routes must be a non-empty list");
  }
  return raw.map((row, i) => {
    const where = `contract.routes[${i}]`;
    if (!isRecord(row)) {
      throw new SwarmContractError(`${where} must be a mapping`);
    }
    if ("join" in row) {
      throw new SwarmContractError(`${where}.join is reserved for fan-out/join (ARCH §6)`);
    }
    if (row.count !== undefined && row.count !== 1) {
      throw new SwarmContractError(`${where}.count must be 1 (fan-out is reserved, ARCH §6)`);
    }
    const on = requireString(row, "on", where);
    const from = requireString(row, "from", where);
    const to = requireString(row, "to", where);
    const message = typeof row.message === "string" ? row.message : on.toLowerCase();
    if (from !== ANY && from !== TASKMASTER && !roles.has(from)) {
      throw new SwarmContractError(`${where}.from "${from}" is not a declared role`);
    }
    if (to !== TASKMASTER && to !== UPSTREAM && to !== ROLE_PLACEHOLDER && !roles.has(to)) {
      throw new SwarmContractError(`${where}.to "${to}" is not a declared role`);
    }
    return { on, from, to, message };
  });
}

function parseChannel(raw: unknown, where: string): UpstreamChannel | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!isRecord(raw)) {
    throw new SwarmContractError(`${where} must be a mapping { kind, to }`);
  }
  return { kind: requireString(raw, "kind", where), to: requireString(raw, "to", where) };
}

function parseUpstream(raw: unknown, defaults: ContractDefaults): UpstreamSpec {
  const value = raw ?? {};
  if (!isRecord(value)) {
    throw new SwarmContractError("contract.upstream must be a mapping");
  }
  const events = value.events ?? defaults.upstream?.events ?? DEFAULT_UPSTREAM_EVENTS;
  if (!Array.isArray(events) || events.some((e) => typeof e !== "string")) {
    throw new SwarmContractError("contract.upstream.events must be a list of event names");
  }
  return {
    sessionKey:
      optionalString(value.sessionKey, "contract.upstream.sessionKey") ??
      defaults.upstream?.sessionKey,
    channel: parseChannel(value.channel, "contract.upstream.channel") ?? defaults.upstream?.channel,
    events: events as string[],
  };
}

function parseBudget(raw: unknown, defaults: ContractDefaults) {
  const value = raw ?? {};
  if (!isRecord(value)) {
    throw new SwarmContractError("contract.budget must be a mapping");
  }
  const wall = optionalString(value.wall, "contract.budget.wall") ?? defaults.budget?.wall;
  const budget = { wall: wall ?? DEFAULT_WALL };
  parseDuration(budget.wall);
  return budget;
}

export function parseContract(yamlText: string, defaults: ContractDefaults = {}): Contract {
  let doc: unknown;
  try {
    doc = YAML.parse(yamlText);
  } catch (err) {
    throw new SwarmContractError(`contract is not valid YAML: ${String(err)}`);
  }
  if (!isRecord(doc)) {
    throw new SwarmContractError("contract must be a YAML mapping");
  }
  for (const key of CHILD_TASK_KEYS) {
    if (key in doc) {
      throw new SwarmContractError(`contract.${key}: child tasks are post-MVP (ARCH §2, §9)`);
    }
  }
  for (const key of Object.keys(doc)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      throw new SwarmContractError(`contract.${key} is not a known contract field`);
    }
  }
  const id = requireString(doc, "id");
  if (!TASK_ID_RE.test(id)) {
    throw new SwarmContractError(`contract.id "${id}" must match ${TASK_ID_RE.source}`);
  }
  const kind = typeof doc.kind === "string" && doc.kind.trim() ? doc.kind.trim() : "build";
  const workers = parseWorkers(doc.workers, defaults);
  const contract: Contract = {
    id,
    kind,
    input: requireString(doc, "input"),
    done_when: requireString(doc, "done_when"),
    workers,
    routes: parseRoutes(doc.routes, kind, new Set(Object.keys(workers))),
    upstream: parseUpstream(doc.upstream, defaults),
    budget: parseBudget(doc.budget, defaults),
  };
  const repo = optionalString(doc.repo, "contract.repo");
  if (repo) {
    if (!path.isAbsolute(repo)) {
      throw new SwarmContractError("contract.repo must be an absolute path");
    }
    contract.repo = repo;
  }
  return contract;
}

export function serializeContract(contract: Contract): string {
  return YAML.stringify(contract);
}

export function taskDirFor(stateDir: string, taskId: string): string {
  if (!TASK_ID_RE.test(taskId)) {
    throw new SwarmContractError(`invalid task id "${taskId}"`);
  }
  return path.join(stateDir, "swarm", taskId);
}

export function loadContract(
  stateDir: string,
  taskId: string,
  defaults: ContractDefaults = {},
): Contract {
  const file = path.join(taskDirFor(stateDir, taskId), "contract.yaml");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new SwarmContractError(`task "${taskId}" not found`);
  }
  return parseContract(text, defaults);
}
