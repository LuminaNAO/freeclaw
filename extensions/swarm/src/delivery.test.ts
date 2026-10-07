import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { formatEnvelope, Mailbox, msgIdFor } from "./delivery.js";
import { readEvents, readOutbox } from "./store.js";
import { makeStubRuntime } from "./test-runtime.js";

const tmp = fs.mkdtempSync(path.join(tmpdir(), "swarm-delivery-test-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function freshState(): string {
  const stateDir = path.join(tmp, `s-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(path.join(stateDir, "swarm", "task-1"), { recursive: true });
  return stateDir;
}

function request(stateDir: string, seq: number, target = "agent:main:swarm:task-1:audit") {
  const msgId = msgIdFor("task-1", [seq]);
  return {
    stateDir,
    taskId: "task-1",
    targetSessionKey: target,
    to: "audit",
    seqs: [seq],
    idempotencyKey: msgId,
    message: formatEnvelope(
      {
        taskId: "task-1",
        from: "build",
        to: "audit",
        event: "BUILD_DONE",
        sha: "abc",
        body: `b${seq}`,
      },
      msgId,
    ),
  };
}

describe("swarm delivery envelope", () => {
  it("carries the ARCH §4 header, the MSG id and an optional resend marker", () => {
    const text = formatEnvelope(
      { taskId: "task-1", from: "build", to: "audit", event: "BUILD_DONE", sha: "abc", body: "x" },
      "swarm-1",
      4,
    );
    expect(text.split("\n")).toEqual([
      "TASK task-1 | FROM build | TO audit",
      "EVENT BUILD_DONE @ abc",
      "MSG swarm-1",
      "[RESEND of seq 4]",
      "x",
    ]);
  });

  it("derives a deterministic message id from task and seqs", () => {
    expect(msgIdFor("task-1", [3])).toBe(msgIdFor("task-1", [3]));
    expect(msgIdFor("task-1", [3])).not.toBe(msgIdFor("task-1", [4]));
  });
});

const AUDIT = "agent:main:swarm:task-1:audit";

describe("swarm mailbox", () => {
  it("writes the outbox record before sending and acks only after the run is accepted", async () => {
    const stateDir = freshState();
    const runtime = makeStubRuntime();
    runtime.subagent.run.mockImplementationOnce(async (params) => {
      // At send time the delivery record exists and is not yet acked.
      expect(readOutbox(stateDir, "task-1")[0]?.acked).toBe(false);
      runtime.runs.push(params);
      return { runId: "r1" };
    });
    const mailbox = new Mailbox(runtime);
    await expect(mailbox.deliver(request(stateDir, 1))).resolves.toEqual({
      status: "delivered",
      runId: "r1",
    });
    expect(readOutbox(stateDir, "task-1")[0]).toMatchObject({ acked: true, runId: "r1" });
    expect(runtime.runs[0]).toMatchObject({ lane: "subagent", deliver: false });
  });

  it("queues messages for a busy session and flushes them as one combined turn", async () => {
    const stateDir = freshState();
    const runtime = makeStubRuntime();
    const mailbox = new Mailbox(runtime);
    await mailbox.deliver(request(stateDir, 1));
    expect(mailbox.isBusy("agent:main:swarm:task-1:audit")).toBe(true);
    await expect(mailbox.deliver(request(stateDir, 2))).resolves.toEqual({ status: "queued" });
    await expect(mailbox.deliver(request(stateDir, 3))).resolves.toEqual({ status: "queued" });
    expect(runtime.runs).toHaveLength(1);

    await runtime.end("agent:main:swarm:task-1:audit");
    expect(runtime.runs).toHaveLength(2);
    expect(runtime.runs[1]?.message).toContain("b2");
    expect(runtime.runs[1]?.message).toContain("b3");
    // The two queued records are settled; only the merged delivery is the live one.
    const outbox = readOutbox(stateDir, "task-1");
    expect(outbox.every((o) => o.acked)).toBe(true);
    expect(outbox.find((o) => o.seqs.length === 2)).toBeDefined();
  });

  it("acks queued parts only after the merged send is accepted (audit B2)", async () => {
    const stateDir = freshState();
    const runtime = makeStubRuntime();
    const mailbox = new Mailbox(runtime);
    await mailbox.deliver(request(stateDir, 1));
    await mailbox.deliver(request(stateDir, 2));
    await mailbox.deliver(request(stateDir, 3));
    runtime.subagent.run.mockImplementationOnce(async () => {
      // Crash window: the merged record exists, the parts must still be unacked.
      const outbox = readOutbox(stateDir, "task-1");
      expect(
        outbox.filter((o) => o.seqs.length === 1 && o.seqs[0] !== 1).every((o) => !o.acked),
      ).toBe(true);
      expect(outbox.find((o) => o.supersedes)?.acked).toBe(false);
      throw new Error("process killed");
    });
    await runtime.end("agent:main:swarm:task-1:audit");
    // Nothing that was not sent is acked.
    const outbox = readOutbox(stateDir, "task-1");
    expect(
      outbox.filter((o) => o.seqs.length === 1 && o.seqs[0] !== 1).every((o) => !o.acked),
    ).toBe(true);
  });

  it("leaves a failed delivery un-acked for resume and does not throw", async () => {
    const stateDir = freshState();
    const runtime = makeStubRuntime({ failRuns: 1 });
    const mailbox = new Mailbox(runtime);
    const res = await mailbox.deliver(request(stateDir, 1));
    expect(res.status).toBe("failed");
    expect(readOutbox(stateDir, "task-1")[0]?.acked).toBe(false);
    expect(mailbox.isBusy("agent:main:swarm:task-1:audit")).toBe(false);
  });

  it("retries a stale session write lock with backoff instead of failing", async () => {
    const stateDir = freshState();
    const runtime = makeStubRuntime({
      failRuns: 2,
      runError: "session file locked (timeout 10000ms)",
    });
    const sleep = vi.fn(async () => {});
    const mailbox = new Mailbox(runtime, { sleep });
    const res = await mailbox.deliver(request(stateDir, 1));
    expect(res.status).toBe("delivered");
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("urgent delivery aborts the target run first and bypasses the queue", async () => {
    const stateDir = freshState();
    const runtime = makeStubRuntime();
    const mailbox = new Mailbox(runtime);
    await mailbox.deliver(request(stateDir, 1));
    await mailbox.deliver({ ...request(stateDir, 2), urgent: true });
    expect(runtime.aborts).toEqual(["agent:main:swarm:task-1:audit"]);
    expect(runtime.runs).toHaveLength(2);
  });

  it("releases the session only when the gateway reports the whole run settled", async () => {
    const stateDir = freshState();
    const runtime = makeStubRuntime();
    const ended = vi.fn();
    const mailbox = new Mailbox(runtime, { onRunEnd: ended });
    await mailbox.deliver(request(stateDir, 1));
    await runtime.drain();
    expect(mailbox.isBusy(AUDIT)).toBe(true);
    await runtime.end(AUDIT, { status: "error", error: "provider down" });
    expect(mailbox.isBusy(AUDIT)).toBe(false);
    expect(ended).toHaveBeenCalledWith({
      sessionKey: AUDIT,
      runId: msgIdFor("task-1", [1]),
      status: "error",
      error: "provider down",
    });
  });

  it("one run per session: a message during an active run, even one that errored, queues (ARCH §5)", async () => {
    const stateDir = freshState();
    const runtime = makeStubRuntime();
    // The run-end handler sends a retry to the same session, as the error path does.
    const mailbox: Mailbox = new Mailbox(runtime, {
      onRunEnd: async (end) => {
        if (end.status === "error") {
          await mailbox.deliver(request(stateDir, 9));
        }
      },
    });
    await mailbox.deliver(request(stateDir, 1));
    // Anything that arrives while the run is live (re-prompts, retries) waits behind it.
    await mailbox.deliver(request(stateDir, 2));
    await mailbox.deliver(request(stateDir, 3));
    expect(runtime.liveIn(AUDIT)).toBe(1);
    await runtime.end(AUDIT, { status: "error", error: "overloaded" });
    expect(runtime.liveIn(AUDIT)).toBe(1);
    await runtime.end(AUDIT);
    expect(runtime.maxLive.get(AUDIT)).toBe(1);
    expect(runtime.subagent.abortSession).not.toHaveBeenCalled();
    expect(runtime.runs).toHaveLength(2);
    expect(runtime.runs[1]?.message).toContain("b9");
  });

  it("a session whose agent.wait call fails stays claimed (never a second run beside it)", async () => {
    const stateDir = freshState();
    const runtime = makeStubRuntime();
    runtime.subagent.waitForRun.mockRejectedValueOnce(new Error("gateway gone"));
    const mailbox = new Mailbox(runtime);
    await mailbox.deliver(request(stateDir, 1));
    await runtime.drain();
    await expect(mailbox.deliver(request(stateDir, 2))).resolves.toEqual({
      status: "queued",
    });
    expect(runtime.runs).toHaveLength(1);
  });

  it("logs every successful send as a send event", async () => {
    const stateDir = freshState();
    const mailbox = new Mailbox(makeStubRuntime());
    await mailbox.deliver(request(stateDir, 1));
    expect(readEvents(stateDir, "task-1").map((e) => [e.kind, e.event])).toEqual([
      ["send", "DELIVERED"],
    ]);
  });
});
