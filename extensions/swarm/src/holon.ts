import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import {
  loadContract,
  parseContract,
  SwarmContractError,
  taskDirFor,
  type Contract,
  type ContractDefaults,
  type WorkerSpec,
} from "./contract.js";
import { ANY as ANY_ROLE, ROLE_PLACEHOLDER, TASKMASTER, type RouteRow } from "./routing.js";

// The holon file (ARCH §2) and derived state. A v1 contract.yaml is a root holon whose lead
// is the gateway default model (ARCH §11); a v2 holon.yaml carries lead, lanes, canon and
// children. Steps 3-5 of §10 (children, commands, human leads) are not built yet; the file
// format carries them so nothing is designed out.

export type Join = { kind: "all" } | { kind: "any" } | { kind: "quorum"; k: number };

export type Lane = {
  role: string;
  count: number;
  models: (string | undefined)[];
  thinking?: string;
  partition: boolean;
  join: Join;
};

export type LeadSpec = { kind: "agent"; model?: string; thinking?: string };

export type Canon = {
  scope?: string;
  never: string[];
  approve: string[];
  depth?: number;
};

export type Holon = {
  contract: Contract;
  lead: LeadSpec;
  lanes: Lane[];
  children: string[];
  canon: Canon;
  /** True when the on-disk file is a v1 contract.yaml (single role lanes, no lead key). */
  v1: boolean;
};

export type HolonState = "planning" | "running" | "blocked" | "done" | "failed" | "cancelled";

export const HOLON_FILE = "holon.yaml";
const ROLE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const LANE_KEYS = new Set(["count", "model", "thinking", "join", "partition"]);
const JOIN_RE = /^(all|any|quorum:(\d+))$/;
const TERMINAL = new Set(["DONE", "FAILED", "CANCELLED"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJoin(raw: unknown, where: string): Join {
  if (raw === undefined || raw === null) {
    return { kind: "all" };
  }
  if (typeof raw !== "string") {
    throw new SwarmContractError(`${where}.join must be a string (all | quorum:<k> | any)`);
  }
  const match = JOIN_RE.exec(raw.trim());
  if (!match) {
    throw new SwarmContractError(
      `${where}.join "${raw}" is not a join; use all, any or quorum:<k>`,
    );
  }
  if (match[1] === "all") {
    return { kind: "all" };
  }
  if (match[1] === "any") {
    return { kind: "any" };
  }
  const k = Number(match[2]);
  if (!Number.isInteger(k) || k < 1) {
    throw new SwarmContractError(`${where}.join quorum needs k >= 1`);
  }
  return { kind: "quorum", k };
}

export function joinToString(join: Join): string {
  return join.kind === "quorum" ? `quorum:${join.k}` : join.kind;
}

/** Lane from a v1 worker spec (ARCH §11: one lane per role, count 1, join all). */
function v1Lane(role: string, spec: WorkerSpec): Lane {
  return {
    role,
    count: 1,
    models: [spec.model],
    thinking: spec.thinking,
    partition: false,
    join: { kind: "all" },
  };
}

function parseLane(role: string, raw: unknown, defaults: ContractDefaults): Lane {
  const where = `holon.lanes.${role}`;
  if (!ROLE_RE.test(role)) {
    throw new SwarmContractError(`${where}: invalid lane name`);
  }
  if (!isRecord(raw)) {
    throw new SwarmContractError(`${where} must be a mapping`);
  }
  for (const key of Object.keys(raw)) {
    if (!LANE_KEYS.has(key)) {
      throw new SwarmContractError(`${where}.${key} is not a known lane field`);
    }
  }
  const countRaw = raw.count ?? 1;
  if (typeof countRaw !== "number" || !Number.isInteger(countRaw) || countRaw < 1) {
    throw new SwarmContractError(`${where}.count must be a positive integer`);
  }
  let models: (string | undefined)[];
  if (Array.isArray(raw.model)) {
    if (raw.model.length === 0) {
      throw new SwarmContractError(`${where}.model list must not be empty`);
    }
    models = raw.model.map((m, i) => {
      if (typeof m !== "string" || !m.trim()) {
        throw new SwarmContractError(`${where}.model[${i}] must be a non-empty string`);
      }
      return m.trim();
    });
  } else if (raw.model === undefined || raw.model === null) {
    models = [defaults.defaultModel];
  } else if (typeof raw.model === "string" && raw.model.trim()) {
    models = [raw.model.trim()];
  } else {
    throw new SwarmContractError(`${where}.model must be a provider/model string or a list`);
  }
  const join = parseJoin(raw.join, where);
  if (join.kind === "quorum" && join.k > countRaw) {
    throw new SwarmContractError(
      `${where}.join quorum:${join.k} needs count >= ${join.k} (count is ${countRaw})`,
    );
  }
  if (raw.thinking !== undefined && typeof raw.thinking !== "string") {
    throw new SwarmContractError(`${where}.thinking must be a string`);
  }
  return {
    role,
    count: countRaw,
    models,
    thinking:
      typeof raw.thinking === "string" && raw.thinking.trim()
        ? raw.thinking.trim()
        : defaults.defaultThinking,
    partition: raw.partition === true,
    join,
  };
}

function parseLead(raw: unknown): LeadSpec {
  if (raw === undefined || raw === null) {
    return { kind: "agent" };
  }
  if (!isRecord(raw)) {
    throw new SwarmContractError("holon.lead must be a mapping");
  }
  if (raw.kind === "human") {
    throw new SwarmContractError("holon.lead.kind human is a later build step (ARCH §10.5)");
  }
  if (raw.kind !== undefined && raw.kind !== "agent") {
    throw new SwarmContractError(`holon.lead.kind "${String(raw.kind)}" is not agent or human`);
  }
  const lead: LeadSpec = { kind: "agent" };
  if (raw.model !== undefined) {
    if (typeof raw.model !== "string" || !raw.model.trim()) {
      throw new SwarmContractError("holon.lead.model must be a non-empty string");
    }
    lead.model = raw.model.trim();
  }
  if (raw.thinking !== undefined) {
    if (typeof raw.thinking !== "string" || !raw.thinking.trim()) {
      throw new SwarmContractError("holon.lead.thinking must be a non-empty string");
    }
    lead.thinking = raw.thinking.trim();
  }
  return lead;
}

function parseCanon(raw: unknown): Canon {
  if (raw === undefined || raw === null) {
    return { never: [], approve: [] };
  }
  if (!isRecord(raw)) {
    throw new SwarmContractError("holon.canon must be a mapping");
  }
  const list = (value: unknown, key: string): string[] => {
    if (value === undefined || value === null) {
      return [];
    }
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      throw new SwarmContractError(`holon.canon.${key} must be a list of strings`);
    }
    return value as string[];
  };
  const canon: Canon = { never: list(raw.never, "never"), approve: list(raw.approve, "approve") };
  if (raw.scope !== undefined) {
    if (typeof raw.scope !== "string" || !raw.scope.trim()) {
      throw new SwarmContractError("holon.canon.scope must be a non-empty string");
    }
    canon.scope = raw.scope.trim();
  }
  if (raw.depth !== undefined) {
    if (typeof raw.depth !== "number" || !Number.isInteger(raw.depth) || raw.depth < 0) {
      throw new SwarmContractError("holon.canon.depth must be a non-negative integer");
    }
    canon.depth = raw.depth;
  }
  return canon;
}

function parseChildren(raw: unknown): string[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw) || raw.some((c) => typeof c !== "string")) {
    throw new SwarmContractError("holon.children must be a list of child holon ids");
  }
  return raw as string[];
}

/**
 * The lanes of a holon. A holon with a `lanes:` key declares its work; a holon without one
 * falls back to its v1 `workers:` (one lane per role, ARCH §11).
 */
function parseLanes(
  doc: Record<string, unknown>,
  workers: Record<string, WorkerSpec>,
  defaults: ContractDefaults,
): Lane[] {
  if (doc.lanes === undefined || doc.lanes === null) {
    return Object.entries(workers).map(([role, spec]) => v1Lane(role, spec));
  }
  if (!isRecord(doc.lanes) || Object.keys(doc.lanes).length === 0) {
    throw new SwarmContractError("holon.lanes must declare at least one lane");
  }
  return Object.entries(doc.lanes).map(([role, raw]) => parseLane(role, raw, defaults));
}

/**
 * Parse a holon file (ARCH §2). Everything but lead/lanes/children/canon is the v1 contract
 * (id, goal→input, done_when, routes, upstream, repo, budget). A v2-only field present beside
 * v1 `workers:` is an error: pick one shape per holon.
 */
export function parseHolon(yamlText: string, defaults: ContractDefaults = {}): Holon {
  let doc: unknown;
  try {
    doc = YAML.parse(yamlText);
  } catch (err) {
    throw new SwarmContractError(`holon is not valid YAML: ${String(err)}`);
  }
  if (!isRecord(doc)) {
    throw new SwarmContractError("holon must be a YAML mapping");
  }
  if (doc.lanes !== undefined && doc.workers !== undefined) {
    throw new SwarmContractError("holon has both lanes and workers; use lanes (ARCH §2)");
  }
  // The v1 parser validates the shared fields. `goal` is the v2 name of `input`; workers are
  // optional when lanes carry the roles, so a lanes-only holon gets synthetic count-1 workers
  // for validation (they are never used; lanes win below).
  const contractDoc: Record<string, unknown> = { ...doc };
  delete contractDoc.lanes;
  delete contractDoc.lead;
  delete contractDoc.children;
  delete contractDoc.canon;
  delete contractDoc.recipe;
  delete contractDoc.plan;
  if (contractDoc.input === undefined && typeof doc.goal === "string") {
    contractDoc.input = doc.goal;
    delete contractDoc.goal;
  }
  if (contractDoc.workers === undefined && doc.lanes !== undefined && isRecord(doc.lanes)) {
    contractDoc.workers = Object.fromEntries(Object.keys(doc.lanes).map((role) => [role, {}]));
  }
  const contract = parseContract(YAML.stringify(contractDoc), defaults);
  // count > 1 is legal under v2 lanes (ARCH §4); the v1 parser only ever produced count 1.
  const lanes = parseLanes(doc, contract.workers, defaults);
  const workers: Record<string, WorkerSpec> = {};
  for (const lane of lanes) {
    workers[lane.role] = {
      count: 1,
      model: lane.models[0],
      thinking: lane.thinking,
    };
  }
  // A template route that names a lane the holon does not declare would send work into a
  // session that can never emit. Template rows remap to the lead (it drives the next hop,
  // §4.5); explicit `routes:` in the file stay verbatim (the author's choice, still
  // validated by the v1 parser).
  const routes =
    doc.routes === undefined && doc.lanes !== undefined
      ? contract.routes
          .filter((r) => {
            const ok = (role: string) =>
              role === TASKMASTER ||
              role === "upstream" ||
              role === ROLE_PLACEHOLDER ||
              role === ANY_ROLE ||
              workers[role] !== undefined;
            return ok(r.from);
          })
          .map((r) =>
            r.to !== TASKMASTER &&
            r.to !== "upstream" &&
            r.to !== ROLE_PLACEHOLDER &&
            workers[r.to] === undefined
              ? { ...r, to: TASKMASTER }
              : r,
          )
      : contract.routes;
  return {
    contract: { ...contract, workers, routes },
    lead: parseLead(doc.lead),
    lanes,
    children: parseChildren(doc.children),
    canon: parseCanon(doc.canon),
    v1: false,
  };
}

/**
 * Load the holon at a task directory: holon.yaml when present, else contract.yaml as a root
 * holon with one lane per role (ARCH §11).
 */
export function loadHolon(
  stateDir: string,
  taskId: string,
  defaults: ContractDefaults = {},
): Holon {
  const dir = taskDirFor(stateDir, taskId);
  const holonFile = path.join(dir, HOLON_FILE);
  if (fs.existsSync(holonFile)) {
    return parseHolon(fs.readFileSync(holonFile, "utf8"), defaults);
  }
  const contract = loadContract(stateDir, taskId, defaults);
  return {
    contract,
    lead: { kind: "agent" },
    lanes: Object.entries(contract.workers).map(([role, spec]) => v1Lane(role, spec)),
    children: [],
    canon: { never: [], approve: [] },
    v1: true,
  };
}

/**
 * Derived state (ARCH §2): the event log is the only source; there is no state file.
 * TASK_STARTED (or a later round) → running; a BLOCKED that reached upstream → blocked;
 * a terminal event that reached upstream (or TASK_CLOSED) → done/failed/cancelled.
 */
export function holonStateFrom(
  events: {
    kind: string;
    event: string;
    from?: string;
    to?: string | null;
    data?: Record<string, unknown>;
  }[],
): HolonState {
  let state: HolonState = "planning";
  for (const e of events) {
    if (e.event === "TASK_STARTED" || e.event === "ROUND_STARTED") {
      state = "running";
    }
    if (e.event === "BLOCKED" && (e.kind === "upstream" || e.to === "upstream")) {
      state = "blocked";
    }
    if (TERMINAL.has(e.event) && (e.kind === "upstream" || e.to === "upstream")) {
      state = e.event === "DONE" ? "done" : e.event === "FAILED" ? "failed" : "cancelled";
    }
    if (e.event === "TASK_CLOSED") {
      const status = e.data?.status;
      state = status === "failed" ? "failed" : status === "cancelled" ? "cancelled" : "done";
    }
  }
  return state;
}

/** RouteRow fan-out view: a lane route target resolves to every member (ARCH §6.2). A
 * count-1 lane keeps the bare role (`build`), exactly as v1; count > 1 names members
 * `<role>:<n>` (ARCH §2). */
export function targetMembers(holon: Holon, to: string): string[] {
  if (to === TASKMASTER || to === "upstream" || to === ROLE_PLACEHOLDER) {
    return [to];
  }
  const lane = holon.lanes.find((l) => l.role === to);
  if (!lane) {
    return [to];
  }
  return lane.count === 1
    ? [lane.role]
    : Array.from({ length: lane.count }, (_, i) => `${to}:${i + 1}`);
}
