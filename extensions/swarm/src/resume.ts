import { briefFor } from "./briefs.js";
import { msgIdFor } from "./delivery.js";
import { lastInputSeqFor, type SwarmEngine, type TaskState } from "./engine.js";
import { TASKMASTER } from "./routing.js";
import { appendOutbox, readOutbox, readTasksIndex, type OutboxEntry } from "./store.js";

// Resume after a gateway restart (ARCH §8, §7).

export type ResumeSummary = {
  tasks: number;
  resent: number;
  ackedFromTranscript: number;
  ackedAsAnswered: number;
  redelivered: number;
  /** Unacked entries left alone because their transcript could not be read. */
  deferred: number;
  /** Workers held back because their contract model could not be re-applied. */
  modelBlocked: number;
};

/** ARCH §8 step 2: the line put on top of a re-delivered input. */
export const RESTART_LINE =
  "[gateway restarted during this input; check what is already done, then finish and emit]";

function messageText(msg: unknown): string {
  const content = (msg as { content?: unknown })?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        typeof (c as { text?: unknown })?.text === "string" ? (c as { text: string }).text : "",
      )
      .join("\n");
  }
  return "";
}

/** sessions.get returns the newest `limit` messages (default 200); ask for all of them. */
const WHOLE_TRANSCRIPT = Number.MAX_SAFE_INTEGER;

type TranscriptCheck = "delivered" | "absent" | "unknown";

/**
 * ARCH §8 "never double-delivered": the gateway dedupe map is empty after a restart, so check
 * the target session's durable transcript for the MSG id before resending. Fails closed: if
 * the transcript cannot be read, the answer is "unknown" and the entry is left for later.
 */
async function checkTranscript(engine: SwarmEngine, entry: OutboxEntry): Promise<TranscriptCheck> {
  const get = engine.runtime.subagent.getSessionMessages;
  if (!get) {
    return "unknown";
  }
  try {
    const { messages } = await get({ sessionKey: entry.targetSessionKey, limit: WHOLE_TRANSCRIPT });
    const needle = `MSG ${entry.idempotencyKey}`;
    return messages.some((m) => messageText(m).includes(needle)) ? "delivered" : "absent";
  } catch {
    return "unknown";
  }
}

/** Insert the resend marker right after the MSG line (or the EVENT line for older entries). */
export function withResendMarker(message: string, seq: number): string {
  if (message.includes("[RESEND of seq")) {
    return message;
  }
  const lines = message.split("\n");
  const at = lines.findIndex((l) => l.startsWith("MSG "));
  const anchor = at >= 0 ? at : lines.findIndex((l) => l.startsWith("EVENT "));
  lines.splice(anchor >= 0 ? anchor + 1 : lines.length, 0, `[RESEND of seq ${seq}]`);
  return lines.join("\n");
}

/** The target already emitted an answer after this entry's input (resend would fork the flow). */
function alreadyAnswered(state: TaskState, entry: OutboxEntry): boolean {
  const first = Math.min(...(entry.seqs.length > 0 ? entry.seqs : [entry.seq]));
  return state.events.some((e) => e.kind === "emit" && e.from === entry.to && e.seq > first);
}

/** The text the session got for `inputSeq`, with a fresh MSG id and the restart line on top. */
function redeliveryText(
  state: TaskState,
  outbox: OutboxEntry[],
  role: string,
  inputSeq: number,
  msgId: string,
): string {
  const sent = outbox.findLast((o) => o.to === role && !o.supersedes && o.seqs.includes(inputSeq));
  const input = state.events.find((e) => e.seq === inputSeq);
  const original =
    sent?.message ??
    [
      `TASK ${state.contract.id} | FROM ${input?.from ?? "swarm"} | TO ${role}`,
      `EVENT ${input?.event ?? "UNKNOWN"} @ ${input?.sha ?? state.sha}`,
      `MSG ${msgId}`,
      input?.body ?? "",
    ].join("\n");
  const body = original.startsWith(`${RESTART_LINE}\n`)
    ? original.slice(RESTART_LINE.length + 1)
    : original;
  return `${RESTART_LINE}\n${body.replace(/^MSG \S+$/m, `MSG ${msgId}`)}`;
}

async function resumeTask(engine: SwarmEngine, taskId: string, summary: ResumeSummary) {
  const state = engine.loadState(taskId);
  if (state.status !== "open") {
    return;
  }
  // A terminal upstream event in the log means the task finished before the index caught up.
  if (
    state.events.some((e) => e.event === "DONE" && (e.from === TASKMASTER || e.kind === "upstream"))
  ) {
    engine.close(taskId, "done");
    return;
  }
  summary.tasks += 1;
  engine.record(taskId, { kind: "system", event: "RESUMED", sha: state.sha });

  // ARCH §3: never send work to a worker that could run on the wrong model.
  const blockedRoles = await reapplyModels(engine, state);
  for (const role of blockedRoles) {
    summary.modelBlocked += 1;
    await engine.toUpstream(taskId, state, {
      event: "BLOCKED",
      from: role,
      sha: state.sha,
      body: `cannot re-apply the contract model to worker ${role} after restart; held, not resumed`,
    });
  }

  // Step 1: resend unacknowledged outbox entries, never double-delivered.
  const outbox = readOutbox(engine.stateDir, taskId);
  // A merged delivery carries queued parts. While it is unresolved the parts are its
  // responsibility; once it is acked the parts are acked too (written after the merged send).
  const coveredByMerged = new Set(
    outbox.filter((o) => !o.acked && o.supersedes).flatMap((o) => o.supersedes ?? []),
  );
  for (const entry of outbox.filter((o) => !o.acked)) {
    if (blockedRoles.has(entry.to) || coveredByMerged.has(entry.idempotencyKey)) {
      continue;
    }
    if (alreadyAnswered(state, entry)) {
      appendOutbox(engine.stateDir, taskId, {
        type: "ack",
        idempotencyKey: entry.idempotencyKey,
        ts: Date.now(),
      });
      summary.ackedAsAnswered += 1;
      continue;
    }
    const transcript = await checkTranscript(engine, entry);
    if (transcript === "delivered") {
      for (const key of [entry.idempotencyKey, ...(entry.supersedes ?? [])]) {
        appendOutbox(engine.stateDir, taskId, { type: "ack", idempotencyKey: key, ts: Date.now() });
      }
      summary.ackedFromTranscript += 1;
      continue;
    }
    if (transcript === "unknown") {
      summary.deferred += 1;
      continue;
    }
    await engine.mailbox.resend(engine.stateDir, taskId, {
      ...entry,
      message: withResendMarker(entry.message, entry.seqs[0] ?? entry.seq),
    });
    summary.resent += 1;
  }

  // Step 2: every session whose last delivered input has no emit after it and that has no
  // active run gets that input again. On every restart; no "already re-prompted" skip.
  const after = engine.loadState(taskId);
  const pending = readOutbox(engine.stateDir, taskId);
  const undelivered = new Set(pending.filter((o) => !o.acked).map((o) => o.to));
  for (const role of [...Object.keys(after.contract.workers), TASKMASTER]) {
    const sessionKey = engine.sessionKey(taskId, role);
    const inputSeq = lastInputSeqFor(after.events, role);
    if (
      inputSeq === undefined ||
      blockedRoles.has(role) ||
      undelivered.has(role) || // its last input is step 1's (not delivered yet)
      engine.mailbox.isBusy(sessionKey) ||
      after.events.some((e) => e.kind === "emit" && e.from === role && e.seq > inputSeq)
    ) {
      continue;
    }
    const rec = engine.record(taskId, {
      kind: "system",
      event: "REDELIVERED",
      from: "swarm",
      sha: after.sha,
      data: { role, inputSeq },
    });
    const msgId = msgIdFor(taskId, [inputSeq], `restart-${rec.seq}`);
    await engine.mailbox.deliver({
      stateDir: engine.stateDir,
      taskId,
      targetSessionKey: sessionKey,
      to: role,
      seqs: [inputSeq],
      idempotencyKey: msgId,
      message: redeliveryText(after, pending, role, inputSeq, msgId),
      extraSystemPrompt: briefFor(after.contract, role),
    });
    summary.redelivered += 1;
  }
}

/**
 * Re-apply each worker's contract model/thinking (ARCH §3). Returns the roles whose re-apply
 * failed: resume must not hand those workers anything, since they could run on another model.
 */
export async function reapplyModels(engine: SwarmEngine, state: TaskState): Promise<Set<string>> {
  const blocked = new Set<string>();
  const patch = (engine.runtime.subagent as { patchSession?: unknown }).patchSession as
    | ((p: { sessionKey: string; model?: string; thinkingLevel?: string }) => Promise<unknown>)
    | undefined;
  for (const [role, spec] of Object.entries(state.contract.workers)) {
    if (!spec.model && !spec.thinking) {
      continue;
    }
    if (!patch) {
      blocked.add(role);
      continue;
    }
    try {
      await patch({
        sessionKey: engine.sessionKey(state.contract.id, role),
        ...(spec.model && { model: spec.model }),
        ...(spec.thinking && { thinkingLevel: spec.thinking }),
      });
    } catch (err) {
      blocked.add(role);
      engine.record(state.contract.id, {
        kind: "system",
        event: "MODEL_REAPPLY_FAILED",
        from: role,
        data: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
  return blocked;
}

/** Plain async entry point invoked by the plugin service on gateway start. */
export async function resumeOpenTasks(engine: SwarmEngine): Promise<ResumeSummary> {
  const summary: ResumeSummary = {
    tasks: 0,
    resent: 0,
    ackedFromTranscript: 0,
    ackedAsAnswered: 0,
    redelivered: 0,
    deferred: 0,
    modelBlocked: 0,
  };
  for (const [taskId, entry] of Object.entries(readTasksIndex(engine.stateDir))) {
    if (entry.status !== "open") {
      continue;
    }
    try {
      await engine.locks.run(taskId, () => resumeTask(engine, taskId, summary));
    } catch (err) {
      engine.logger?.warn(
        `[swarm] resume of ${taskId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return summary;
}
