import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createSwarmEmitTool } from "./emit.js";
import { SwarmEngine } from "./engine.js";
import { createSwarmHooks, isQuotaError } from "./hooks.js";
import { readEvents, readTasksIndex } from "./store.js";
import { seedTask } from "./test-fixtures.js";
import { makeStubRuntime } from "./test-runtime.js";

const tmp = fs.mkdtempSync(path.join(tmpdir(), "swarm-hooks-test-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const TASK = "task-200";
const SHA = "cafe01";
const key = (role: string) => `agent:main:swarm:${TASK}:${role}`;

function setup() {
  const stateDir = path.join(tmp, `s-${Math.random().toString(36).slice(2)}`);
  seedTask(stateDir, { taskId: TASK, headSha: SHA, upstreamSessionKey: "agent:main:up" });
  const runtime = makeStubRuntime();
  const engine = new SwarmEngine({ stateDir, runtime });
  const hooks = createSwarmHooks(() => engine);
  hooks.attach(engine);
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
  return { stateDir, runtime, engine, hooks, emit, give };
}

describe("exit enforcement (run settled, ARCH §5)", () => {
  it("a worker run that emitted is left alone", async () => {
    const { runtime, give, emit } = setup();
    await give("build");
    await emit("build", { event: "BLOCKED", sha: SHA, body: "x" });
    const before = runtime.runs.length;
    await runtime.end(key("build"));
    expect(runtime.runs).toHaveLength(before);
  });

  it("first silent end: taskmaster is told the worker ended without exit and to re-prompt", async () => {
    const { runtime, stateDir, give } = setup();
    await give("build");
    await runtime.end(key("build"));
    expect(runtime.runs.at(-1)?.sessionKey).toBe(key("taskmaster"));
    expect(runtime.runs.at(-1)?.message).toMatch(/worker build ended without exit/);
    expect(runtime.runs.at(-1)?.message).toMatch(/Re-prompt it once/);
    expect(readEvents(stateDir, TASK).some((e) => e.event === "WORKER_EXIT_WITHOUT_EMIT")).toBe(
      true,
    );
  });

  it("second silent end for the same input: taskmaster is told to escalate", async () => {
    const { runtime, engine, give } = setup();
    await give("build");
    await runtime.end(key("build"));
    await runtime.end(key("taskmaster"));
    // The same input runs again (a restart re-delivery adds no new input) and ends silently.
    await engine.mailbox.deliver({
      stateDir: engine.stateDir,
      taskId: TASK,
      targetSessionKey: key("build"),
      to: "build",
      seqs: [1],
      idempotencyKey: "again-1",
      message: "same input again",
    });
    await runtime.end(key("build"));
    expect(runtime.runs.at(-1)?.message).toMatch(/Escalate now/);
  });

  it("a new input resets the count", async () => {
    const { runtime, give, emit } = setup();
    await give("build");
    await runtime.end(key("build"));
    await runtime.end(key("taskmaster"));
    await emit("taskmaster", {
      event: "RETRY",
      sha: SHA,
      body: "emit",
      role: "build",
    });
    await runtime.end(key("build"));
    expect(runtime.runs.at(-1)?.message).toMatch(/Re-prompt it once/);
  });

  it("if the taskmaster also ends silently after an escalate notice, swarm escalates upstream", async () => {
    const { runtime, engine, give } = setup();
    await give("build");
    engine.record(TASK, {
      kind: "system",
      event: "WORKER_EXIT_WITHOUT_EMIT",
      from: "build",
    });
    await runtime.end(key("build"));
    expect(runtime.runs.at(-1)?.message).toMatch(/Escalate now/);
    await runtime.end(key("taskmaster"));
    expect(runtime.runs.at(-1)?.sessionKey).toBe("agent:main:up");
    expect(runtime.runs.at(-1)?.message).toContain("EVENT BLOCKED");
  });

  it("ARCH §10.8: a long run raises nothing while it is live; there is no silence timer", async () => {
    const { runtime, stateDir, give, hooks } = setup();
    await give("build");
    // Hours pass inside one run (fake clock not needed: nothing is scheduled at all).
    await new Promise((r) => setTimeout(r, 20));
    await runtime.drain();
    expect(runtime.liveIn(key("build"))).toBe(1);
    expect(runtime.runs).toHaveLength(1);
    expect(readEvents(stateDir, TASK).map((e) => e.event)).toEqual(["PING", "DELIVERED"]);
    expect(Object.keys(hooks).toSorted()).toEqual(["attach", "onLlmInput", "onRunEnd"]);
  });
});

describe("run errors (ARCH §7)", () => {
  it("retries the same input once, then reports FAILED upstream and closes the task", async () => {
    const { runtime, stateDir, give } = setup();
    await give("build");
    await runtime.end(key("build"), {
      status: "error",
      error: "provider unavailable",
    });
    expect(runtime.runs.at(-1)?.sessionKey).toBe(key("build"));
    expect(runtime.runs.at(-1)?.message).toContain("RETRY_AFTER_ERROR");
    await runtime.end(key("build"), {
      status: "error",
      error: "provider unavailable",
    });
    expect(runtime.runs.at(-1)?.sessionKey).toBe("agent:main:up");
    expect(runtime.runs.at(-1)?.message).toContain("EVENT FAILED");
    expect(readTasksIndex(stateDir)[TASK]?.status).toBe("failed");
  });

  it("the retry after an error is never a second run beside the errored one (ARCH §5)", async () => {
    const { runtime, give, emit } = setup();
    await give("build");
    // A re-prompt arrives while the run is still going (it errors later).
    await emit("taskmaster", {
      event: "RETRY",
      sha: SHA,
      body: "status?",
      role: "build",
    });
    expect(runtime.liveIn(key("build"))).toBe(1);
    await runtime.end(key("build"), { status: "error", error: "overloaded" });
    expect(runtime.liveIn(key("build"))).toBe(1);
    await runtime.end(key("build"));
    expect(runtime.maxLive.get(key("build"))).toBe(1);
    expect(runtime.subagent.abortSession).not.toHaveBeenCalled();
  });

  it("quota errors skip the retry and go upstream as BLOCKED", async () => {
    const { runtime, stateDir, give } = setup();
    await give("audit");
    await runtime.end(key("audit"), {
      status: "error",
      error: "429 Too Many Requests: quota exceeded",
    });
    expect(runtime.runs.at(-1)?.sessionKey).toBe("agent:main:up");
    expect(runtime.runs.at(-1)?.message).toContain("EVENT BLOCKED");
    expect(readTasksIndex(stateDir)[TASK]?.status).toBe("open");
  });

  it("an aborted run (urgent stop, wrong model) is not treated as silence or an error", async () => {
    const { runtime, stateDir, give, engine } = setup();
    await give("build");
    await engine.runtime.subagent.abortSession?.({ sessionKey: key("build") });
    await runtime.drain();
    await runtime.drain();
    const names = readEvents(stateDir, TASK).map((e) => e.event);
    expect(names).not.toContain("WORKER_EXIT_WITHOUT_EMIT");
    expect(names).not.toContain("RUN_ERROR");
  });

  it("classifies quota text", () => {
    expect(isQuotaError("HTTP 403 insufficient_quota")).toBe(true);
    expect(isQuotaError("rate limit reached")).toBe(true);
    expect(isQuotaError("socket hang up")).toBe(false);
    expect(isQuotaError(undefined)).toBe(false);
  });
});

describe("model check (llm_input, ARCH §3 / §10.5)", () => {
  it("records the observed model once per run", async () => {
    const { hooks, stateDir } = setup();
    const ev = {
      runId: "r1",
      sessionId: "s1",
      provider: "cb-sonnet",
      model: "claude-sonnet-5-5",
      prompt: "x",
      historyMessages: [],
      imagesCount: 0,
    };
    await hooks.onLlmInput(ev, { sessionKey: key("build") });
    await hooks.onLlmInput(ev, { sessionKey: key("build") });
    const observed = readEvents(stateDir, TASK).filter((e) => e.event === "MODEL_OBSERVED");
    expect(observed).toHaveLength(1);
    expect(observed[0]?.data).toMatchObject({ provider: "cb-sonnet", model: "claude-sonnet-5-5" });
  });

  const wrongModel = {
    runId: "r2",
    sessionId: "s1",
    provider: "fallback",
    model: "other-model",
    prompt: "x",
    historyMessages: [],
    imagesCount: 0,
  };

  it("a mismatch stops the run, escalates BLOCKED upstream and tells the taskmaster (audit B3)", async () => {
    const { hooks, runtime, stateDir } = setup();
    await hooks.onLlmInput(wrongModel, { sessionKey: key("audit") });
    expect(readEvents(stateDir, TASK).some((e) => e.event === "MODEL_MISMATCH")).toBe(true);
    expect(runtime.aborts).toEqual([key("audit")]);
    const upstream = runtime.runs.find((r) => r.sessionKey === "agent:main:up");
    expect(upstream?.message).toContain("EVENT BLOCKED");
    expect(upstream?.message).toMatch(/ran on fallback\/other-model/);
    expect(runtime.runs.some((r) => r.sessionKey === key("taskmaster"))).toBe(true);
  });

  it("an emit from a worker that ran on the wrong model is refused and not routed (audit B3)", async () => {
    const { hooks, runtime, stateDir, emit } = setup();
    await hooks.onLlmInput(wrongModel, { sessionKey: key("audit") });
    const runsBefore = runtime.runs.length;
    const res = await emit("audit", { event: "AUDIT_PASS", sha: SHA, body: "looks fine" });
    expect(res.details).toMatchObject({ ok: false });
    expect(String((res.details as { error: string }).error)).toMatch(/not its contract model/);
    expect(runtime.runs).toHaveLength(runsBefore);
    expect(readEvents(stateDir, TASK).some((e) => e.event === "EMIT_REFUSED_WRONG_MODEL")).toBe(
      true,
    );
  });

  it("a later run on the contract model clears the refusal", async () => {
    const { hooks, emit } = setup();
    await hooks.onLlmInput(wrongModel, { sessionKey: key("audit") });
    await hooks.onLlmInput(
      { ...wrongModel, runId: "r3", provider: "cb-sonnet", model: "claude-sonnet-5-5" },
      { sessionKey: key("audit") },
    );
    const res = await emit("audit", { event: "AUDIT_PASS", sha: SHA, body: "ok" });
    expect(res.details).toMatchObject({ ok: true });
  });

  it("ignores non-swarm sessions", async () => {
    const { hooks, stateDir } = setup();
    await hooks.onLlmInput(
      {
        runId: "r3",
        sessionId: "s",
        provider: "p",
        model: "m",
        prompt: "x",
        historyMessages: [],
        imagesCount: 0,
      },
      { sessionKey: "agent:main:main" },
    );
    expect(readEvents(stateDir, TASK)).toHaveLength(0);
  });
});
