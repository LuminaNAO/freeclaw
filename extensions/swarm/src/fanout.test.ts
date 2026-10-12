import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createSwarmEmitTool } from "./emit.js";
import { SwarmEngine } from "./engine.js";
import { createSwarmHooks } from "./hooks.js";
import { readEvents, readTasksIndex } from "./store.js";
import { startTask } from "./tasks.js";
import { initScratchRepo } from "./test-fixtures.js";
import { makeStubRuntime } from "./test-runtime.js";

// Fan-out lanes (ARCH §4): partition, redundancy, join all | quorum:<k> | any, findings dedup.
// Scripted members play the lane; the engine joins and the lead gets one event (§4.5).

const tmp = fs.mkdtempSync(path.join(tmpdir(), "swarm-fanout-test-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const UPSTREAM = "agent:main:upstream-0000";
const key = (task: string, member: string) => `agent:main:swarm:${task}:${member}`;

function setup(opts: { hooks?: boolean } = {}) {
  const stateDir = path.join(tmp, `s-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(stateDir, { recursive: true });
  const runtime = makeStubRuntime();
  const engine = new SwarmEngine({ stateDir, runtime });
  // Hooks (exit enforcement) attach only where the test is about them; everywhere else the
  // members are scripted, so a scripted settle is not a silent end.
  if (opts.hooks) {
    createSwarmHooks(() => engine).attach(engine);
  }
  return { stateDir, runtime, engine };
}

type Ctx = ReturnType<typeof setup>;

/** Emit as a member, then settle every live run (as the gateway would report them). */
async function emit(ctx: Ctx, task: string, member: string, event: string, sha: string, body = "") {
  const tool = createSwarmEmitTool({ engine: ctx.engine, callerSessionKey: key(task, member) });
  const res = (await tool.execute("c", { event, sha, body })).details as Record<string, unknown>;
  await ctx.runtime.endAll();
  return res;
}

/** Start a task and settle its kickoff runs. */
async function start(ctx: Ctx, contractYaml: string) {
  const task = await startTask(ctx.engine, { contractYaml });
  await ctx.runtime.endAll();
  return task;
}

const FANOUT = (id: string, auditLane: string) => `
id: ${id}
kind: build
input: add a function plus unit test
done_when: unit test passes
lead: { kind: agent, model: provider-lead/model-lead, thinking: high }
lanes:
  build: { count: 1, model: provider-a/model-a, thinking: "off" }
  audit: ${auditLane}
  test: { count: 1, model: provider-a/model-a, thinking: "off" }
upstream: { sessionKey: ${UPSTREAM} }
`;

describe("fan-out: redundant audit lane, join all (ARCH §4.3, §4.4)", () => {
  it("start patches every member on its own model in the cycle", async () => {
    const ctx = setup();
    const { runtime, engine } = ctx;
    const task = await start(
      ctx,
      FANOUT("task-f1", "{ count: 3, model: [provider-a/model-a, provider-b/model-b], join: all }"),
    );
    expect(task.sessions).toMatchObject({
      "audit:1": key("task-f1", "audit:1"),
      "audit:2": key("task-f1", "audit:2"),
      "audit:3": key("task-f1", "audit:3"),
    } as never);
    expect(runtime.patches.find((p) => p.sessionKey === key("task-f1", "audit:2"))?.model).toBe(
      "provider-b/model-b",
    );
    expect(runtime.patches.find((p) => p.sessionKey === key("task-f1", "audit:3"))?.model).toBe(
      "provider-a/model-a",
    );
    // ARCH §3.2: the lead's own model is applied to the lead session.
    expect(runtime.patches.find((p) => p.sessionKey === key("task-f1", "taskmaster"))?.model).toBe(
      "provider-lead/model-lead",
    );
    expect(
      readEvents(engine.stateDir, "task-f1").some(
        (e) => e.event === "MODEL_APPLIED" && e.from === "taskmaster",
      ),
    ).toBe(true);
  });

  it("the lead gets one AUDIT_PASS only after every member passes on the same sha", async () => {
    const ctx = setup();
    const { runtime, engine, stateDir } = ctx;
    await start(ctx, FANOUT("task-f2", "{ count: 3, model: provider-a/model-a, join: all }"));
    await emit(ctx, "task-f2", "build", "BUILD_DONE", "sha1");
    // All three members get the review request.
    const reviews = runtime.runs.filter((r) => /:audit:\d$/.test(r.sessionKey));
    expect(reviews.map((r) => r.sessionKey).toSorted()).toEqual(
      ["audit:1", "audit:2", "audit:3"].map((m) => key("task-f2", m)).toSorted(),
    );
    // Two members pass: the lane is not settled; the lead hears waiting, not a pass.
    await emit(ctx, "task-f2", "audit:1", "AUDIT_PASS", "sha1");
    await emit(ctx, "task-f2", "audit:2", "AUDIT_PASS", "sha1");
    const tm = runtime.runs.filter((r) => r.sessionKey === key("task-f2", "taskmaster"));
    expect(tm.at(-1)?.message).toMatch(/LANE_WAITING/);
    expect(tm.some((r) => r.message.includes("EVENT AUDIT_PASS"))).toBe(false);
    // The third pass settles the lane: one event to the lead, nothing to test yet.
    await emit(ctx, "task-f2", "audit:3", "AUDIT_PASS", "sha1");
    const tmAfter = runtime.runs.filter((r) => r.sessionKey === key("task-f2", "taskmaster"));
    expect(tmAfter.at(-1)?.message).toMatch(/EVENT AUDIT_PASS @ sha1/);
    expect(tmAfter.at(-1)?.message).toMatch(/lane audit settled/);
    expect(runtime.runs.some((r) => r.sessionKey === key("task-f2", "test"))).toBe(false);
    expect(readEvents(stateDir, "task-f2").filter((e) => e.kind === "emit")).toHaveLength(4);
  });
});

describe("fan-out: join quorum (ARCH §4.4)", () => {
  it("4 passes of 5 settle the lane; the 5th is never awaited", async () => {
    const ctx = setup();
    const { runtime, engine } = ctx;
    await start(
      ctx,
      FANOUT("task-f3", '{ count: 5, model: provider-a/model-a, join: "quorum:4" }'),
    );
    await emit(ctx, "task-f3", "build", "BUILD_DONE", "sha9");
    for (const m of ["audit:1", "audit:2", "audit:3"]) {
      await emit(ctx, "task-f3", m, "AUDIT_PASS", "sha9");
    }
    const before = runtime.runs.filter((r) => r.sessionKey === key("task-f3", "taskmaster"));
    expect(before.at(-1)?.message).toMatch(/LANE_WAITING/);
    await emit(ctx, "task-f3", "audit:4", "AUDIT_PASS", "sha9");
    const tm = runtime.runs.filter((r) => r.sessionKey === key("task-f3", "taskmaster"));
    expect(tm.at(-1)?.message).toMatch(/EVENT AUDIT_PASS @ sha9/);
  });

  it("a dissent reaches the lead as one deduplicated finding list", async () => {
    const ctx = setup();
    const { runtime, engine } = ctx;
    await start(
      ctx,
      FANOUT("task-f4", '{ count: 3, model: provider-a/model-a, join: "quorum:2" }'),
    );
    await emit(ctx, "task-f4", "build", "BUILD_DONE", "shaD");
    // Two dissenters with one shared finding and one each: quorum of passes is unreachable.
    await emit(ctx, "task-f4", "audit:1", "AUDIT_FAIL", "shaD", "- missing null check\n- no docs");
    const res = await emit(
      ctx,
      "task-f4",
      "audit:2",
      "AUDIT_FAIL",
      "shaD",
      "- Missing null check.\n- flaky test",
    );
    expect(res.routedTo).toBe("taskmaster");
    const tm = runtime.runs.filter((r) => r.sessionKey === key("task-f4", "taskmaster"));
    const failMsg = tm.at(-1)?.message ?? "";
    expect(failMsg).toMatch(/EVENT AUDIT_FAIL @ shaD/);
    // "missing null check" appears once though both reported it (§4.4 dedup).
    expect(failMsg.toLowerCase().match(/missing null check/g)).toHaveLength(1);
    expect(failMsg).toMatch(/no docs/);
    expect(failMsg).toMatch(/flaky test/);
    expect(failMsg).toMatch(/audit:1/);
    expect(failMsg).toMatch(/audit:2/);
  });
});

describe("fan-out: join any (ARCH §4.4)", () => {
  it("the first pass settles the lane; the other members are told to stop", async () => {
    const ctx = setup();
    const { runtime, engine, stateDir } = ctx;
    await start(ctx, FANOUT("task-f5", "{ count: 3, model: provider-a/model-a, join: any }"));
    await emit(ctx, "task-f5", "build", "BUILD_DONE", "shaA");
    const res = await emit(ctx, "task-f5", "audit:2", "AUDIT_PASS", "shaA");
    expect(res.routedTo).toBe("taskmaster");
    const tm = runtime.runs.filter((r) => r.sessionKey === key("task-f5", "taskmaster"));
    expect(tm.at(-1)?.message).toMatch(/EVENT AUDIT_PASS @ shaA/);
    // The rest are told to stop (§4.4), and it is logged.
    const stops = runtime.runs.filter(
      (r) => /:audit:[13]$/.test(r.sessionKey) && r.message.includes("EVENT CANCELLED"),
    );
    expect(stops).toHaveLength(2);
    expect(readEvents(stateDir, "task-f5").some((e) => e.event === "LANE_CANCELLED")).toBe(true);
  });
});

describe("fan-out: partition (ARCH §4.2)", () => {
  const git = (repo: string, args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Lumina Nao",
        GIT_AUTHOR_EMAIL: "luminanao@duck.com",
        GIT_COMMITTER_NAME: "Lumina Nao",
        GIT_COMMITTER_EMAIL: "luminanao@duck.com",
      },
    })
      .toString()
      .trim();

  it("N builders get N worktrees/branches; the pass merges them into the holon branch", async () => {
    const repo = initScratchRepo();
    const ctx = setup();
    const { runtime, engine, stateDir } = ctx;
    const task = await start(
      ctx,
      `
id: task-f6
kind: build
input: split the work
done_when: merged head builds
lead: { kind: agent, model: provider-lead/model-lead }
lanes:
  build: { count: 3, model: provider-a/model-a, partition: true }
  audit: { count: 1, model: provider-a/model-a }
  test: { count: 1, model: provider-a/model-a }
upstream: { sessionKey: ${UPSTREAM} }
repo: ${repo}
`,
    );
    expect(task.sessions["build:1"]).toBe(key("task-f6", "build:1"));
    // Three worktrees and branches exist, one per member.
    for (const n of [1, 2, 3]) {
      expect(fs.existsSync(path.join(repo, "worktrees", `master-p${n}`))).toBe(true);
      expect(git(repo, ["rev-parse", "--verify", `master-p${n}`])).toMatch(/^[0-9a-f]{40}$/);
    }
    expect(fs.readFileSync(path.join(stateDir, "swarm", "task-f6", "plan.md"), "utf8")).toContain(
      "part 1 of 3",
    );
    // Each member commits on its own branch (scripted) and emits BUILD_DONE.
    for (const n of [1, 2, 3]) {
      const wt = path.join(repo, "worktrees", `master-p${n}`);
      fs.writeFileSync(path.join(wt, `part${n}.js`), `export const part${n} = ${n};\n`);
      git(wt, ["add", "-A"]);
      git(wt, ["commit", "-qm", `part ${n}`]);
      const sha = git(wt, ["rev-parse", "HEAD"]);
      const res = await emit(ctx, "task-f6", `build:${n}`, "BUILD_DONE", sha, `part ${n}`);
      expect(res.ok).toBe(true);
    }
    // The lane settled: the merge is on the holon branch and the lead got one BUILD_DONE.
    const head = git(repo, ["rev-parse", "HEAD"]);
    const mergeEvents = readEvents(engine.stateDir, "task-f6").filter((e) =>
      e.event.startsWith("LANE_"),
    );
    for (const n of [1, 2, 3]) {
      expect(
        fs.existsSync(path.join(repo, `part${n}.js`)),
        `part${n}.js missing; lane events: ${JSON.stringify(mergeEvents)}`,
      ).toBe(true);
    }
    const tm = runtime.runs.filter((r) => r.sessionKey === key("task-f6", "taskmaster"));
    expect(tm.at(-1)?.message).toContain(`EVENT BUILD_DONE @ ${head}`);
    expect(tm.at(-1)?.message).toMatch(/lane build settled/);
    expect(
      readEvents(stateDir, "task-f6").some((e) => e.event === "LANE_MERGED" && e.sha === head),
    ).toBe(true);
  });

  it("a merge conflict is told to the lead, never resolved by the swarm", async () => {
    const repo = initScratchRepo();
    const ctx = setup();
    const { runtime, engine } = ctx;
    await start(
      ctx,
      `
id: task-f7
kind: build
input: split the work
done_when: merged head builds
lanes:
  build: { count: 2, model: provider-a/model-a, partition: true }
  audit: { count: 1, model: provider-a/model-a }
  test: { count: 1, model: provider-a/model-a }
upstream: { sessionKey: ${UPSTREAM} }
repo: ${repo}
`,
    );
    // Both members edit the same line: the parts cannot merge cleanly.
    for (const n of [1, 2]) {
      const wt = path.join(repo, "worktrees", `master-p${n}`);
      fs.writeFileSync(path.join(wt, "index.js"), `export const hello = (n) => \`hi ${n}\`;\n`);
      git(wt, ["add", "-A"]);
      git(wt, ["commit", "-qm", `edit ${n}`]);
      await emit(ctx, "task-f7", `build:${n}`, "BUILD_DONE", git(wt, ["rev-parse", "HEAD"]));
    }
    const tm = runtime.runs.filter((r) => r.sessionKey === key("task-f7", "taskmaster"));
    expect(tm.at(-1)?.message).toMatch(/LANE_MERGE_CONFLICT/);
    expect(tm.at(-1)?.message).toMatch(/master-p2/);
  });
});

describe("fan-out: exit enforcement covers every member and the lead (ARCH §6.3)", () => {
  it("a member that ends without emitting is reported like any worker", async () => {
    const ctx = setup({ hooks: true });
    const { runtime, engine, stateDir } = ctx;
    await start(ctx, FANOUT("task-f8", "{ count: 2, model: provider-a/model-a, join: all }"));
    await emit(ctx, "task-f8", "build", "BUILD_DONE", "shaX");
    // audit:2 reports; audit:1's run then settles with no emit: the lead is told which
    // member went silent.
    await emit(ctx, "task-f8", "audit:2", "AUDIT_PASS", "shaX");
    await runtime.end(key("task-f8", "audit:1"));
    expect(
      readEvents(stateDir, "task-f8").some(
        (e) => e.event === "WORKER_EXIT_WITHOUT_EMIT" && e.from === "audit:1",
      ),
    ).toBe(true);
    const tm = runtime.runs.filter((r) => r.sessionKey === key("task-f8", "taskmaster"));
    expect(tm.some((r) => r.message.match(/audit:1 ended without exit/))).toBe(true);
  });
});

describe("fan-out: full flow reaches DONE (ARCH §12.1 shape)", () => {
  it("3 partitioned builders, 5 auditors quorum:4 on 2 models, 1 tester, dedup findings", async () => {
    const repo = initScratchRepo();
    const ctx = setup();
    const { runtime, engine, stateDir } = ctx;
    await start(
      ctx,
      `
id: task-f9
kind: build
input: the dev task
done_when: the head is green
lead: { kind: agent, model: provider-lead/model-lead }
lanes:
  build: { count: 3, model: provider-a/model-a, partition: true }
  audit: { count: 5, model: [provider-a/model-a, provider-b/model-b], join: "quorum:4" }
  test: { count: 1, model: provider-a/model-a }
upstream: { sessionKey: ${UPSTREAM} }
repo: ${repo}
`,
    );
    const git2 = (args: string[], cwd = repo) =>
      execFileSync("git", args, {
        cwd,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Lumina Nao",
          GIT_AUTHOR_EMAIL: "luminanao@duck.com",
          GIT_COMMITTER_NAME: "Lumina Nao",
          GIT_COMMITTER_EMAIL: "luminanao@duck.com",
        },
      })
        .toString()
        .trim();
    // Build lane: each member commits its part; the lane merges and the lead re-emits to audit.
    for (const n of [1, 2, 3]) {
      const wt = path.join(repo, "worktrees", `master-p${n}`);
      fs.writeFileSync(path.join(wt, `p${n}.js`), `export const p${n} = true;\n`);
      git2(["add", "-A"], wt);
      git2(["commit", "-qm", `p${n}`], wt);
      await emit(ctx, "task-f9", `build:${n}`, "BUILD_DONE", git2(["rev-parse", "HEAD"], wt));
    }
    const mergedSha = git2(["rev-parse", "HEAD"]);
    const tmRuns = () => runtime.runs.filter((r) => r.sessionKey === key("task-f9", "taskmaster"));
    expect(tmRuns().at(-1)?.message).toContain(`EVENT BUILD_DONE @ ${mergedSha}`);
    // The lead reviews the merged head and sends it to audit.
    await emit(ctx, "task-f9", "taskmaster", "BUILD_DONE", mergedSha, "merged; review it");
    // Five auditors on two models (the cycle is asserted in the join-all test above).
    const audits = runtime.runs.filter((r) => /:audit:\d$/.test(r.sessionKey));
    expect(audits).toHaveLength(5);
    // Four passes settle the quorum; the lane's one event goes to the lead.
    for (const m of ["audit:1", "audit:2", "audit:3", "audit:4"]) {
      await emit(ctx, "task-f9", m, "AUDIT_PASS", mergedSha);
    }
    expect(tmRuns().at(-1)?.message).toContain(`EVENT AUDIT_PASS @ ${mergedSha}`);
    await emit(ctx, "task-f9", "taskmaster", "AUDIT_PASS", mergedSha, "lane green; test it");
    await emit(ctx, "task-f9", "test", "TEST_PASS", mergedSha);
    await emit(ctx, "task-f9", "taskmaster", "DONE", mergedSha, "gate passed");
    expect(readTasksIndex(stateDir)["task-f9"]?.status).toBe("done");
    const upstream = runtime.runs.filter((r) => r.sessionKey === UPSTREAM);
    expect(upstream.at(-1)?.message).toContain(`EVENT DONE @ ${mergedSha}`);
  });
});

describe("fan-out: a settled lane stays settled (ARCH §4.4)", () => {
  it("a late verdict after join any is logged, never re-routed", async () => {
    const ctx = setup();
    const { runtime, engine, stateDir } = ctx;
    await start(ctx, FANOUT("task-f10", "{ count: 2, model: provider-a/model-a, join: any }"));
    await emit(ctx, "task-f10", "build", "BUILD_DONE", "shaL");
    await emit(ctx, "task-f10", "audit:1", "AUDIT_PASS", "shaL");
    const tmBefore = runtime.runs.filter(
      (r) => r.sessionKey === key("task-f10", "taskmaster"),
    ).length;
    // audit:2 answers late: logged, no second settle, no new message to the lead.
    const res = await emit(ctx, "task-f10", "audit:2", "AUDIT_PASS", "shaL");
    expect(res.routedTo).toBeNull();
    expect(String(res.notice)).toMatch(/already settled/);
    const tmAfter = runtime.runs.filter(
      (r) => r.sessionKey === key("task-f10", "taskmaster"),
    ).length;
    expect(tmAfter).toBe(tmBefore);
    expect(readEvents(stateDir, "task-f10").some((e) => e.event === "LANE_LATE_VERDICT")).toBe(
      true,
    );
    expect(readEvents(stateDir, "task-f10").filter((e) => e.event === "LANE_SETTLED")).toHaveLength(
      1,
    );
  });
});
