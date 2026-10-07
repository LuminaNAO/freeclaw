import type { PluginHookAgentContext, PluginHookLlmInputEvent } from "openclaw/plugin-sdk/swarm";
import type { RunEnd } from "./delivery.js";
import { lastInputSeqFor, type SwarmEngine, type TaskState } from "./engine.js";
import { TASKMASTER } from "./routing.js";
import { isSwarmSessionKey, parseSwarmSessionKey } from "./sessions.js";
import type { SwarmEvent } from "./store.js";

// Run end: exit enforcement and run errors (ARCH §5, §7), plus the model check (ARCH §3, §10.5).
// A run is over when the gateway reports the whole run settled (mailbox), never earlier.

export type FollowUp = "re-prompt" | "escalate";

const QUOTA_RE = /\b(403|429)\b|quota|rate[ -]?limit|insufficient[_ ]quota|resource[_ ]exhausted/i;

export function isQuotaError(error: string | undefined): boolean {
  return Boolean(error && QUOTA_RE.test(error));
}

function countSince(events: SwarmEvent[], name: string, role: string, inputSeq: number): number {
  return events.filter((e) => e.event === name && e.from === role && e.seq > inputSeq).length;
}

/** First silent end for an input → re-prompt; any further one → escalate. */
export function decideFollowUp(
  events: SwarmEvent[],
  role: string,
  inputSeq = lastInputSeqFor(events, role) ?? 0,
): FollowUp {
  return countSince(events, "WORKER_EXIT_WITHOUT_EMIT", role, inputSeq) <= 1
    ? "re-prompt"
    : "escalate";
}

/** Seq of the DELIVERED event that started this run, if the swarm started it. */
function deliverySeqFor(events: SwarmEvent[], runId: string): number | undefined {
  return events.findLast((e) => e.kind === "send" && e.data?.runId === runId)?.seq;
}

export function createSwarmHooks(getEngine: () => SwarmEngine | undefined) {
  const recordedModelRuns = new Set<string>();

  /** Attach to an engine so every settled run it started comes here. */
  function attach(engine: SwarmEngine) {
    engine.runEndHandler = (end) => onRunEnd(engine, end);
  }

  async function onRunEnd(engine: SwarmEngine, end: RunEnd) {
    const ref = parseSwarmSessionKey(end.sessionKey);
    if (!ref || end.status === "aborted") {
      return; // aborts are urgent stops or a wrong-model stop, already handled
    }
    await engine.locks.run(ref.taskId, async () => {
      let state: TaskState;
      try {
        state = engine.loadState(ref.taskId);
      } catch {
        return;
      }
      if (state.status !== "open") {
        return;
      }
      if (end.status === "error") {
        if (ref.role !== TASKMASTER) {
          await handleRunError(engine, state, ref, end.error);
        }
        return;
      }
      // Emitted = the role logged an emit after the delivery that started this run.
      const since = deliverySeqFor(state.events, end.runId) ?? 0;
      if (state.events.some((e) => e.kind === "emit" && e.from === ref.role && e.seq > since)) {
        return;
      }
      if (ref.role === TASKMASTER) {
        await handleTaskmasterSilence(engine, state);
        return;
      }
      const inputSeq = lastInputSeqFor(state.events, ref.role) ?? 0;
      engine.record(ref.taskId, {
        kind: "system",
        event: "WORKER_EXIT_WITHOUT_EMIT",
        from: ref.role,
        sha: state.sha,
      });
      const events = engine.loadState(ref.taskId).events;
      const action = decideFollowUp(events, ref.role, inputSeq);
      const body =
        action === "re-prompt"
          ? `worker ${ref.role} ended without exit @ ${state.sha}. Re-prompt it once with ` +
            `swarm_emit RETRY (role: ${ref.role}).`
          : `worker ${ref.role} ended without exit @ ${state.sha} again after a re-prompt. ` +
            `Escalate now: swarm_emit BLOCKED with the reason.`;
      await engine.notify(ref.taskId, state, {
        event: "WORKER_EXIT_WITHOUT_EMIT",
        body,
      });
    });
  }

  /** If the taskmaster itself ends silently while an escalation is pending, escalate for it. */
  async function handleTaskmasterSilence(engine: SwarmEngine, state: TaskState) {
    const last = [...state.events]
      .toReversed()
      .find((e) => e.to === TASKMASTER && e.kind !== "send");
    if (last?.event !== "WORKER_EXIT_WITHOUT_EMIT" || !/Escalate now/.test(last.body ?? "")) {
      return;
    }
    await engine.toUpstream(state.contract.id, state, {
      event: "BLOCKED",
      from: TASKMASTER,
      sha: state.sha,
      body: `escalated by swarm: ${last.body}`,
    });
  }

  async function handleRunError(
    engine: SwarmEngine,
    state: TaskState,
    ref: { taskId: string; role: string },
    error: string | undefined,
  ) {
    const reason = error ?? "run ended in error";
    const inputSeq = lastInputSeqFor(state.events, ref.role) ?? 0;
    engine.record(ref.taskId, {
      kind: "system",
      event: "RUN_ERROR",
      from: ref.role,
      sha: state.sha,
      data: { quota: isQuotaError(reason) },
    });
    if (isQuotaError(reason)) {
      // ARCH §7: quota → upstream BLOCKED with reason; never wait silently.
      await engine.toUpstream(ref.taskId, state, {
        event: "BLOCKED",
        from: ref.role,
        sha: state.sha,
        body: `quota exhausted for ${ref.role}: ${reason}`,
      });
      return;
    }
    const errorsForInput = countSince(state.events, "RUN_ERROR", ref.role, inputSeq) + 1;
    if (errorsForInput <= 1) {
      // Queues behind the ended run's release; never a second run beside it (ARCH §5).
      const input = state.events.find((e) => e.seq === inputSeq);
      await engine.sendTo(ref.taskId, state, {
        to: ref.role,
        from: "swarm",
        event: "RETRY_AFTER_ERROR",
        sha: state.sha,
        body: `your previous run ended in an error; retry the same input.\n${input?.body ?? ""}`,
        seqs: [inputSeq],
        salt: `retry-${errorsForInput}`,
      });
      return;
    }
    await engine.toUpstream(ref.taskId, state, {
      event: "FAILED",
      from: ref.role,
      sha: state.sha,
      body: `${ref.role} failed twice on the same input: ${reason}`,
    });
    engine.close(ref.taskId, "failed");
  }

  async function onLlmInput(event: PluginHookLlmInputEvent, ctx: PluginHookAgentContext) {
    if (!isSwarmSessionKey(ctx.sessionKey)) {
      return;
    }
    const engine = getEngine();
    const ref = parseSwarmSessionKey(ctx.sessionKey);
    if (!engine || !ref || ref.role === TASKMASTER) {
      return;
    }
    const runKey = `${ctx.sessionKey}:${event.runId}`;
    if (recordedModelRuns.has(runKey)) {
      return;
    }
    recordedModelRuns.add(runKey);
    await engine.locks.run(ref.taskId, async () => {
      let state: TaskState;
      try {
        state = engine.loadState(ref.taskId);
      } catch {
        return;
      }
      const observed = `${event.provider}/${event.model}`;
      engine.record(ref.taskId, {
        kind: "system",
        event: "MODEL_OBSERVED",
        from: ref.role,
        data: { provider: event.provider, model: event.model, runId: event.runId },
      });
      const expected = state.contract.workers[ref.role]?.model;
      if (expected && expected !== observed) {
        // ARCH §3: a worker must never silently run on another model. Stop the run, refuse
        // its emits (engine.emit checks MODEL_MISMATCH), and escalate; model remap is post-MVP.
        engine.record(ref.taskId, {
          kind: "system",
          event: "MODEL_MISMATCH",
          from: ref.role,
          data: { expected, observed },
        });
        await engine.runtime.subagent.abortSession?.({ sessionKey: ctx.sessionKey ?? "" });
        const body = `worker ${ref.role} ran on ${observed}, but its contract model is ${expected}; run stopped`;
        await engine.toUpstream(ref.taskId, state, {
          event: "BLOCKED",
          from: ref.role,
          sha: state.sha,
          body,
        });
        await engine.notify(ref.taskId, state, { event: "MODEL_MISMATCH", body });
      }
    });
  }

  return { onLlmInput, onRunEnd, attach };
}
