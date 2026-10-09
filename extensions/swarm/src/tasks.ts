import fs from "node:fs";
import path from "node:path";
import { taskmasterBrief, workerBrief } from "./briefs.js";
import { parseContract, serializeContract, SwarmContractError, taskDirFor } from "./contract.js";
import { readRepoHead, type SwarmEngine } from "./engine.js";
import { ROUND_STARTED, roundStarts } from "./rounds.js";
import { TASKMASTER, UPSTREAM } from "./routing.js";
import {
  readEvents,
  readOutbox,
  readTasksIndex,
  writeFileAtomic,
  writeTasksIndex,
  type SwarmEvent,
  type TaskStatus,
} from "./store.js";

// start / list / show / cancel / answer (ARCH §3, §5, §9).

export type AppliedModel = {
  model?: string;
  thinking?: string;
  provider?: string;
  resolved?: string;
};

export type StartedTask = {
  /** Task id; `id` is kept for existing callers (change 3: CLI JSON must carry taskId). */
  taskId: string;
  id: string;
  status: TaskStatus;
  sha: string;
  dir: string;
  sessions: Record<string, string>;
  workers: Record<string, AppliedModel>;
};

export function firstRole(routes: { from: string }[], workers: string[]): string {
  return workers.includes("build") ? "build" : (routes[0]?.from ?? workers[0] ?? "build");
}

/**
 * Validate, apply each worker's model+thinking to its session (ARCH §3), then create the task
 * and deliver the first worker's brief plus a kickoff to the taskmaster. If any session patch
 * fails, nothing is created and no message is sent.
 */
export async function startTask(
  engine: SwarmEngine,
  source: { contractPath?: string; contractYaml?: string },
): Promise<StartedTask> {
  const yaml =
    source.contractYaml ??
    (source.contractPath ? fs.readFileSync(source.contractPath, "utf8") : undefined);
  if (!yaml) {
    throw new SwarmContractError("swarm.start needs a contract file or contract text");
  }
  const contract = parseContract(yaml, engine.defaults);
  const dir = taskDirFor(engine.stateDir, contract.id);
  if (readTasksIndex(engine.stateDir)[contract.id] || fs.existsSync(dir)) {
    throw new SwarmContractError(`task "${contract.id}" already exists`);
  }

  const workers: Record<string, AppliedModel> = {};
  const patch = engine.runtime.subagent as {
    patchSession?: (p: {
      sessionKey: string;
      model?: string;
      thinkingLevel?: string;
      label?: string;
    }) => Promise<{ provider: string; model: string }>;
  };
  for (const [role, spec] of Object.entries(contract.workers)) {
    const sessionKey = engine.sessionKey(contract.id, role);
    if (!patch.patchSession) {
      throw new Error("runtime cannot apply worker models (patchSession unavailable)");
    }
    let resolved: { provider: string; model: string };
    try {
      resolved = await patch.patchSession({
        sessionKey,
        label: `swarm:${contract.id}:${role}`,
        ...(spec.model && { model: spec.model }),
        ...(spec.thinking && { thinkingLevel: spec.thinking }),
      });
    } catch (err) {
      throw new SwarmContractError(
        `cannot apply model to worker ${role}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    workers[role] = {
      model: spec.model,
      thinking: spec.thinking,
      provider: resolved.provider,
      resolved: `${resolved.provider}/${resolved.model}`,
    };
  }
  await patch
    .patchSession?.({
      sessionKey: engine.sessionKey(contract.id, TASKMASTER),
      label: `swarm:${contract.id}:${TASKMASTER}`,
    })
    .catch(() => undefined);

  const sha = readRepoHead(contract.repo) ?? "init";
  const now = new Date().toISOString();
  fs.mkdirSync(dir, { recursive: true });
  writeFileAtomic(path.join(dir, "contract.yaml"), serializeContract(contract));
  const index = readTasksIndex(engine.stateDir);
  index[contract.id] = { status: "open", sha, createdAt: now, updatedAt: now };
  writeTasksIndex(engine.stateDir, index);

  const state = engine.loadState(contract.id);
  // Optional group (ARCH §1.5): its outcome is logged; a missing channel never blocks the task.
  const group = await engine.group.ensureGroup(contract.id).catch((err: unknown) => ({
    ok: false,
    reason: err instanceof Error ? err.message : String(err),
  }));
  engine.record(contract.id, {
    kind: "system",
    event: "GROUP",
    data: { kind: engine.group.kind, ...group },
  });
  for (const [role, applied] of Object.entries(workers)) {
    engine.record(contract.id, {
      kind: "system",
      event: "MODEL_APPLIED",
      from: role,
      data: { ...applied },
    });
  }
  const startRec = engine.record(contract.id, {
    kind: "system",
    event: "TASK_STARTED",
    to: firstRole(contract.routes, Object.keys(contract.workers)),
    sha,
    body: contract.input,
  });

  await engine.locks.run(contract.id, async () => {
    const first = firstRole(contract.routes, Object.keys(contract.workers));
    await engine.sendTo(contract.id, state, {
      to: first,
      from: TASKMASTER,
      event: "TASK_STARTED",
      sha,
      body: `Start the task.\n${contract.input}\nDone when: ${contract.done_when}`,
      seqs: [startRec.seq],
      extraSystemPrompt: workerBrief(contract, first),
    });
    await engine.sendTo(contract.id, state, {
      to: TASKMASTER,
      from: UPSTREAM,
      event: "TASK_STARTED",
      sha,
      body: `Task started; ${first} has the brief. Wait for events; do not do the work yourself.`,
      seqs: [startRec.seq],
      salt: "kickoff",
      extraSystemPrompt: taskmasterBrief(contract),
    });
  });

  const sessions: Record<string, string> = {
    [TASKMASTER]: engine.sessionKey(contract.id, TASKMASTER),
  };
  for (const role of Object.keys(contract.workers)) {
    sessions[role] = engine.sessionKey(contract.id, role);
  }
  return { taskId: contract.id, id: contract.id, status: "open", sha, dir, sessions, workers };
}

export type TaskSummary = {
  id: string;
  status: TaskStatus;
  /** ARCH §12: the current round (1 until the first `swarm continue`). */
  round: number;
  sha: string;
  recentEvent?: string;
  updatedAt: string;
  ageMs: number;
};

export function listTasks(stateDir: string, now = Date.now()): TaskSummary[] {
  return Object.entries(readTasksIndex(stateDir))
    .map(([id, entry]) => {
      let recentEvent: string | undefined;
      let round = 1;
      try {
        const events = readEvents(stateDir, id);
        recentEvent = events.at(-1)?.event;
        round = roundStarts(events).length;
      } catch {
        recentEvent = undefined;
      }
      return {
        id,
        status: entry.status,
        round,
        sha: entry.sha,
        recentEvent,
        updatedAt: entry.updatedAt,
        ageMs: Math.max(0, now - Date.parse(entry.createdAt)),
      };
    })
    .toSorted((a, b) => a.id.localeCompare(b.id));
}

export type TaskDetail = HandoverTimeline & {
  id: string;
  status: TaskStatus;
  sha: string;
  /** ARCH §12: the current round. */
  round: number;
  /** ARCH §12: the timeline grouped by round (round 1 = the original start). */
  rounds: RoundTimeline[];
  contract: {
    kind: string;
    input: string;
    done_when: string;
    repo?: string;
    upstream: unknown;
  };
  models: Record<string, { contract?: string; applied?: string; observed: string[] }>;
  events: SwarmEvent[];
  outbox: Array<{
    to: string;
    seqs: number[];
    acked: boolean;
    attempts: number;
  }>;
};

export type Handover = {
  seq: number;
  /** Unix epoch ms. */
  ts: number;
  event: string;
  from: string;
  to: string;
  sha: string | null;
  sinceStartMs: number;
  sincePrevMs: number;
};

export type HandoverTimeline = {
  startedAt: number | null;
  /** Ts of TASK_CLOSED; null while the task is open. */
  endedAt: number | null;
  /** endedAt - startedAt; for an open task, elapsed time up to `now`. */
  durationMs: number | null;
  handovers: Handover[];
  /** Per role: summed time from a delivery to that role until its next emit (completed turns). */
  activeMs: Record<string, number>;
};

export type RoundTimeline = HandoverTimeline & {
  round: number;
  /** Seq of the round's TASK_STARTED / ROUND_STARTED. */
  seq: number;
  input: string;
};

/** ARCH §12: one timeline per round, each over that round's slice of the log. */
export function buildRoundTimelines(events: SwarmEvent[], now = Date.now()): RoundTimeline[] {
  const rounds = roundStarts(events);
  return rounds.map((r, i) => {
    const next = rounds[i + 1];
    const slice = events.filter(
      (e) => (i === 0 || e.seq >= r.seq) && (next === undefined || e.seq < next.seq),
    );
    return { round: r.round, seq: r.seq, input: r.input, ...buildTimeline(slice, now) };
  });
}

/**
 * Handover timeline (ARCH §4 "Logged": events.jsonl is the audit trail and board feed, §11 board).
 * A handover is the task kickoff (TASK_STARTED) or an emit the route table sent somewhere
 * (`to` set). Always computed over the whole log.
 */
export function buildTimeline(events: SwarmEvent[], now = Date.now()): HandoverTimeline {
  const started =
    events.find((e) => e.event === "TASK_STARTED" || e.event === ROUND_STARTED) ?? events[0];
  const startedAt = started?.ts ?? null;
  // ARCH §12: a close from an earlier round does not end a task that was continued.
  const lastRound = events.findLast((e) => e.kind === "system" && e.event === ROUND_STARTED);
  const closed = events.findLast((e) => e.event === "TASK_CLOSED");
  const endedAt = closed && (!lastRound || closed.seq > lastRound.seq) ? closed.ts : null;
  const durationMs = startedAt === null ? null : Math.max(0, (endedAt ?? now) - startedAt);

  const handovers: Handover[] = [];
  let prevTs = startedAt ?? 0;
  for (const e of events) {
    const routed =
      (e.kind === "system" && (e.event === "TASK_STARTED" || e.event === ROUND_STARTED) && e.to) ||
      (e.kind === "emit" && e.to);
    if (!routed || !e.to) {
      continue;
    }
    handovers.push({
      seq: e.seq,
      ts: e.ts,
      event: e.event,
      from: e.from ?? TASKMASTER,
      to: e.to,
      sha: e.sha ?? null,
      sinceStartMs: startedAt === null ? 0 : e.ts - startedAt,
      sincePrevMs: e.ts - prevTs,
    });
    prevTs = e.ts;
  }

  const activeMs: Record<string, number> = {};
  const openSince = new Map<string, number>();
  for (const e of events) {
    if (e.kind === "send" && e.event === "DELIVERED" && e.to && !openSince.has(e.to)) {
      openSince.set(e.to, e.ts);
    } else if (e.kind === "emit" && e.from && openSince.has(e.from)) {
      activeMs[e.from] = (activeMs[e.from] ?? 0) + (e.ts - (openSince.get(e.from) ?? e.ts));
      openSince.delete(e.from);
    }
  }
  return { startedAt, endedAt, durationMs, handovers, activeMs };
}

export function showTask(engine: SwarmEngine, taskId: string, limit?: number): TaskDetail {
  const state = engine.loadState(taskId);
  const models: TaskDetail["models"] = {};
  for (const [role, spec] of Object.entries(state.contract.workers)) {
    models[role] = { contract: spec.model, observed: [] };
  }
  for (const e of state.events) {
    const slot = e.from ? models[e.from] : undefined;
    if (!slot) {
      continue;
    }
    if (e.event === "MODEL_APPLIED" && typeof e.data?.resolved === "string") {
      slot.applied = e.data.resolved;
    }
    if (e.event === "MODEL_OBSERVED" && e.data) {
      const observed = `${String(e.data.provider)}/${String(e.data.model)}`;
      if (!slot.observed.includes(observed)) {
        slot.observed.push(observed);
      }
    }
  }
  const events = limit && limit > 0 ? state.events.slice(-limit) : state.events;
  const rounds = buildRoundTimelines(state.events);
  return {
    id: taskId,
    status: state.status,
    sha: state.sha,
    round: rounds.length,
    rounds,
    contract: {
      kind: state.contract.kind,
      input: state.contract.input,
      done_when: state.contract.done_when,
      repo: state.contract.repo,
      upstream: state.contract.upstream,
    },
    models,
    events,
    ...buildTimeline(state.events),
    outbox: readOutbox(engine.stateDir, taskId).map((o) => ({
      to: o.to,
      seqs: o.seqs,
      acked: o.acked,
      attempts: o.attempts,
    })),
  };
}

/** Urgent stop to every task session, then close and report CANCELLED upstream. */
export async function cancelTask(engine: SwarmEngine, taskId: string, reason = "cancelled") {
  return engine.locks.run(taskId, async () => {
    const state = engine.loadState(taskId);
    if (state.status !== "open") {
      return { id: taskId, status: state.status, changed: false };
    }
    engine.close(taskId, "cancelled");
    const rec = engine.record(taskId, { kind: "system", event: "CANCELLED", body: reason });
    for (const role of [TASKMASTER, ...Object.keys(state.contract.workers)]) {
      await engine.sendTo(taskId, state, {
        to: role,
        from: UPSTREAM,
        event: "CANCELLED",
        sha: state.sha,
        body: `Stop: this task was cancelled (${reason}). Do not continue.`,
        seqs: [rec.seq],
        urgent: true,
        salt: `cancel-${role}`,
      });
    }
    // ARCH §9: cancel always reports CANCELLED upstream, whatever upstream.events lists.
    await engine.toUpstream(
      taskId,
      state,
      { event: "CANCELLED", from: TASKMASTER, sha: state.sha, body: reason },
      { force: true },
    );
    return { id: taskId, status: "cancelled" as const, changed: true };
  });
}

/**
 * Operator answer (ARCH §5, §9): logged as an OPERATOR event, then delivered to the taskmaster
 * as an ordinary message (it queues behind any active run there).
 */
export async function answerTask(engine: SwarmEngine, taskId: string, message: string) {
  return engine.locks.run(taskId, async () => {
    const state = engine.loadState(taskId);
    if (state.status !== "open") {
      throw new Error(`task ${taskId} is ${state.status}; not open for answers`);
    }
    const rec = engine.record(taskId, {
      kind: "system",
      event: "OPERATOR",
      from: "operator",
      to: TASKMASTER,
      sha: state.sha,
      body: message,
    });
    const result = await engine.sendTo(taskId, state, {
      to: TASKMASTER,
      from: "operator",
      event: "OPERATOR",
      sha: state.sha,
      body: message,
      seqs: [rec.seq],
    });
    return { id: taskId, seq: rec.seq, delivery: result.status };
  });
}
