import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { holonPathKey, listHolonTree, spawnChild } from "./children.js";
import { HOLON_KEY_SEPARATOR, SwarmContractError, TASK_ID_RE, taskDirFor } from "./contract.js";
import type { SwarmEngine } from "./engine.js";
import {
  HOLON_FILE,
  loadHolon,
  parseHolon,
  parseLead,
  type Holon,
  type HolonState,
} from "./holon.js";
import { isMemberKind } from "./member-aliases.js";
import { closeHolonGroup, openHolonGroup } from "./members.js";
import { relayMemberReply } from "./relay.js";
import { TASKMASTER } from "./routing.js";
import { parseSwarmSessionKey } from "./sessions.js";
import { readEvents, readTasksIndex, writeFileAtomic } from "./store.js";
import { showTask, type TaskDetail } from "./tasks.js";

// ARCH §6.4, §9, §10a.2: the ops core for `swarm add`, `swarm lead` and `swarm show --tree`.
// House standard (§10a preamble): every capability is one function here; the gateway method
// (and through it the CLI verb, `--json`) and the lead tool call that same function via the
// SWARM_OPS table, never a copy of its logic. The parity test walks the table.

/** Who is calling an op: the operator (gateway client, CLI) or a swarm session (a tool). */
export type OpCaller =
  | { kind: "operator" }
  | { kind: "session"; sessionKey: string; taskId?: string; role?: string };

export const OPERATOR_CALLER: OpCaller = { kind: "operator" };

/** A holon reference: `<root>` or `<root>/<child>/<grandchild>` (ARCH §2 holon path). */
export function parseHolonRef(ref: string): string[] {
  const parts = ref
    .trim()
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new SwarmContractError("a holon reference is <root>[/<child>...]");
  }
  for (const p of parts) {
    if (!TASK_ID_RE.test(p)) {
      throw new SwarmContractError(`invalid holon id "${p}" in "${ref}"`);
    }
  }
  return parts;
}

/**
 * The engine task that runs a holon path (ARCH §2, §5): the holon key `<root>/<child>/…`,
 * whose folder is the parent's `children/<id>/` (children.ts holonDirFor).
 */
export function resolveHolonTask(engine: SwarmEngine, holonPath: string[]): string {
  if (holonPath.length === 0) {
    throw new SwarmContractError("empty holon path");
  }
  const key = holonPathKey(holonPath);
  if (!readTasksIndex(engine.stateDir)[key]) {
    throw new Error(`holon "${key}" not found`);
  }
  return key;
}

// ── §6.4 stacking: swarm add ────────────────────────────────────────────────────────────

export type AddedWork = {
  holon: string;
  seq: number;
  urgent: boolean;
  /** delivered (lead idle, sent now) | queued (lead mid-turn, next turn) | failed (resent). */
  delivery: "delivered" | "queued" | "failed";
};

/**
 * An add file is plain text: the work. Optional YAML front matter (`---` … `---`) may set
 * `urgent: true` (steer, ARCH §6.4); no other key is allowed.
 */
export function parseAddFile(text: string): { work: string; urgent: boolean } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  let urgent = false;
  let work = text;
  if (match) {
    let front: unknown;
    try {
      front = YAML.parse(match[1] ?? "");
    } catch (err) {
      throw new SwarmContractError(`add file front matter is not valid YAML: ${String(err)}`);
    }
    if (front !== null && front !== undefined) {
      if (typeof front !== "object" || Array.isArray(front)) {
        throw new SwarmContractError("add file front matter must be a mapping");
      }
      for (const [key, value] of Object.entries(front)) {
        if (key !== "urgent") {
          throw new SwarmContractError(
            `add file front matter: "${key}" is not allowed (only urgent)`,
          );
        }
        if (typeof value !== "boolean") {
          throw new SwarmContractError("add file front matter: urgent must be true or false");
        }
        urgent = value;
      }
    }
    work = match[2] ?? "";
  }
  work = work.trim();
  if (!work) {
    throw new SwarmContractError("add file has no work in it");
  }
  return { work, urgent };
}

/**
 * ARCH §6.4: give a holon more work. It is queued to the lead like any other message: a lead
 * mid-turn gets it with whatever else queued, as one message next turn; nothing interrupts.
 * `urgent: true` steers: the lead's current turn stops and this comes first (nothing queued
 * is dropped). A session caller (lead tool) may only add to its own direct children (§1.6).
 */
export async function addWork(
  engine: SwarmEngine,
  holonPath: string[],
  text: string,
  opts: { urgent?: boolean; caller?: OpCaller } = {},
): Promise<AddedWork> {
  const caller = opts.caller ?? OPERATOR_CALLER;
  if (caller.kind === "session") {
    const own = callerHolonPath(caller);
    const parentOfTarget = holonPath.slice(0, -1).join("/");
    if (!own || caller.role !== TASKMASTER || own.join("/") !== parentOfTarget) {
      throw new Error(
        `add refused: a lead adds work only to its own child holons; ` +
          `${holonPath.join("/")} is not a child of this session's holon`,
      );
    }
  }
  const taskId = resolveHolonTask(engine, holonPath);
  const urgent = opts.urgent === true;
  const work = text.trim();
  if (!work) {
    throw new SwarmContractError("add needs some work text");
  }
  return engine.locks.run(taskId, async () => {
    const state = engine.loadState(taskId);
    if (state.status !== "open") {
      throw new Error(`holon ${holonPath.join("/")} is ${state.status}; not open for more work`);
    }
    const from = caller.kind === "operator" ? "operator" : (caller.role ?? "swarm");
    const rec = engine.record(taskId, {
      kind: "system",
      event: "WORK_ADDED",
      from,
      to: TASKMASTER,
      sha: state.sha,
      body: work,
      data: { urgent },
    });
    const res = await engine.sendTo(taskId, state, {
      to: TASKMASTER,
      from,
      event: "WORK_ADDED",
      sha: state.sha,
      body:
        `${urgent ? "Urgent work for this holon (your turn was stopped for it)" : "More work for this holon"}; ` +
        `fold it into your plan and drive it like the rest.\n${work}`,
      seqs: [rec.seq],
      salt: `add-${rec.seq}`,
      ...(urgent && { steer: true }),
    });
    return {
      holon: holonPath.join("/"),
      seq: rec.seq,
      urgent,
      delivery: res.status,
    };
  });
}

/** The holon path of a swarm session: its key `<root>/<child>/…` split (ARCH §2, §5). */
function callerHolonPath(caller: Extract<OpCaller, { kind: "session" }>): string[] | undefined {
  const taskId = caller.taskId ?? parseSwarmSessionKey(caller.sessionKey)?.taskId;
  return taskId ? taskId.split(HOLON_KEY_SEPARATOR) : undefined;
}

// ── §3.4 / §9 lead override: swarm lead ─────────────────────────────────────────────────

/**
 * A lead spec on the command line: a YAML/JSON mapping (`{ kind: agent, model: p/m }`), or the
 * short forms `agent`, `agent:<provider/model>[:<thinking>]`, `member:<channel>:<who>[,<who>…]`
 * (§10b.3: the step-5 spelling is accepted as an alias, see member-aliases.ts). Validation is the holon file's own (parseLead), so
 * the CLI accepts exactly what a file does.
 */
export function parseLeadSpec(spec: string): Holon["lead"] {
  const raw = spec.trim();
  if (!raw) {
    throw new SwarmContractError("lead spec is empty");
  }
  if (raw.startsWith("{")) {
    let doc: unknown;
    try {
      doc = YAML.parse(raw);
    } catch (err) {
      throw new SwarmContractError(`lead spec is not valid YAML: ${String(err)}`);
    }
    return parseLead(doc);
  }
  const [kind, ...rest] = raw.split(":");
  if (kind === "agent") {
    const [model, thinking] = rest;
    return parseLead({
      kind: "agent",
      ...(model && { model }),
      ...(thinking && { thinking }),
    });
  }
  if (kind && isMemberKind(kind)) {
    const [channel, who] = rest;
    return parseLead({
      kind: "member",
      ...(channel && { channel }),
      ...(who && { who: who.split(",").map((w) => w.trim()) }),
    });
  }
  throw new SwarmContractError(
    `lead spec "${raw}" is not agent[:<provider/model>[:<thinking>]], member:<channel>:<who> or a mapping`,
  );
}

export type LeadChanged = {
  holon: string;
  seq: number;
  previous: Holon["lead"];
  lead: Holon["lead"];
};

/** One line naming a lead, for `swarm list` / `swarm show` (ARCH §9). */
export function describeLead(lead: Holon["lead"] | undefined): string {
  if (!lead) {
    return "default";
  }
  const l = lead as { kind: string; model?: string; thinking?: string; channel?: string };
  if (l.kind === "member") {
    return `member${l.channel ? `@${l.channel}` : ""}`;
  }
  return `${l.model ?? "default"}${l.thinking ? ` (${l.thinking})` : ""}`;
}

/**
 * The root owner (ARCH §3.4) is whoever started the root: the operator through the gateway
 * (CLI, `swarm.lead`) or the root's own upstream session. Anyone else is refused, naming who
 * may.
 */
function assertRootOwner(caller: OpCaller, rootUpstream: string | undefined, holon: string) {
  if (caller.kind === "operator") {
    return;
  }
  if (rootUpstream && caller.sessionKey === rootUpstream) {
    return;
  }
  throw new Error(
    `lead refused for ${holon}: only the root owner may change a lead ` +
      "(the operator with `swarm lead`, or the root's upstream session)",
  );
}

/**
 * ARCH §3.4, §9: `swarm lead <holon> <spec>`. Root owner only. The new lead's model is applied
 * to the lead session before anything is written (a refused model changes nothing); then the
 * holon file is rewritten, LEAD_CHANGED is logged and the lead is told (queued, never
 * interrupting).
 */
export async function overrideLead(
  engine: SwarmEngine,
  holonPath: string[],
  spec: string,
  opts: { caller?: OpCaller } = {},
): Promise<LeadChanged> {
  const caller = opts.caller ?? OPERATOR_CALLER;
  const holonRef = holonPath.join("/");
  const taskId = resolveHolonTask(engine, holonPath);
  const lead = parseLeadSpec(spec);
  return engine.locks.run(taskId, async () => {
    const state = engine.loadState(taskId);
    // §3.4: the root owner is the root's, whatever the depth of the holon being changed.
    const rootUpstream =
      holonPath.length > 1
        ? engine.loadState(holonPath[0]!).contract.upstream.sessionKey
        : state.contract.upstream.sessionKey;
    assertRootOwner(caller, rootUpstream, holonRef);
    if (state.status !== "open") {
      throw new Error(`holon ${holonRef} is ${state.status}; its lead cannot change`);
    }
    const dir = taskDirFor(engine.stateDir, taskId);
    const holonFile = path.join(dir, HOLON_FILE);
    // A v1 root has only contract.yaml; giving it a lead makes it a v2 holon file (§11: a v1
    // contract is a root holon whose lead is the gateway default unless `lead` is given).
    const source = fs.existsSync(holonFile)
      ? fs.readFileSync(holonFile, "utf8")
      : fs.readFileSync(path.join(dir, "contract.yaml"), "utf8");
    const doc = YAML.parseDocument(source);
    doc.set("lead", leadToYaml(lead));
    const nextText = doc.toString();
    const next = parseHolon(nextText, engine.defaults);

    if (next.lead.kind === "agent") {
      await engine.applyLeadModel(taskId, next);
    }
    writeFileAtomic(holonFile, nextText);
    const previous = state.holon.lead;
    const rec = engine.record(taskId, {
      kind: "system",
      event: "LEAD_CHANGED",
      from: caller.kind === "operator" ? "operator" : "upstream",
      to: TASKMASTER,
      sha: state.sha,
      body: `lead is now ${describeLead(next.lead)} (was ${describeLead(previous)})`,
      data: { previous, lead: next.lead },
    });
    await engine.sendTo(taskId, engine.loadState(taskId), {
      to: TASKMASTER,
      from: "operator",
      event: "LEAD_CHANGED",
      sha: state.sha,
      body:
        `The root owner changed this holon's lead to ${describeLead(next.lead)}. ` +
        "You lead from here: re-read the holon's events and continue.",
      seqs: [rec.seq],
      salt: `lead-${rec.seq}`,
    });
    return { holon: holonRef, seq: rec.seq, previous, lead: next.lead };
  });
}

function leadToYaml(lead: Holon["lead"]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(lead).filter(([, v]) => v !== undefined));
}

// ── §9 swarm show <holon> --tree ────────────────────────────────────────────────────────

export type HolonTreeRow = {
  path: string[];
  state: HolonState;
  lead: string;
  ageMs: number;
};

/**
 * ARCH §8.2, §9: the holon tree under a holon, depth first (the holon, then each child and
 * its subtree by id), walked by children.ts listHolonTree over the child folders.
 */
export function holonTree(engine: SwarmEngine, holonKey: string, now = Date.now()): HolonTreeRow[] {
  if (!readTasksIndex(engine.stateDir)[holonKey]) {
    throw new Error(`holon "${holonKey}" not found`);
  }
  return listHolonTree(engine.stateDir, holonKey, now).map((row) => {
    let lead = "-";
    try {
      lead = describeLead(loadHolon(engine.stateDir, row.key, engine.defaults).lead);
    } catch {
      // an unreadable holon file: its lead is unknown, the row still shows
    }
    return { path: row.path, state: row.state, lead, ageMs: row.ageMs };
  });
}

export type HolonShown = TaskDetail & {
  lead: string;
  tree?: Array<HolonTreeRow & { summary?: string }>;
};

/**
 * ARCH §8.2, §9: one holon in detail; with `tree`, every holon under it as one line each plus
 * its latest summary (the root owner reads everything).
 */
export function showHolon(
  engine: SwarmEngine,
  holonPath: string[],
  opts: { tree?: boolean; limit?: number } = {},
): HolonShown {
  const taskId = resolveHolonTask(engine, holonPath);
  const detail = showTask(engine, taskId, opts.limit);
  const state = engine.loadState(taskId);
  const shown: HolonShown = {
    ...detail,
    lead: describeLead(state.holon.lead),
  };
  if (opts.tree) {
    shown.tree = holonTree(engine, taskId).map((row) => ({
      ...row,
      summary: latestSummary(readEvents(engine.stateDir, holonPathKey(row.path))),
    }));
  }
  return shown;
}

/** The holon's newest summary upward: its last upstream (or CHILD_*) report body, one line. */
function latestSummary(events: ReturnType<typeof readEvents>): string | undefined {
  const last = events.findLast(
    (e) => e.kind === "upstream" || /^CHILD_(DONE|BLOCKED|FAILED)$/.test(e.event),
  );
  const line = last?.body?.split("\n").find((l) => l.trim());
  return last ? `${last.event}${line ? `: ${line.trim()}` : ""}` : undefined;
}

/**
 * ARCH §8.2: a participant sees its own holon plus its parent and children; the operator (root
 * owner) reads everything.
 */
function assertCanSee(caller: OpCaller, target: string[]): void {
  if (caller.kind === "operator") {
    return;
  }
  const own = callerHolonPath(caller)?.join("/");
  const t = target.join("/");
  const parent = target.slice(0, -1).join("/");
  const ownParent = own?.split("/").slice(0, -1).join("/");
  if (own && (t === own || parent === own || (ownParent && t === ownParent))) {
    return;
  }
  throw new Error(`show refused: ${t} is not this session's holon, its parent or a child`);
}

// ── The op table (ARCH §10a parity gate) ────────────────────────────────────────────────

type Params = Record<string, unknown>;

export type SwarmOp = {
  /** Gateway method; the CLI verb calls it. */
  method: string;
  /** `swarm <verb>`; every verb accepts `--json`. */
  cliVerb: string;
  /** Exposed to lead sessions through the swarm_holon tool. */
  leadTool: boolean;
  run: (engine: SwarmEngine, params: Params, caller: OpCaller) => Promise<unknown> | unknown;
};

function str(params: Params, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function need(params: Params, key: string, method: string): string {
  const value = str(params, key);
  if (!value) {
    throw new Error(`${method} needs \`${key}\``);
  }
  return value;
}

/**
 * Every new op of steps 3-5, keyed by name (add, lead, showTree, spawn, relay, group). The
 * gateway methods (and through them the CLI verbs) and the lead tool dispatch through `.run`
 * at call time; none has a second implementation.
 */
export const SWARM_OPS: Record<string, SwarmOp> = {
  add: {
    method: "swarm.add",
    cliVerb: "add",
    leadTool: true,
    run: (engine, params, caller) => {
      const holon = parseHolonRef(need(params, "holon", "swarm.add"));
      let text = str(params, "text");
      let urgent = params.urgent === true;
      const file = str(params, "file");
      if (!text && file) {
        if (!path.isAbsolute(file)) {
          throw new Error(
            `swarm.add \`file\` must be an absolute path (got "${file}"); resolve it in the caller`,
          );
        }
        const parsed = parseAddFile(fs.readFileSync(file, "utf8"));
        text = parsed.work;
        urgent = urgent || parsed.urgent;
      } else if (text) {
        const parsed = parseAddFile(text);
        text = parsed.work;
        urgent = urgent || parsed.urgent;
      }
      if (!text) {
        throw new Error("swarm.add needs `holon` and `text` (the work) or `file`");
      }
      return addWork(engine, holon, text, { urgent, caller });
    },
  },
  lead: {
    method: "swarm.lead",
    cliVerb: "lead",
    leadTool: true,
    run: (engine, params, caller) =>
      overrideLead(
        engine,
        parseHolonRef(need(params, "holon", "swarm.lead")),
        need(params, "spec", "swarm.lead"),
        { caller },
      ),
  },
  showTree: {
    method: "swarm.show",
    cliVerb: "show",
    leadTool: true,
    run: (engine, params, caller) => {
      const ref = str(params, "holon") ?? str(params, "taskId");
      if (!ref) {
        throw new Error("swarm.show needs `taskId`");
      }
      const target = parseHolonRef(ref);
      assertCanSee(caller, target);
      const limit = typeof params.limit === "number" ? params.limit : undefined;
      return showHolon(engine, target, { tree: params.tree === true, limit });
    },
  },
  // ARCH §5.1, §10a.1: spawn a child holon. The operator names the parent; a lead's parent is
  // its own holon, from its session key (a lead spawns only under itself, §1.6).
  spawn: {
    method: "swarm.spawn",
    cliVerb: "spawn",
    leadTool: true,
    run: (engine, params, caller) => {
      const holonYaml = str(params, "holon") ?? str(params, "spec");
      const file = str(params, "file");
      let parent = str(params, "parent");
      if (caller.kind === "session") {
        const own = callerHolonPath(caller)?.join(HOLON_KEY_SEPARATOR);
        if (!own || caller.role !== TASKMASTER) {
          throw new Error("spawn refused: only a holon's lead spawns, under its own holon");
        }
        if (parent && parent !== own) {
          throw new Error(`spawn refused: a lead spawns only under its own holon (${own})`);
        }
        parent = own;
      }
      if (!parent || (!holonYaml && !file)) {
        throw new Error(
          "swarm.spawn needs `parent` and `file` (holon path) or `holon` (YAML text)",
        );
      }
      if (!holonYaml && file && !path.isAbsolute(file)) {
        throw new Error(
          `swarm.spawn \`file\` must be an absolute path (got "${file}"); resolve it in the caller`,
        );
      }
      return spawnChild(engine, parseHolonRef(parent), holonYaml ?? fs.readFileSync(file!, "utf8"));
    },
  },
  // ARCH §3.3, §10a.3: hand a member's reply to a holon's relay (as if written in its group).
  // Operator only: a member's words come from the channel, never from an agent's tool.
  relay: {
    method: "swarm.relay",
    cliVerb: "relay",
    leadTool: false,
    run: (engine, params) => {
      const ref = str(params, "holon") ?? str(params, "taskId");
      const who = str(params, "who");
      const message = str(params, "message") ?? str(params, "text");
      if (!ref || !who || !message) {
        throw new Error("swarm.relay needs `taskId`, `who` (a member's channel id) and `message`");
      }
      return relayMemberReply(engine, {
        taskId: holonPathKey(parseHolonRef(ref)),
        who,
        text: message,
      });
    },
  },
  // ARCH §8.1, §10a.3: open or close a holon's channel group. Operator only.
  group: {
    method: "swarm.group",
    cliVerb: "group",
    leadTool: false,
    run: (engine, params) => {
      const ref = str(params, "holon") ?? str(params, "taskId");
      const action = str(params, "action") ?? "open";
      if (!ref || (action !== "open" && action !== "close")) {
        throw new Error("swarm.group needs `taskId` and `action` (open | close)");
      }
      const taskId = holonPathKey(parseHolonRef(ref));
      return action === "open" ? openHolonGroup(engine, taskId) : closeHolonGroup(engine, taskId);
    },
  },
};

/** Run an op by name with a caller; the single dispatch the method and the tool share. */
export function runOp(
  name: string,
  engine: SwarmEngine,
  params: Params,
  caller: OpCaller,
): Promise<unknown> {
  const op = SWARM_OPS[name];
  if (!op) {
    return Promise.reject(new Error(`unknown swarm op "${name}"`));
  }
  return Promise.resolve().then(() => op.run(engine, params, caller));
}
