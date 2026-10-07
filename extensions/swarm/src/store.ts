import fs from "node:fs";
import path from "node:path";
import { taskDirFor } from "./contract.js";

// On-disk task state (ARCH §1.6, §3, §8).

export type TaskStatus = "open" | "done" | "failed" | "cancelled";

export type TaskIndexEntry = {
  status: TaskStatus;
  sha: string;
  createdAt: string;
  updatedAt: string;
};

export type TaskIndex = Record<string, TaskIndexEntry>;

export type EventKind = "emit" | "send" | "system" | "upstream";

export type SwarmEvent = {
  seq: number;
  ts: number;
  taskId: string;
  kind: EventKind;
  event: string;
  from?: string;
  to?: string | null;
  sha?: string;
  body?: string;
  msgId?: string;
  data?: Record<string, unknown>;
};

export type OutboxRecord =
  | {
      type: "delivery";
      seq: number;
      ts: number;
      idempotencyKey: string;
      targetSessionKey: string;
      to: string;
      message: string;
      /** Event seqs included in this delivery (mailbox may merge several). */
      seqs: number[];
      urgent?: boolean;
      extraSystemPrompt?: string;
      /** Merged mailbox delivery: the queued entries it carries (acked once it is accepted). */
      supersedes?: string[];
    }
  | { type: "ack"; idempotencyKey: string; ts: number; runId?: string }
  | { type: "fail"; idempotencyKey: string; ts: number; error: string };

export type OutboxEntry = {
  seq: number;
  idempotencyKey: string;
  targetSessionKey: string;
  to: string;
  message: string;
  seqs: number[];
  extraSystemPrompt?: string;
  supersedes?: string[];
  acked: boolean;
  attempts: number;
  runId?: string;
};

export function swarmRoot(stateDir: string): string {
  return path.join(stateDir, "swarm");
}

function indexPath(stateDir: string): string {
  return path.join(swarmRoot(stateDir), "tasks.json");
}

export function eventsPath(stateDir: string, taskId: string): string {
  return path.join(taskDirFor(stateDir, taskId), "events.jsonl");
}

export function outboxPath(stateDir: string, taskId: string): string {
  return path.join(taskDirFor(stateDir, taskId), "outbox.jsonl");
}

export function writeFileAtomic(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/** One complete line per call, fsynced, so a crash leaves at most one torn tail line. */
export function appendJsonLine(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, "a");
  try {
    fs.writeSync(fd, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function readJsonLines<T>(file: string, onSkip?: (line: number) => void): T[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const out: T[] = [];
  raw.split("\n").forEach((line, i) => {
    if (!line.trim()) {
      return;
    }
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      onSkip?.(i + 1);
    }
  });
  return out;
}

export function readTasksIndex(stateDir: string): TaskIndex {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath(stateDir), "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as TaskIndex) : {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw err;
  }
}

export function writeTasksIndex(stateDir: string, index: TaskIndex): void {
  writeFileAtomic(indexPath(stateDir), `${JSON.stringify(index, null, 2)}\n`);
}

export function updateTaskIndexEntry(
  stateDir: string,
  taskId: string,
  patch: Partial<TaskIndexEntry>,
): TaskIndexEntry {
  const index = readTasksIndex(stateDir);
  const existing = index[taskId];
  if (!existing) {
    throw new Error(`task "${taskId}" is not in the task index`);
  }
  const next = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  index[taskId] = next;
  writeTasksIndex(stateDir, index);
  return next;
}

/**
 * Normalize events written by older tooling or hand-written fixtures: accept `at` (ISO)
 * for `ts`, and assign a seq by position when missing.
 */
export function readEvents(stateDir: string, taskId: string): SwarmEvent[] {
  const file = eventsPath(stateDir, taskId);
  if (!fs.existsSync(path.dirname(file))) {
    throw new Error(`task "${taskId}" not found`);
  }
  const raw = readJsonLines<Partial<SwarmEvent> & { at?: string }>(file);
  return raw.map((e, i) => ({
    ...e,
    seq: typeof e.seq === "number" ? e.seq : i + 1,
    ts: typeof e.ts === "number" ? e.ts : e.at ? Date.parse(e.at) : 0,
    taskId: e.taskId ?? taskId,
    kind: e.kind ?? "emit",
    event: e.event ?? "UNKNOWN",
  }));
}

export function nextSeq(events: SwarmEvent[]): number {
  return events.reduce((max, e) => Math.max(max, e.seq), 0) + 1;
}

export function appendEvent(
  stateDir: string,
  taskId: string,
  event: Omit<SwarmEvent, "seq" | "ts" | "taskId"> & { ts?: number },
): SwarmEvent {
  const seq = nextSeq(readEvents(stateDir, taskId));
  const record: SwarmEvent = { seq, ts: event.ts ?? Date.now(), taskId, ...event };
  appendJsonLine(eventsPath(stateDir, taskId), record);
  return record;
}

export function appendOutbox(stateDir: string, taskId: string, record: OutboxRecord): void {
  appendJsonLine(outboxPath(stateDir, taskId), record);
}

type LegacyOutboxEntry = {
  idempotencyKey: string;
  targetSessionKey: string;
  to: string;
  message: string;
  seq?: number;
  acked?: boolean;
  attempts?: number;
};

/** Fold delivery/ack/fail records into one entry per idempotency key, in delivery order. */
export function readOutbox(stateDir: string, taskId: string): OutboxEntry[] {
  const records = readJsonLines<OutboxRecord | LegacyOutboxEntry>(outboxPath(stateDir, taskId));
  const byKey = new Map<string, OutboxEntry>();
  for (const rec of records) {
    if (!("type" in rec)) {
      // Flat entry form (one line per delivery with an inline ack flag).
      const prior = byKey.get(rec.idempotencyKey);
      byKey.set(rec.idempotencyKey, {
        seq: rec.seq ?? prior?.seq ?? 0,
        idempotencyKey: rec.idempotencyKey,
        targetSessionKey: rec.targetSessionKey,
        to: rec.to,
        message: rec.message,
        seqs: rec.seq !== undefined ? [rec.seq] : [],
        acked: Boolean(rec.acked) || Boolean(prior?.acked),
        attempts: rec.attempts ?? 1,
      });
      continue;
    }
    if (rec.type === "delivery") {
      const prior = byKey.get(rec.idempotencyKey);
      byKey.set(rec.idempotencyKey, {
        seq: rec.seq,
        idempotencyKey: rec.idempotencyKey,
        targetSessionKey: rec.targetSessionKey,
        to: rec.to,
        message: rec.message,
        seqs: rec.seqs,
        extraSystemPrompt: rec.extraSystemPrompt,
        supersedes: rec.supersedes,
        // An ack is final: a later delivery line for the same key never re-opens it.
        acked: prior?.acked ?? false,
        attempts: (prior?.attempts ?? 0) + 1,
        runId: prior?.runId,
      });
      continue;
    }
    const entry = byKey.get(rec.idempotencyKey);
    if (!entry) {
      continue;
    }
    if (rec.type === "ack") {
      entry.acked = true;
      entry.runId = rec.runId ?? entry.runId;
    }
  }
  // A merged delivery's ack is one atomic line that also settles every part it carried.
  for (const entry of byKey.values()) {
    if (entry.acked && entry.supersedes) {
      for (const key of entry.supersedes) {
        const part = byKey.get(key);
        if (part) {
          part.acked = true;
        }
      }
    }
  }
  return [...byKey.values()].toSorted((a, b) => a.seq - b.seq);
}

/** Per-task async mutex: every store write and route decision for a task runs inside it. */
export class TaskLocks {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(taskId: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.tails.get(taskId) ?? Promise.resolve();
    const result = prev.then(() => fn());
    const tail = result.catch(() => undefined);
    this.tails.set(taskId, tail);
    try {
      return await result;
    } finally {
      if (this.tails.get(taskId) === tail) {
        this.tails.delete(taskId);
      }
    }
  }
}
