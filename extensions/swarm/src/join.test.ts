import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createSwarmEmitTool } from "./emit.js";
import { SwarmEngine } from "./engine.js";
import { joinStatus } from "./fanout.js";
import { createSwarmHooks } from "./hooks.js";
import { resumeOpenTasks } from "./resume.js";
import { readEvents, type SwarmEvent } from "./store.js";
import { startTask } from "./tasks.js";
import { makeStubRuntime } from "./test-runtime.js";

// ARCH §4.6 (every verdict joins, whatever its route) and §4.7 (nobody waits on nothing).

const tmp = fs.mkdtempSync(path.join(tmpdir(), "swarm-join-test-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const UPSTREAM = "agent:main:upstream-0000";
const key = (task: string, member: string) => `agent:main:swarm:${task}:${member}`;

const CONTRACT = (id: string, testLane: string, extra = "") => `
id: ${id}
kind: build
input: add a function plus unit test
done_when: unit test passes
lead: { kind: agent, model: provider-lead/model-lead }
lanes:
  build: { count: 1, model: provider-a/model-a }
  audit: { count: 1, model: provider-a/model-a }
  test: ${testLane}
upstream: { sessionKey: ${UPSTREAM} }
${extra}`;

function setup(opts: { hooks?: boolean } = {}) {
  const stateDir = path.join(tmp, `s-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(stateDir, { recursive: true });
  const runtime = makeStubRuntime();
  const engine = new SwarmEngine({ stateDir, runtime });
  if (opts.hooks) {
    createSwarmHooks(() => engine).attach(engine);
  }
  return { stateDir, runtime, engine };
}
type Ctx = ReturnType<typeof setup>;

/** Emit as a participant; the emitting run is left live (the caller ends runs it wants). */
async function emitOnly(
  ctx: Ctx,
  task: string,
  member: string,
  event: string,
  sha: string,
  body = "",
) {
  const tool = createSwarmEmitTool({ engine: ctx.engine, callerSessionKey: key(task, member) });
  const res = (await tool.execute("c", { event, sha, body })).details as Record<string, unknown>;
  await ctx.runtime.drain();
  return res;
}

/** Emit and settle every live run without the run-end handlers (scripted members). */
async function emit(ctx: Ctx, task: string, member: string, event: string, sha: string, body = "") {
  const res = await emitOnly(ctx, task, member, event, sha, body);
  await ctx.runtime.settleAll();
  return res;
}

/** Start the task and hand one sha to the test lane (build → audit → test fan-out). */
async function toTestLane(ctx: Ctx, task: string, testLane: string, sha: string) {
  await startTask(ctx.engine, { contractYaml: CONTRACT(task, testLane) });
  await ctx.runtime.settleAll();
  await emit(ctx, task, "build", "BUILD_DONE", sha);
  await emit(ctx, task, "audit", "AUDIT_PASS", sha);
}

const CONTRACT_ROUTES = `routes:
  - { on: BUILD_DONE, from: build, to: audit, message: "review {{sha}}" }
  - { on: AUDIT_PASS, from: audit, to: test, message: "test {{sha}}" }
  - { on: TEST_PASS, from: test, to: upstream, message: "shipped {{sha}}" }
  - { on: TEST_FAIL, from: test, to: build, message: "repro" }
  - { on: DONE, from: taskmaster, to: upstream, message: done }
  - { on: BLOCKED, from: "*", to: taskmaster, message: blocked }
  - { on: RETRY, from: taskmaster, to: "{{role}}", message: re-prompt }
`;

const leadRuns = (ctx: Ctx, task: string) =>
  ctx.runtime.runs.filter((r) => r.sessionKey === key(task, "taskmaster"));
const leadSaw = (ctx: Ctx, task: string, event: string) =>
  leadRuns(ctx, task).filter((r) => r.message.includes(`EVENT ${event} @`));

describe("ARCH §4.6: every verdict joins, whatever its route", () => {
  it("replays the live sequence: test:1 TEST_FAIL, test:2/test:3 TEST_PASS (join all) settles as a fail", async () => {
    const ctx = setup();
    const task = "task-j1";
    await toTestLane(ctx, task, "{ count: 3, model: provider-a/model-a, join: all }", "shaJ");
    // test:1's FAIL routes to build; the PASSes route to the lead. All three join.
    const r1 = await emit(ctx, task, "test:1", "TEST_FAIL", "shaJ", "- off by one in add()");
    expect(r1.routedTo).toBe("taskmaster");
    const r2 = await emit(ctx, task, "test:2", "TEST_PASS", "shaJ", "all green");
    expect(String(r2.notice)).toMatch(/not settled/);
    const r3 = await emit(ctx, task, "test:3", "TEST_PASS", "shaJ", "all green");
    expect(String(r3.notice)).toMatch(/settled \(fail\)/);

    const events = readEvents(ctx.stateDir, task);
    const settled = events.filter((e) => e.event === "LANE_SETTLED");
    expect(settled).toHaveLength(1);
    expect(settled[0]?.data).toMatchObject({ lane: "test", verdict: "TEST_FAIL", join: "all" });
    // Two LANE_WAITING (1/3, 2/3), each naming its lane (§4.7.3).
    const waiting = events.filter((e) => e.event === "LANE_WAITING");
    expect(waiting.map((e) => e.data?.lane)).toEqual(["test", "test"]);
    // The lead got one merged fail with test:1's finding and never a raw member verdict.
    const fails = leadSaw(ctx, task, "TEST_FAIL");
    expect(fails).toHaveLength(1);
    expect(fails[0]?.message).toMatch(/off by one in add\(\)/);
    expect(fails[0]?.message).toMatch(/dissenters: test:1/);
    expect(leadSaw(ctx, task, "TEST_PASS")).toHaveLength(0);
    expect(leadRuns(ctx, task).some((r) => /FROM test:\d/.test(r.message))).toBe(false);
    // Nothing went to build behind the lead's back: the lead hands the fail on.
    const buildRuns = ctx.runtime.runs.filter((r) => r.sessionKey === key(task, "build"));
    expect(buildRuns.some((r) => r.message.includes("EVENT TEST_FAIL"))).toBe(false);
  });

  it("the same verdicts in any order settle the same way", async () => {
    for (const order of [
      ["test:2", "test:1", "test:3"],
      ["test:2", "test:3", "test:1"],
    ]) {
      const ctx = setup();
      const task = `task-j2${order.join("").replace(/\D/g, "")}`;
      await toTestLane(ctx, task, "{ count: 3, model: provider-a/model-a, join: all }", "shaO");
      for (const m of order) {
        await emit(ctx, task, m, m === "test:1" ? "TEST_FAIL" : "TEST_PASS", "shaO", "- bad");
      }
      const settled = readEvents(ctx.stateDir, task).filter((e) => e.event === "LANE_SETTLED");
      expect(settled.map((e) => e.data?.verdict)).toEqual(["TEST_FAIL"]);
      expect(leadSaw(ctx, task, "TEST_PASS")).toHaveLength(0);
      expect(leadSaw(ctx, task, "TEST_FAIL")).toHaveLength(1);
    }
  });

  it("all pass: the lead gets one TEST_PASS, not three", async () => {
    const ctx = setup();
    const task = "task-j3";
    await toTestLane(ctx, task, "{ count: 3, model: provider-a/model-a, join: all }", "shaP");
    for (const m of ["test:1", "test:2"]) {
      await emit(ctx, task, m, "TEST_PASS", "shaP");
      expect(leadSaw(ctx, task, "TEST_PASS")).toHaveLength(0);
    }
    const res = await emit(ctx, task, "test:3", "TEST_PASS", "shaP");
    expect(res.routedTo).toBe("taskmaster");
    const passes = leadSaw(ctx, task, "TEST_PASS");
    expect(passes).toHaveLength(1);
    expect(passes[0]?.message).toMatch(/lane test settled \(all\)/);
    expect(passes[0]?.message).toMatch(/gate passed shaP/);
  });

  it("quorum on a lead-routed lane is unchanged: k passes settle, one event", async () => {
    const ctx = setup();
    const task = "task-j4";
    await toTestLane(
      ctx,
      task,
      '{ count: 3, model: provider-a/model-a, join: "quorum:2" }',
      "shaQ",
    );
    await emit(ctx, task, "test:1", "TEST_FAIL", "shaQ", "- flaky");
    await emit(ctx, task, "test:2", "TEST_PASS", "shaQ");
    expect(leadSaw(ctx, task, "TEST_PASS")).toHaveLength(0);
    await emit(ctx, task, "test:3", "TEST_PASS", "shaQ");
    expect(leadSaw(ctx, task, "TEST_PASS")).toHaveLength(1);
    expect(leadSaw(ctx, task, "TEST_FAIL")).toHaveLength(0);
  });

  it("any on a lead-routed lane is unchanged: the first pass wins, the rest stop", async () => {
    const ctx = setup();
    const task = "task-j5";
    await toTestLane(ctx, task, "{ count: 3, model: provider-a/model-a, join: any }", "shaA");
    await emit(ctx, task, "test:2", "TEST_PASS", "shaA");
    expect(leadSaw(ctx, task, "TEST_PASS")).toHaveLength(1);
    const stops = ctx.runtime.runs.filter(
      (r) => /:test:[13]$/.test(r.sessionKey) && r.message.includes("EVENT CANCELLED"),
    );
    expect(stops).toHaveLength(2);
    const late = await emit(ctx, task, "test:1", "TEST_PASS", "shaA");
    expect(late.routedTo).toBeNull();
    expect(leadSaw(ctx, task, "TEST_PASS")).toHaveLength(1);
  });

  it("a pass whose route is upstream joins too and reaches upstream once", async () => {
    const ctx = setup();
    const task = "task-j6";
    await startTask(ctx.engine, {
      contractYaml:
        CONTRACT(task, "{ count: 2, model: provider-a/model-a, join: all }").replace(
          `upstream: { sessionKey: ${UPSTREAM} }`,
          `upstream: { sessionKey: ${UPSTREAM}, events: [TEST_PASS, DONE, BLOCKED, FAILED] }`,
        ) + CONTRACT_ROUTES,
    });
    await ctx.runtime.settleAll();
    await emit(ctx, task, "build", "BUILD_DONE", "shaU");
    await emit(ctx, task, "audit", "AUDIT_PASS", "shaU");
    await emit(ctx, task, "test:1", "TEST_PASS", "shaU");
    const upstreamRuns = () => ctx.runtime.runs.filter((r) => r.sessionKey === UPSTREAM);
    expect(upstreamRuns().filter((r) => r.message.includes("EVENT TEST_PASS"))).toHaveLength(0);
    await emit(ctx, task, "test:2", "TEST_PASS", "shaU");
    const events = readEvents(ctx.stateDir, task);
    expect(events.filter((e) => e.event === "LANE_SETTLED")).toHaveLength(1);
    const ups = upstreamRuns().filter((r) => r.message.includes("EVENT TEST_PASS @ shaU"));
    expect(ups).toHaveLength(1);
    expect(ups[0]?.message).toMatch(/FROM test \|/);
    expect(ups[0]?.message).toMatch(/lane test settled/);
    expect(leadSaw(ctx, task, "TEST_PASS")).toHaveLength(0);
  });

  it("invariant: once every member has a verdict, the lane is settled, for every route mix", async () => {
    // 3 members, each PASS (→ lead) or FAIL (→ build), every order: always settled.
    const verdicts = ["TEST_PASS", "TEST_FAIL"];
    const combos: string[][] = [];
    for (const a of verdicts) {
      for (const b of verdicts) {
        for (const c of verdicts) {
          combos.push([a, b, c]);
        }
      }
    }
    let n = 0;
    for (const combo of combos) {
      for (const join of ["all", '"quorum:2"', "any"]) {
        const ctx = setup();
        const task = `task-inv${(n += 1)}`;
        await toTestLane(ctx, task, `{ count: 3, model: provider-a/model-a, join: ${join} }`, "s");
        for (const [i, v] of combo.entries()) {
          await emit(ctx, task, `test:${i + 1}`, v, "s", `- finding ${i + 1}`);
        }
        const settled = readEvents(ctx.stateDir, task).filter((e) => e.event === "LANE_SETTLED");
        expect(settled, `${combo.join(",")} join ${join}`).toHaveLength(1);
        const leadVerdicts =
          leadSaw(ctx, task, "TEST_PASS").length + leadSaw(ctx, task, "TEST_FAIL").length;
        expect(leadVerdicts, `${combo.join(",")} join ${join}`).toBe(1);
      }
    }
  });

  it("a member's second verdict in a round replaces its first, never counts as another member", () => {
    const lane = {
      role: "test",
      count: 2,
      models: ["m/m"],
      partition: false,
      join: { kind: "all" as const },
    };
    const ev = (seq: number, from: string, event: string): SwarmEvent =>
      ({ seq, ts: seq, taskId: "t", kind: "emit", from, event }) as SwarmEvent;
    const status = joinStatus(
      lane as never,
      [ev(1, "test:1", "TEST_FAIL"), ev(2, "test:1", "TEST_PASS")],
      "TEST_PASS",
      "TEST_FAIL",
    );
    expect(status.settled).toBe(false);
  });
});

describe("ARCH §4.7: nobody waits on nothing", () => {
  it("the last idle member without a verdict gets the lane LANE_STALLED once and is re-prompted", async () => {
    const ctx = setup({ hooks: true });
    const task = "task-s1";
    await startTask(ctx.engine, {
      contractYaml: CONTRACT(task, "{ count: 3, model: provider-a/model-a, join: all }"),
    });
    await ctx.runtime.settleAll();
    await emitOnly(ctx, task, "build", "BUILD_DONE", "shaS");
    await ctx.runtime.end(key(task, "build"));
    await emitOnly(ctx, task, "audit", "AUDIT_PASS", "shaS");
    await ctx.runtime.end(key(task, "audit"));
    await ctx.runtime.end(key(task, "taskmaster"));

    // test:1 reports and its turn ends; test:2 and test:3 are still running: no stall.
    await emitOnly(ctx, task, "test:1", "TEST_PASS", "shaS");
    await ctx.runtime.end(key(task, "test:1"));
    const stalls = () => readEvents(ctx.stateDir, task).filter((e) => e.event === "LANE_STALLED");
    expect(stalls()).toHaveLength(0);
    // test:2 ends silently; test:3 is still in flight: still no stall.
    await ctx.runtime.end(key(task, "test:2"));
    expect(stalls()).toHaveLength(0);
    // test:3 (the last member with a turn) ends silently: the lane would wait on nothing.
    await ctx.runtime.end(key(task, "test:3"));
    expect(stalls()).toHaveLength(1);
    expect(stalls()[0]?.data).toMatchObject({ lane: "test", missing: ["test:2", "test:3"] });
    // The lead was still on LANE_WAITING; the stall reaches it on its next turn.
    await ctx.runtime.end(key(task, "taskmaster"));
    const leadStall = leadRuns(ctx, task).filter((r) => r.message.includes("EVENT LANE_STALLED"));
    expect(leadStall).toHaveLength(1);
    expect(leadStall[0]?.message).toMatch(/test:2, test:3/);
    expect(leadStall[0]?.message).toMatch(/1\/3/);
    // Each member with no verdict is re-prompted once; test:1 is not.
    for (const m of ["test:2", "test:3"]) {
      const reprompts = ctx.runtime.runs.filter(
        (r) =>
          r.sessionKey === key(task, m) && /lane test is waiting for your verdict/.test(r.message),
      );
      expect(reprompts, m).toHaveLength(1);
    }
    expect(
      ctx.runtime.runs.some(
        (r) => r.sessionKey === key(task, "test:1") && /waiting for your verdict/.test(r.message),
      ),
    ).toBe(false);
    // The re-prompts end silently again: never repeated for the same round.
    await ctx.runtime.end(key(task, "test:2"));
    await ctx.runtime.end(key(task, "test:3"));
    expect(stalls()).toHaveLength(1);
  });

  it("a stalled member that answers settles the lane", async () => {
    const ctx = setup({ hooks: true });
    const task = "task-s2";
    await startTask(ctx.engine, {
      contractYaml: CONTRACT(task, "{ count: 2, model: provider-a/model-a, join: all }"),
    });
    await ctx.runtime.settleAll();
    await emitOnly(ctx, task, "build", "BUILD_DONE", "shaT");
    await ctx.runtime.end(key(task, "build"));
    await emitOnly(ctx, task, "audit", "AUDIT_PASS", "shaT");
    await ctx.runtime.end(key(task, "audit"));
    await emitOnly(ctx, task, "test:1", "TEST_PASS", "shaT");
    await ctx.runtime.end(key(task, "test:1"));
    await ctx.runtime.end(key(task, "test:2"));
    expect(readEvents(ctx.stateDir, task).some((e) => e.event === "LANE_STALLED")).toBe(true);
    // The re-prompted member answers.
    await emitOnly(ctx, task, "test:2", "TEST_PASS", "shaT");
    await ctx.runtime.end(key(task, "taskmaster"));
    await ctx.runtime.end(key(task, "taskmaster"));
    expect(leadSaw(ctx, task, "TEST_PASS")).toHaveLength(1);
  });

  it("the lead brief says: wait on LANE_WAITING, decide on LANE_STALLED", async () => {
    const ctx = setup();
    await startTask(ctx.engine, {
      contractYaml: CONTRACT("task-b1", "{ count: 3, model: provider-a/model-a, join: all }"),
    });
    const brief = leadRuns(ctx, "task-b1")[0]?.extraSystemPrompt ?? "";
    expect(brief).toMatch(/On LANE_WAITING: wait/);
    expect(brief).toMatch(/On LANE_STALLED: decide/);
    expect(brief).toMatch(/RETRY/);
    expect(brief).toMatch(/BLOCKED/);
    expect(brief).toMatch(/never see raw member verdicts/i);
  });
});

describe("ARCH §4.7.1 on resume: an unsettled lane is re-checked", () => {
  async function unsettledLane(task: string) {
    const ctx = setup();
    await toTestLane(ctx, task, "{ count: 3, model: provider-a/model-a, join: all }", "shaR");
    return ctx;
  }

  it("a member's redelivered input is a turn in flight; when it ends without a verdict, the lane stalls", async () => {
    const ctx = await unsettledLane("task-r1");
    await emit(ctx, "task-r1", "test:1", "TEST_PASS", "shaR");
    await emit(ctx, "task-r1", "test:2", "TEST_PASS", "shaR");
    // Restart: test:3 had no verdict; its input is redelivered, so nobody waits on nothing.
    const runtime2 = makeStubRuntime();
    const engine2 = new SwarmEngine({ stateDir: ctx.stateDir, runtime: runtime2 });
    createSwarmHooks(() => engine2).attach(engine2);
    await resumeOpenTasks(engine2);
    const stalls = () =>
      readEvents(ctx.stateDir, "task-r1").filter((e) => e.event === "LANE_STALLED");
    expect(runtime2.runs.some((r) => r.sessionKey === key("task-r1", "test:3"))).toBe(true);
    expect(stalls()).toHaveLength(0);
    await runtime2.end(key("task-r1", "test:3"));
    expect(stalls()).toHaveLength(1);
    expect(stalls()[0]?.data).toMatchObject({ lane: "test", missing: ["test:3"] });
  });

  it("an unsettled lane with nobody to redeliver to stalls at resume", async () => {
    const ctx = await unsettledLane("task-r2");
    await emit(ctx, "task-r2", "test:1", "TEST_PASS", "shaR");
    // test:2/test:3 answered before the restart with a non-verdict (nothing to redeliver).
    await emit(ctx, "task-r2", "test:2", "BLOCKED", "shaR", "need a fixture");
    await emit(ctx, "task-r2", "test:3", "BLOCKED", "shaR", "need a fixture");
    const runtime2 = makeStubRuntime();
    await resumeOpenTasks(new SwarmEngine({ stateDir: ctx.stateDir, runtime: runtime2 }));
    const stalls = readEvents(ctx.stateDir, "task-r2").filter((e) => e.event === "LANE_STALLED");
    expect(stalls).toHaveLength(1);
    expect(stalls[0]?.data).toMatchObject({ lane: "test", missing: ["test:2", "test:3"] });
    // A second restart does not repeat it.
    await resumeOpenTasks(new SwarmEngine({ stateDir: ctx.stateDir, runtime: makeStubRuntime() }));
    expect(
      readEvents(ctx.stateDir, "task-r2").filter((e) => e.event === "LANE_STALLED"),
    ).toHaveLength(1);
  });

  it("a log from before §4.6 (passes bypassed the join) settles on resume", async () => {
    const ctx = await unsettledLane("task-r3");
    await emit(ctx, "task-r3", "test:1", "TEST_FAIL", "shaR", "- off by one");
    // The old engine let these reach the lead raw: logged emits, no join.
    for (const m of ["test:2", "test:3"]) {
      ctx.engine.record("task-r3", {
        kind: "emit",
        event: "TEST_PASS",
        from: m,
        to: "taskmaster",
        sha: "shaR",
        body: "green",
      });
    }
    const runtime2 = makeStubRuntime();
    await resumeOpenTasks(new SwarmEngine({ stateDir: ctx.stateDir, runtime: runtime2 }));
    // The lead's own input was redelivered first; the merged fail follows on its next turn.
    await runtime2.settleAll();
    const events = readEvents(ctx.stateDir, "task-r3");
    const settled = events.filter((e) => e.event === "LANE_SETTLED");
    expect(settled).toHaveLength(1);
    expect(settled[0]?.data).toMatchObject({ lane: "test", verdict: "TEST_FAIL" });
    expect(events.some((e) => e.event === "LANE_STALLED")).toBe(false);
    const leadFail = runtime2.runs.filter(
      (r) => r.sessionKey === key("task-r3", "taskmaster") && r.message.includes("EVENT TEST_FAIL"),
    );
    expect(leadFail).toHaveLength(1);
    expect(leadFail[0]?.message).toMatch(/off by one/);
  });
});
