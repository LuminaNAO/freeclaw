import { execFileSync } from "node:child_process";
import path from "node:path";
import { briefFor, holonBriefFor } from "./briefs.js";
import { loadContract, type Contract, type ContractDefaults } from "./contract.js";
import { formatEnvelope, Mailbox, msgIdFor, type RunEnd, type RuntimeLike } from "./delivery.js";
import { dedupeFindings, joinStatus, laneEmits } from "./fanout.js";
import { noGroupAdapter, type SwarmGroupAdapter } from "./group.js";
import { loadHolon, targetMembers, type Holon } from "./holon.js";
import { holonBranch, memberBranch, mergePartition } from "./partition.js";
import { effectiveContract } from "./rounds.js";
import {
  renderRouteMessage,
  resolveRoute,
  ROLE_PLACEHOLDER,
  TASKMASTER,
  TERMINAL_EVENTS,
  UPSTREAM,
} from "./routing.js";
import { DEFAULT_AGENT_ID, laneRoleOf, sessionKeyFor } from "./sessions.js";
import {
  appendEvent,
  readEvents,
  readTasksIndex,
  TaskLocks,
  updateTaskIndexEntry,
  type SwarmEvent,
  type TaskStatus,
} from "./store.js";
import { deliverUpstream, type ChannelSender } from "./upstream.js";

// Routing engine (ARCH §4, §5).

export type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error?: (msg: string) => void;
};

export type EngineOptions = {
  stateDir: string;
  runtime: RuntimeLike;
  agentId?: string;
  lane?: string;
  defaults?: ContractDefaults;
  logger?: Logger;
  channelSender?: ChannelSender;
  /** Optional per-task channel group (ARCH §1.5); defaults to the no-group adapter. */
  group?: SwarmGroupAdapter;
  /** Called after any event is appended; the wall deadline uses it to arm new tasks. */
  onEvent?: (taskId: string, event: SwarmEvent) => void;
};

export type EmitInput = {
  event: string;
  sha: string;
  body: string;
  /** RETRY only: the worker role to re-prompt. */
  role?: string;
};

export type EmitResult =
  | { ok: true; seq: number; routedTo: string | null; notice?: string }
  | { ok: false; error: string };

export type TaskState = {
  contract: Contract;
  /** The holon this task is (ARCH §2); for a v1 contract, one lane per role (§11). */
  holon: Holon;
  status: TaskStatus;
  sha: string;
  events: SwarmEvent[];
};

/** Full commit id of the repo HEAD, or undefined without a repo or a resolvable HEAD. */
export function readRepoHead(repo: string | undefined): string | undefined {
  if (!repo) {
    return undefined;
  }
  try {
    return execFileSync("git", ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
      cwd: repo,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

/**
 * The role's most recent model observation, if it was a mismatch. A later MODEL_OBSERVED that
 * matches the contract (after a re-apply) clears it.
 */
export function modelMismatchFor(
  events: SwarmEvent[],
  role: string,
): { expected: string; observed: string } | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (!e || e.from !== role) {
      continue;
    }
    if (e.event === "MODEL_MISMATCH") {
      return {
        expected: String(e.data?.expected ?? ""),
        observed: String(e.data?.observed ?? ""),
      };
    }
    if (e.event === "MODEL_OBSERVED") {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Seq of the last event addressed to a role (the input its next emit answers). A lane
 * member's own input is addressed to the member key (`audit:2`); the lane role (`audit`) is
 * where the settled lane event went, never a member's mailbox (ARCH §4.5).
 */
export function lastInputSeqFor(events: SwarmEvent[], role: string): number | undefined {
  return events.findLast((e) => (e.kind === "emit" || e.kind === "system") && e.to === role)?.seq;
}

export class SwarmEngine {
  readonly locks = new TaskLocks();
  readonly mailbox: Mailbox;
  readonly stateDir: string;
  readonly runtime: RuntimeLike;
  readonly agentId: string;
  readonly defaults: ContractDefaults;
  readonly logger?: Logger;
  readonly group: SwarmGroupAdapter;
  private readonly channelSender?: ChannelSender;
  private readonly onEvent?: EngineOptions["onEvent"];
  /** Set by the hooks: exit enforcement and run errors when a run ends (ARCH §5, §7). */
  runEndHandler?: (end: RunEnd) => Promise<void>;

  constructor(opts: EngineOptions) {
    this.stateDir = opts.stateDir;
    this.runtime = opts.runtime;
    this.agentId = opts.agentId ?? DEFAULT_AGENT_ID;
    this.defaults = opts.defaults ?? {};
    this.logger = opts.logger;
    this.channelSender = opts.channelSender;
    this.onEvent = opts.onEvent;
    this.group = opts.group ?? noGroupAdapter;
    this.mailbox = new Mailbox(opts.runtime, {
      lane: opts.lane,
      logger: opts.logger,
      onRunEnd: async (end) => {
        await this.runEndHandler?.(end);
      },
    });
  }

  sessionKey(taskId: string, role: string): string {
    return sessionKeyFor(taskId, role, this.agentId);
  }

  loadState(taskId: string): TaskState {
    const entry = readTasksIndex(this.stateDir)[taskId];
    if (!entry) {
      throw new Error(`task "${taskId}" not found`);
    }
    const holon = loadHolon(this.stateDir, taskId, this.defaults);
    const events = readEvents(this.stateDir, taskId);
    return {
      // ARCH §12: the current round's input, done_when and wall; round 1 is the contract as is.
      contract: effectiveContract(holon.contract, events),
      holon: { ...holon, contract: effectiveContract(holon.contract, events) },
      status: entry.status,
      // ARCH §4: the sha is information, not a gate; the task reports the repo head.
      sha: readRepoHead(holon.contract.repo) ?? entry.sha,
      events,
    };
  }

  record(taskId: string, event: Omit<SwarmEvent, "seq" | "ts" | "taskId">): SwarmEvent {
    const appended = appendEvent(this.stateDir, taskId, event);
    this.onEvent?.(taskId, appended);
    return appended;
  }

  /** Called by swarm_emit. Identity (taskId, role) must come from the session key only. */
  async emit(taskId: string, from: string, input: EmitInput): Promise<EmitResult> {
    return this.locks.run(taskId, () => this.emitLocked(taskId, from, input));
  }

  private async emitLocked(taskId: string, from: string, input: EmitInput): Promise<EmitResult> {
    let state: TaskState;
    try {
      state = this.loadState(taskId);
    } catch (err) {
      return { ok: false, error: String(err instanceof Error ? err.message : err) };
    }
    if (state.status !== "open") {
      return { ok: false, error: `task ${taskId} is ${state.status}; not open for events` };
    }
    const laneRole = laneRoleOf(from);
    const isTaskmaster = from === TASKMASTER;
    if (!isTaskmaster && !state.contract.workers[laneRole]) {
      return { ok: false, error: `role "${from}" is not a worker of task ${taskId}` };
    }
    const wrongModel = modelMismatchFor(state.events, from);
    if (wrongModel) {
      // ARCH §3: work done on another model is never routed.
      this.record(taskId, {
        kind: "system",
        event: "EMIT_REFUSED_WRONG_MODEL",
        from,
        sha: input.sha,
        data: wrongModel,
      });
      return {
        ok: false,
        error:
          `refused: this session ran on ${wrongModel.observed}, not its contract model ` +
          `${wrongModel.expected}; the task was escalated upstream`,
      };
    }
    const event = input.event.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(event)) {
      return { ok: false, error: `invalid event name "${input.event}"` };
    }

    const route = resolveRoute(state.contract.routes, { event, from: laneRole });
    // A lane member shares the lane's routes; its emits record the lane as `to` (§4.5).
    let to: string | null = route ? route.to : null;
    if (to === ROLE_PLACEHOLDER) {
      const target = input.role?.trim().toLowerCase();
      if (!target || !state.contract.workers[target]) {
        return { ok: false, error: `${event} needs a "role" naming a worker of task ${taskId}` };
      }
      to = target;
    }

    const emitted = this.record(taskId, {
      kind: "emit",
      event,
      from,
      to,
      sha: input.sha,
      body: input.body,
    });

    if (!route || !to) {
      if (!isTaskmaster) {
        await this.notify(taskId, state, {
          event: "UNROUTED",
          body: `worker ${from} emitted ${event} @ ${input.sha}, which has no route.\n${input.body}`,
        });
      }
      return {
        ok: true,
        seq: emitted.seq,
        routedTo: null,
        notice: `no route for ${event} from ${from}; logged only`,
      };
    }

    // ARCH §4: an emit between members of fanned-out lanes joins in the engine; the lead
    // gets one event. A fanned-out FROM lane joins its members' verdicts; a fanned-out TO
    // lane gets the message fanned out to every member.
    const fromLane = state.holon.lanes.find((l) => l.role === laneRole);
    const toLane = to ? state.holon.lanes.find((l) => l.role === to) : undefined;
    if (!isTaskmaster && fromLane && fromLane.count > 1) {
      return this.joinFanOut(taskId, state, {
        fromLane,
        to,
        event,
        emitted,
        input,
        message: `${renderRouteMessage(route.message, { sha: input.sha })}\n${input.body}`.trim(),
      });
    }
    if (toLane && toLane.count > 1) {
      const message =
        `${renderRouteMessage(route.message, { sha: input.sha })}\n${input.body}`.trim();
      for (const member of targetMembers(state.holon, toLane.role)) {
        await this.sendTo(taskId, state, {
          to: member,
          from,
          event,
          sha: input.sha,
          body: message,
          seqs: [emitted.seq],
          salt: member,
        });
      }
      return { ok: true, seq: emitted.seq, routedTo: toLane.role };
    }

    const message =
      `${renderRouteMessage(route.message, { sha: input.sha })}\n${input.body}`.trim();
    if (to === UPSTREAM) {
      await this.toUpstream(taskId, state, { event, from, sha: input.sha, body: message });
      if (TERMINAL_EVENTS.has(event)) {
        this.close(taskId, event === "DONE" ? "done" : event === "FAILED" ? "failed" : "cancelled");
      }
      return { ok: true, seq: emitted.seq, routedTo: UPSTREAM };
    }

    const result = await this.sendTo(taskId, state, {
      to,
      from,
      event,
      sha: input.sha,
      body: message,
      seqs: [emitted.seq],
    });
    return {
      ok: true,
      seq: emitted.seq,
      routedTo: to,
      ...(result.status === "failed" && {
        notice: `routed to ${to}; delivery pending (${result.error}); it will be resent`,
      }),
    };
  }

  /** Deliver an envelope to a task participant through the mailbox, logging the send. */
  async sendTo(
    taskId: string,
    state: Pick<TaskState, "contract"> & { holon?: Holon },
    msg: {
      to: string;
      from: string;
      event: string;
      sha: string;
      body: string;
      seqs: number[];
      extraSystemPrompt?: string;
      urgent?: boolean;
      salt?: string;
    },
  ) {
    const msgId = msgIdFor(taskId, msg.seqs, msg.salt ?? msg.to);
    const brief = state.holon
      ? holonBriefFor(state.holon, [], msg.to)
      : briefFor(state.contract, msg.to);
    return this.mailbox.deliver({
      stateDir: this.stateDir,
      taskId,
      targetSessionKey: this.sessionKey(taskId, msg.to),
      to: msg.to,
      seqs: msg.seqs,
      idempotencyKey: msgId,
      message: formatEnvelope(
        { taskId, from: msg.from, to: msg.to, event: msg.event, sha: msg.sha, body: msg.body },
        msgId,
      ),
      extraSystemPrompt: msg.extraSystemPrompt ?? brief,
      urgent: msg.urgent,
    });
  }

  /** System notice to the taskmaster (exit enforcement, silence, unrouted, model mismatch). */
  async notify(
    taskId: string,
    state: Pick<TaskState, "contract" | "sha">,
    notice: { event: string; body: string; from?: string; sha?: string },
  ) {
    const rec = this.record(taskId, {
      kind: "system",
      event: notice.event,
      from: notice.from ?? "swarm",
      to: TASKMASTER,
      sha: notice.sha ?? state.sha,
      body: notice.body,
    });
    return this.sendTo(taskId, state, {
      to: TASKMASTER,
      from: notice.from ?? "swarm",
      event: notice.event,
      sha: notice.sha ?? state.sha,
      body: notice.body,
      seqs: [rec.seq],
    });
  }

  async toUpstream(
    taskId: string,
    state: Pick<TaskState, "contract">,
    msg: { event: string; from: string; sha: string; body: string },
    opts: { force?: boolean } = {},
  ): Promise<void> {
    const upstream = state.contract.upstream;
    await deliverUpstream({
      engine: this,
      taskId,
      upstream:
        opts.force && !upstream.events.includes(msg.event)
          ? { ...upstream, events: [...upstream.events, msg.event] }
          : upstream,
      envelope: {
        taskId,
        from: msg.from,
        to: UPSTREAM,
        event: msg.event,
        sha: msg.sha,
        body: msg.body,
      },
      channelSender: this.channelSender,
    });
  }

  close(taskId: string, status: Exclude<TaskStatus, "open">): void {
    updateTaskIndexEntry(this.stateDir, taskId, { status });
    this.record(taskId, { kind: "system", event: "TASK_CLOSED", data: { status } });
    // A group is a convenience; failing to dispose it never affects the task.
    void this.group.dispose(taskId).catch(() => undefined);
  }

  /**
   * ARCH §3.2: the lead's own model, applied to its session at start and re-applied on resume.
   * A v1 holon has no lead key: the session keeps the gateway default model, as before (§11).
   */
  async applyLeadModel(taskId: string, holon: Holon): Promise<void> {
    if (holon.v1 || (!holon.lead.model && !holon.lead.thinking)) {
      return;
    }
    const patch = (this.runtime.subagent as { patchSession?: unknown }).patchSession as
      | ((p: {
          sessionKey: string;
          model?: string;
          thinkingLevel?: string;
          label?: string;
        }) => Promise<{ provider: string; model: string }>)
      | undefined;
    if (!patch) {
      throw new Error("runtime cannot apply the lead model (patchSession unavailable)");
    }
    const sessionKey = this.sessionKey(taskId, TASKMASTER);
    const resolved = await patch({
      sessionKey,
      label: `swarm:${taskId}:${TASKMASTER}`,
      ...(holon.lead.model && { model: holon.lead.model }),
      ...(holon.lead.thinking && { thinkingLevel: holon.lead.thinking }),
    });
    this.record(taskId, {
      kind: "system",
      event: "MODEL_APPLIED",
      from: TASKMASTER,
      data: {
        model: holon.lead.model,
        thinking: holon.lead.thinking,
        provider: resolved.provider,
        resolved: `${resolved.provider}/${resolved.model}`,
      },
    });
  }

  /**
   * ARCH §4.4/§4.5: a verdict from one member of a fanned-out lane. The emit is logged; the
   * lane's join is computed from the log; when it settles, the lead gets exactly one event —
   * pass, or the deduplicated dissent — so routing stays linear.
   */
  private async joinFanOut(
    taskId: string,
    state: TaskState,
    args: {
      fromLane: Holon["lanes"][number];
      /** Where the settled verdict routes (lane role, taskmaster or upstream). */
      to: string | null;
      event: string;
      emitted: SwarmEvent;
      input: EmitInput;
      message: string;
    },
  ): Promise<EmitResult> {
    const { fromLane, to, event, emitted, input, message } = args;
    const kind = classify(event);
    if (!kind || !to || to === TASKMASTER || to === UPSTREAM) {
      // Not a verdict the join understands (e.g. BLOCKED): straight through, as v1.
      await this.sendTo(taskId, state, {
        to: to ?? TASKMASTER,
        from: emitted.from ?? fromLane.role,
        event,
        sha: input.sha,
        body: message,
        seqs: [emitted.seq],
      });
      return { ok: true, seq: emitted.seq, routedTo: to };
    }

    // Run the lane's join over its members' verdicts since this round's first member emit.
    // state.events was loaded before this emit was recorded; re-read so the log is the
    // single source (ARCH §2) and the current emit counts.
    const fresh = this.loadState(taskId).events;
    const floor = this.laneFloor(state, fromLane.role);
    const passEvent = passOf(event);
    const failEvent = VERDICTS[passEvent]!;
    const emits = [
      ...laneEmits(fresh, fromLane, passEvent, floor),
      ...laneEmits(fresh, fromLane, failEvent, floor),
    ].toSorted((a, b) => a.seq - b.seq);
    // A lane settles once per round: a late verdict after the settle (join any with a slow
    // member, or a re-prompted straggler) is logged and never re-settles the round.
    const settledSeq = fresh.findLast(
      (e) =>
        e.kind === "system" &&
        e.event === "LANE_SETTLED" &&
        e.seq > floor &&
        e.data?.lane === fromLane.role &&
        e.data?.verdict === passEvent,
    )?.seq;
    if (settledSeq !== undefined && emitted.seq > settledSeq) {
      this.record(taskId, {
        kind: "system",
        event: "LANE_LATE_VERDICT",
        from: emitted.from,
        sha: input.sha,
        data: { lane: fromLane.role, event },
      });
      return {
        ok: true,
        seq: emitted.seq,
        routedTo: null,
        notice: `lane ${fromLane.role} already settled this round; logged only`,
      };
    }
    const status = joinStatus(fromLane, emits, passEvent, failEvent);

    if (!status.settled) {
      await this.notify(taskId, state, {
        event: "LANE_WAITING",
        body: `${fromLane.role} member ${emitted.from} emitted ${event} @ ${input.sha}; join ${status.reason}.`,
      });
      return {
        ok: true,
        seq: emitted.seq,
        routedTo: TASKMASTER,
        notice: `lane ${fromLane.role} not settled (${status.reason}); the lead was told`,
      };
    }

    if (status.outcome === "cancel-rest") {
      const winner = status.winner;
      const stopRec = this.record(taskId, {
        kind: "system",
        event: "LANE_CANCELLED",
        from: TASKMASTER,
        sha: winner.sha,
        data: { lane: fromLane.role, winner: winner.from, event },
      });
      for (const member of targetMembers(state.holon, fromLane.role)) {
        if (member === winner.from) {
          continue;
        }
        await this.sendTo(taskId, state, {
          to: member,
          from: TASKMASTER,
          event: "CANCELLED",
          sha: winner.sha ?? state.sha,
          body: `lane ${fromLane.role} is settled by ${winner.from} (join any); stop this lane round.`,
          seqs: [stopRec.seq],
          urgent: true,
          salt: `join-any-${fromLane.role}-${emitted.seq}-${member}`,
        });
      }
    }

    const pass = status.outcome !== "fail";
    const body = pass
      ? `lane ${fromLane.role} settled (${fromLane.join.kind === "quorum" ? `quorum:${fromLane.join.k}` : fromLane.join.kind}). ` +
        message
      : `lane ${fromLane.role} findings (deduplicated, dissenters: ${status.dissenters.join(", ")}):\n${status.findings}`;

    // A partitioned lane that passed merges its member branches into the holon branch (§4.2).
    let sha = input.sha;
    if (pass && fromLane.partition && state.contract.repo) {
      const base = this.holonBranch(state.contract.repo);
      if (base) {
        const merged = mergePartition(
          state.contract.repo,
          base,
          Array.from({ length: fromLane.count }, (_, i) => memberBranch(base, i + 1)),
        );
        if (merged.ok) {
          sha = merged.sha;
          this.record(taskId, {
            kind: "system",
            event: "LANE_MERGED",
            from: TASKMASTER,
            sha,
            data: { lane: fromLane.role, members: fromLane.count },
          });
        } else {
          await this.notify(taskId, state, {
            event: "LANE_MERGE_CONFLICT",
            body:
              `lane ${fromLane.role} passed but merging ${merged.conflicted} into ${base} ` +
              `conflicted; resolve it (the other members are merged).\n${merged.detail}`,
          });
          return {
            ok: true,
            seq: emitted.seq,
            routedTo: TASKMASTER,
            notice: `merge conflict on ${merged.conflicted}; the lead was told`,
          };
        }
      }
    }

    // One lane event to the lead (§4.5); the lead drives the next hop. The settle marker
    // closes the round: a later verdict from this lane is LANE_LATE_VERDICT, never re-routed.
    this.record(taskId, {
      kind: "system",
      event: "LANE_SETTLED",
      from: fromLane.role,
      sha,
      data: {
        lane: fromLane.role,
        verdict: pass ? passEvent : failEvent,
        join: fromLane.join.kind === "quorum" ? `quorum:${fromLane.join.k}` : fromLane.join.kind,
      },
    });
    await this.notify(taskId, state, {
      event: pass ? passEvent : failEvent,
      from: fromLane.role,
      body,
      sha,
    });
    return {
      ok: true,
      seq: emitted.seq,
      routedTo: TASKMASTER,
      notice: `lane ${fromLane.role} settled (${pass ? "pass" : "fail"}); the lead was told`,
    };
  }

  /** The branch the holon works on: the repo's checked-out branch (v1 default; §4.2). */
  private holonBranch(repo: string): string | undefined {
    try {
      return holonBranch(repo) || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The seq after which this lane's current round of verdicts counts: the last event that
   * handed work into the lane — TASK_STARTED/ROUND_STARTED for the first lane, or the emit
   * that was fanned out to it — so an earlier round's verdicts never count twice.
   */
  private laneFloor(state: TaskState, role: string): number {
    let floor = 0;
    for (const e of state.events) {
      if (
        e.kind === "system" &&
        (e.event === "TASK_STARTED" || e.event === "ROUND_STARTED") &&
        e.to === role
      ) {
        floor = e.seq;
      }
      // An emit routed to this lane fans out to its members: it is the round's input.
      if (e.kind === "emit" && e.to === role) {
        floor = e.seq;
      }
    }
    return floor;
  }
}

/** PASS/FAIL verdict pairs the fan-out join understands (ARCH §4.4). */
const VERDICTS: Record<string, string> = {
  BUILD_DONE: "BUILD_FAILED",
  AUDIT_PASS: "AUDIT_FAIL",
  TEST_PASS: "TEST_FAIL",
};

function classify(event: string): "pass" | "fail" | undefined {
  if (event in VERDICTS) {
    return "pass";
  }
  if (Object.values(VERDICTS).includes(event)) {
    return "fail";
  }
  return undefined;
}

function passOf(event: string): string {
  for (const [pass, fail] of Object.entries(VERDICTS)) {
    if (fail === event) {
      return pass;
    }
  }
  return event;
}
