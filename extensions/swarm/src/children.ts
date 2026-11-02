import path from "node:path";
import YAML from "yaml";
import {
  HOLON_KEY_SEPARATOR,
  holonKeySegments,
  isHolonKey,
  parentKeyOf,
  SwarmContractError,
} from "./contract.js";
import type { SwarmEngine, TaskState } from "./engine.js";
import {
  holonStateFrom,
  loadHolon,
  parseHolon,
  type Canon,
  type HolonState,
  type LeadSpec,
} from "./holon.js";
import { TASKMASTER } from "./routing.js";
import { readEvents, readTasksIndex, type SwarmEvent, type TaskStatus } from "./store.js";
import { startHolon, type StartedTask } from "./tasks.js";

// The holarchy (ARCH §5): a child holon reports to its parent lead only, as one unit; every
// escalation climbs exactly one level. A root holon reports to `upstream` (unchanged, §6).

/** ARCH §5.3: what a child's report up becomes at its parent lead. */
export const CHILD_EVENTS: Readonly<Record<string, string>> = Object.freeze({
  DONE: "CHILD_DONE",
  BLOCKED: "CHILD_BLOCKED",
  FAILED: "CHILD_FAILED",
  // A child cancelled on its own (not as part of its parent's subtree) still reports, so its
  // parent is never left waiting on it (§1.3).
  CANCELLED: "CHILD_CANCELLED",
});

/** Where a child's report to its parent is recorded in the child's own log. */
export const TO_PARENT = "parent";

const MAX_SUMMARY_LINES = 5;

export function childEventFor(event: string): string {
  return CHILD_EVENTS[event] ?? `CHILD_${event}`;
}

/** The child's id within its parent (the last path segment). */
export function childIdOf(key: string): string {
  return key.slice(key.lastIndexOf(HOLON_KEY_SEPARATOR) + 1);
}

/** ARCH §5.3: a 1-5 line summary; never empty, never raw chatter beyond five lines. */
export function summarize(body: string | undefined, fallback: string): string {
  const lines = (body ?? "")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim());
  if (lines.length === 0) {
    return fallback;
  }
  if (lines.length <= MAX_SUMMARY_LINES) {
    return lines.join("\n");
  }
  return [...lines.slice(0, MAX_SUMMARY_LINES - 1), `${lines[MAX_SUMMARY_LINES - 1]} …`].join("\n");
}

/** Direct children of a holon, from the task index (one entry per holon in the tree). */
export function childKeysOf(stateDir: string, key: string): string[] {
  return Object.keys(readTasksIndex(stateDir))
    .filter((k) => parentKeyOf(k) === key)
    .toSorted();
}

/** Open direct children of a holon (ARCH §5.3: the parent waits on these). */
export function openChildrenOf(stateDir: string, key: string): string[] {
  const index = readTasksIndex(stateDir);
  return childKeysOf(stateDir, key).filter((k) => index[k]?.status === "open");
}

/** The parent-side event that answers a child's report (keyed by the child's log seq). */
function parentHasReport(parentEvents: SwarmEvent[], childKey: string, childSeq: number): boolean {
  return parentEvents.some(
    (e) => e.kind === "system" && e.data?.child === childKey && e.data?.childSeq === childSeq,
  );
}

/** `children: 2 of 3 done, 1 open`, counting the reporting child as its report says. */
function tally(stateDir: string, parentKey: string, childKey: string, event: string): string {
  const index = readTasksIndex(stateDir);
  const kids = Object.keys(index).filter((k) => parentKeyOf(k) === parentKey);
  const reported: Record<string, TaskStatus> = {
    DONE: "done",
    FAILED: "failed",
    CANCELLED: "cancelled",
  };
  const statusOf = (k: string) =>
    k === childKey && reported[event] ? reported[event] : index[k]?.status;
  const done = kids.filter((k) => statusOf(k) === "done").length;
  const open = kids.filter((k) => statusOf(k) === "open").length;
  return `children: ${done} of ${kids.length} done, ${open} open`;
}

/**
 * Deliver one recorded child report to the parent lead (idempotent per child seq, so resume
 * can call it again after a crash between the child's record and the parent's). The parent's
 * lock is taken here; callers hold at most the child's lock, never the parent's (lock order is
 * always child → parent, so no cycle).
 */
export async function deliverChildReport(
  engine: SwarmEngine,
  childKey: string,
  report: SwarmEvent,
): Promise<"delivered" | "already" | "parent-closed" | "no-parent"> {
  const parentKey = parentKeyOf(childKey);
  if (!parentKey) {
    return "no-parent";
  }
  return engine.locks.run(parentKey, async () => {
    let parent: TaskState;
    try {
      parent = engine.loadState(parentKey);
    } catch {
      return "no-parent" as const;
    }
    if (parentHasReport(parent.events, childKey, report.seq)) {
      return "already" as const;
    }
    if (parent.status !== "open") {
      // The parent closed first (its lead finished or was cancelled): logged on the parent,
      // never re-opened by a late child.
      engine.record(parentKey, {
        kind: "system",
        event: "CHILD_REPORT_AFTER_CLOSE",
        from: childKey,
        sha: report.sha,
        data: { child: childKey, childSeq: report.seq, event: report.event },
      });
      return "parent-closed" as const;
    }
    const childEvent = childEventFor(report.event);
    const summary = summarize(report.body, `${report.event} @ ${report.sha ?? parent.sha}`);
    await engine.notify(parentKey, parent, {
      event: childEvent,
      from: childKey,
      sha: report.sha ?? parent.sha,
      body:
        `child ${childIdOf(childKey)} reports ${report.event} @ ${report.sha ?? "-"} ` +
        `(${tally(engine.stateDir, parentKey, childKey, report.event)}).\n${summary}`,
      data: { child: childKey, childSeq: report.seq, event: report.event },
    });
    return "delivered" as const;
  });
}

/**
 * ARCH §5.3/§5.4: a child holon's event bound for "upstream" goes to its parent lead, one
 * level up, and nowhere else. Recorded in the child's log as kind `upstream` (so its derived
 * state is right) addressed `to: parent`, then delivered as CHILD_* to the parent lead.
 */
export async function reportToParent(
  engine: SwarmEngine,
  childKey: string,
  msg: { event: string; from: string; sha: string; body: string },
): Promise<void> {
  const parentKey = parentKeyOf(childKey)!;
  const rec = engine.record(childKey, {
    kind: "upstream",
    event: msg.event,
    from: msg.from,
    to: TO_PARENT,
    sha: msg.sha,
    body: summarize(msg.body, `${msg.event} @ ${msg.sha}`),
    data: { parent: parentKey, lead: `${parentKey}:${TASKMASTER}` },
  });
  await deliverChildReport(engine, childKey, rec);
}

/** Resume (ARCH §7): every report this child recorded reaches its parent exactly once. */
export async function reconcileChildReports(
  engine: SwarmEngine,
  childKey: string,
): Promise<number> {
  if (!parentKeyOf(childKey)) {
    return 0;
  }
  let delivered = 0;
  let events: SwarmEvent[];
  try {
    events = engine.loadState(childKey).events;
  } catch {
    return 0;
  }
  for (const e of events) {
    if (e.kind === "upstream" && e.to === TO_PARENT) {
      if ((await deliverChildReport(engine, childKey, e)) === "delivered") {
        delivered += 1;
      }
    }
  }
  return delivered;
}

// ---------------------------------------------------------------------------------------
// Spawn (ARCH §5.1, §5.2, §10a.1): one ops function; the CLI, the gateway method and the
// lead's tool all call `spawnChild`.

/** Canon keys a child may only tighten (ARCH §2, §5.2). */
const CANON_KEYS = new Set(["scope", "never", "approve", "depth"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scopeEntries(scope: string): string[] {
  return scope
    .split(/[,\s]+/)
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

/** A scope entry is inside another when it is the same path or a path below it. */
function entryWithin(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

/** Every entry of the child's scope lies inside some entry of the parent's scope. */
export function scopeWithin(child: string, parent: string): boolean {
  const parents = scopeEntries(parent);
  return scopeEntries(child).every((c) => parents.some((p) => entryWithin(c, p)));
}

/**
 * ARCH §5.2: the child's canon is the parent's, tightened only. `raw` is the child file's own
 * `canon:` mapping (undefined when the child gives none: it inherits everything). Returns the
 * child's effective canon; any loosening throws a SwarmContractError naming the exact key.
 */
export function inheritCanon(parent: Canon, raw: unknown): Canon {
  if (raw !== undefined && raw !== null && !isRecord(raw)) {
    throw new SwarmContractError("canon must be a mapping");
  }
  const own = (raw ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(own)) {
    if (!CANON_KEYS.has(key)) {
      throw new SwarmContractError(`canon.${key} is not a canon key`);
    }
  }
  const list = (key: "never" | "approve"): string[] => {
    const value = own[key];
    if (value === undefined || value === null) {
      return [...parent[key]];
    }
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      throw new SwarmContractError(`canon.${key} must be a list of strings`);
    }
    const dropped = parent[key].filter((v) => !(value as string[]).includes(v));
    if (dropped.length > 0) {
      throw new SwarmContractError(
        `canon.${key}: child drops ${dropped.map((d) => `"${d}"`).join(", ")}; a child may only ` +
          `add to its parent's canon.${key}, never remove (ARCH §5.2)`,
      );
    }
    return [...new Set([...parent[key], ...(value as string[])])];
  };
  const canon: Canon = { never: list("never"), approve: list("approve") };

  if (own.scope !== undefined && own.scope !== null) {
    if (typeof own.scope !== "string" || !own.scope.trim()) {
      throw new SwarmContractError("canon.scope must be a non-empty string");
    }
    const scope = own.scope.trim();
    if (parent.scope !== undefined && !scopeWithin(scope, parent.scope)) {
      throw new SwarmContractError(
        `canon.scope: "${scope}" is outside the parent's scope "${parent.scope}" (ARCH §5.2)`,
      );
    }
    canon.scope = scope;
  } else if (parent.scope !== undefined) {
    canon.scope = parent.scope;
  }

  // depth = how many more child levels are allowed below a holon. The parent spends one
  // level on this child; the child may ask for fewer, never more.
  const allowed = parent.depth === undefined ? undefined : parent.depth - 1;
  if (allowed !== undefined && allowed < 0) {
    throw new SwarmContractError(
      "canon.depth: the parent's canon allows no more child levels (depth 0)",
    );
  }
  if (own.depth !== undefined && own.depth !== null) {
    if (typeof own.depth !== "number" || !Number.isInteger(own.depth) || own.depth < 0) {
      throw new SwarmContractError("canon.depth must be a non-negative integer");
    }
    if (allowed !== undefined && own.depth > allowed) {
      throw new SwarmContractError(
        `canon.depth: child asks for ${own.depth} more levels; its parent allows ${allowed} (ARCH §5.2)`,
      );
    }
    canon.depth = own.depth;
  } else if (allowed !== undefined) {
    canon.depth = allowed;
  }
  return canon;
}

/** Throws (naming the key) unless `child` only tightens `parent` (ARCH §5.2). */
export function assertCanonTightens(parent: Canon, child: Canon): void {
  inheritCanon(parent, {
    never: child.never,
    approve: child.approve,
    ...(child.scope !== undefined && { scope: child.scope }),
    ...(child.depth !== undefined && { depth: child.depth }),
  });
}

export type SpawnResult = StartedTask & { parent: string; path: string[]; canon: Canon };

/**
 * ARCH §5.1: create and start a child holon under `parentKey`. The child file is checked
 * against the parent's canon (any loosening is refused with the key named, §5.2), written as
 * the child's holon.yaml under the parent's `children/<id>/` folder with its effective canon,
 * and started like any holon; the parent's log records CHILD_SPAWNED. A refused spawn writes
 * nothing and sends nothing.
 */
export async function spawnChild(
  engine: SwarmEngine,
  parentKey: string,
  yamlText: string,
): Promise<SpawnResult> {
  holonKeySegments(parentKey);
  const parent = engine.loadState(parentKey);
  if (parent.status !== "open") {
    throw new SwarmContractError(`holon ${parentKey} is ${parent.status}; it cannot spawn`);
  }
  if (parent.holon.v1) {
    throw new SwarmContractError(
      `holon ${parentKey} is a v1 contract with no canon; only a holon spawns children (ARCH §5)`,
    );
  }
  let doc: unknown;
  try {
    doc = YAML.parse(yamlText);
  } catch (err) {
    throw new SwarmContractError(`child holon is not valid YAML: ${String(err)}`);
  }
  if (!isRecord(doc)) {
    throw new SwarmContractError("child holon must be a YAML mapping");
  }
  if (doc.upstream !== undefined) {
    throw new SwarmContractError(
      "upstream: a child reports to its parent lead only; only the root has upstream (ARCH §2, §5.3)",
    );
  }
  if (doc.workers !== undefined && doc.lanes === undefined) {
    throw new SwarmContractError("a child holon declares lanes, not v1 workers (ARCH §2)");
  }
  const canon = inheritCanon(parent.holon.canon, doc.canon);
  // A child's work stays inside its parent's checkout (ARCH §5.2, scope): the same repo or a
  // path below it (a worktree of it, for instance).
  if (
    typeof doc.repo === "string" &&
    parent.contract.repo &&
    !entryWithin(path.resolve(doc.repo), path.resolve(parent.contract.repo))
  ) {
    throw new SwarmContractError(
      `repo: "${doc.repo}" is outside the parent's repo "${parent.contract.repo}" (ARCH §5.2)`,
    );
  }
  // The parent lead picks the child's lead (§3.4); without one the child inherits the
  // parent's lead model, never silently the gateway default.
  const childDoc: Record<string, unknown> = { ...doc, canon: canonDoc(canon) };
  if (childDoc.lead === undefined && parent.holon.lead.kind === "agent") {
    const { model, thinking } = parent.holon.lead;
    if (model || thinking) {
      childDoc.lead = { kind: "agent", ...(model && { model }), ...(thinking && { thinking }) };
    }
  }
  const text = YAML.stringify(childDoc);
  // Validate fully before anything is written (ids, lanes, lead).
  parseHolon(text, engine.defaults);
  const started = await startHolon(engine, text, { parentKey });
  await engine.locks.run(parentKey, () => {
    engine.record(parentKey, {
      kind: "system",
      event: "CHILD_SPAWNED",
      from: TASKMASTER,
      to: started.taskId,
      sha: started.sha,
      body: typeof doc.goal === "string" ? summarize(doc.goal, started.taskId) : undefined,
      data: { child: started.taskId, canon },
    });
  });
  return {
    ...started,
    parent: parentKey,
    path: holonKeySegments(started.taskId),
    canon,
  };
}

function canonDoc(canon: Canon): Record<string, unknown> {
  return {
    ...(canon.scope !== undefined && { scope: canon.scope }),
    never: canon.never,
    approve: canon.approve,
    ...(canon.depth !== undefined && { depth: canon.depth }),
  };
}

// ---------------------------------------------------------------------------------------
// The tree (ARCH §9 `swarm list`, §7 resume): every holon is one task-index entry keyed by
// its path; the tree is read from the files only, so it works with the gateway down.

/** Depth-first order of holon keys: a parent, then each of its children, by id. */
export function compareHolonKeys(a: string, b: string): number {
  const sa = a.split(HOLON_KEY_SEPARATOR);
  const sb = b.split(HOLON_KEY_SEPARATOR);
  for (let i = 0; i < Math.min(sa.length, sb.length); i += 1) {
    const c = sa[i]!.localeCompare(sb[i]!);
    if (c !== 0) {
      return c;
    }
  }
  return sa.length - sb.length;
}

export type HolonTreeRow = {
  /** Holon key, `<root>/<child>/…`. */
  key: string;
  /** Holon ids from the root downward. */
  path: string[];
  depth: number;
  status: TaskStatus;
  state: HolonState;
  /** `agent <model>` / `agent (default)` / a human lead's description. */
  lead: string;
  ageMs: number;
};

export function leadLabel(lead: LeadSpec): string {
  if (lead.kind === "agent") {
    return `agent ${lead.model ?? "(default)"}${lead.thinking ? ` thinking=${lead.thinking}` : ""}`;
  }
  return String((lead as { kind: string }).kind);
}

/** One row per holon (ARCH §9): path, state, lead, age. `rootId` limits it to one tree. */
export function listHolonTree(stateDir: string, rootId?: string, now = Date.now()): HolonTreeRow[] {
  const index = readTasksIndex(stateDir);
  return Object.keys(index)
    .filter((k) => !rootId || k === rootId || k.startsWith(`${rootId}${HOLON_KEY_SEPARATOR}`))
    .toSorted(compareHolonKeys)
    .map((key) => {
      const entry = index[key]!;
      let state: HolonState = "planning";
      let lead = "agent (default)";
      try {
        state = holonStateFrom(readEvents(stateDir, key));
      } catch {
        // a holon folder that cannot be read keeps the default
      }
      try {
        lead = leadLabel(loadHolon(stateDir, key).lead);
      } catch {
        // unreadable holon file: the lead is unknown
        lead = "-";
      }
      const segments = key.split(HOLON_KEY_SEPARATOR);
      return {
        key,
        path: segments,
        depth: segments.length - 1,
        status: entry.status,
        state,
        lead,
        ageMs: Math.max(0, now - Date.parse(entry.createdAt)),
      };
    });
}

// ---------------------------------------------------------------------------------------
// The parent lead's hand on its own children (ARCH §5.3): answer a blocked child, cancel one
// (with its subtree, §9). One level at a time: only direct children.

/** `child` is a direct child id or the full key of a direct child of `parentKey`. */
export function directChildKey(parentKey: string, child: string): string {
  const raw = child.trim().toLowerCase();
  const key = raw.includes(HOLON_KEY_SEPARATOR) ? raw : `${parentKey}${HOLON_KEY_SEPARATOR}${raw}`;
  if (!isHolonKey(key) || parentKeyOf(key) !== parentKey) {
    throw new SwarmContractError(
      `"${child}" is not a child of ${parentKey}; a lead talks to its own children only (ARCH §1.6)`,
    );
  }
  return key;
}

/** ARCH §5.3: the parent lead answers its child's lead (logged as PARENT on the child). */
export async function answerChild(
  engine: SwarmEngine,
  parentKey: string,
  child: string,
  message: string,
): Promise<{ child: string; seq: number; delivery: string }> {
  const key = directChildKey(parentKey, child);
  if (!readTasksIndex(engine.stateDir)[key]) {
    throw new SwarmContractError(`child holon ${key} not found`);
  }
  return engine.locks.run(key, async () => {
    const state = engine.loadState(key);
    if (state.status !== "open") {
      throw new Error(`child holon ${key} is ${state.status}; not open for answers`);
    }
    const rec = engine.record(key, {
      kind: "system",
      event: "PARENT",
      from: TO_PARENT,
      to: TASKMASTER,
      sha: state.sha,
      body: message,
    });
    const result = await engine.sendTo(key, state, {
      to: TASKMASTER,
      from: TO_PARENT,
      event: "PARENT",
      sha: state.sha,
      body: message,
      seqs: [rec.seq],
    });
    return { child: key, seq: rec.seq, delivery: result.status };
  });
}
