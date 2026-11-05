import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openChildrenOf } from "./children.js";
import { createSwarmEmitTool } from "./emit.js";
import { SwarmEngine } from "./engine.js";
import {
  classifyRunError,
  IDLE_SWEEP_MS,
  retryDelayMs,
  RESUMED_IDLE,
  RETRY_AFTER_ERROR,
  RETRY_SCHEDULED,
  RUN_ERROR,
  startIdleSweep,
} from "./heal.js";
import { createSwarmHooks } from "./hooks.js";
import { resumeOpenTasks } from "./resume.js";
import { readEvents, readTasksIndex, type SwarmEvent } from "./store.js";
import { seedTask } from "./test-fixtures.js";
import { makeFakeClock, makeStubRuntime } from "./test-runtime.js";

// ARCH §7.1: the swarm heals itself. Every rule 6 case, on a fake clock: no real timers, no
// gateway, no channel. Ids are generic placeholders.

const tmp = fs.mkdtempSync(path.join(tmpdir(), "swarm-heal-test-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const TASK = "task-710";
const SHA = "c0ffee71";
const UP = "agent:main:up";
const key = (role: string) => `agent:main:swarm:${TASK}:${role}`;
const SEC = 1000;
const MIN = 60 * SEC;

type Msg = Record<string, unknown>;

/** A session's transcript as the gateway's sessions.get returns it (newest last). */
function transcripts() {
  const bySession = new Map<string, Msg[]>();
  return {
    bySession,
    /** The run's last assistant message settled with a provider error (ARCH §7.1.1). */
    providerError(sessionKey: string, errorMessage: string, timestamp = Date.now() + 1) {
      bySession.set(sessionKey, [
        ...(bySession.get(sessionKey) ?? []),
        { role: "assistant", content: [], stopReason: "error", errorMessage, timestamp },
      ]);
    },
    /** A normal reply (no tool call, no error). */
    reply(sessionKey: string, text: string) {
      bySession.set(sessionKey, [
        ...(bySession.get(sessionKey) ?? []),
        {
          role: "assistant",
          content: [{ type: "text", text }],
          stopReason: "stop",
          timestamp: Date.now() + 1,
        },
      ]);
    },
  };
}

function setup(opts: { stateDir?: string; start?: number } = {}) {
  const stateDir = opts.stateDir ?? path.join(tmp, `s-${Math.random().toString(36).slice(2)}`);
  if (!opts.stateDir) {
    seedTask(stateDir, { taskId: TASK, headSha: SHA, upstreamSessionKey: UP });
  }
  const runtime = makeStubRuntime();
  const tx = transcripts();
  // The gateway's messages carry stopReason / errorMessage; the stub's type is narrower.
  runtime.subagent.getSessionMessages.mockImplementation((async (p: { sessionKey: string }) => ({
    messages: tx.bySession.get(p.sessionKey) ?? [],
  })) as never);
  const clock = makeFakeClock(opts.start);
  const engine = new SwarmEngine({ stateDir, runtime, clock: clock.clock });
  createSwarmHooks(() => engine).attach(engine);
  const emit = (role: string, args: Record<string, unknown>) =>
    createSwarmEmitTool({ engine, callerSessionKey: key(role) }).execute("c", args);
  /** Hand a role an input (a live run in its session), as routing would. */
  const give = (role: string, body = "go") =>
    engine.sendTo(TASK, engine.loadState(TASK), {
      to: role,
      from: "swarm",
      event: "PING",
      sha: SHA,
      body,
      seqs: [engine.record(TASK, { kind: "system", event: "PING", to: role }).seq],
    });
  const events = () => readEvents(stateDir, TASK);
  const named = (name: string) => events().filter((e) => e.event === name);
  const runsTo = (role: string) => runtime.runs.filter((r) => r.sessionKey === key(role));
  /** Every live run settles and the swarm never hears of it (the old code's ignored ends). */
  const loseRunEnds = async () => {
    const handler = engine.runEndHandler;
    engine.runEndHandler = undefined;
    await runtime.settleAll();
    engine.runEndHandler = handler;
  };
  return { stateDir, runtime, tx, clock, engine, emit, give, events, named, runsTo, loseRunEnds };
}

const lastMessageTo = (h: ReturnType<typeof setup>, role: string) => h.runsTo(role).at(-1)?.message;

describe("ARCH §7.1 error classes", () => {
  it("transient, quota and permanent, with the rule 2 backoff", () => {
    for (const text of [
      "Request timed out",
      "502 Bad Gateway",
      "503 Service Unavailable",
      "overloaded_error: Overloaded",
      "read ECONNRESET",
      "connect ECONNREFUSED 127.0.0.1:1",
      "socket hang up",
      "stream error: premature close",
    ]) {
      expect(classifyRunError(text), text).toBe("transient");
    }
    for (const text of [
      "429 Too Many Requests",
      "HTTP 403 insufficient_quota",
      "rate limit reached",
    ]) {
      expect(classifyRunError(text), text).toBe("quota");
    }
    for (const text of [
      "400 invalid request: tool schema rejected",
      "401 invalid api key",
      undefined,
    ]) {
      expect(classifyRunError(text), String(text)).toBe("permanent");
    }
    expect([1, 2, 3, 4, 5, 6, 50].map((n) => retryDelayMs(n))).toEqual([
      30 * SEC,
      2 * MIN,
      5 * MIN,
      10 * MIN,
      15 * MIN,
      15 * MIN,
      15 * MIN,
    ]);
    expect(retryDelayMs(1, "quota")).toBe(15 * MIN);
  });
});

describe("rule 1: a provider error is a run error, whatever the run status says", () => {
  it("a run that settles ok with an error assistant message → RUN_ERROR + scheduled retry, not WORKER_EXIT_WITHOUT_EMIT", async () => {
    const h = setup();
    await h.give("build", "build the greeting");
    h.tx.providerError(key("build"), "Request timed out");
    await h.runtime.end(key("build"), { status: "ok" });

    expect(h.named("WORKER_EXIT_WITHOUT_EMIT")).toHaveLength(0);
    expect(h.named(RUN_ERROR)).toMatchObject([
      { from: "build", body: "Request timed out", data: { class: "transient", attempt: 1 } },
    ]);
    const [sched] = h.named(RETRY_SCHEDULED);
    expect(sched?.data).toMatchObject({ role: "build", attempt: 1, class: "transient" });
    expect(Number(sched?.data?.at) - h.clock.clock.now()).toBe(30 * SEC);
    // Nobody was told the worker went silent; nothing ran yet.
    expect(h.runsTo("taskmaster")).toHaveLength(0);
    expect(h.runsTo("build")).toHaveLength(1);

    await h.clock.advance(30 * SEC);
    expect(h.runsTo("build")).toHaveLength(2);
    expect(lastMessageTo(h, "build")).toMatch(
      /^\[RETRY_AFTER_ERROR attempt 1: .*Request timed out/,
    );
    expect(lastMessageTo(h, "build")).toContain("build the greeting");
    expect(h.named(RETRY_AFTER_ERROR)).toMatchObject([{ data: { role: "build", attempt: 1 } }]);
    expect(h.runtime.maxLive.get(key("build"))).toBe(1);
  });

  it("a normal silent end, or an error older than the run, is still exit enforcement", async () => {
    const h = setup();
    h.tx.providerError(key("build"), "Request timed out", 1); // an earlier run's error
    await h.give("build");
    await h.runtime.end(key("build"), { status: "ok" });
    expect(h.named(RUN_ERROR)).toHaveLength(0);
    expect(h.named("WORKER_EXIT_WITHOUT_EMIT").filter((e) => e.from === "build")).toHaveLength(1);

    const h2 = setup();
    await h2.give("build");
    h2.tx.reply(key("build"), "all done, I think");
    await h2.runtime.end(key("build"), { status: "ok" });
    expect(h2.named(RUN_ERROR)).toHaveLength(0);
    expect(h2.named("WORKER_EXIT_WITHOUT_EMIT").filter((e) => e.from === "build")).toHaveLength(1);
  });

  it("a run that emitted before the provider error is not retried (its work is handed on)", async () => {
    const h = setup();
    await h.give("build");
    await h.emit("build", { event: "BUILD_DONE", sha: SHA, body: "done" });
    h.tx.providerError(key("build"), "Request timed out");
    await h.runtime.end(key("build"), { status: "error", error: "Request timed out" });
    expect(h.named(RETRY_SCHEDULED)).toHaveLength(0);
    expect(h.runsTo("audit")).toHaveLength(1);
  });
});

describe("rule 2: transient errors retry with backoff, never FAILED", () => {
  it("five transient errors in a row → still retrying (30 s, 2, 5, 10, 15 min), never FAILED", async () => {
    const h = setup();
    await h.give("build", "the input");
    const delays = [30 * SEC, 2 * MIN, 5 * MIN, 10 * MIN, 15 * MIN];
    for (const [i, delay] of delays.entries()) {
      await h.runtime.end(key("build"), { status: "error", error: "503 Service Unavailable" });
      const sched = h.named(RETRY_SCHEDULED).at(-1);
      expect(sched?.data).toMatchObject({ attempt: i + 1, class: "transient" });
      expect(h.clock.pending()).toEqual([delay]);
      await h.clock.advance(delay - 1);
      expect(h.runsTo("build")).toHaveLength(i + 1); // not a moment early
      await h.clock.advance(1);
      expect(h.runsTo("build")).toHaveLength(i + 2);
      expect(lastMessageTo(h, "build")).toContain(`attempt ${i + 1}:`);
      expect(lastMessageTo(h, "build")).toContain("the input");
    }
    // The retry line is replaced, never stacked.
    expect(lastMessageTo(h, "build")?.match(/RETRY_AFTER_ERROR attempt/g)).toHaveLength(1);
    // A sixth: still 15 min, still open, nothing went upstream.
    await h.runtime.end(key("build"), { status: "error", error: "Request timed out" });
    expect(h.clock.pending()).toEqual([15 * MIN]);
    expect(h.named(RUN_ERROR)).toHaveLength(6);
    expect(h.named("FAILED")).toHaveLength(0);
    expect(h.runtime.runs.filter((r) => r.sessionKey === UP)).toHaveLength(0);
    expect(readTasksIndex(h.stateDir)[TASK]?.status).toBe("open");
    expect(h.runtime.maxLive.get(key("build"))).toBe(1);
    // It recovers: the worker emits and the flow goes on.
    await h.clock.advance(15 * MIN);
    await h.emit("build", { event: "BUILD_DONE", sha: SHA, body: "done" });
    await h.runtime.end(key("build"));
    expect(h.runsTo("audit")).toHaveLength(1);
    expect(h.clock.pending()).toEqual([]);
  });

  it("quota → BLOCKED upstream with the reason, retried every 15 min, and it resumes on its own", async () => {
    const h = setup();
    await h.give("audit", "audit the sha");
    await h.runtime.end(key("audit"), {
      status: "error",
      error: "429 Too Many Requests: quota exceeded",
    });
    const up = () => h.runtime.runs.filter((r) => r.sessionKey === UP);
    expect(up()).toHaveLength(1);
    expect(up()[0]?.message).toContain("EVENT BLOCKED");
    expect(up()[0]?.message).toContain("quota exceeded");
    expect(h.clock.pending()).toEqual([15 * MIN]);
    // Still out of quota at the first retry: no second BLOCKED, another 15 min.
    await h.clock.advance(15 * MIN);
    expect(h.runsTo("audit")).toHaveLength(2);
    await h.runtime.end(key("audit"), { status: "error", error: "429 rate limit" });
    expect(up()).toHaveLength(1);
    expect(h.clock.pending()).toEqual([15 * MIN]);
    // Quota back: the retry runs and the holon carries on with nobody stepping in.
    await h.clock.advance(15 * MIN);
    expect(h.runsTo("audit")).toHaveLength(3);
    expect(lastMessageTo(h, "audit")).toContain("audit the sha");
    await h.emit("audit", { event: "AUDIT_PASS", sha: SHA, body: "ok" });
    await h.runtime.end(key("audit"));
    expect(h.runsTo("test")).toHaveLength(1);
    expect(readTasksIndex(h.stateDir)[TASK]?.status).toBe("open");
    expect(h.named("OPERATOR")).toHaveLength(0);
  });

  it("closing the holon drops its scheduled retries", async () => {
    const h = setup();
    await h.give("build");
    await h.runtime.end(key("build"), { status: "error", error: "Request timed out" });
    expect(h.clock.pending()).toEqual([30 * SEC]);
    h.engine.close(TASK, "cancelled");
    expect(h.clock.pending()).toEqual([]);
    await h.clock.advance(30 * MIN);
    expect(h.runsTo("build")).toHaveLength(1);
  });
});

describe("rule 3: lead errors are not ignored", () => {
  it("the lead errors → it is retried with its last input; worker events queue meanwhile, nothing dropped", async () => {
    const h = setup();
    await h.give("taskmaster", "drive the holon");
    await h.give("build");
    await h.runtime.end(key("taskmaster"), { status: "error", error: "Request timed out" });
    expect(h.named(RUN_ERROR)).toMatchObject([{ from: "taskmaster" }]);
    expect(h.named(RETRY_SCHEDULED)).toMatchObject([{ data: { role: "taskmaster", attempt: 1 } }]);
    // While the lead is down, build reports BLOCKED: it queues for the lead.
    await h.emit("build", { event: "BLOCKED", sha: SHA, body: "need the api key name" });
    await h.runtime.end(key("build"));
    expect(h.runsTo("taskmaster")).toHaveLength(1);
    expect(h.engine.mailbox.hasPending(key("taskmaster"))).toBe(true);

    await h.clock.advance(30 * SEC);
    // One turn: the retried input and the queued worker event (ARCH principle 4).
    expect(h.runsTo("taskmaster")).toHaveLength(2);
    const msg = lastMessageTo(h, "taskmaster") ?? "";
    expect(msg).toContain("RETRY_AFTER_ERROR attempt 1");
    expect(msg).toContain("drive the holon");
    expect(msg).toContain("need the api key name");
    expect(h.runtime.maxLive.get(key("taskmaster"))).toBe(1);

    // It errors again (ok status, provider error message): the next retry still carries both.
    h.tx.providerError(key("taskmaster"), "overloaded");
    await h.runtime.end(key("taskmaster"), { status: "ok" });
    expect(h.named(RETRY_SCHEDULED).at(-1)?.data).toMatchObject({ role: "taskmaster", attempt: 2 });
    await h.clock.advance(2 * MIN);
    const again = lastMessageTo(h, "taskmaster") ?? "";
    expect(again).toContain("attempt 2");
    expect(again).toContain("drive the holon");
    expect(again).toContain("need the api key name");
    expect(again.match(/RETRY_AFTER_ERROR attempt/g)).toHaveLength(1);
  });
});

describe("rule 4: the retry timer survives a restart", () => {
  it("a gateway restart with a scheduled retry → re-armed on resume, fires at its logged time", async () => {
    const first = setup();
    await first.give("build", "the build input");
    await first.runtime.end(key("build"), { status: "error", error: "Request timed out" });
    const sched = first.named(RETRY_SCHEDULED)[0] as SwarmEvent;
    const at = Number(sched.data?.at);
    first.engine.timers.stopAll(); // the gateway goes down

    // 10 s later a fresh gateway resumes from the files alone.
    const second = setup({ stateDir: first.stateDir, start: at - 20 * SEC });
    const summary = await resumeOpenTasks(second.engine);
    expect(summary.retriesRearmed).toBe(1);
    expect(second.clock.pending()).toEqual([20 * SEC]);
    // Held for the retry: resume's own re-delivery leaves build alone.
    expect(second.runsTo("build")).toHaveLength(0);
    expect(second.named("REDELIVERED").some((e) => e.data?.role === "build")).toBe(false);
    await second.clock.advance(20 * SEC);
    expect(second.runsTo("build")).toHaveLength(1);
    expect(lastMessageTo(second, "build")).toContain("RETRY_AFTER_ERROR attempt 1");
    expect(lastMessageTo(second, "build")).toContain("the build input");
    // A second restart: the retry already fired, nothing is armed twice.
    const third = setup({ stateDir: first.stateDir, start: at + MIN });
    expect((await resumeOpenTasks(third.engine)).retriesRearmed).toBe(0);
  });

  it("a retry whose time passed while the gateway was down fires at once on resume", async () => {
    const first = setup();
    await first.give("taskmaster", "lead input");
    await first.runtime.end(key("taskmaster"), { status: "error", error: "Request timed out" });
    const at = Number(first.named(RETRY_SCHEDULED)[0]?.data?.at);
    first.engine.timers.stopAll();
    const second = setup({ stateDir: first.stateDir, start: at + 10 * MIN });
    await resumeOpenTasks(second.engine);
    await second.clock.advance(0);
    expect(second.runsTo("taskmaster")).toHaveLength(1);
    expect(lastMessageTo(second, "taskmaster")).toContain("lead input");
  });
});

describe("rule 5: the idle sweep", () => {
  it("a holon with an unanswered input and nothing in flight → RESUMED_IDLE within the sweep", async () => {
    const h = setup();
    await h.give("audit", "audit this");
    // The run is settled without the swarm seeing it (a lost run end): nothing in flight.
    await h.loseRunEnds();
    expect(h.named(RUN_ERROR)).toHaveLength(0);
    startIdleSweep(h.engine, (id) => openChildrenOf(h.stateDir, id));
    await h.clock.advance(IDLE_SWEEP_MS);
    expect(h.named(RESUMED_IDLE)).toMatchObject([{ data: { role: "audit" } }]);
    expect(h.runsTo("audit")).toHaveLength(2);
    expect(lastMessageTo(h, "audit")).toContain("audit this");
    // Busy now: the next sweep leaves it alone.
    await h.clock.advance(IDLE_SWEEP_MS);
    expect(h.named(RESUMED_IDLE)).toHaveLength(1);
    // The same input lost again: repeats back off (2 min after the first), not every minute.
    await h.loseRunEnds();
    await h.clock.advance(IDLE_SWEEP_MS); // 2 min after the first: due
    expect(h.named(RESUMED_IDLE)).toHaveLength(2);
    await h.loseRunEnds();
    for (let i = 0; i < 4; i += 1) {
      await h.clock.advance(IDLE_SWEEP_MS); // within 5 min of the second
    }
    expect(h.named(RESUMED_IDLE)).toHaveLength(2);
    await h.clock.advance(IDLE_SWEEP_MS);
    expect(h.named(RESUMED_IDLE)).toHaveLength(3);
    h.engine.timers.stopAll();
  });

  it("leaves a holon alone while something is in flight, scheduled, or it waits on upstream", async () => {
    const h = setup();
    startIdleSweep(h.engine, (id) => openChildrenOf(h.stateDir, id));
    await h.give("build");
    await h.clock.advance(IDLE_SWEEP_MS); // build is running
    expect(h.named(RESUMED_IDLE)).toHaveLength(0);
    await h.runtime.end(key("build"), { status: "error", error: "502 Bad Gateway" });
    await h.clock.advance(20 * SEC); // a retry is scheduled (due at 30 s)
    expect(h.named(RESUMED_IDLE)).toHaveLength(0);
    await h.emit("build", { event: "BLOCKED", sha: SHA, body: "stuck" });
    await h.emit("taskmaster", { event: "BLOCKED", sha: SHA, body: "need the operator" });
    await h.runtime.settleAll();
    await h.clock.advance(5 * IDLE_SWEEP_MS); // waiting on an upstream answer
    expect(h.named(RESUMED_IDLE)).toHaveLength(0);
    h.engine.timers.stopAll();
  });

  it("re-delivers an input that was never delivered", async () => {
    const h = setup();
    h.runtime.subagent.run.mockRejectedValueOnce(new Error("gateway unavailable"));
    await h.give("test", "test this");
    expect(h.runsTo("test")).toHaveLength(0);
    startIdleSweep(h.engine, (id) => openChildrenOf(h.stateDir, id));
    await h.clock.advance(IDLE_SWEEP_MS);
    expect(h.named(RESUMED_IDLE)).toMatchObject([{ data: { role: "test", undelivered: true } }]);
    expect(h.runsTo("test")).toHaveLength(1);
    expect(lastMessageTo(h, "test")).toContain("test this");
    h.engine.timers.stopAll();
  });
});

describe("the 14:44 sequence, replayed", () => {
  /**
   * Live failure (ARCH §7.1): "Request timed out" on the build turn and, one second later, on
   * the taskmaster turn handling it. The build run settled as a normal end with an error
   * assistant message; the taskmaster run errored.
   */
  it("ends with build running again, with no operator message", async () => {
    const h = setup();
    await h.give("taskmaster", "Task started; build has the brief. Wait for events.");
    await h.give("build", "Start the task. add a greeting");
    startIdleSweep(h.engine, (id) => openChildrenOf(h.stateDir, id));

    h.tx.providerError(key("build"), "Request timed out");
    await h.runtime.end(key("build"), { status: "ok" });
    await h.clock.advance(SEC);
    h.tx.providerError(key("taskmaster"), "Request timed out");
    await h.runtime.end(key("taskmaster"), { status: "error", error: "Request timed out" });

    expect(h.named("WORKER_EXIT_WITHOUT_EMIT")).toHaveLength(0);
    expect(h.named(RUN_ERROR).map((e) => e.from)).toEqual(["build", "taskmaster"]);
    expect(h.named(RETRY_SCHEDULED).map((e) => e.data?.role)).toEqual(["build", "taskmaster"]);

    // No operator: within the backoff, build is running again on the same input.
    await h.clock.advance(30 * SEC);
    expect(h.runtime.liveIn(key("build"))).toBe(1);
    expect(lastMessageTo(h, "build")).toContain("add a greeting");
    expect(h.runtime.liveIn(key("taskmaster"))).toBe(1);
    expect(h.named("OPERATOR")).toHaveLength(0);
    expect(h.runtime.runs.filter((r) => r.sessionKey === UP)).toHaveLength(0);
    expect(readTasksIndex(h.stateDir)[TASK]?.status).toBe("open");
    h.engine.timers.stopAll();
  });

  it("a holon left exactly as 14:44 left it (nothing in flight) is picked up by the sweep", async () => {
    const h = setup();
    await h.give("build", "Start the task. add a greeting");
    // As the old code left it: build's end read as a silent exit (the lead was told to
    // re-prompt), then the lead's turn on that notice errored and was ignored. Nothing is
    // running, queued or scheduled.
    await h.runtime.end(key("build"), { status: "ok" });
    expect(h.runsTo("taskmaster").at(-1)?.message).toContain("Re-prompt it once");
    await h.loseRunEnds();
    startIdleSweep(h.engine, (id) => openChildrenOf(h.stateDir, id));

    await h.clock.advance(IDLE_SWEEP_MS);
    expect(h.named(RESUMED_IDLE)).toMatchObject([{ data: { role: "taskmaster" } }]);
    expect(lastMessageTo(h, "taskmaster")).toContain("Re-prompt it once");
    // The lead does what the notice says; build runs again.
    await h.emit("taskmaster", { event: "RETRY", sha: SHA, body: "go on", role: "build" });
    await h.runtime.end(key("taskmaster"));
    expect(h.runtime.liveIn(key("build"))).toBe(1);
    expect(h.named("OPERATOR")).toHaveLength(0);
    h.engine.timers.stopAll();
  });
});
