// One mail connector (docs/design/mail-push.md §5, §6): runs a provider, filters and batches new
// mail, hands each batch to every attached session and commits the cursor only after all of them
// accepted it (at-least-once).
import type { MailConnectorAttachConfig, MailConnectorConfig } from "../config/types.mail.js";
import { mailFilterRejection } from "./filter.js";
import { formatMailEvent, mailMessageId } from "./format.js";
import {
  type MailConnectorStateFile,
  readMailConnectorState,
  writeMailConnectorState,
} from "./state-store.js";
import type {
  ConnectorState,
  MailConnectorStateName,
  MailCursor,
  MailLogger,
  MailMessage,
  MailProvider,
} from "./types.js";

export const DEFAULT_MAIL_BATCH_WINDOW_SECONDS = 20;
export const DEFAULT_MAIL_BATCH_MAX = 10;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
/** Pending messages above this many batches make the provider wait (backpressure). */
const PENDING_BATCHES_LIMIT = 5;

/** One batch handed to one attached session. */
export type MailSessionEvent = {
  connectorId: string;
  attach: MailConnectorAttachConfig;
  attachIndex: number;
  /** Event text (§4): header line + one untrusted-content block per message. */
  text: string;
  messageIds: string[];
  /** Aborted when the connector stops; an aborted delivery counts as not accepted. */
  signal: AbortSignal;
};

/** Delivers one event into one session; resolves when the session accepted it. */
export type MailSessionSink = (event: MailSessionEvent) => Promise<void>;

export type MailStateIo = {
  read: (filePath: string) => Promise<MailConnectorStateFile | null>;
  write: (filePath: string, state: MailConnectorStateFile) => Promise<void>;
};

export type MailConnectorStatus = {
  id: string;
  provider: string;
  enabled: boolean;
  state: MailConnectorStateName;
  stateSince: number;
  /** Since when the connector is in backoff/auth-failed without a successful connect between. */
  troubleSince?: number;
  detail?: string;
  retryAt?: number;
  pending: number;
  sessions: number;
  lastEventAt?: number;
  lastEventCount?: number;
  lastError?: { at: number; message: string };
  cursor: { folders: Record<string, { uidValidity: string; lastUid: number }> } | null;
};

type PendingItem = { message: MailMessage; id: string; cursor: MailCursor };

type InflightBatch = {
  items: PendingItem[];
  text: Map<number, string>;
  accepted: Set<number>;
};

function cloneCursor(cursor: MailCursor | null): MailCursor {
  return {
    folders: Object.fromEntries(
      Object.entries(cursor?.folders ?? {}).map(([folder, pos]) => [folder, { ...pos }]),
    ),
  };
}

function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
}

/** Error text for state and logs: the message only, cut short, never content or secrets. */
export function sanitizeMailError(err: unknown, secrets: string[] = []): string {
  let text = err instanceof Error ? err.message : String(err);
  for (const secret of secrets) {
    if (secret) {
      text = text.split(secret).join("[redacted]");
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

export class MailConnector {
  readonly id: string;
  readonly config: MailConnectorConfig;
  private readonly provider: MailProvider;
  private readonly sink: MailSessionSink;
  private readonly statePath: string;
  private readonly log: MailLogger;
  private readonly io: MailStateIo;
  private readonly now: () => number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly secrets: string[];

  private abort: AbortController | null = null;
  private runPromise: Promise<void> | null = null;
  private stateName: MailConnectorStateName;
  private stateSince: number;
  private troubleSince: number | undefined;
  private detail: string | undefined;
  private retryAt: number | undefined;
  private committed: MailCursor | null = null;
  private stored: MailConnectorStateFile | null = null;
  private pending: PendingItem[] = [];
  /** Cursor that becomes valid once every pending item is delivered (covers filtered mail). */
  private tailCursor: MailCursor | null = null;
  private inflight: InflightBatch | null = null;
  private windowTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private deliveryAttempt = 0;
  private flushing: Promise<void> | null = null;
  private capacityWaiters: Array<() => void> = [];
  private stateWrite: Promise<void> = Promise.resolve();

  constructor(params: {
    config: MailConnectorConfig;
    provider: MailProvider;
    sink: MailSessionSink;
    statePath: string;
    log: MailLogger;
    io?: MailStateIo;
    now?: () => number;
    retryBaseMs?: number;
    retryMaxMs?: number;
    /** Values that must never appear in state or logs (e.g. the resolved password). */
    secrets?: string[];
  }) {
    this.id = params.config.id;
    this.config = params.config;
    this.provider = params.provider;
    this.sink = params.sink;
    this.statePath = params.statePath;
    this.log = params.log;
    this.io = params.io ?? { read: readMailConnectorState, write: writeMailConnectorState };
    this.now = params.now ?? Date.now;
    this.retryBaseMs = params.retryBaseMs ?? RETRY_BASE_MS;
    this.retryMaxMs = params.retryMaxMs ?? RETRY_MAX_MS;
    this.secrets = params.secrets ?? [];
    this.stateName = params.config.enabled === false ? "disabled" : "starting";
    this.stateSince = this.now();
  }

  get running(): boolean {
    return this.abort !== null;
  }

  private get batchWindowMs(): number {
    return Math.max(
      0,
      (this.config.batch?.windowSeconds ?? DEFAULT_MAIL_BATCH_WINDOW_SECONDS) * 1000,
    );
  }

  private get batchMax(): number {
    return Math.max(1, this.config.batch?.max ?? DEFAULT_MAIL_BATCH_MAX);
  }

  /** Loads the stored cursor and starts the provider. Resolves once the provider is running. */
  async start(): Promise<void> {
    if (this.abort) {
      return;
    }
    this.stored = await this.io.read(this.statePath);
    this.committed = this.stored?.cursor ?? null;
    this.troubleSince = this.stored?.troubleSince;
    if (this.config.enabled === false) {
      this.setState({ state: "disabled" });
      return;
    }
    const abort = new AbortController();
    this.abort = abort;
    this.setState({ state: "starting" });
    this.runPromise = this.runProvider(abort.signal);
  }

  private async runProvider(signal: AbortSignal): Promise<void> {
    let attempt = 0;
    while (!signal.aborted) {
      try {
        await this.provider.start({
          cursor: this.committed ? cloneCursor(this.committed) : null,
          onMessages: (msgs, cursor) => this.onMessages(msgs, cursor, signal),
          onState: (state) => {
            if (!signal.aborted) {
              this.setState(state);
            }
          },
          signal,
        });
        return;
      } catch (err) {
        if (signal.aborted) {
          return;
        }
        const message = sanitizeMailError(err, this.secrets);
        this.recordError(message);
        const delay = backoffDelay(attempt, this.retryBaseMs, this.retryMaxMs);
        attempt += 1;
        this.setState({ state: "backoff", detail: message, retryAt: this.now() + delay });
        this.log.warn(`mail connector ${this.id}: provider failed, retrying in ${delay}ms`);
        await sleep(delay, signal);
      }
    }
  }

  /** Stops the provider and timers; already accepted batches are committed first. */
  async stop(): Promise<void> {
    const abort = this.abort;
    this.abort = null;
    abort?.abort();
    this.clearTimers();
    for (const waiter of this.capacityWaiters.splice(0)) {
      waiter();
    }
    await this.runPromise?.catch(() => {});
    this.runPromise = null;
    await this.flushing?.catch(() => {});
    await this.stateWrite.catch(() => {});
    if (this.config.enabled === false) {
      this.setState({ state: "disabled" });
    }
  }

  private clearTimers(): void {
    if (this.windowTimer) {
      clearTimeout(this.windowTimer);
      this.windowTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private setState(next: ConnectorState): void {
    const changed = next.state !== this.stateName;
    if (changed) {
      this.stateName = next.state;
      this.stateSince = this.now();
    }
    this.detail = next.detail ? sanitizeMailError(next.detail, this.secrets) : undefined;
    this.retryAt = next.retryAt;
    if (next.state === "auth-failed" || next.state === "backoff") {
      this.troubleSince ??= this.now();
      if (this.detail) {
        this.recordError(this.detail);
      }
    } else if (next.state === "idle" || next.state === "polling" || next.state === "disabled") {
      this.troubleSince = undefined;
    }
    if (changed) {
      this.log.info(`mail connector ${this.id}: ${next.state}`);
      void this.persist().catch(() => {});
    }
  }

  private recordError(message: string): void {
    this.stored = {
      ...this.baseState(),
      lastError: { at: this.now(), message: sanitizeMailError(message, this.secrets) },
    };
  }

  private baseState(): MailConnectorStateFile {
    return {
      version: 1,
      connectorId: this.id,
      cursor: this.committed,
      lastEventAt: this.stored?.lastEventAt,
      lastEventCount: this.stored?.lastEventCount,
      state: this.stateName,
      stateSince: this.stateSince,
      ...(this.troubleSince ? { troubleSince: this.troubleSince } : {}),
      lastError: this.stored?.lastError,
      updatedAt: this.now(),
    };
  }

  /** Writes the state file (serialized). Failures are logged and kept as lastError. */
  private persist(extra?: Partial<MailConnectorStateFile>): Promise<void> {
    const write = async () => {
      const state = { ...this.baseState(), ...extra };
      this.stored = state;
      await this.io.write(this.statePath, state);
    };
    const next = this.stateWrite.then(write, write);
    this.stateWrite = next.catch((err) => {
      this.log.error(
        `mail connector ${this.id}: state write failed: ${sanitizeMailError(err, this.secrets)}`,
      );
    });
    return next;
  }

  private async onMessages(
    msgs: MailMessage[],
    cursor: MailCursor,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) {
      return;
    }
    const nowMs = this.now();
    let base = cloneCursor(this.tailCursor ?? this.committed);
    let skipped = 0;
    for (const message of msgs) {
      const reason = mailFilterRejection(message, this.config.filter, nowMs);
      if (reason) {
        skipped += 1;
        continue;
      }
      base = cloneCursor(base);
      base.folders[message.folder] = { uidValidity: message.uidValidity, lastUid: message.uid };
      this.pending.push({ message, id: mailMessageId(this.id, message), cursor: base });
    }
    if (skipped > 0) {
      this.log.debug?.(`mail connector ${this.id}: ${skipped} message(s) filtered out`);
    }
    if (this.pending.length === 0 && !this.inflight) {
      this.tailCursor = null;
      await this.commit(cursor, 0);
      return;
    }
    this.tailCursor = cloneCursor(cursor);
    this.scheduleFlush();
    while (
      !signal.aborted &&
      this.pending.length >= this.batchMax * PENDING_BATCHES_LIMIT &&
      this.abort
    ) {
      await new Promise<void>((resolve) => this.capacityWaiters.push(resolve));
    }
  }

  private scheduleFlush(): void {
    if (this.flushing || this.retryTimer || !this.abort) {
      return;
    }
    if (this.pending.length >= this.batchMax) {
      this.startFlush();
      return;
    }
    if (!this.windowTimer && this.pending.length > 0) {
      this.windowTimer = setTimeout(() => {
        this.windowTimer = null;
        this.startFlush();
      }, this.batchWindowMs);
    }
  }

  private startFlush(): void {
    if (this.flushing) {
      return;
    }
    if (this.windowTimer) {
      clearTimeout(this.windowTimer);
      this.windowTimer = null;
    }
    this.flushing = this.flushLoop().finally(() => {
      this.flushing = null;
      for (const waiter of this.capacityWaiters.splice(0)) {
        waiter();
      }
      if (this.abort && this.pending.length > 0 && !this.retryTimer) {
        this.scheduleFlush();
      }
    });
  }

  /** Delivers pending batches one after the other until empty, a failure or stop. */
  private async flushLoop(): Promise<void> {
    while (this.inflight || this.pending.length > 0) {
      if (!this.inflight) {
        const items = this.pending.splice(0, this.batchMax);
        this.inflight = { items, text: new Map(), accepted: new Set() };
      }
      const batch = this.inflight;
      const ok = await this.deliver(batch);
      if (!ok) {
        if (!this.abort) {
          return;
        }
        const delay = backoffDelay(this.deliveryAttempt, this.retryBaseMs, this.retryMaxMs);
        this.deliveryAttempt += 1;
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.startFlush();
        }, delay);
        return;
      }
      this.deliveryAttempt = 0;
      this.inflight = null;
      const last = batch.items[batch.items.length - 1];
      const cursor =
        this.pending.length === 0 && this.tailCursor ? this.tailCursor : (last?.cursor ?? null);
      if (this.pending.length === 0) {
        this.tailCursor = null;
      }
      if (cursor) {
        await this.commit(cursor, batch.items.length);
      }
      if (!this.abort) {
        return;
      }
    }
  }

  /** Hands one batch to every attached session that has not accepted it yet. */
  private async deliver(batch: InflightBatch): Promise<boolean> {
    const attach = this.config.attach;
    const signal = this.abort?.signal;
    if (!signal || signal.aborted) {
      return false;
    }
    const results = await Promise.all(
      attach.map(async (entry, index) => {
        if (batch.accepted.has(index)) {
          return true;
        }
        let text = batch.text.get(index);
        if (text === undefined) {
          text = await formatMailEvent({
            connectorId: this.id,
            messages: batch.items.map((item) => item.message),
            instructionsFile: entry.instructionsFile,
            body: this.config.body,
          });
          batch.text.set(index, text);
        }
        try {
          await this.sink({
            connectorId: this.id,
            attach: entry,
            attachIndex: index,
            text,
            messageIds: batch.items.map((item) => item.id),
            signal,
          });
          if (signal.aborted) {
            return false;
          }
          batch.accepted.add(index);
          return true;
        } catch (err) {
          if (signal.aborted) {
            return false;
          }
          const message = sanitizeMailError(err, this.secrets);
          this.recordError(`session ${entry.sessionKey}: ${message}`);
          this.log.warn(
            `mail connector ${this.id}: session ${entry.sessionKey} did not accept a batch: ${message}`,
          );
          return false;
        }
      }),
    );
    const ok = results.every(Boolean);
    if (ok) {
      this.log.info(
        `mail connector ${this.id}: pushed ${batch.items.length} message(s) to ${attach.length} session(s)`,
      );
    }
    return ok;
  }

  /** Stores the cursor once every attached session accepted (or nothing was due). */
  private async commit(cursor: MailCursor, count: number): Promise<void> {
    this.committed = cloneCursor(cursor);
    const extra: Partial<MailConnectorStateFile> =
      count > 0 ? { lastEventAt: this.now(), lastEventCount: count } : {};
    await this.persist(extra).catch(() => {});
  }

  status(): MailConnectorStatus {
    return {
      id: this.id,
      provider: this.config.provider,
      enabled: this.config.enabled !== false,
      state: this.stateName,
      stateSince: this.stateSince,
      ...(this.troubleSince ? { troubleSince: this.troubleSince } : {}),
      ...(this.detail ? { detail: this.detail } : {}),
      ...(this.retryAt ? { retryAt: this.retryAt } : {}),
      pending: this.pending.length + (this.inflight?.items.length ?? 0),
      sessions: this.config.attach.length,
      ...(this.stored?.lastEventAt ? { lastEventAt: this.stored.lastEventAt } : {}),
      ...(this.stored?.lastEventCount ? { lastEventCount: this.stored.lastEventCount } : {}),
      ...(this.stored?.lastError ? { lastError: { ...this.stored.lastError } } : {}),
      cursor: this.committed ? cloneCursor(this.committed) : null,
    };
  }

  /** Waits until nothing is pending or in flight (tests and graceful shutdown). */
  async idle(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.pending.length > 0 || this.inflight || this.flushing) {
      if (Date.now() > deadline) {
        throw new Error(`mail connector ${this.id}: still busy after ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await this.stateWrite;
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
