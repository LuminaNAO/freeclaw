import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterAll, describe, expect, it, vi } from "vitest";
import * as children from "./children.js";
import {
  assertCanonTightens,
  inheritCanon,
  listHolonTree,
  scopeWithin,
  spawnChild,
  summarize,
} from "./children.js";
import { registerSwarmCli } from "./cli.js";
import { SwarmContractError, taskDirFor } from "./contract.js";
import { createSwarmEmitTool } from "./emit.js";
import { SwarmEngine } from "./engine.js";
import { createSwarmHolonTool, createSwarmHolonToolFactory } from "./lead-tool.js";
import { createSwarmMethods } from "./methods.js";
import { resumeOpenTasks } from "./resume.js";
import { parseSwarmSessionKey, sessionKeyFor } from "./sessions.js";
import { readEvents, readTasksIndex } from "./store.js";
import { cancelTask, listTasks, startTask } from "./tasks.js";
import { makeStubRuntime } from "./test-runtime.js";

// Child holons (ARCH §5, §10a.1, §12.2): spawn with canon inheritance and refusal of any
// loosening, CHILD_* to the parent lead only, one-level escalation, the tree in `swarm list`,
// and resume over the tree (§7). Scripted sessions only; no channel, no gateway.

const tmp = fs.mkdtempSync(path.join(tmpdir(), "swarm-children-test-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const UPSTREAM = "agent:main:upstream-0000";
const ROOT = "root-site";
const key = (holon: string, role: string) => sessionKeyFor(holon, role);

function setup(stateDir = path.join(tmp, `s-${Math.random().toString(36).slice(2)}`)) {
  fs.mkdirSync(stateDir, { recursive: true });
  const runtime = makeStubRuntime();
  const engine = new SwarmEngine({ stateDir, runtime });
  return { stateDir, runtime, engine };
}
type Ctx = ReturnType<typeof setup>;

const ROOT_HOLON = `
id: ${ROOT}
goal: fix the test suite, split into three scopes
done_when: every child is done and the root branch is green
lead: { kind: agent, model: provider-lead/model-lead, thinking: high }
lanes:
  build: { count: 1, model: provider-a/model-a, thinking: "off" }
canon:
  scope: src
  never: [push, deploy]
  approve: []
  depth: 2
upstream: { sessionKey: ${UPSTREAM} }
`;

const child = (id: string, extra = "") => `
id: ${id}
goal: fix the tests in scope ${id}
done_when: the scope's tests pass
lanes:
  build: { count: 1, model: provider-a/model-a, thinking: "off" }
  audit: { count: 1, model: provider-b/model-b, thinking: "off" }
  test: { count: 1, model: provider-a/model-a, thinking: "off" }
${extra}`;

async function emitAs(
  ctx: Ctx,
  holon: string,
  role: string,
  event: string,
  body = "",
  sha = "c0ffee",
) {
  const tool = createSwarmEmitTool({ engine: ctx.engine, callerSessionKey: key(holon, role) });
  const res = (await tool.execute("c", { event, sha, body })).details as Record<string, unknown>;
  await ctx.runtime.endAll();
  return res;
}

async function startRoot(ctx: Ctx) {
  await startTask(ctx.engine, { contractYaml: ROOT_HOLON });
  await ctx.runtime.endAll();
}

/** Drive a child build/audit/test holon to DONE through its own lanes. */
async function finishChild(ctx: Ctx, holon: string, summary: string) {
  expect(await emitAs(ctx, holon, "build", "BUILD_DONE")).toMatchObject({ routedTo: "audit" });
  expect(await emitAs(ctx, holon, "audit", "AUDIT_PASS")).toMatchObject({ routedTo: "test" });
  expect(await emitAs(ctx, holon, "test", "TEST_PASS")).toMatchObject({ routedTo: "taskmaster" });
  return emitAs(ctx, holon, "taskmaster", "DONE", summary);
}

const leadRuns = (ctx: Ctx, holon: string) =>
  ctx.runtime.runs.filter((r) => r.sessionKey === key(holon, "taskmaster"));

describe("holon paths and sessions (ARCH §2, §5)", () => {
  it("a child lives in its parent's children/<id>/ folder and has its own session keys", () => {
    expect(taskDirFor("/state", "root-a/child-b/leaf-c")).toBe(
      path.join("/state", "swarm", "root-a", "children", "child-b", "children", "leaf-c"),
    );
    expect(key("root-a/child-b", "audit:2")).toBe("agent:main:swarm:root-a:child-b:audit:2");
    expect(parseSwarmSessionKey("agent:main:swarm:root-a:child-b:audit:2")).toEqual({
      agentId: "main",
      taskId: "root-a/child-b",
      role: "audit:2",
    });
    expect(parseSwarmSessionKey("agent:main:swarm:root-a:taskmaster")).toEqual({
      agentId: "main",
      taskId: "root-a",
      role: "taskmaster",
    });
    expect(() => taskDirFor("/state", "root-a/../x")).toThrow(SwarmContractError);
    // plan.md interface for the other partitions.
    expect(children.holonPathKey(["root-a", "child-b"])).toBe("root-a/child-b");
    expect(children.holonDirFor("/state", "root-a", ["child-b"])).toBe(
      taskDirFor("/state", "root-a/child-b"),
    );
    expect(children.holonDirFor("/state", "root-a", [])).toBe(taskDirFor("/state", "root-a"));
  });
});

describe("canon inheritance (ARCH §5.2)", () => {
  const parent = { scope: "src", never: ["push", "deploy"], approve: ["plan"], depth: 2 };

  it("a child with no canon inherits it, one level spent", () => {
    expect(inheritCanon(parent, undefined)).toEqual({
      scope: "src",
      never: ["push", "deploy"],
      approve: ["plan"],
      depth: 1,
    });
  });

  it("tightening is allowed: more never, narrower scope, fewer levels", () => {
    expect(
      inheritCanon(parent, { never: ["push", "deploy", "merge"], scope: "src/a src/b", depth: 0 }),
    ).toEqual({
      scope: "src/a src/b",
      never: ["push", "deploy", "merge"],
      approve: ["plan"],
      depth: 0,
    });
    expect(scopeWithin("src/a", "src")).toBe(true);
    expect(scopeWithin("srcx", "src")).toBe(false);
  });

  it("every loosening is refused with the exact key named", () => {
    expect(() => inheritCanon(parent, { never: ["deploy"] })).toThrow(
      /canon\.never: child drops "push"/,
    );
    expect(() => inheritCanon(parent, { approve: [] })).toThrow(
      /canon\.approve: child drops "plan"/,
    );
    expect(() => inheritCanon(parent, { scope: "docs" })).toThrow(/canon\.scope: .*outside/);
    expect(() => inheritCanon(parent, { depth: 5 })).toThrow(/canon\.depth: child asks for 5/);
    expect(() => inheritCanon({ ...parent, depth: 0 }, {})).toThrow(/canon\.depth: .*no more/);
    expect(() => inheritCanon(parent, { budget: 1 })).toThrow(/canon\.budget is not a canon key/);
    expect(() => assertCanonTightens(parent, { never: [], approve: ["plan"] })).toThrow(
      SwarmContractError,
    );
  });
});

describe("swarm spawn (ARCH §5.1, §10a.1)", () => {
  it("a child spawn that drops never: [push] is refused; nothing is written or sent (§12.2)", async () => {
    const ctx = setup();
    await startRoot(ctx);
    const runsBefore = ctx.runtime.runs.length;
    await expect(
      spawnChild(ctx.engine, ROOT, child("lane-a", "canon: { never: [deploy] }")),
    ).rejects.toThrow(/canon\.never: child drops "push"/);
    expect(fs.existsSync(taskDirFor(ctx.stateDir, `${ROOT}/lane-a`))).toBe(false);
    expect(readTasksIndex(ctx.stateDir)[`${ROOT}/lane-a`]).toBeUndefined();
    expect(ctx.runtime.runs.length).toBe(runsBefore);
    // Through the lead's tool, the refusal comes back as the tool result.
    const tool = createSwarmHolonTool({
      engine: ctx.engine,
      callerSessionKey: key(ROOT, "taskmaster"),
    });
    const res = (
      await tool.execute("c", {
        action: "spawn",
        holon: child("lane-a", "canon: { never: [deploy] }"),
      })
    ).details;
    expect(res).toMatchObject({ ok: false });
    expect(String((res as { error: string }).error)).toMatch(/canon\.never: child drops "push"/);
  });

  it("spawn writes the child holon.yaml under the parent, with its effective canon, and starts it", async () => {
    const ctx = setup();
    await startRoot(ctx);
    const spawned = await spawnChild(ctx.engine, ROOT, child("lane-a"));
    await ctx.runtime.endAll();
    expect(spawned).toMatchObject({
      taskId: `${ROOT}/lane-a`,
      parent: ROOT,
      path: [ROOT, "lane-a"],
    });
    const file = path.join(taskDirFor(ctx.stateDir, `${ROOT}/lane-a`), "holon.yaml");
    const text = fs.readFileSync(file, "utf8");
    expect(text).toMatch(/never:\s*\n\s*- push\n\s*- deploy/);
    expect(text).not.toMatch(/upstream/);
    // The child's lead inherits the parent lead's model when the child names none (§3.4).
    expect(
      ctx.runtime.patches.find((p) => p.sessionKey === key(`${ROOT}/lane-a`, "taskmaster"))?.model,
    ).toBe("provider-lead/model-lead");
    // The child's build got its brief; its lead knows its parent and canon.
    expect(ctx.runtime.runs.some((r) => r.sessionKey === key(`${ROOT}/lane-a`, "build"))).toBe(
      true,
    );
    const brief = leadRuns(ctx, `${ROOT}/lane-a`)[0]?.extraSystemPrompt ?? "";
    expect(brief).toMatch(new RegExp(`child of ${ROOT}`));
    expect(brief).toMatch(/never: push, deploy/);
    // The parent's log records the spawn.
    expect(readEvents(ctx.stateDir, ROOT).find((e) => e.event === "CHILD_SPAWNED")).toMatchObject({
      to: `${ROOT}/lane-a`,
      data: { child: `${ROOT}/lane-a` },
    });
  });

  it("refuses an upstream key, a duplicate id, a parent repo escape and spawning past depth", async () => {
    const ctx = setup();
    await startRoot(ctx);
    await expect(
      spawnChild(ctx.engine, ROOT, child("lane-a", `upstream: { sessionKey: ${UPSTREAM} }`)),
    ).rejects.toThrow(/only the root has upstream/);
    await spawnChild(ctx.engine, ROOT, child("lane-a"));
    await expect(spawnChild(ctx.engine, ROOT, child("lane-a"))).rejects.toThrow(/already exists/);
    // depth 2 at the root: child gets 1, grandchild gets 0, a great-grandchild is refused.
    await spawnChild(ctx.engine, `${ROOT}/lane-a`, child("leaf-a"));
    await expect(spawnChild(ctx.engine, `${ROOT}/lane-a/leaf-a`, child("deeper"))).rejects.toThrow(
      /canon\.depth/,
    );
  });

  it("the CLI verb, the gateway method and the lead tool all call the same spawnChild (§10a)", async () => {
    const ctx = setup();
    await startRoot(ctx);
    const spy = vi.spyOn(children, "spawnChild");
    // Gateway method.
    let out: { ok: boolean; payload: unknown } | undefined;
    await createSwarmMethods(() => ctx.engine)["swarm.spawn"]!({
      params: { parent: ROOT, holon: child("lane-a") },
      respond: (ok: boolean, payload: unknown) => {
        out = { ok, payload };
      },
    } as never);
    expect(out).toMatchObject({ ok: true, payload: { taskId: `${ROOT}/lane-a` } });
    // Lead tool.
    const tool = createSwarmHolonTool({
      engine: ctx.engine,
      callerSessionKey: key(ROOT, "taskmaster"),
    });
    expect(
      (await tool.execute("c", { action: "spawn", holon: child("lane-b") })).details,
    ).toMatchObject({
      ok: true,
      child: `${ROOT}/lane-b`,
    });
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
    // CLI: a thin client over swarm.spawn with --json.
    const lines: string[] = [];
    const call = vi.fn(async () => ({ taskId: `${ROOT}/lane-c`, sha: "init", sessions: {} }));
    const program = new Command().exitOverride();
    registerSwarmCli({ program, log: (l) => lines.push(l), call, cwd: () => "/caller" });
    await program.parseAsync([
      "node",
      "openclaw",
      "swarm",
      "spawn",
      ROOT,
      "--file",
      "c.yaml",
      "--json",
    ]);
    expect(call).toHaveBeenCalledWith("swarm.spawn", expect.anything(), {
      parent: ROOT,
      file: "/caller/c.yaml",
    });
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ taskId: `${ROOT}/lane-c` });
    await ctx.runtime.endAll();
  });

  it("only a lead sees swarm_holon", () => {
    const ctx = setup();
    const factory = createSwarmHolonToolFactory(() => ctx.engine);
    expect(factory({ sessionKey: key(ROOT, "taskmaster") })).not.toBeNull();
    expect(factory({ sessionKey: key(ROOT, "build") })).toBeNull();
    expect(factory({ sessionKey: "agent:main:main" })).toBeNull();
  });
});

describe("three children finish and the root integrates (ARCH §5.3, §12.2)", () => {
  it("each child reports CHILD_DONE to the root lead only; the root reports DONE upstream", async () => {
    const ctx = setup();
    await startRoot(ctx);
    const ids = ["lane-a", "lane-b", "lane-c"];
    for (const id of ids) {
      await spawnChild(ctx.engine, ROOT, child(id));
    }
    await ctx.runtime.endAll();
    // The root cannot report DONE while a child is open.
    const early = await emitAs(ctx, ROOT, "taskmaster", "DONE", "too soon");
    expect(early).toMatchObject({ ok: false });
    expect(String(early.error)).toMatch(/still open/);

    for (const [i, id] of ids.entries()) {
      const res = await finishChild(
        ctx,
        `${ROOT}/${id}`,
        `scope ${id} green\n${i + 1} files fixed`,
      );
      expect(res).toMatchObject({ ok: true, routedTo: "upstream" });
      expect(readTasksIndex(ctx.stateDir)[`${ROOT}/${id}`]?.status).toBe("done");
    }
    // Nothing from a child ever reached upstream directly.
    expect(ctx.runtime.runs.filter((r) => r.sessionKey === UPSTREAM)).toHaveLength(0);
    // The root lead got exactly one CHILD_DONE per child, with the summary and a tally.
    const reports = leadRuns(ctx, ROOT).filter((r) => /EVENT CHILD_DONE/.test(r.message));
    expect(reports).toHaveLength(3);
    expect(reports[0]?.message).toMatch(new RegExp(`FROM ${ROOT}/lane-a \\| TO taskmaster`));
    expect(reports[0]?.message).toMatch(/scope lane-a green\n1 files fixed/);
    expect(reports[2]?.message).toMatch(/children: 3 of 3 done, 0 open/);

    // The root integrates and reports DONE upstream; the tree is done.
    expect(await emitAs(ctx, ROOT, "taskmaster", "DONE", "integrated")).toMatchObject({
      ok: true,
      routedTo: "upstream",
    });
    expect(ctx.runtime.runs.filter((r) => r.sessionKey === UPSTREAM)).toHaveLength(1);
    expect(listTasks(ctx.stateDir).map((t) => [t.id, t.status, t.state])).toEqual([
      [ROOT, "done", "done"],
      [`${ROOT}/lane-a`, "done", "done"],
      [`${ROOT}/lane-b`, "done", "done"],
      [`${ROOT}/lane-c`, "done", "done"],
    ]);
  });

  it("a summary is 1-5 lines, never empty", () => {
    expect(summarize("", "fallback")).toBe("fallback");
    expect(summarize("a\n\nb", "x")).toBe("a\nb");
    expect(summarize("1\n2\n3\n4\n5\n6\n7", "x").split("\n")).toHaveLength(5);
  });
});

describe("escalation climbs one level at a time (ARCH §5.4)", () => {
  it("grandchild BLOCKED → child lead; child BLOCKED → root lead; root BLOCKED → upstream", async () => {
    const ctx = setup();
    await startRoot(ctx);
    await spawnChild(ctx.engine, ROOT, child("lane-a"));
    await spawnChild(ctx.engine, `${ROOT}/lane-a`, child("leaf-a"));
    await ctx.runtime.endAll();
    const leaf = `${ROOT}/lane-a/leaf-a`;
    const mid = `${ROOT}/lane-a`;

    // A worker's BLOCKED goes to its own lead (v1 route, kept).
    expect(await emitAs(ctx, leaf, "build", "BLOCKED", "cannot reach the fixture")).toMatchObject({
      routedTo: "taskmaster",
    });
    // The leaf lead cannot resolve it: one level up, to the child's lead, not the root.
    await emitAs(ctx, leaf, "taskmaster", "BLOCKED", "fixture missing; needs a decision");
    expect(leadRuns(ctx, mid).filter((r) => /EVENT CHILD_BLOCKED/.test(r.message))).toHaveLength(1);
    expect(leadRuns(ctx, ROOT).filter((r) => /CHILD_BLOCKED/.test(r.message))).toHaveLength(0);
    expect(ctx.runtime.runs.filter((r) => r.sessionKey === UPSTREAM)).toHaveLength(0);
    // A blocked child stays open: its parent decides.
    expect(readTasksIndex(ctx.stateDir)[leaf]?.status).toBe("open");

    // The child lead is stuck too: one more level, to the root lead.
    await emitAs(ctx, mid, "taskmaster", "BLOCKED", "leaf-a blocked: fixture missing");
    const rootBlocked = leadRuns(ctx, ROOT).filter((r) => /EVENT CHILD_BLOCKED/.test(r.message));
    expect(rootBlocked).toHaveLength(1);
    expect(rootBlocked[0]?.message).toMatch(new RegExp(`FROM ${mid} `));
    expect(ctx.runtime.runs.filter((r) => r.sessionKey === UPSTREAM)).toHaveLength(0);

    // The root escalates to upstream.
    await emitAs(ctx, ROOT, "taskmaster", "BLOCKED", "someone must restore the fixture");
    expect(ctx.runtime.runs.filter((r) => r.sessionKey === UPSTREAM)).toHaveLength(1);
  });

  it("the parent lead answers its own child only; a child FAILED reaches it as CHILD_FAILED", async () => {
    const ctx = setup();
    await startRoot(ctx);
    await spawnChild(ctx.engine, ROOT, child("lane-a"));
    await ctx.runtime.endAll();
    const tool = createSwarmHolonTool({
      engine: ctx.engine,
      callerSessionKey: key(ROOT, "taskmaster"),
    });
    expect(
      (await tool.execute("c", { action: "answer", child: "lane-a", message: "use option B" }))
        .details,
    ).toMatchObject({ ok: true, child: `${ROOT}/lane-a` });
    await ctx.runtime.endAll();
    expect(leadRuns(ctx, `${ROOT}/lane-a`).at(-1)?.message).toMatch(
      /EVENT PARENT[\s\S]*use option B/,
    );
    expect(
      (await tool.execute("c", { action: "answer", child: "other/lane-a", message: "x" })).details,
    ).toMatchObject({ ok: false });

    await emitAs(ctx, `${ROOT}/lane-a`, "taskmaster", "FAILED", "cannot be done in scope");
    expect(leadRuns(ctx, ROOT).filter((r) => /EVENT CHILD_FAILED/.test(r.message))).toHaveLength(1);
    expect(readTasksIndex(ctx.stateDir)[`${ROOT}/lane-a`]?.status).toBe("failed");
  });
});

describe("cancel takes the subtree (ARCH §9)", () => {
  it("cancelling the root stops every open child; children do not report back to it", async () => {
    const ctx = setup();
    await startRoot(ctx);
    await spawnChild(ctx.engine, ROOT, child("lane-a"));
    await spawnChild(ctx.engine, `${ROOT}/lane-a`, child("leaf-a"));
    await spawnChild(ctx.engine, ROOT, child("lane-b"));
    await ctx.runtime.endAll();
    const res = await cancelTask(ctx.engine, ROOT, "stop");
    expect(res).toMatchObject({ status: "cancelled", changed: true });
    expect(res.children?.toSorted()).toEqual(
      [`${ROOT}/lane-a`, `${ROOT}/lane-a/leaf-a`, `${ROOT}/lane-b`].toSorted(),
    );
    const index = readTasksIndex(ctx.stateDir);
    expect(Object.values(index).every((e) => e.status === "cancelled")).toBe(true);
    expect(readEvents(ctx.stateDir, ROOT).some((e) => e.event === "CHILD_CANCELLED")).toBe(false);
  });

  it("a child cancelled on its own reports CHILD_CANCELLED to its parent lead", async () => {
    const ctx = setup();
    await startRoot(ctx);
    await spawnChild(ctx.engine, ROOT, child("lane-a"));
    await ctx.runtime.endAll();
    await cancelTask(ctx.engine, `${ROOT}/lane-a`, "not needed");
    await ctx.runtime.endAll();
    expect(leadRuns(ctx, ROOT).filter((r) => /EVENT CHILD_CANCELLED/.test(r.message))).toHaveLength(
      1,
    );
    expect(readTasksIndex(ctx.stateDir)[ROOT]?.status).toBe("open");
  });
});

describe("swarm list shows the tree (ARCH §9)", () => {
  it("depth-first, one line per holon: path, state, lead, age", async () => {
    const ctx = setup();
    await startRoot(ctx);
    await spawnChild(ctx.engine, ROOT, child("lane-b"));
    await spawnChild(
      ctx.engine,
      ROOT,
      child("lane-a", "lead: { kind: agent, model: provider-c/model-c }"),
    );
    await spawnChild(ctx.engine, `${ROOT}/lane-a`, child("leaf-a"));
    await ctx.runtime.endAll();
    const rows = listTasks(ctx.stateDir);
    expect(rows.map((r) => [r.id, r.depth])).toEqual([
      [ROOT, 0],
      [`${ROOT}/lane-a`, 1],
      [`${ROOT}/lane-a/leaf-a`, 2],
      [`${ROOT}/lane-b`, 1],
    ]);
    expect(rows[0]).toMatchObject({
      state: "running",
      lead: "agent provider-lead/model-lead thinking=high",
    });
    expect(rows[1]?.lead).toBe("agent provider-c/model-c");
    // The leaf inherits its parent's lead (provider-c), not the root's.
    expect(rows[2]?.lead).toBe("agent provider-c/model-c");
    expect(listHolonTree(ctx.stateDir, `${ROOT}/lane-a`).map((r) => r.key)).toEqual([
      `${ROOT}/lane-a`,
      `${ROOT}/lane-a/leaf-a`,
    ]);

    const lines: string[] = [];
    const program = new Command().exitOverride();
    registerSwarmCli({ program, log: (l) => lines.push(l), call: async () => ({ tasks: rows }) });
    await program.parseAsync(["node", "openclaw", "swarm", "list"]);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(new RegExp(`^${ROOT}\\s+running\\s+r1`));
    expect(lines[1]).toMatch(/^└ lane-a\s+running/);
    expect(lines[2]).toMatch(/^ {2}└ leaf-a\s+running/);
    expect(lines[0]).toMatch(/lead=agent provider-lead\/model-lead/);
  });
});

describe("resume walks the tree (ARCH §7, §12.5)", () => {
  it("after two gateway kills in a row every open holon resumes and finishes", async () => {
    const stateDir = path.join(tmp, "two-kills");
    const first = setup(stateDir);
    await startRoot(first);
    for (const id of ["lane-a", "lane-b", "lane-c"]) {
      await spawnChild(first.engine, ROOT, child(id));
    }
    await first.runtime.endAll();
    // lane-a finishes before the first kill; lane-b is mid-flight (build emitted).
    await finishChild(first, `${ROOT}/lane-a`, "a done");
    await emitAs(first, `${ROOT}/lane-b`, "build", "BUILD_DONE");

    // Kill 1: a fresh engine on the same files, with runs left hanging.
    const second = setup(stateDir);
    const s1 = await resumeOpenTasks(second.engine);
    // Root + lane-b + lane-c are open; lane-a is done and not resumed.
    expect(s1.tasks).toBe(3);
    // Kill 2 before anything settles: resume again from the files.
    const third = setup(stateDir);
    const s2 = await resumeOpenTasks(third.engine);
    expect(s2.tasks).toBe(3);
    await third.runtime.endAll();
    // Every holon was re-delivered its input in its own sessions.
    const redelivered = readEvents(stateDir, `${ROOT}/lane-b`).filter(
      (e) => e.event === "REDELIVERED",
    );
    expect(redelivered.length).toBeGreaterThan(0);

    // The tree finishes on the third gateway.
    await emitAs(third, `${ROOT}/lane-b`, "audit", "AUDIT_PASS");
    await emitAs(third, `${ROOT}/lane-b`, "test", "TEST_PASS");
    await emitAs(third, `${ROOT}/lane-b`, "taskmaster", "DONE", "b done");
    await finishChild(third, `${ROOT}/lane-c`, "c done");
    expect(await emitAs(third, ROOT, "taskmaster", "DONE", "integrated")).toMatchObject({
      ok: true,
    });
    const index = readTasksIndex(stateDir);
    expect(
      Object.entries(index)
        .map(([k, v]) => [k, v.status])
        .toSorted(),
    ).toEqual(
      [ROOT, `${ROOT}/lane-a`, `${ROOT}/lane-b`, `${ROOT}/lane-c`]
        .map((k) => [k, "done"])
        .toSorted(),
    );
    // Exactly one CHILD_DONE per child on the root, across all three gateways.
    const reports = readEvents(stateDir, ROOT).filter(
      (e) => e.kind === "system" && e.event === "CHILD_DONE",
    );
    expect(reports.map((e) => e.data?.child).toSorted()).toEqual([
      `${ROOT}/lane-a`,
      `${ROOT}/lane-b`,
      `${ROOT}/lane-c`,
    ]);
  });

  it("a child report recorded before a crash reaches the parent exactly once on resume", async () => {
    const stateDir = path.join(tmp, "lost-report");
    const ctx = setup(stateDir);
    await startRoot(ctx);
    await spawnChild(ctx.engine, ROOT, child("lane-a"));
    await ctx.runtime.endAll();
    // Crash between the child's record and the parent's: write the child side only.
    ctx.engine.record(`${ROOT}/lane-a`, {
      kind: "upstream",
      event: "BLOCKED",
      from: "taskmaster",
      to: "parent",
      sha: "c0ffee",
      body: "needs a decision",
    });
    const next = setup(stateDir);
    expect((await resumeOpenTasks(next.engine)).childReports).toBe(1);
    expect((await resumeOpenTasks(setup(stateDir).engine)).childReports).toBe(0);
    expect(readEvents(stateDir, ROOT).filter((e) => e.event === "CHILD_BLOCKED")).toHaveLength(1);
  });

  it("a broken branch never blocks its siblings", async () => {
    const stateDir = path.join(tmp, "broken-branch");
    const ctx = setup(stateDir);
    await startRoot(ctx);
    await spawnChild(ctx.engine, ROOT, child("lane-a"));
    await spawnChild(ctx.engine, ROOT, child("lane-b"));
    await ctx.runtime.endAll();
    fs.writeFileSync(
      path.join(taskDirFor(stateDir, `${ROOT}/lane-a`), "holon.yaml"),
      "id: [broken",
    );
    const next = setup(stateDir);
    const warn = vi.fn();
    (next.engine as { logger?: unknown }).logger = { info() {}, warn };
    const summary = await resumeOpenTasks(next.engine);
    expect(summary.tasks).toBe(2);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/lane-a/));
    expect(readEvents(stateDir, `${ROOT}/lane-b`).some((e) => e.event === "RESUMED")).toBe(true);
  });
});
