import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createSwarmEmitTool } from "./emit.js";
import { SwarmEngine } from "./engine.js";
import { RESTART_LINE, resumeOpenTasks, withResendMarker } from "./resume.js";
import { appendOutbox, readEvents, readOutbox } from "./store.js";
import { seedTask } from "./test-fixtures.js";
import { makeStubRuntime } from "./test-runtime.js";

const tmp = fs.mkdtempSync(path.join(tmpdir(), "swarm-resume-test-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const TASK = "task-300";
const SHA = "b16b00b5";
const key = (role: string) => `agent:main:swarm:${TASK}:${role}`;

function freshState(): string {
  const stateDir = path.join(tmp, `s-${Math.random().toString(36).slice(2)}`);
  seedTask(stateDir, { taskId: TASK, headSha: SHA });
  return stateDir;
}

/** Gateway "crash": BUILD_DONE emitted and routed, but the audit delivery never got through. */
async function crashMidDelivery(stateDir: string) {
  const crashed = makeStubRuntime({ failRuns: 10 });
  const engine = new SwarmEngine({ stateDir, runtime: crashed });
  const res = await createSwarmEmitTool({ engine, callerSessionKey: key("build") }).execute("c", {
    event: "BUILD_DONE",
    sha: SHA,
    body: "done",
  });
  expect(res.details).toMatchObject({ ok: true, routedTo: "audit" });
  const [entry] = readOutbox(stateDir, TASK);
  expect(entry?.acked).toBe(false);
  return entry;
}

describe("swarm resume (ARCH §8)", () => {
  it("resends an undelivered entry with its original key and a resend marker", async () => {
    const stateDir = freshState();
    const entry = await crashMidDelivery(stateDir);
    const runtime = makeStubRuntime();
    const summary = await resumeOpenTasks(new SwarmEngine({ stateDir, runtime }));
    expect(summary.resent).toBe(1);
    expect(runtime.runs).toHaveLength(1);
    expect(runtime.runs[0]?.sessionKey).toBe(key("audit"));
    expect(runtime.runs[0]?.idempotencyKey).toBe(entry?.idempotencyKey);
    expect(runtime.runs[0]?.message).toMatch(/\[RESEND of seq \d+\]/);
    expect(readOutbox(stateDir, TASK)[0]?.acked).toBe(true);
  });

  it("never double-delivers: a second resume does not resend the same entry", async () => {
    const stateDir = freshState();
    const entry = await crashMidDelivery(stateDir);
    const first = makeStubRuntime();
    await resumeOpenTasks(new SwarmEngine({ stateDir, runtime: first }));
    // The resend is the delivery of that input; no second message in the same resume.
    expect(first.runs.filter((r) => r.sessionKey === key("audit"))).toHaveLength(1);
    const second = makeStubRuntime();
    const summary = await resumeOpenTasks(new SwarmEngine({ stateDir, runtime: second }));
    expect(summary.resent).toBe(0);
    expect(second.runs.filter((r) => r.idempotencyKey === entry?.idempotencyKey)).toHaveLength(0);
  });

  /** BUILD_DONE delivered to audit and acked; audit then works with no emit. */
  async function auditWorking() {
    const stateDir = freshState();
    const engine = new SwarmEngine({ stateDir, runtime: makeStubRuntime() });
    await createSwarmEmitTool({ engine, callerSessionKey: key("build") }).execute("c", {
      event: "BUILD_DONE",
      sha: SHA,
      body: "done",
    });
    return stateDir;
  }

  it("ARCH §10.4: re-delivers the same input on every restart, twice in a row and more, no counter", async () => {
    const stateDir = await auditWorking();
    const keys: string[] = [];
    for (let restart = 0; restart < 4; restart += 1) {
      const rt = makeStubRuntime();
      const summary = await resumeOpenTasks(new SwarmEngine({ stateDir, runtime: rt }));
      expect(summary.redelivered).toBe(1);
      const audit = rt.runs.filter((r) => r.sessionKey === key("audit"));
      expect(audit).toHaveLength(1);
      expect(audit[0]?.message.split("\n")[0]).toBe(RESTART_LINE);
      expect(audit[0]?.message.split(RESTART_LINE)).toHaveLength(2);
      expect(audit[0]?.message).toContain(`EVENT BUILD_DONE @ ${SHA}`);
      expect(audit[0]?.message).toContain("done");
      keys.push(audit[0]?.idempotencyKey ?? "");
    }
    // Each restart is a fresh message (the gateway dedupe must not swallow it).
    expect(new Set(keys).size).toBe(4);
    const events = readEvents(stateDir, TASK);
    expect(events.some((e) => /ESCALATED|SILENT/.test(e.event))).toBe(false);
  });

  it("after the re-delivered input is answered, the next restart re-delivers nothing to that role", async () => {
    const stateDir = await auditWorking();
    await resumeOpenTasks(new SwarmEngine({ stateDir, runtime: makeStubRuntime() }));
    const engine = new SwarmEngine({ stateDir, runtime: makeStubRuntime() });
    await createSwarmEmitTool({ engine, callerSessionKey: key("audit") }).execute("c", {
      event: "AUDIT_PASS",
      sha: SHA,
      body: "ok",
    });
    const again = makeStubRuntime();
    await resumeOpenTasks(new SwarmEngine({ stateDir, runtime: again }));
    expect(again.runs.filter((r) => r.sessionKey === key("audit"))).toHaveLength(0);
  });

  it("skips a session with an active run; it is never given a second run (ARCH §5, §8)", async () => {
    const stateDir = await auditWorking();
    const runtime = makeStubRuntime();
    const engine = new SwarmEngine({ stateDir, runtime });
    // A run is live in the audit session in this gateway (e.g. resume ran twice in one life).
    await engine.mailbox.deliver({
      stateDir,
      taskId: TASK,
      targetSessionKey: key("audit"),
      to: "audit",
      seqs: [1],
      idempotencyKey: "live-run",
      message: "working",
    });
    const summary = await resumeOpenTasks(engine);
    expect(summary.redelivered).toBe(0);
    expect(runtime.runs.filter((r) => r.sessionKey === key("audit"))).toHaveLength(1);
    expect(runtime.maxLive.get(key("audit"))).toBe(1);
  });

  it("re-delivers the taskmaster's unanswered input too", async () => {
    const stateDir = freshState();
    const engine = new SwarmEngine({ stateDir, runtime: makeStubRuntime() });
    await createSwarmEmitTool({
      engine,
      callerSessionKey: key("build"),
    }).execute("c", {
      event: "BLOCKED",
      sha: SHA,
      body: "need a decision",
    });
    const runtime = makeStubRuntime();
    await resumeOpenTasks(new SwarmEngine({ stateDir, runtime }));
    const tm = runtime.runs.filter((r) => r.sessionKey === key("taskmaster"));
    expect(tm).toHaveLength(1);
    expect(tm[0]?.message).toContain("EVENT BLOCKED");
    expect(tm[0]?.message).toContain("need a decision");
  });

  it("acks instead of resending when the message is already in the target transcript", async () => {
    const stateDir = freshState();
    const entry = await crashMidDelivery(stateDir);
    // The run was accepted before the crash; only the ack was lost.
    const runtime = makeStubRuntime({
      transcripts: { [key("audit")]: [`TASK ${TASK}\nMSG ${entry?.idempotencyKey}\ndone`] },
    });
    const summary = await resumeOpenTasks(new SwarmEngine({ stateDir, runtime }));
    expect(summary.ackedFromTranscript).toBe(1);
    expect(runtime.runs.filter((r) => r.idempotencyKey === entry?.idempotencyKey)).toHaveLength(0);
    expect(readOutbox(stateDir, TASK)[0]?.acked).toBe(true);
  });

  it("does not resend an input the target already answered", async () => {
    const stateDir = freshState();
    const entry = await crashMidDelivery(stateDir);
    // Audit answered (its later emit is on the log) although the ack was never written.
    const engine = new SwarmEngine({ stateDir, runtime: makeStubRuntime() });
    await createSwarmEmitTool({ engine, callerSessionKey: key("audit") }).execute("c", {
      event: "AUDIT_PASS",
      sha: SHA,
      body: "ok",
    });
    const runtime = makeStubRuntime();
    const summary = await resumeOpenTasks(new SwarmEngine({ stateDir, runtime }));
    expect(summary.ackedAsAnswered).toBeGreaterThanOrEqual(1);
    expect(runtime.runs.filter((r) => r.idempotencyKey === entry?.idempotencyKey)).toHaveLength(0);
  });

  it("re-delivers a worker's delivered input that has no reply", async () => {
    const stateDir = freshState();
    const engine = new SwarmEngine({ stateDir, runtime: makeStubRuntime() });
    await createSwarmEmitTool({ engine, callerSessionKey: key("build") }).execute("c", {
      event: "BUILD_DONE",
      sha: SHA,
      body: "done",
    });
    // Delivered and acked, then the gateway died while audit was working.
    const runtime = makeStubRuntime();
    const summary = await resumeOpenTasks(new SwarmEngine({ stateDir, runtime }));
    expect(summary.redelivered).toBe(1);
    expect(runtime.runs).toHaveLength(1);
    expect(runtime.runs[0]?.sessionKey).toBe(key("audit"));
    expect(runtime.runs[0]?.message).toContain(`EVENT BUILD_DONE @ ${SHA}`);
    expect(runtime.runs[0]?.message).toContain(RESTART_LINE);
  });

  it("does not re-deliver to a worker that already replied", async () => {
    const stateDir = freshState();
    const engine = new SwarmEngine({ stateDir, runtime: makeStubRuntime() });
    const emit = (role: string, event: string) =>
      createSwarmEmitTool({ engine, callerSessionKey: key(role) }).execute("c", {
        event,
        sha: SHA,
        body: "x",
      });
    await emit("build", "BUILD_DONE");
    await emit("audit", "AUDIT_PASS");
    const runtime = makeStubRuntime();
    await resumeOpenTasks(new SwarmEngine({ stateDir, runtime }));
    expect(runtime.runs.filter((r) => r.sessionKey === key("audit"))).toHaveLength(0);
    // test received AUDIT_PASS and has not answered: it is the one re-delivered.
    expect(runtime.runs.map((r) => r.sessionKey)).toEqual([key("test")]);
  });

  it("re-applies worker models before resending (ARCH §3)", async () => {
    const stateDir = freshState();
    await crashMidDelivery(stateDir);
    const runtime = makeStubRuntime();
    await resumeOpenTasks(new SwarmEngine({ stateDir, runtime }));
    expect(runtime.patches.map((p) => p.sessionKey).toSorted()).toEqual(
      [key("audit"), key("build"), key("test")].toSorted(),
    );
    expect(runtime.patches[0]?.model).toBe("cb-sonnet/claude-sonnet-5-5");
  });

  it("skips closed tasks and tasks whose log already shows DONE", async () => {
    const stateDir = freshState();
    fs.writeFileSync(
      path.join(stateDir, "swarm", TASK, "events.jsonl"),
      `${JSON.stringify({ from: "taskmaster", event: "DONE", sha: SHA, at: "2026-01-01T00:00:00Z" })}\n`,
    );
    const runtime = makeStubRuntime();
    const summary = await resumeOpenTasks(new SwarmEngine({ stateDir, runtime }));
    expect(summary.tasks).toBe(0);
    expect(runtime.runs).toHaveLength(0);
  });

  it("handles flat legacy outbox lines", async () => {
    const stateDir = freshState();
    fs.appendFileSync(
      path.join(stateDir, "swarm", TASK, "outbox.jsonl"),
      `${JSON.stringify({
        idempotencyKey: "legacy-1",
        seq: 1,
        targetSessionKey: key("audit"),
        to: "audit",
        message: `TASK ${TASK} | FROM build | TO audit\nEVENT BUILD_DONE @ ${SHA}\ndone`,
        acked: false,
      })}\n`,
    );
    const runtime = makeStubRuntime();
    await resumeOpenTasks(new SwarmEngine({ stateDir, runtime }));
    expect(runtime.runs[0]?.idempotencyKey).toBe("legacy-1");
    expect(runtime.runs[0]?.message.split("\n")[2]).toBe("[RESEND of seq 1]");
  });

  it("logs a RESUMED event per open task", async () => {
    const stateDir = freshState();
    await resumeOpenTasks(new SwarmEngine({ stateDir, runtime: makeStubRuntime() }));
    expect(readEvents(stateDir, TASK).some((e) => e.event === "RESUMED")).toBe(true);
  });

  it("crash after a resent run is accepted but before its ack: next resume does not resend (audit B1)", async () => {
    const stateDir = freshState();
    const entry = await crashMidDelivery(stateDir);
    // Resume #1: the run is accepted, then the gateway dies before the ack line is written.
    const accepted: string[] = [];
    const crashing = makeStubRuntime();
    crashing.subagent.run.mockImplementation(async (p) => {
      accepted.push(p.idempotencyKey ?? "");
      throw new Error("process killed before ack");
    });
    crashing.subagent.getSessionMessages.mockResolvedValue({ messages: [] });
    await resumeOpenTasks(new SwarmEngine({ stateDir, runtime: crashing }));
    expect(accepted).toEqual([entry?.idempotencyKey]);
    // Resume #2: the message is now in the target transcript, so it is acked, not resent.
    const runtime = makeStubRuntime({
      transcripts: { [key("audit")]: [`MSG ${entry?.idempotencyKey}`] },
    });
    const summary = await resumeOpenTasks(new SwarmEngine({ stateDir, runtime }));
    expect(summary.resent).toBe(0);
    expect(summary.ackedFromTranscript).toBe(1);
    expect(runtime.runs.filter((r) => r.idempotencyKey === entry?.idempotencyKey)).toHaveLength(0);
  });

  it("a resend writes no second delivery record for the same key (audit B1)", async () => {
    const stateDir = freshState();
    const entry = await crashMidDelivery(stateDir);
    await resumeOpenTasks(new SwarmEngine({ stateDir, runtime: makeStubRuntime() }));
    const lines = fs
      .readFileSync(path.join(stateDir, "swarm", TASK, "outbox.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { type: string; idempotencyKey: string });
    expect(
      lines.filter((l) => l.type === "delivery" && l.idempotencyKey === entry?.idempotencyKey),
    ).toHaveLength(1);
  });

  it("reads the whole transcript, not only the newest 200 messages (audit B1)", async () => {
    const stateDir = freshState();
    const entry = await crashMidDelivery(stateDir);
    const runtime = makeStubRuntime();
    await resumeOpenTasks(new SwarmEngine({ stateDir, runtime }));
    const limits = runtime.subagent.getSessionMessages.mock.calls.map(
      (c) => (c[0] as { limit?: number }).limit,
    );
    expect(limits.length).toBeGreaterThan(0);
    expect(limits.every((l) => (l ?? 0) > 200)).toBe(true);
    expect(entry).toBeDefined();
  });

  it("an unreadable transcript defers the entry instead of resending (fail closed, audit B1)", async () => {
    const stateDir = freshState();
    await crashMidDelivery(stateDir);
    const runtime = makeStubRuntime();
    runtime.subagent.getSessionMessages.mockRejectedValue(new Error("store unavailable"));
    const summary = await resumeOpenTasks(new SwarmEngine({ stateDir, runtime }));
    expect(summary.deferred).toBe(1);
    expect(summary.resent).toBe(0);
    expect(runtime.runs).toHaveLength(0);
    expect(readOutbox(stateDir, TASK).some((o) => !o.acked)).toBe(true);
  });

  it("a worker whose model cannot be re-applied is held and escalated, not resent (audit B3)", async () => {
    const stateDir = freshState();
    await crashMidDelivery(stateDir);
    const runtime = makeStubRuntime({
      patchFails: { "cb-sonnet/claude-sonnet-5-5": "model not allowed" },
    });
    const summary = await resumeOpenTasks(new SwarmEngine({ stateDir, runtime }));
    expect(summary.modelBlocked).toBe(3);
    expect(runtime.runs.some((r) => r.sessionKey === key("audit"))).toBe(false);
    expect(runtime.runs.some((r) => /EVENT BLOCKED/.test(r.message))).toBe(true);
    expect(readEvents(stateDir, TASK).some((e) => e.event === "MODEL_REAPPLY_FAILED")).toBe(true);
  });

  it("an unresolved merged delivery is resent once and its parts are not resent separately (audit B2)", async () => {
    const stateDir = freshState();
    const parts = ["p1", "p2"];
    for (const [i, k] of parts.entries()) {
      appendOutbox(stateDir, TASK, {
        type: "delivery",
        seq: i + 1,
        ts: 1,
        idempotencyKey: k,
        targetSessionKey: key("audit"),
        to: "audit",
        message: `TASK ${TASK}\nEVENT BUILD_DONE @ ${SHA}\nMSG ${k}\npart ${k}`,
        seqs: [i + 1],
      });
    }
    appendOutbox(stateDir, TASK, {
      type: "delivery",
      seq: 1,
      ts: 2,
      idempotencyKey: "merged-1",
      targetSessionKey: key("audit"),
      to: "audit",
      message: `TASK ${TASK}\nEVENT BUILD_DONE @ ${SHA}\nMSG merged-1\nboth parts`,
      seqs: [1, 2],
      supersedes: parts,
    });
    const runtime = makeStubRuntime();
    await resumeOpenTasks(new SwarmEngine({ stateDir, runtime }));
    expect(runtime.runs.map((r) => r.idempotencyKey)).toEqual(["merged-1"]);
    // Once the merged message is in the transcript, it and its parts are all settled.
    const settled = makeStubRuntime({ transcripts: { [key("audit")]: ["MSG merged-1"] } });
    const freshState2 = freshState();
    fs.copyFileSync(
      path.join(stateDir, "swarm", TASK, "outbox.jsonl"),
      path.join(freshState2, "swarm", TASK, "outbox.jsonl"),
    );
    await resumeOpenTasks(new SwarmEngine({ stateDir: freshState2, runtime: settled }));
    expect(readOutbox(freshState2, TASK).every((o) => o.acked)).toBe(true);
    expect(settled.runs.filter((r) => parts.includes(r.idempotencyKey ?? ""))).toHaveLength(0);
  });

  it("resend marker sits after the MSG line and is never duplicated", () => {
    const once = withResendMarker("TASK t\nEVENT E @ s\nMSG m\nbody", 3);
    expect(once.split("\n")).toEqual([
      "TASK t",
      "EVENT E @ s",
      "MSG m",
      "[RESEND of seq 3]",
      "body",
    ]);
    expect(withResendMarker(once, 3)).toBe(once);
  });

  it("an unacked entry whose send keeps failing stays unacked for the next resume", async () => {
    const stateDir = freshState();
    await crashMidDelivery(stateDir);
    await resumeOpenTasks(new SwarmEngine({ stateDir, runtime: makeStubRuntime({ failRuns: 5 }) }));
    expect(readOutbox(stateDir, TASK).some((o) => !o.acked)).toBe(true);
    appendOutbox(stateDir, TASK, { type: "ack", idempotencyKey: "unrelated", ts: 1 });
    const runtime = makeStubRuntime();
    const summary = await resumeOpenTasks(new SwarmEngine({ stateDir, runtime }));
    expect(summary.resent).toBe(1);
  });
});
