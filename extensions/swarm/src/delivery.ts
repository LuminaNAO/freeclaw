import { createHash } from "node:crypto";
import type { PluginRuntime } from "openclaw/plugin-sdk/swarm";
import { appendEvent, appendOutbox, readOutbox, type OutboxEntry } from "./store.js";

// Mailbox + delivery (ARCH §1.3, §4, §8).

export type SubagentLike = Pick<PluginRuntime["subagent"], "run" | "waitForRun"> &
  Partial<Pick<PluginRuntime["subagent"], "abortSession" | "getSessionMessages">>;

export type RuntimeLike = { subagent: SubagentLike };

export const DEFAULT_LANE = "subagent";
const LOCK_RETRY_DELAYS_MS = [500, 2000, 5000];
const DEFAULT_RUN_WAIT_MS = 4 * 60 * 60 * 1000;

export type Envelope = {
  taskId: string;
  from: string;
  to: string;
  event: string;
  sha: string;
  body: string;
};

/** ARCH §4 header, plus the MSG id line used for transcript lookup (ARCH §4, §8). */
export function formatEnvelope(env: Envelope, msgId: string, resendOf?: number): string {
  const lines = [
    `TASK ${env.taskId} | FROM ${env.from} | TO ${env.to}`,
    `EVENT ${env.event} @ ${env.sha}`,
    `MSG ${msgId}`,
  ];
  if (resendOf !== undefined) {
    lines.push(`[RESEND of seq ${resendOf}]`);
  }
  if (env.body) {
    lines.push(env.body);
  }
  return lines.join("\n");
}

export function msgIdFor(taskId: string, seqs: number[], salt = ""): string {
  const digest = createHash("sha256")
    .update(`${taskId}|${seqs.join(",")}|${salt}`)
    .digest("hex")
    .slice(0, 24);
  return `swarm-${digest}`;
}

export type DeliveryRequest = {
  stateDir: string;
  taskId: string;
  targetSessionKey: string;
  to: string;
  /** Event seqs answered by / included in this message. */
  seqs: number[];
  message: string;
  idempotencyKey: string;
  extraSystemPrompt?: string;
  urgent?: boolean;
  /** Merged delivery: the queued entries it carries. */
  supersedes?: string[];
};

/** A run the swarm started has settled (gateway agent.wait for its run id). */
export type RunEnd = {
  sessionKey: string;
  runId: string;
  status: "ok" | "error" | "aborted";
  error?: string;
};

export type DeliveryResult =
  | { status: "delivered"; runId: string }
  | { status: "queued" }
  | { status: "failed"; error: string };

function isLockError(err: unknown): boolean {
  return /session file locked/i.test(String(err));
}

/** Append a delivery record unless the outbox already has one for this key. */
function recordDelivery(req: DeliveryRequest): void {
  const known = readOutbox(req.stateDir, req.taskId).some(
    (o) => o.idempotencyKey === req.idempotencyKey,
  );
  if (known) {
    return;
  }
  appendOutbox(req.stateDir, req.taskId, {
    type: "delivery",
    seq: req.seqs[0] ?? 0,
    ts: Date.now(),
    idempotencyKey: req.idempotencyKey,
    targetSessionKey: req.targetSessionKey,
    to: req.to,
    message: req.message,
    seqs: req.seqs,
    ...(req.urgent && { urgent: true }),
    ...(req.extraSystemPrompt && { extraSystemPrompt: req.extraSystemPrompt }),
    ...(req.supersedes && { supersedes: req.supersedes }),
  });
}

/**
 * Per-session mailbox (ARCH §1.3, §5). One run at a time per target session: a message for a
 * session whose run has not settled is held and flushed as ONE combined message when it does.
 * The only signal that a run is over is the gateway's agent.wait for that run id, which spans
 * the whole run including its internal retries; nothing else releases a session.
 */
export class Mailbox {
  /** Session key → id of the run the swarm started there that has not settled yet. */
  private readonly active = new Map<string, string>();
  private readonly pending = new Map<string, DeliveryRequest[]>();

  constructor(
    private readonly runtime: RuntimeLike,
    private readonly opts: {
      lane?: string;
      logger?: { warn: (msg: string) => void };
      sleep?: (ms: number) => Promise<void>;
      runWaitMs?: number;
      /** Called when a run settles, before anything queued for that session is sent. */
      onRunEnd?: (end: RunEnd) => Promise<void> | void;
    } = {},
  ) {}

  isBusy(sessionKey: string): boolean {
    return this.active.has(sessionKey);
  }

  /** Writes the outbox record first, then sends now or holds it for the next turn. */
  async deliver(req: DeliveryRequest): Promise<DeliveryResult> {
    recordDelivery(req);
    if (req.urgent) {
      // Abort is only used for terminal stops (ARCH §4 urgent stop); never for routed work.
      await this.runtime.subagent.abortSession?.({
        sessionKey: req.targetSessionKey,
      });
      this.active.delete(req.targetSessionKey);
      this.pending.delete(req.targetSessionKey);
      return this.send(req);
    }
    if (this.active.has(req.targetSessionKey)) {
      const queue = this.pending.get(req.targetSessionKey) ?? [];
      queue.push(req);
      this.pending.set(req.targetSessionKey, queue);
      return { status: "queued" };
    }
    return this.send(req);
  }

  /**
   * Resend an existing outbox entry with its original key (resume path). Its delivery record
   * already exists, so no second one is written: a crash after the resent run is accepted but
   * before its ack leaves the entry exactly as it was, never re-opened.
   */
  async resend(stateDir: string, taskId: string, entry: OutboxEntry): Promise<DeliveryResult> {
    return this.send({
      stateDir,
      taskId,
      targetSessionKey: entry.targetSessionKey,
      to: entry.to,
      seqs: entry.seqs,
      message: entry.message,
      idempotencyKey: entry.idempotencyKey,
      extraSystemPrompt: entry.extraSystemPrompt,
      supersedes: entry.supersedes,
    });
  }

  /** The session's run settled: flush everything that queued meanwhile as one message. */
  private async flush(sessionKey: string): Promise<DeliveryResult | null> {
    const queue = this.pending.get(sessionKey);
    this.pending.delete(sessionKey);
    if (!queue || queue.length === 0) {
      return null;
    }
    const first = queue[0];
    if (!first) {
      return null;
    }
    if (queue.length === 1) {
      return this.send(first);
    }
    const seqs = queue.flatMap((q) => q.seqs);
    const mergedKey = msgIdFor(first.taskId, seqs, "merged");
    const merged: DeliveryRequest = {
      stateDir: first.stateDir,
      taskId: first.taskId,
      targetSessionKey: sessionKey,
      to: first.to,
      seqs,
      // Own MSG line first, so resume can find the merged message in the transcript.
      message: [`MSG ${mergedKey}`, ...queue.map((q) => q.message)].join("\n\n---\n\n"),
      idempotencyKey: mergedKey,
      extraSystemPrompt: queue.find((q) => q.extraSystemPrompt)?.extraSystemPrompt,
      supersedes: queue.map((q) => q.idempotencyKey),
    };
    // The parts stay unacked until the merged run is accepted; its single ack line then
    // settles them all (store fold). A crash before that leaves everything pending.
    recordDelivery(merged);
    return this.send(merged);
  }

  private async send(req: DeliveryRequest): Promise<DeliveryResult> {
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    let lastError: unknown;
    for (let attempt = 0; attempt <= LOCK_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        // Claimed before the await so a concurrent delivery queues instead of racing.
        this.active.set(req.targetSessionKey, req.idempotencyKey);
        const { runId } = await this.runtime.subagent.run({
          sessionKey: req.targetSessionKey,
          message: req.message,
          idempotencyKey: req.idempotencyKey,
          lane: this.opts.lane ?? DEFAULT_LANE,
          deliver: false,
          ...(req.extraSystemPrompt && { extraSystemPrompt: req.extraSystemPrompt }),
        });
        // Ack only after the gateway accepted the run (ARCH §8 ack order).
        appendOutbox(req.stateDir, req.taskId, {
          type: "ack",
          idempotencyKey: req.idempotencyKey,
          ts: Date.now(),
          runId,
        });
        appendEvent(req.stateDir, req.taskId, {
          kind: "send",
          event: "DELIVERED",
          to: req.to,
          msgId: req.idempotencyKey,
          data: { seqs: req.seqs, runId },
        });
        this.active.set(req.targetSessionKey, runId);
        this.watchRun(req.targetSessionKey, runId);
        return { status: "delivered", runId };
      } catch (err) {
        this.active.delete(req.targetSessionKey);
        lastError = err;
        const delay = LOCK_RETRY_DELAYS_MS[attempt];
        if (!isLockError(err) || delay === undefined) {
          break;
        }
        await sleep(delay);
      }
    }
    const error = lastError instanceof Error ? lastError.message : String(lastError);
    appendOutbox(req.stateDir, req.taskId, {
      type: "fail",
      idempotencyKey: req.idempotencyKey,
      ts: Date.now(),
      error,
    });
    this.opts.logger?.warn(`[swarm] delivery to ${req.to} failed; left for resume`);
    return { status: "failed", error };
  }

  /** Push signal for the end of the run; the session stays claimed until then. */
  private watchRun(sessionKey: string, runId: string): void {
    void this.waitForEnd(sessionKey, runId)
      .then(async (end) => {
        if (this.active.get(sessionKey) !== runId) {
          return; // superseded by an urgent stop
        }
        // Handle the outcome first (it may queue a retry behind this run), then release.
        await this.opts.onRunEnd?.(end);
        if (this.active.get(sessionKey) === runId) {
          this.active.delete(sessionKey);
          await this.flush(sessionKey);
        }
      })
      .catch((err: unknown) => {
        // The session stays claimed: never risk a second run beside one that may be live.
        this.opts.logger?.warn(`[swarm] waiting for run ${runId} failed: ${String(err)}`);
      });
  }

  /** agent.wait reports an aborted run as "timeout" before the wait window has passed. */
  private async waitForEnd(sessionKey: string, runId: string): Promise<RunEnd> {
    const timeoutMs = this.opts.runWaitMs ?? DEFAULT_RUN_WAIT_MS;
    for (;;) {
      const started = Date.now();
      const res = await this.runtime.subagent.waitForRun({ runId, timeoutMs });
      if (res.status !== "timeout") {
        return { sessionKey, runId, status: res.status, error: res.error };
      }
      if (Date.now() - started < timeoutMs) {
        return { sessionKey, runId, status: "aborted" };
      }
    }
  }
}
