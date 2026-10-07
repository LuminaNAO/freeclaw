import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  appendEvent,
  appendOutbox,
  eventsPath,
  readEvents,
  readOutbox,
  readTasksIndex,
  TaskLocks,
  updateTaskIndexEntry,
  writeTasksIndex,
} from "./store.js";

const tmp = fs.mkdtempSync(path.join(tmpdir(), "swarm-store-test-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function freshState(): string {
  const stateDir = path.join(tmp, `s-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(path.join(stateDir, "swarm", "task-1"), { recursive: true });
  return stateDir;
}

describe("swarm store", () => {
  it("rewrites the task index atomically and leaves no temp files", () => {
    const stateDir = freshState();
    writeTasksIndex(stateDir, {
      "task-1": { status: "open", sha: "a", createdAt: "x", updatedAt: "x" },
    });
    const next = updateTaskIndexEntry(stateDir, "task-1", { status: "done" });
    expect(next.status).toBe("done");
    expect(readTasksIndex(stateDir)["task-1"]?.status).toBe("done");
    expect(fs.readdirSync(path.join(stateDir, "swarm")).filter((f) => f.endsWith(".tmp"))).toEqual(
      [],
    );
  });

  it("assigns increasing seq numbers to appended events", () => {
    const stateDir = freshState();
    const a = appendEvent(stateDir, "task-1", { kind: "emit", event: "BUILD_DONE" });
    const b = appendEvent(stateDir, "task-1", { kind: "send", event: "BUILD_DONE" });
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect(readEvents(stateDir, "task-1").map((e) => e.seq)).toEqual([1, 2]);
  });

  it("skips a torn trailing line instead of failing", () => {
    const stateDir = freshState();
    appendEvent(stateDir, "task-1", { kind: "emit", event: "BUILD_DONE" });
    fs.appendFileSync(eventsPath(stateDir, "task-1"), '{"seq":2,"kind":"emi');
    expect(readEvents(stateDir, "task-1")).toHaveLength(1);
  });

  it("normalizes hand-written events that use an ISO `at` and no seq", () => {
    const stateDir = freshState();
    fs.writeFileSync(
      eventsPath(stateDir, "task-1"),
      `${JSON.stringify({ event: "DONE", from: "taskmaster", at: "2026-01-01T00:00:00.000Z" })}\n`,
    );
    const [event] = readEvents(stateDir, "task-1");
    expect(event?.seq).toBe(1);
    expect(event?.ts).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
  });

  it("folds outbox delivery and ack records per idempotency key", () => {
    const stateDir = freshState();
    const delivery = {
      type: "delivery" as const,
      seq: 3,
      ts: 1,
      idempotencyKey: "k1",
      targetSessionKey: "agent:main:swarm:task-1:audit",
      to: "audit",
      message: "m",
      seqs: [3],
    };
    appendOutbox(stateDir, "task-1", delivery);
    expect(readOutbox(stateDir, "task-1")[0]).toMatchObject({ acked: false, attempts: 1 });
    appendOutbox(stateDir, "task-1", delivery);
    appendOutbox(stateDir, "task-1", { type: "ack", idempotencyKey: "k1", ts: 2, runId: "r1" });
    const [entry] = readOutbox(stateDir, "task-1");
    expect(entry).toMatchObject({ acked: true, attempts: 2, runId: "r1" });
  });

  it("an ack is final: a later delivery line for the same key does not re-open it (audit B1)", () => {
    const stateDir = freshState();
    const delivery = {
      type: "delivery" as const,
      seq: 1,
      ts: 1,
      idempotencyKey: "k1",
      targetSessionKey: "agent:main:swarm:task-1:audit",
      to: "audit",
      message: "m",
      seqs: [1],
    };
    appendOutbox(stateDir, "task-1", delivery);
    appendOutbox(stateDir, "task-1", { type: "ack", idempotencyKey: "k1", ts: 2 });
    appendOutbox(stateDir, "task-1", { ...delivery, ts: 3 });
    expect(readOutbox(stateDir, "task-1")[0]?.acked).toBe(true);
  });

  it("serializes work per task id and keeps tasks independent", async () => {
    const locks = new TaskLocks();
    const order: string[] = [];
    const slow = locks.run("task-a", async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("a1");
    });
    const queued = locks.run("task-a", () => {
      order.push("a2");
    });
    const other = locks.run("task-b", () => {
      order.push("b1");
    });
    await Promise.all([slow, queued, other]);
    expect(order).toEqual(["b1", "a1", "a2"]);
  });

  it("keeps the lock usable after a failing job", async () => {
    const locks = new TaskLocks();
    await expect(
      locks.run("task-a", () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(locks.run("task-a", () => "ok")).resolves.toBe("ok");
  });
});
