import { execFileSync } from "node:child_process";
import { briefFor } from "./briefs.js";
import { loadContract, type Contract, type ContractDefaults } from "./contract.js";
import { formatEnvelope, Mailbox, msgIdFor, type RunEnd, type RuntimeLike } from "./delivery.js";
import { noGroupAdapter, type SwarmGroupAdapter } from "./group.js";
import { effectiveContract } from "./rounds.js";
import {
  renderRouteMessage,
  resolveRoute,
  ROLE_PLACEHOLDER,
  TASKMASTER,
  TERMINAL_EVENTS,
  UPSTREAM,
} from "./routing.js";
import { DEFAULT_AGENT_ID, sessionKeyFor } from "./sessions.js";
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

/** Seq of the last event addressed to a role (the input its next emit answers). */
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
    const contract = loadContract(this.stateDir, taskId, this.defaults);
    const events = readEvents(this.stateDir, taskId);
    return {
      // ARCH §12: the current round's input, done_when and wall; round 1 is the contract as is.
      contract: effectiveContract(contract, events),
      status: entry.status,
      // ARCH §4: the sha is information, not a gate; the task reports the repo head.
      sha: readRepoHead(contract.repo) ?? entry.sha,
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
    const isTaskmaster = from === TASKMASTER;
    if (!isTaskmaster && !state.contract.workers[from]) {
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

    const route = resolveRoute(state.contract.routes, { event, from });
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
    state: Pick<TaskState, "contract">,
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
      extraSystemPrompt: msg.extraSystemPrompt ?? briefFor(state.contract, msg.to),
      urgent: msg.urgent,
    });
  }

  /** System notice to the taskmaster (exit enforcement, silence, unrouted, model mismatch). */
  async notify(
    taskId: string,
    state: Pick<TaskState, "contract" | "sha">,
    notice: { event: string; body: string; from?: string },
  ) {
    const rec = this.record(taskId, {
      kind: "system",
      event: notice.event,
      from: notice.from ?? "swarm",
      to: TASKMASTER,
      sha: state.sha,
      body: notice.body,
    });
    return this.sendTo(taskId, state, {
      to: TASKMASTER,
      from: notice.from ?? "swarm",
      event: notice.event,
      sha: state.sha,
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
}
