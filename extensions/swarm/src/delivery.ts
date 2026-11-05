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
  /**
   * ARCH §6.4 steer (`urgent: true` work): stop the session's current turn and deliver this
   * message, together with anything already queued for the session, as its next turn. Unlike
   * `urgent` (terminal stop), nothing queued is dropped.
   */
  steer?: boolean;
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
  /**
   * ARCH §7.1.2-3: sessions waiting for a scheduled retry after a run error. Nothing runs in a
   * held session; everything for it queues and goes with the retry when it fires.
   */
  private readonly held = new Set<string>();

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

  /** A message is held for the session's next turn (ARCH §4.7.1: a queued input). */
  hasPending(sessionKey: string): boolean {
    return (this.pending.get(sessionKey)?.length ?? 0) > 0;
  }

  /** ARCH §7.1.4: a retry is scheduled for the session (its next step is in flight). */
  isHeld(sessionKey: string): boolean {
    return this.held.has(sessionKey);
  }

  /** Nothing running, queued or scheduled for the session (ARCH §7.1.5). */
  isIdle(sessionKey: string): boolean {
    return !this.isBusy(sessionKey) && !this.hasPending(sessionKey) && !this.isHeld(sessionKey);
  }

  /**
   * ARCH §7.1.2-3: hold the session until its scheduled retry. Called from the run-end
   * handler, so the ended run's release does not flush what queued behind it.
   */
  hold(sessionKey: string): void {
    this.held.add(sessionKey);
  }

  /**
   * ARCH §7.1.2: the scheduled retry is due. It goes first, with everything that queued
   * during the hold behind it, as one turn (principle 4).
   */
  async release(req: DeliveryRequest): Promise<DeliveryResult> {
    recordDelivery(req);
    const key = req.targetSessionKey;
    this.held.delete(key);
    const queued = this.pending.get(key) ?? [];
    if (this.active.has(key)) {
      // A run started meanwhile (a steer): the retry waits behind it like any message.
      this.pending.set(key, [...queued, req]);
      return { status: "queued" };
    }
    this.pending.set(key, [req, ...queued]);
    return (await this.flush(key)) ?? { status: "queued" };
  }

  /** The holon closed: the hold and what queued under it are dropped (nothing more runs). */
  dropHold(sessionKey: string): void {
    if (this.held.delete(sessionKey) && !this.active.has(sessionKey)) {
      this.pending.delete(sessionKey);
    }
  }

  /** Drop a hold without a retry (the retry is moot); queued work goes now. */
  async unhold(sessionKey: string): Promise<void> {
    if (!this.held.delete(sessionKey) || this.active.has(sessionKey)) {
      return;
    }
    await this.flush(sessionKey);
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
      this.held.delete(req.targetSessionKey);
      return this.send(req);
    }
    if (req.steer) {
      return this.steer(req);
    }
    if (this.active.has(req.targetSessionKey) || this.held.has(req.targetSessionKey)) {
      const queue = this.pending.get(req.targetSessionKey) ?? [];
      queue.push(req);
      this.pending.set(req.targetSessionKey, queue);
      return { status: "queued" };
    }
    return this.send(req);
  }

  /**
   * ARCH §6.4: interrupt the current turn, then send this message first and everything that
   * had queued behind the turn after it, as one merged message. Nothing is lost.
   */
  private async steer(req: DeliveryRequest): Promise<DeliveryResult> {
    const key = req.targetSessionKey;
    if (this.active.has(key)) {
      await this.runtime.subagent.abortSession?.({ sessionKey: key });
      this.active.delete(key);
    }
    // Urgent work does not wait for a scheduled retry (ARCH §6.4); the retry still follows.
    this.held.delete(key);
    const queued = this.pending.get(key) ?? [];
    this.pending.delete(key);
    if (queued.length === 0) {
      return this.send(req);
    }
    this.pending.set(key, [req, ...queued]);
    return (await this.flush(key)) ?? { status: "queued" };
  }

  /**
   * Resend an existing outbox entry with its original key (resume path). Its delivery record
   * already exists, so no second one is written: a crash after the resent run is accepted but
   * before its ack leaves the entry exactly as it was, never re-opened.
   */
  async resend(stateDir: string, taskId: string, entry: OutboxEntry): Promise<DeliveryResult> {
    const req: DeliveryRequest = {
      stateDir,
      taskId,
      targetSessionKey: entry.targetSessionKey,
      to: entry.to,
      seqs: entry.seqs,
      message: entry.message,
      idempotencyKey: entry.idempotencyKey,
      extraSystemPrompt: entry.extraSystemPrompt,
      supersedes: entry.supersedes,
    };
    const key = entry.targetSessionKey;
    if (this.active.has(key) || this.held.has(key)) {
      // One run per session (ARCH §5); a held session's resends go with its retry (§7.1.2).
      this.pending.set(key, [...(this.pending.get(key) ?? []), req]);
      return { status: "queued" };
    }
    return this.send(req);
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
          if (!this.held.has(sessionKey)) {
            // A held session (retry scheduled, §7.1.2) keeps its queue for the retry.
            await this.flush(sessionKey);
          }
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
