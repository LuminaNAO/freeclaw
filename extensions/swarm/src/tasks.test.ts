import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { taskmasterBrief, workerBrief } from "./briefs.js";
import { parseContract } from "./contract.js";
import { SwarmEngine } from "./engine.js";
import { readEvents, readTasksIndex } from "./store.js";
import type { SwarmEvent } from "./store.js";
import { buildTimeline, cancelTask, listTasks, showTask, startTask } from "./tasks.js";
import { initScratchRepo, gitHead } from "./test-fixtures.js";
import { makeStubRuntime } from "./test-runtime.js";

const tmp = fs.mkdtempSync(path.join(tmpdir(), "swarm-tasks-test-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function contractYaml(id: string, extra = "") {
  return `id: ${id}
kind: build
input: add a function plus unit test
done_when: unit test passes on head
workers:
  build: { count: 1, model: provider-a/model-a, thinking: "off" }
  audit: { count: 1, model: provider-b/model-b, thinking: high }
  test: { count: 1, model: provider-a/model-a, thinking: "off" }
upstream:
  sessionKey: agent:main:upstream-0000
${extra}`;
}

function setup(runtimeOpts: Parameters<typeof makeStubRuntime>[0] = {}) {
  const stateDir = path.join(tmp, `s-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(stateDir, { recursive: true });
  const runtime = makeStubRuntime(runtimeOpts);
  const engine = new SwarmEngine({ stateDir, runtime });
  return { stateDir, runtime, engine };
}

const key = (task: string, role: string) => `agent:main:swarm:${task}:${role}`;

describe("swarm.start", () => {
  it("applies every worker's contract model and thinking before any delivery (ARCH §3)", async () => {
    const { runtime, engine } = setup();
    const order: string[] = [];
    runtime.subagent.patchSession.mockImplementation(async (p) => {
      order.push(`patch:${p.sessionKey.split(":").pop()}`);
      const [provider = "", model = ""] = (p.model ?? "x/x").split("/");
      return { provider, model };
    });
    runtime.subagent.run.mockImplementation(async (p) => {
      order.push(`run:${p.sessionKey.split(":").pop()}`);
      runtime.runs.push(p);
      return { runId: "r" };
    });
    const task = await startTask(engine, { contractYaml: contractYaml("task-400") });
    const firstRun = order.findIndex((o) => o.startsWith("run:"));
    expect(order.slice(0, firstRun).toSorted()).toEqual(
      ["patch:audit", "patch:build", "patch:taskmaster", "patch:test"].toSorted(),
    );
    expect(runtime.subagent.patchSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: key("task-400", "audit"),
        model: "provider-b/model-b",
        thinkingLevel: "high",
      }),
    );
    expect(task.workers.audit).toMatchObject({
      model: "provider-b/model-b",
      thinking: "high",
      resolved: "provider-b/model-b",
    });
    expect(task.workers.build?.model).toBe("provider-a/model-a");
  });

  it("refuses to start and creates nothing when a model cannot be applied", async () => {
    const { runtime, engine, stateDir } = setup({
      patchFails: { "provider-b/model-b": "model not allowed" },
    });
    await expect(startTask(engine, { contractYaml: contractYaml("task-401") })).rejects.toThrow(
      /cannot apply model to worker audit: model not allowed/,
    );
    expect(runtime.runs).toHaveLength(0);
    expect(readTasksIndex(stateDir)["task-401"]).toBeUndefined();
    expect(fs.existsSync(path.join(stateDir, "swarm", "task-401"))).toBe(false);
  });

  it("creates state under <stateDir>/swarm/<id>, records models, briefs build and kicks the taskmaster", async () => {
    const { runtime, engine, stateDir } = setup();
    const task = await startTask(engine, { contractYaml: contractYaml("task-402") });
    expect(task.dir).toBe(path.join(stateDir, "swarm", "task-402"));
    expect(fs.existsSync(path.join(task.dir, "contract.yaml"))).toBe(true);
    expect(readTasksIndex(stateDir)["task-402"]?.status).toBe("open");
    expect(runtime.runs.map((r) => r.sessionKey)).toEqual([
      key("task-402", "build"),
      key("task-402", "taskmaster"),
    ]);
    expect(runtime.runs[0]?.extraSystemPrompt).toMatch(/You are the build worker/);
    expect(runtime.runs[1]?.extraSystemPrompt).toMatch(/You are the taskmaster/);
    const applied = readEvents(stateDir, "task-402").filter((e) => e.event === "MODEL_APPLIED");
    expect(applied.map((e) => e.from).toSorted()).toEqual(["audit", "build", "test"]);
  });

  it("uses the repo HEAD as the starting sha", async () => {
    const repo = initScratchRepo();
    const { engine } = setup();
    const task = await startTask(engine, {
      contractYaml: contractYaml("task-403", `repo: ${repo}\n`),
    });
    // Stored as the full commit id so short and full forms from workers both match it.
    expect(task.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(task.sha.startsWith(gitHead(repo))).toBe(true);
  });

  it("starts from a contract file", async () => {
    const { engine, stateDir } = setup();
    const file = path.join(stateDir, "c.yaml");
    fs.writeFileSync(file, contractYaml("task-404"));
    expect((await startTask(engine, { contractPath: file })).id).toBe("task-404");
  });

  it("returns taskId in the start result (change 3)", async () => {
    const { engine } = setup();
    const task = await startTask(engine, { contractYaml: contractYaml("task-406") });
    expect(task.taskId).toBe("task-406");
    expect(task.id).toBe("task-406");
    expect(JSON.parse(JSON.stringify(task))).toMatchObject({ taskId: "task-406" });
  });

  it("rejects an invalid contract and a duplicate id", async () => {
    const { engine, runtime } = setup();
    await expect(startTask(engine, { contractYaml: "id: x\n" })).rejects.toThrow();
    expect(runtime.runs).toHaveLength(0);
    await startTask(engine, { contractYaml: contractYaml("task-405") });
    await expect(startTask(engine, { contractYaml: contractYaml("task-405") })).rejects.toThrow(
      /already exists/,
    );
  });
});

describe("swarm.list / swarm.show", () => {
  it("lists tasks with status, sha and last event as plain JSON", async () => {
    const { engine, stateDir } = setup();
    await startTask(engine, { contractYaml: contractYaml("task-410") });
    const tasks = listTasks(stateDir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: "task-410", status: "open", sha: "init" });
    expect(typeof tasks[0]?.recentEvent).toBe("string");
    expect(JSON.parse(JSON.stringify(tasks))).toEqual(tasks);
  });

  it("show returns contract summary, applied and observed models, events and outbox", async () => {
    const { engine } = setup();
    await startTask(engine, { contractYaml: contractYaml("task-411") });
    engine.record("task-411", {
      kind: "system",
      event: "MODEL_OBSERVED",
      from: "audit",
      data: { provider: "provider-b", model: "model-b" },
    });
    const shown = showTask(engine, "task-411");
    expect(shown.models.audit).toEqual({
      contract: "provider-b/model-b",
      applied: "provider-b/model-b",
      observed: ["provider-b/model-b"],
    });
    expect(shown.events.length).toBeGreaterThan(0);
    expect(shown.outbox.every((o) => o.acked)).toBe(true);
    expect(showTask(engine, "task-411", 2).events).toHaveLength(2);
    expect(JSON.stringify(shown)).not.toMatch(/\u001b\[/);
  });

  it("reads never change state", async () => {
    const { engine, stateDir } = setup();
    await startTask(engine, { contractYaml: contractYaml("task-412") });
    const before = fs.readFileSync(
      path.join(stateDir, "swarm", "task-412", "events.jsonl"),
      "utf8",
    );
    listTasks(stateDir);
    showTask(engine, "task-412");
    expect(fs.readFileSync(path.join(stateDir, "swarm", "task-412", "events.jsonl"), "utf8")).toBe(
      before,
    );
  });
});

describe("handover timeline (change 5)", () => {
  const ev = (seq: number, ts: number, rest: Partial<SwarmEvent>): SwarmEvent => ({
    seq,
    ts,
    taskId: "task-430",
    kind: "system",
    event: "X",
    ...rest,
  });
  const T0 = 1_000_000;
  const log: SwarmEvent[] = [
    ev(1, T0 - 5, { event: "GROUP" }),
    ev(2, T0, { event: "TASK_STARTED", to: "build", sha: "aaa" }),
    ev(3, T0 + 10, { kind: "send", event: "DELIVERED", to: "build" }),
    ev(4, T0 + 20, { kind: "send", event: "DELIVERED", to: "taskmaster" }),
    ev(5, T0 + 1_010, {
      kind: "emit",
      event: "BUILD_DONE",
      from: "build",
      to: "audit",
      sha: "bbb",
    }),
    ev(6, T0 + 1_020, { kind: "send", event: "DELIVERED", to: "audit" }),
    ev(7, T0 + 1_500, {
      kind: "emit",
      event: "AUDIT_FAIL",
      from: "audit",
      to: "build",
      sha: "bbb",
    }),
    ev(8, T0 + 1_510, { kind: "send", event: "DELIVERED", to: "build" }),
    // An unrouted emit (no route) is not a handover.
    ev(9, T0 + 1_600, { kind: "emit", event: "NOTE", from: "audit", to: null }),
    ev(10, T0 + 3_510, {
      kind: "emit",
      event: "BUILD_DONE",
      from: "build",
      to: "audit",
      sha: "ccc",
    }),
    ev(11, T0 + 3_520, { kind: "send", event: "DELIVERED", to: "audit" }),
    ev(12, T0 + 4_020, {
      kind: "emit",
      event: "AUDIT_PASS",
      from: "audit",
      to: "test",
      sha: "ccc",
    }),
    ev(13, T0 + 4_030, { kind: "send", event: "DELIVERED", to: "test" }),
    ev(14, T0 + 6_030, {
      kind: "emit",
      event: "TEST_PASS",
      from: "test",
      to: "taskmaster",
      sha: "ccc",
    }),
    ev(15, T0 + 6_040, { kind: "send", event: "DELIVERED", to: "taskmaster" }),
    ev(16, T0 + 6_100, {
      kind: "emit",
      event: "DONE",
      from: "taskmaster",
      to: "upstream",
      sha: "ccc",
    }),
    ev(17, T0 + 6_101, { event: "TASK_CLOSED", data: { status: "done" } }),
  ];

  it("lists each routed event with unix-ms ts and deltas", () => {
    const t = buildTimeline(log);
    expect(t.startedAt).toBe(T0);
    expect(t.endedAt).toBe(T0 + 6_101);
    expect(t.durationMs).toBe(6_101);
    expect(t.handovers.map((h) => h.seq)).toEqual([2, 5, 7, 10, 12, 14, 16]);
    expect(t.handovers[0]).toEqual({
      seq: 2,
      ts: T0,
      event: "TASK_STARTED",
      from: "taskmaster",
      to: "build",
      sha: "aaa",
      sinceStartMs: 0,
      sincePrevMs: 0,
    });
    expect(t.handovers[2]).toMatchObject({
      event: "AUDIT_FAIL",
      from: "audit",
      to: "build",
      sinceStartMs: 1_500,
      sincePrevMs: 490,
    });
    expect(t.handovers.at(-1)).toMatchObject({ event: "DONE", to: "upstream", sincePrevMs: 70 });
  });

  it("sums per-role active time from each delivery to that role's next emit", () => {
    expect(buildTimeline(log).activeMs).toEqual({
      build: 1_000 + 2_000,
      audit: 480 + 500,
      test: 2_000,
      taskmaster: 6_080,
    });
  });

  it("an open task has no endedAt and its duration runs to now", () => {
    const open = log.slice(0, 8);
    const t = buildTimeline(open, T0 + 9_000);
    expect(t.endedAt).toBeNull();
    expect(t.durationMs).toBe(9_000);
    // build's second delivery (seq 8) has no emit yet: not counted.
    expect(t.activeMs).toEqual({ build: 1_000, audit: 480 });
  });

  it("swarm.show exposes the timeline over the whole log, even with --limit", async () => {
    const { engine } = setup();
    await startTask(engine, { contractYaml: contractYaml("task-431") });
    await engine.emit("task-431", "build", { event: "BUILD_DONE", sha: "init", body: "ok" });
    const shown = showTask(engine, "task-431", 1);
    expect(shown.events).toHaveLength(1);
    expect(shown.handovers.map((h) => h.event)).toEqual(["TASK_STARTED", "BUILD_DONE"]);
    expect(shown.handovers[1]).toMatchObject({ from: "build", to: "audit", sha: "init" });
    expect(typeof shown.startedAt).toBe("number");
    expect(shown.endedAt).toBeNull();
    expect(shown.activeMs.build).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(JSON.stringify(shown)).handovers).toHaveLength(2);
  });
});

describe("swarm.cancel", () => {
  it("sends an urgent stop to every session, closes the task and refuses later emits", async () => {
    const { engine, runtime, stateDir } = setup();
    await startTask(engine, { contractYaml: contractYaml("task-420") });
    const res = await cancelTask(engine, "task-420", "operator request");
    expect(res).toMatchObject({ status: "cancelled", changed: true });
    expect(runtime.aborts.toSorted()).toEqual(
      ["audit", "build", "taskmaster", "test"].map((r) => key("task-420", r)).toSorted(),
    );
    expect(readTasksIndex(stateDir)["task-420"]?.status).toBe("cancelled");
    const emitted = await engine.emit("task-420", "build", {
      event: "BUILD_DONE",
      sha: "init",
      body: "",
    });
    expect(emitted).toMatchObject({ ok: false });
  });

  it("always reports CANCELLED upstream, even when upstream.events omits it (ARCH §9)", async () => {
    const { engine, runtime } = setup();
    // contractYaml leaves upstream.events at the default [DONE, BLOCKED, FAILED].
    await startTask(engine, { contractYaml: contractYaml("task-422") });
    await cancelTask(engine, "task-422", "operator request");
    const upstream = runtime.runs.filter((r) => r.sessionKey === "agent:main:upstream-0000");
    expect(upstream).toHaveLength(1);
    expect(upstream[0]?.message).toContain("EVENT CANCELLED");
  });

  it("is a no-op on a closed task", async () => {
    const { engine } = setup();
    await startTask(engine, { contractYaml: contractYaml("task-421") });
    await cancelTask(engine, "task-421");
    expect(await cancelTask(engine, "task-421")).toMatchObject({ changed: false });
  });
});

describe("briefs", () => {
  const contract = parseContract(contractYaml("task-430"));

  it("worker brief names the events it may emit and the exit rule", () => {
    const brief = workerBrief(contract, "audit");
    expect(brief).toMatch(/AUDIT_FAIL/);
    expect(brief).toMatch(/AUDIT_PASS/);
    expect(brief).toMatch(/End EVERY turn by calling swarm_emit/);
    expect(brief).toMatch(/MSG <id>/);
  });

  it("build brief explains that BUILD_DONE carries the new sha", () => {
    expect(workerBrief(contract, "build")).toMatch(/BUILD_DONE with the new commit sha/);
  });

  it("taskmaster brief covers DONE, RETRY once, then BLOCKED", () => {
    const brief = taskmasterBrief(contract);
    expect(brief).toMatch(/swarm_emit DONE/);
    expect(brief).toMatch(/RETRY \(role: X\)/);
    expect(brief).toMatch(/BLOCKED/);
  });
});
