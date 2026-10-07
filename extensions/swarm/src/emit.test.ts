import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createSwarmEmitTool, createSwarmEmitToolFactory } from "./emit.js";
import { SwarmEngine } from "./engine.js";
import { readEvents, readOutbox, readTasksIndex } from "./store.js";
import { commitScratchChange, gitHead, initScratchRepo, seedTask } from "./test-fixtures.js";
import { makeStubRuntime } from "./test-runtime.js";

const tmp = fs.mkdtempSync(path.join(tmpdir(), "swarm-emit-test-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const TASK = "task-100";
const key = (role: string) => `agent:main:swarm:${TASK}:${role}`;

function setup(opts: { sha?: string; repo?: string; upstream?: string } = {}) {
  const stateDir = path.join(tmp, `s-${Math.random().toString(36).slice(2)}`);
  seedTask(stateDir, {
    taskId: TASK,
    headSha: opts.sha ?? "abc123",
    repo: opts.repo,
    upstreamSessionKey: opts.upstream,
  });
  const runtime = makeStubRuntime();
  const engine = new SwarmEngine({ stateDir, runtime });
  const emit = async (role: string, args: Record<string, unknown>) => {
    const tool = createSwarmEmitTool({ engine, callerSessionKey: key(role) });
    const res = await tool.execute("call", args);
    // Each delivered run settles before the next step, as the gateway would report it.
    await runtime.endAll();
    return res.details as Record<string, unknown>;
  };
  return { stateDir, runtime, engine, emit };
}

describe("swarm_emit routing (default build template)", () => {
  it.each([
    ["build", "BUILD_DONE", "audit"],
    ["audit", "AUDIT_FAIL", "build"],
    ["audit", "AUDIT_PASS", "test"],
    ["test", "TEST_FAIL", "build"],
    ["test", "TEST_PASS", "taskmaster"],
    ["build", "BLOCKED", "taskmaster"],
  ])("%s %s is delivered to %s", async (from, event, to) => {
    const { runtime, emit, stateDir } = setup();
    const res = await emit(from, { event, sha: "abc123", body: "evidence" });
    expect(res).toMatchObject({ ok: true, routedTo: to });
    expect(runtime.runs.at(-1)?.sessionKey).toBe(key(to));
    expect(runtime.runs.at(-1)?.message).toContain(`TASK ${TASK} | FROM ${from} | TO ${to}`);
    expect(runtime.runs.at(-1)?.message).toContain(`EVENT ${event} @ abc123`);
    expect(readEvents(stateDir, TASK).find((e) => e.kind === "emit")).toMatchObject({
      from,
      event,
      to,
    });
  });

  it("appends the emit before routing and records an idempotent outbox entry", async () => {
    const { runtime, emit, stateDir } = setup();
    await emit("build", { event: "BUILD_DONE", sha: "abc123", body: "done" });
    const [emitted, sent] = readEvents(stateDir, TASK);
    expect(emitted?.kind).toBe("emit");
    expect(sent?.kind).toBe("send");
    const [entry] = readOutbox(stateDir, TASK);
    expect(entry).toMatchObject({ acked: true, to: "audit" });
    expect(runtime.runs[0]?.idempotencyKey).toBe(entry?.idempotencyKey);
    expect(runtime.runs[0]?.message).toContain(`MSG ${entry?.idempotencyKey}`);
    expect(runtime.runs[0]).toMatchObject({ lane: "subagent", deliver: false });
  });

  it("logs an unrouted event, tells the taskmaster and delivers nothing to workers", async () => {
    const { runtime, emit, stateDir } = setup();
    const res = await emit("build", {
      event: "AUDIT_PASS",
      sha: "abc123",
      body: "not mine",
    });
    expect(res).toMatchObject({ ok: true, routedTo: null });
    expect(String(res.notice)).toMatch(/no route/);
    expect(runtime.runs.map((r) => r.sessionKey)).toEqual([key("taskmaster")]);
    expect(readEvents(stateDir, TASK).find((e) => e.kind === "emit")?.to ?? null).toBeNull();
  });

  it("ARCH §10.6: BLOCKED and later BUILD_DONE for the same input are both routed", async () => {
    const { runtime, emit, stateDir } = setup();
    const blocked = await emit("build", {
      event: "BLOCKED",
      sha: "abc123",
      body: "need x",
    });
    const done = await emit("build", {
      event: "BUILD_DONE",
      sha: "abc123",
      body: "got it",
    });
    expect(blocked).toMatchObject({ ok: true, routedTo: "taskmaster" });
    expect(done).toMatchObject({ ok: true, routedTo: "audit" });
    expect(runtime.runs.map((r) => r.sessionKey)).toEqual([key("taskmaster"), key("audit")]);
    const emits = readEvents(stateDir, TASK).filter((e) => e.kind === "emit");
    expect(emits.map((e) => [e.event, e.to])).toEqual([
      ["BLOCKED", "taskmaster"],
      ["BUILD_DONE", "audit"],
    ]);
  });

  it("ARCH §10.7: an event whose sha differs from the last one is routed as-is, not refused", async () => {
    const { runtime, emit, stateDir } = setup({ sha: "abc123" });
    await emit("build", {
      event: "BUILD_DONE",
      sha: "f00d01",
      body: "new commit",
    });
    // Any role, any sha: logged and passed on unchanged.
    const audit = await emit("audit", {
      event: "AUDIT_PASS",
      sha: "0ld5ha0",
      body: "x",
    });
    expect(audit).toMatchObject({ ok: true, routedTo: "test" });
    expect(runtime.runs.at(-1)?.message).toContain("EVENT AUDIT_PASS @ 0ld5ha0");
    const events = readEvents(stateDir, TASK);
    expect(events.filter((e) => e.kind === "emit").map((e) => e.sha)).toEqual([
      "f00d01",
      "0ld5ha0",
    ]);
    expect(events.some((e) => /REFUSED/.test(e.event))).toBe(false);
    // The task index sha is not moved by emits.
    expect(readTasksIndex(stateDir)[TASK]?.sha).toBe("abc123");
  });

  it("swarm show state reports the repo head, whatever sha was emitted (ARCH §4)", async () => {
    const repo = initScratchRepo();
    const { engine, emit } = setup({ sha: "abc123", repo });
    commitScratchChange(repo);
    await emit("build", { event: "BUILD_DONE", sha: "anything", body: "x" });
    expect(engine.loadState(TASK).sha.startsWith(gitHead(repo))).toBe(true);
  });

  it("taskmaster RETRY goes back to the named worker", async () => {
    const { runtime, emit } = setup();
    const res = await emit("taskmaster", {
      event: "RETRY",
      sha: "abc123",
      body: "you ended without emitting",
      role: "build",
    });
    expect(res).toMatchObject({ ok: true, routedTo: "build" });
    expect(runtime.runs.at(-1)?.sessionKey).toBe(key("build"));
  });

  it("RETRY without a valid worker role is refused", async () => {
    const { emit } = setup();
    const res = await emit("taskmaster", {
      event: "RETRY",
      sha: "abc123",
      body: "x",
      role: "nobody",
    });
    expect(res.ok).toBe(false);
  });

  it("taskmaster DONE goes to the upstream session and closes the task", async () => {
    const { runtime, emit, stateDir } = setup({ upstream: "agent:main:upstream-0000" });
    const res = await emit("taskmaster", { event: "DONE", sha: "abc123", body: "gate passed" });
    expect(res).toMatchObject({ ok: true, routedTo: "upstream" });
    expect(runtime.runs.at(-1)?.sessionKey).toBe("agent:main:upstream-0000");
    expect(runtime.runs.at(-1)?.message).toContain("EVENT DONE @ abc123");
    expect(readTasksIndex(stateDir)[TASK]?.status).toBe("done");
  });

  it("refuses every emit once the task is closed", async () => {
    const { runtime, emit } = setup();
    await emit("taskmaster", { event: "DONE", sha: "abc123", body: "done" });
    const runs = runtime.runs.length;
    const res = await emit("build", { event: "BUILD_DONE", sha: "abc123", body: "late" });
    expect(String(res.error)).toMatch(/is done; not open/);
    expect(runtime.runs).toHaveLength(runs);
  });

  it("refuses a role that is not a worker of the task", async () => {
    const { emit } = setup();
    const res = await emit("research", { event: "BLOCKED", sha: "abc123", body: "x" });
    expect(String(res.error)).toMatch(/not a worker/);
  });
});

describe("swarm_emit identity (audit A4)", () => {
  it("takes task and role from the session key, never from arguments", async () => {
    const { runtime, engine, stateDir } = setup();
    const tool = createSwarmEmitTool({ engine, callerSessionKey: key("audit") });
    const res = await tool.execute("c", {
      event: "AUDIT_PASS",
      sha: "abc123",
      body: "ok",
      taskId: "task-999",
      from: "build",
    });
    expect((res.details as { ok: boolean }).ok).toBe(true);
    expect(readEvents(stateDir, TASK).find((e) => e.kind === "emit")?.from).toBe("audit");
    expect(runtime.runs[0]?.sessionKey).toBe(key("test"));
  });

  it("schema exposes no identity fields and no unions", () => {
    const { engine } = setup();
    const tool = createSwarmEmitTool({
      engine,
      callerSessionKey: key("build"),
    });
    const schema = tool.parameters as {
      type?: string;
      properties?: Record<string, unknown>;
    };
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties ?? {}).toSorted()).toEqual([
      "body",
      "event",
      "role",
      "sha",
    ]);
    expect(JSON.stringify(schema)).not.toMatch(/anyOf|oneOf|allOf/);
  });

  it("is a clear, harmless error from a non-swarm session", async () => {
    const { runtime, engine, stateDir } = setup();
    const tool = createSwarmEmitTool({ engine, callerSessionKey: "agent:main:main" });
    const res = await tool.execute("c", { event: "BUILD_DONE", sha: "abc123", body: "x" });
    expect(res.details).toMatchObject({ ok: false });
    expect(String((res.details as { error: string }).error)).toMatch(/non-swarm/);
    expect(readEvents(stateDir, TASK)).toHaveLength(0);
    expect(runtime.runs).toHaveLength(0);
  });

  it("a session of another task cannot touch this task", async () => {
    const { engine, stateDir } = setup();
    const tool = createSwarmEmitTool({
      engine,
      callerSessionKey: "agent:main:swarm:task-999:build",
    });
    const res = await tool.execute("c", { event: "BUILD_DONE", sha: "abc123", body: "x" });
    expect((res.details as { ok: boolean }).ok).toBe(false);
    expect(readEvents(stateDir, TASK)).toHaveLength(0);
  });

  it("the tool factory exposes the tool only in swarm sessions", () => {
    const { engine } = setup();
    const factory = createSwarmEmitToolFactory(() => engine);
    expect(factory({ sessionKey: "agent:main:main" })).toBeNull();
    expect(factory({ sessionKey: undefined })).toBeNull();
    expect(factory({ sessionKey: key("build") })?.name).toBe("swarm_emit");
  });
});

describe("swarm upstream delivery (ARCH §1.7)", () => {
  it("delivers to the session key with no channel configured", async () => {
    const { runtime, emit, stateDir } = setup({ upstream: "agent:main:upstream-0000" });
    await emit("taskmaster", { event: "DONE", sha: "abc123", body: "ok" });
    expect(runtime.runs.map((r) => r.sessionKey)).toEqual(["agent:main:upstream-0000"]);
    expect(readEvents(stateDir, TASK).some((e) => e.event === "UPSTREAM_CHANNEL_FAILED")).toBe(
      false,
    );
  });

  it("a failing channel is logged and the task still completes", async () => {
    const stateDir = path.join(tmp, `s-${Math.random().toString(36).slice(2)}`);
    seedTask(stateDir, { taskId: TASK, headSha: "abc123", upstreamSessionKey: "agent:main:up" });
    const contractFile = path.join(stateDir, "swarm", TASK, "contract.yaml");
    fs.writeFileSync(
      contractFile,
      fs
        .readFileSync(contractFile, "utf8")
        .replace("  events:", "  channel: { kind: example, to: group-0000 }\n  events:"),
    );
    const runtime = makeStubRuntime();
    const engine = new SwarmEngine({
      stateDir,
      runtime,
      channelSender: async () => {
        throw new Error("channel not configured");
      },
    });
    const tool = createSwarmEmitTool({ engine, callerSessionKey: key("taskmaster") });
    const res = await tool.execute("c", { event: "DONE", sha: "abc123", body: "ok" });
    expect((res.details as { ok: boolean }).ok).toBe(true);
    expect(readTasksIndex(stateDir)[TASK]?.status).toBe("done");
    expect(runtime.runs.map((r) => r.sessionKey)).toEqual(["agent:main:up"]);
    expect(
      readEvents(stateDir, TASK).find((e) => e.event === "UPSTREAM_CHANNEL_FAILED"),
    ).toBeDefined();
  });

  it("with no upstream target at all the event is logged and the task completes", async () => {
    const stateDir = path.join(tmp, `s-${Math.random().toString(36).slice(2)}`);
    seedTask(stateDir, { taskId: TASK, headSha: "abc123" });
    const contractFile = path.join(stateDir, "swarm", TASK, "contract.yaml");
    fs.writeFileSync(
      contractFile,
      fs.readFileSync(contractFile, "utf8").replace(/ {2}sessionKey: .*\n/, ""),
    );
    const runtime = makeStubRuntime();
    const engine = new SwarmEngine({ stateDir, runtime });
    const tool = createSwarmEmitTool({ engine, callerSessionKey: key("taskmaster") });
    await tool.execute("c", { event: "DONE", sha: "abc123", body: "ok" });
    expect(runtime.runs).toHaveLength(0);
    expect(readTasksIndex(stateDir)[TASK]?.status).toBe("done");
    expect(readEvents(stateDir, TASK).find((e) => e.kind === "upstream")?.event).toBe("DONE");
  });
});
