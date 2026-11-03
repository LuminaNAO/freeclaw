import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { spawnChild } from "./children.js";
import { formatTree, registerSwarmCli } from "./cli.js";
import { SwarmEngine } from "./engine.js";
import { createSwarmHooks } from "./hooks.js";
import { createSwarmHolonTool, leadToolOps, SWARM_HOLON_TOOL } from "./lead-tool.js";
import { createSwarmMethods } from "./methods.js";
import { isGatewayUnreachable, readOffline } from "./offline.js";
import {
  addWork,
  overrideLead,
  parseAddFile,
  parseHolonRef,
  parseLeadSpec,
  showHolon,
  SWARM_OPS,
} from "./ops.js";
import { readEvents, readOutbox } from "./store.js";
import { startTask } from "./tasks.js";
import { makeStubRuntime } from "./test-runtime.js";

// ARCH §6.4, §9, §10a.2, §12.3: swarm add (stacking), swarm lead (root owner override),
// swarm show --tree, and the §10a parity gate (every op: a CLI verb with --json, and the CLI,
// the gateway method and the lead tool all reach the same op function).

const tmp = fs.mkdtempSync(path.join(tmpdir(), "swarm-ops-test-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

const UPSTREAM = "agent:main:upstream-0000";
const key = (task: string, role: string) => `agent:main:swarm:${task}:${role}`;

const HOLON = (id: string) => `id: ${id}
kind: build
goal: add a function plus unit test
done_when: unit test passes
lead: { kind: agent, model: provider-lead/model-lead, thinking: high }
lanes:
  build: { count: 1, model: provider-a/model-a, thinking: "off" }
  audit: { count: 1, model: provider-b/model-b, thinking: high }
  test: { count: 1, model: provider-a/model-a, thinking: "off" }
upstream:
  sessionKey: ${UPSTREAM}
`;

const V1 = (id: string) => `id: ${id}
kind: build
input: x
done_when: y
workers:
  build: { model: provider-a/model-a }
  audit: {}
  test: {}
upstream:
  sessionKey: ${UPSTREAM}
`;

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

async function callMethod(
  handlers: ReturnType<typeof createSwarmMethods>,
  method: string,
  params: Record<string, unknown>,
) {
  let out: { ok: boolean; payload: unknown; error?: { code: string; message: string } } | undefined;
  await handlers[method]!({
    params,
    respond: (ok: boolean, payload: unknown, error?: { code: string; message: string }) => {
      out = { ok, payload, error };
    },
  } as never);
  return out!;
}

function runCli(argv: string[], reply: unknown) {
  const program = new Command().exitOverride();
  const lines: string[] = [];
  const errors: string[] = [];
  const call = vi.fn(async (_method: string, _opts: unknown, _params: unknown) => reply);
  registerSwarmCli({
    program,
    log: (l) => lines.push(l),
    error: (l) => errors.push(l),
    fail: () => undefined,
    call,
    cwd: () => tmp,
  });
  return program
    .parseAsync(["node", "openclaw", "swarm", ...argv])
    .then(() => ({ lines, errors, call, program }));
}

describe("swarm add: stacking (ARCH §6.4, §12.3)", () => {
  it("work added while the lead is mid-turn is queued, never interrupts, and is handled next turn", async () => {
    const { runtime, engine, stateDir } = setup();
    await startTask(engine, { contractYaml: HOLON("task-700") });
    // The lead's kickoff turn is still running (not settled): it is mid-turn.
    const lead = key("task-700", "taskmaster");
    expect(runtime.liveIn(lead)).toBe(1);
    const runsBefore = runtime.runs.length;

    const res = await addWork(engine, ["task-700"], "also add a README line");
    expect(res).toMatchObject({ holon: "task-700", urgent: false, delivery: "queued" });
    // Nothing interrupted, nothing new was started in the lead's session.
    expect(runtime.aborts).toEqual([]);
    expect(runtime.runs.length).toBe(runsBefore);
    const second = await addWork(engine, ["task-700"], "and a changelog entry");
    expect(second.delivery).toBe("queued");

    // The lead's turn ends: both adds arrive together as its next turn.
    await runtime.end(lead);
    const next = runtime.runs.at(-1)!;
    expect(next.sessionKey).toBe(lead);
    expect(next.message).toContain("also add a README line");
    expect(next.message).toContain("and a changelog entry");
    expect(runtime.maxLive.get(lead)).toBe(1);

    const added = readEvents(stateDir, "task-700").filter((e) => e.event === "WORK_ADDED");
    expect(added).toHaveLength(2);
    expect(added[0]).toMatchObject({ kind: "system", from: "operator", to: "taskmaster" });
    // Durable: the queued adds are in the outbox and acked by the merged delivery.
    const outbox = readOutbox(stateDir, "task-700").filter((o) =>
      o.seqs.some((s) => added.some((a) => a.seq === s)),
    );
    expect(outbox.length).toBeGreaterThanOrEqual(2);
    expect(outbox.every((o) => o.acked)).toBe(true);
  });

  it("an idle lead gets the work right away", async () => {
    const { runtime, engine } = setup();
    await startTask(engine, { contractYaml: HOLON("task-701") });
    await runtime.endAll();
    const res = await addWork(engine, ["task-701"], "one more thing");
    expect(res.delivery).toBe("delivered");
    expect(runtime.runs.at(-1)).toMatchObject({ sessionKey: key("task-701", "taskmaster") });
    expect(runtime.runs.at(-1)?.message).toContain("EVENT WORK_ADDED");
  });

  it("urgent: true steers: the lead's turn stops and the work comes first, nothing queued is lost", async () => {
    const { runtime, engine } = setup({ hooks: true });
    await startTask(engine, { contractYaml: HOLON("task-702") });
    const lead = key("task-702", "taskmaster");
    await addWork(engine, ["task-702"], "queued normal work");
    const res = await addWork(engine, ["task-702"], "rules changed: stop using the old API", {
      urgent: true,
    });
    expect(res.urgent).toBe(true);
    expect(runtime.aborts).toEqual([lead]);
    const steered = runtime.runs.at(-1)!;
    expect(steered.sessionKey).toBe(lead);
    const urgentAt = steered.message.indexOf("rules changed");
    const normalAt = steered.message.indexOf("queued normal work");
    expect(urgentAt).toBeGreaterThan(-1);
    expect(normalAt).toBeGreaterThan(urgentAt);
    await runtime.drain();
    expect(runtime.maxLive.get(lead)).toBe(1);
    // The aborted turn is a steer, not a silent end or an error.
    const names = readEvents(engine.stateDir, "task-702").map((e) => e.event);
    expect(names).not.toContain("RUN_ERROR");
  });

  it("refuses a closed holon and empty work", async () => {
    const { runtime, engine } = setup();
    await startTask(engine, { contractYaml: HOLON("task-703") });
    await runtime.endAll();
    await expect(addWork(engine, ["task-703"], "   ")).rejects.toThrow(/work text/);
    engine.close("task-703", "done");
    await expect(addWork(engine, ["task-703"], "more")).rejects.toThrow(/is done/);
    await expect(addWork(engine, ["task-none"], "more")).rejects.toThrow(/not found/);
  });

  it("parses an add file: plain text, optional front matter with urgent only", () => {
    expect(parseAddFile("do this\n")).toEqual({ work: "do this", urgent: false });
    expect(parseAddFile("---\nurgent: true\n---\nstop now\n")).toEqual({
      work: "stop now",
      urgent: true,
    });
    expect(() => parseAddFile("---\nlead: x\n---\nwork")).toThrow(/"lead" is not allowed/);
    expect(() => parseAddFile("---\nurgent: yes please\n---\nwork")).toThrow(/true or false/);
    expect(() => parseAddFile("---\nurgent: true\n---\n")).toThrow(/no work/);
  });

  it("the gateway method reads an absolute file and refuses a relative one", async () => {
    const { runtime, engine, stateDir } = setup();
    await startTask(engine, { contractYaml: HOLON("task-704") });
    await runtime.endAll();
    const file = path.join(stateDir, "more.md");
    fs.writeFileSync(file, "---\nurgent: false\n---\nwire the new flag\n");
    const handlers = createSwarmMethods(() => engine);
    const ok = await callMethod(handlers, "swarm.add", { holon: "task-704", file });
    expect(ok).toMatchObject({ ok: true, payload: { holon: "task-704", delivery: "delivered" } });
    expect(runtime.runs.at(-1)?.message).toContain("wire the new flag");
    const rel = await callMethod(handlers, "swarm.add", { holon: "task-704", file: "more.md" });
    expect(rel.error?.message).toMatch(/must be an absolute path/);
  });

  it("a lead's tool adds only to its own child holons", async () => {
    const { runtime, engine } = setup();
    await startTask(engine, { contractYaml: HOLON("task-705") });
    await runtime.endAll();
    const tool = createSwarmHolonTool({
      engine,
      callerSessionKey: key("task-705", "taskmaster"),
    });
    const res = (await tool.execute("c", { op: "add", holon: "task-705", text: "x" })).details;
    expect(res).toMatchObject({ ok: false });
    expect(String((res as { error: string }).error)).toMatch(/only to its own child holons/);
  });
});

describe("swarm lead: root owner override (ARCH §3.4, §9)", () => {
  it("the operator changes the lead: model applied first, file rewritten, logged, lead told", async () => {
    const { runtime, engine, stateDir } = setup();
    await startTask(engine, { contractYaml: HOLON("task-710") });
    await runtime.endAll();
    const res = await overrideLead(engine, ["task-710"], "agent:provider-c/model-c:low");
    expect(res.lead).toEqual({ kind: "agent", model: "provider-c/model-c", thinking: "low" });
    expect(res.previous).toMatchObject({ model: "provider-lead/model-lead", thinking: "high" });
    expect(runtime.subagent.patchSession).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionKey: key("task-710", "taskmaster"),
        model: "provider-c/model-c",
        thinkingLevel: "low",
      }),
    );
    const file = YAML.parse(
      fs.readFileSync(path.join(stateDir, "swarm", "task-710", "holon.yaml"), "utf8"),
    ) as { lead: unknown; lanes: Record<string, unknown> };
    expect(file.lead).toEqual({ kind: "agent", model: "provider-c/model-c", thinking: "low" });
    expect(Object.keys(file.lanes)).toEqual(["build", "audit", "test"]);
    expect(engine.loadState("task-710").holon.lead.model).toBe("provider-c/model-c");
    const events = readEvents(stateDir, "task-710");
    expect(events.find((e) => e.event === "LEAD_CHANGED")).toMatchObject({
      from: "operator",
      to: "taskmaster",
    });
    expect(events.findLast((e) => e.event === "MODEL_APPLIED")?.data).toMatchObject({
      resolved: "provider-c/model-c",
    });
    expect(runtime.runs.at(-1)?.sessionKey).toBe(key("task-710", "taskmaster"));
    expect(runtime.runs.at(-1)?.message).toContain("EVENT LEAD_CHANGED");
    // The model hook now checks the lead against the new model (ARCH §3.2).
    const hooks = createSwarmHooks(() => engine);
    await hooks.onLlmInput(
      {
        runId: "r-new",
        sessionId: "s",
        provider: "provider-c",
        model: "model-c",
        prompt: "x",
        historyMessages: [],
        imagesCount: 0,
      },
      { sessionKey: key("task-710", "taskmaster") },
    );
    expect(readEvents(stateDir, "task-710").some((e) => e.event === "MODEL_MISMATCH")).toBe(false);
  });

  it("anyone but the root owner is refused, naming who may; the root's upstream may", async () => {
    const { runtime, engine, stateDir } = setup();
    await startTask(engine, { contractYaml: HOLON("task-711") });
    await runtime.endAll();
    const before = fs.readFileSync(path.join(stateDir, "swarm", "task-711", "holon.yaml"), "utf8");
    const asLead = createSwarmHolonTool({
      engine,
      callerSessionKey: key("task-711", "taskmaster"),
    });
    const refused = (
      await asLead.execute("c", { op: "lead", holon: "task-711", spec: "agent:provider-c/model-c" })
    ).details as { ok: boolean; error: string };
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/only the root owner may change a lead/);
    expect(refused.error).toMatch(/swarm lead/);
    expect(fs.readFileSync(path.join(stateDir, "swarm", "task-711", "holon.yaml"), "utf8")).toBe(
      before,
    );
    expect(readEvents(stateDir, "task-711").some((e) => e.event === "LEAD_CHANGED")).toBe(false);

    const asOwner = await overrideLead(engine, ["task-711"], "agent:provider-c/model-c", {
      caller: { kind: "session", sessionKey: UPSTREAM },
    });
    expect(asOwner.lead.model).toBe("provider-c/model-c");
  });

  it("a refused model changes nothing", async () => {
    const { runtime, engine, stateDir } = setup();
    await startTask(engine, { contractYaml: HOLON("task-712") });
    await runtime.endAll();
    runtime.subagent.patchSession.mockRejectedValueOnce(new Error("model not allowed"));
    await expect(overrideLead(engine, ["task-712"], "agent:provider-x/model-x")).rejects.toThrow(
      /model not allowed/,
    );
    expect(engine.loadState("task-712").holon.lead.model).toBe("provider-lead/model-lead");
    expect(readEvents(stateDir, "task-712").some((e) => e.event === "LEAD_CHANGED")).toBe(false);
  });

  it("a v1 root gets a lead: it becomes a holon file with that lead (ARCH §11)", async () => {
    const { runtime, engine, stateDir } = setup();
    await startTask(engine, { contractYaml: V1("task-713") });
    await runtime.endAll();
    await overrideLead(engine, ["task-713"], "{ kind: agent, model: provider-c/model-c }");
    expect(fs.existsSync(path.join(stateDir, "swarm", "task-713", "holon.yaml"))).toBe(true);
    const state = engine.loadState("task-713");
    expect(state.holon.lead.model).toBe("provider-c/model-c");
    expect(Object.keys(state.contract.workers).toSorted()).toEqual(["audit", "build", "test"]);
  });

  it("parses lead specs exactly as the holon file does", () => {
    expect(parseLeadSpec("agent")).toEqual({ kind: "agent" });
    expect(parseLeadSpec("agent:p/m")).toEqual({ kind: "agent", model: "p/m" });
    expect(parseLeadSpec("{ kind: agent, thinking: high }")).toEqual({
      kind: "agent",
      thinking: "high",
    });
    expect(() => parseLeadSpec("robot:x")).toThrow(/is not agent/);
    expect(() => parseLeadSpec("")).toThrow(/empty/);
  });

  it("refuses a closed holon", async () => {
    const { runtime, engine } = setup();
    await startTask(engine, { contractYaml: HOLON("task-714") });
    await runtime.endAll();
    engine.close("task-714", "cancelled");
    await expect(overrideLead(engine, ["task-714"], "agent:p/m")).rejects.toThrow(/cancelled/);
  });
});

describe("swarm show --tree (ARCH §8.2, §9)", () => {
  it("shows the lead, and with tree one line per holon with state, lead, age and summary", async () => {
    const { runtime, engine } = setup();
    await startTask(engine, { contractYaml: HOLON("task-720") });
    await runtime.endAll();
    const plain = showHolon(engine, ["task-720"]);
    expect(plain.lead).toBe("provider-lead/model-lead (high)");
    expect(plain.tree).toBeUndefined();
    const shown = showHolon(engine, ["task-720"], { tree: true });
    expect(shown.tree).toEqual([
      expect.objectContaining({ path: ["task-720"], state: "running", lead: shown.lead }),
    ]);
    const lines = formatTree(shown.tree);
    expect(lines[0]).toBe("tree");
    expect(lines[1]).toMatch(/task-720\s+running\s+provider-lead\/model-lead/);
  });

  it("the method keeps the old taskId shape and v1 tasks show the default lead", async () => {
    const { runtime, engine } = setup();
    await startTask(engine, { contractYaml: V1("task-721") });
    await runtime.endAll();
    const handlers = createSwarmMethods(() => engine);
    const res = await callMethod(handlers, "swarm.show", { taskId: "task-721", limit: 1 });
    expect(res.ok).toBe(true);
    expect((res.payload as { events: unknown[] }).events).toHaveLength(1);
    expect((res.payload as { lead: string }).lead).toBe("default");
  });

  it("a lead's tool reads its own holon only (ARCH §8.2)", async () => {
    const { runtime, engine } = setup();
    await startTask(engine, { contractYaml: HOLON("task-722") });
    await startTask(engine, { contractYaml: HOLON("task-723") });
    await runtime.endAll();
    const tool = createSwarmHolonTool({
      engine,
      callerSessionKey: key("task-722", "taskmaster"),
    });
    const own = (await tool.execute("c", { op: "showTree", holon: "task-722", tree: true }))
      .details as { ok: boolean; result: { id: string } };
    expect(own).toMatchObject({ ok: true, result: { id: "task-722" } });
    const other = (await tool.execute("c", { op: "showTree", holon: "task-723" })).details as {
      ok: boolean;
      error: string;
    };
    expect(other.ok).toBe(false);
    expect(other.error).toMatch(/not this session's holon/);
  });

  it("the CLI renders --tree and passes it through; --json prints the payload", async () => {
    const reply = {
      id: "task-1",
      status: "open",
      sha: "abc",
      lead: "p/m",
      tree: [{ path: ["task-1"], state: "running", lead: "p/m", ageMs: 0 }],
      models: {},
      events: [],
    };
    const text = await runCli(["show", "task-1", "--tree"], reply);
    expect(text.call).toHaveBeenCalledWith("swarm.show", expect.anything(), {
      taskId: "task-1",
      tree: true,
    });
    expect(text.lines[0]).toBe("task-1  open  @ abc  lead p/m");
    expect(text.lines).toContain("tree");
    const json = await runCli(["show", "task-1", "--tree", "--json"], reply);
    expect(JSON.parse(json.lines.join("\n"))).toEqual(reply);
  });

  it("holon references are root[/child…]", () => {
    expect(parseHolonRef("root-a/child-b")).toEqual(["root-a", "child-b"]);
    expect(() => parseHolonRef("")).toThrow(/holon reference/);
    expect(() => parseHolonRef("Root!")).toThrow(/invalid holon id/);
  });
});

describe("swarm_holon tool", () => {
  it("is offered to a lead only, and rejects unknown ops", async () => {
    const { engine } = setup();
    const member = createSwarmHolonTool({ engine, callerSessionKey: key("task-730", "build") });
    expect(
      (await member.execute("c", { op: "add", holon: "task-730", text: "x" })).details,
    ).toMatchObject({ ok: false, error: expect.stringMatching(/only for a holon's lead/) });
    const lead = createSwarmHolonTool({ engine, callerSessionKey: key("task-730", "taskmaster") });
    expect(lead.name).toBe(SWARM_HOLON_TOOL);
    expect((await lead.execute("c", { op: "nuke", holon: "task-730" })).details).toMatchObject({
      ok: false,
      error: expect.stringMatching(/unknown op/),
    });
  });
});

// ARCH §5 × §6.4, §9: the ops reach child holons through their §5 child folders.
describe("ops over child holons (ARCH §5, §6.4, §8.2, §9)", () => {
  const CHILD = (id: string) => `id: ${id}
goal: one scope of the root
done_when: the scope's tests pass
lanes:
  build: { count: 1, model: provider-a/model-a, thinking: "off" }
`;

  async function tree() {
    const ctx = setup();
    await startTask(ctx.engine, { contractYaml: HOLON("task-760") });
    await ctx.runtime.endAll();
    const lead = createSwarmHolonTool({
      engine: ctx.engine,
      callerSessionKey: key("task-760", "taskmaster"),
    });
    const spawned = (await lead.execute("c", { op: "spawn", holon: CHILD("lane-a") })).details;
    expect(spawned).toMatchObject({ ok: true, result: { taskId: "task-760/lane-a" } });
    await spawnChild(ctx.engine, ["task-760", "lane-a"], CHILD("leaf-a"));
    await ctx.runtime.endAll();
    return { ...ctx, lead };
  }
  const childLead = "agent:main:swarm:task-760:lane-a:taskmaster";

  it("swarm add reaches a child's lead; a lead adds to its own child, not to itself or a grandchild", async () => {
    const { runtime, engine, lead } = await tree();
    const handlers = createSwarmMethods(() => engine);
    const op = await callMethod(handlers, "swarm.add", { holon: "task-760/lane-a", text: "more" });
    expect(op).toMatchObject({ ok: true, payload: { holon: "task-760/lane-a" } });
    await runtime.endAll();
    expect(runtime.runs.filter((r) => r.sessionKey === childLead).at(-1)?.message).toMatch(
      /EVENT WORK_ADDED[\s\S]*more/,
    );
    const viaTool = (await lead.execute("c", { op: "add", holon: "task-760/lane-a", text: "x" }))
      .details;
    expect(viaTool).toMatchObject({ ok: true, result: { holon: "task-760/lane-a" } });
    // The child's lead adds to its own child (two levels below the root).
    const mid = createSwarmHolonTool({ engine, callerSessionKey: childLead });
    expect(
      (await mid.execute("c", { op: "add", holon: "task-760/lane-a/leaf-a", text: "y" })).details,
    ).toMatchObject({ ok: true, result: { holon: "task-760/lane-a/leaf-a" } });
    // The root lead may not skip a level.
    const skip = (
      await lead.execute("c", { op: "add", holon: "task-760/lane-a/leaf-a", text: "z" })
    ).details as { ok: boolean; error: string };
    expect(skip.ok).toBe(false);
    expect(skip.error).toMatch(/only to its own child holons/);
    expect(
      readEvents(engine.stateDir, "task-760/lane-a").filter((e) => e.event === "WORK_ADDED"),
    ).toHaveLength(2);
  });

  it("swarm lead changes a child's lead: root owner only, model applied to the child's lead session", async () => {
    const { runtime, engine, lead } = await tree();
    const handlers = createSwarmMethods(() => engine);
    const res = await callMethod(handlers, "swarm.lead", {
      holon: "task-760/lane-a",
      spec: "agent:provider-c/model-c:low",
    });
    expect(res).toMatchObject({ ok: true, payload: { holon: "task-760/lane-a" } });
    expect(runtime.patches.at(-1)).toMatchObject({
      sessionKey: childLead,
      model: "provider-c/model-c",
      thinkingLevel: "low",
    });
    expect(showHolon(engine, ["task-760", "lane-a"]).lead).toBe("provider-c/model-c (low)");
    // The root's upstream session is the root owner for every holon in the tree.
    const owner = await overrideLead(engine, ["task-760", "lane-a"], "agent", {
      caller: { kind: "session", sessionKey: UPSTREAM },
    });
    expect(owner.holon).toBe("task-760/lane-a");
    // A lead is not the root owner.
    const refused = (
      await lead.execute("c", { op: "lead", holon: "task-760/lane-a", spec: "agent" })
    ).details as { ok: boolean; error: string };
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/only the root owner/);
  });

  it("swarm show <root> --tree walks the tree; a child is shown by its path", async () => {
    const { engine, lead, stateDir } = await tree();
    await spawnChild(engine, "task-760", CHILD("lane-b"));
    const shown = showHolon(engine, ["task-760"], { tree: true });
    expect(shown.tree?.map((r) => r.path.join("/"))).toEqual([
      "task-760",
      "task-760/lane-a",
      "task-760/lane-a/leaf-a",
      "task-760/lane-b",
    ]);
    // A child without a lead inherits its parent lead's model (§3.4).
    expect(shown.tree?.[1]).toMatchObject({
      state: "running",
      lead: "provider-lead/model-lead (high)",
    });
    const sub = showHolon(engine, ["task-760", "lane-a"], { tree: true });
    expect(sub.id).toBe("task-760/lane-a");
    expect(sub.tree?.map((r) => r.path.join("/"))).toEqual([
      "task-760/lane-a",
      "task-760/lane-a/leaf-a",
    ]);
    // The lead reads its child (§8.2); the child's lead reads its parent.
    expect(
      (await lead.execute("c", { op: "showTree", holon: "task-760/lane-a" })).details,
    ).toMatchObject({ ok: true, result: { id: "task-760/lane-a" } });
    const mid = createSwarmHolonTool({ engine, callerSessionKey: childLead });
    expect((await mid.execute("c", { op: "showTree", holon: "task-760" })).details).toMatchObject({
      ok: true,
    });
    // Reads work with the gateway down, child paths included.
    const offline = (await readOffline(stateDir, "swarm.show", {
      taskId: "task-760",
      tree: true,
    })) as { tree: unknown[] };
    expect(offline.tree).toHaveLength(4);
    const lines = formatTree(shown.tree);
    expect(lines.some((l) => /leaf-a/.test(l))).toBe(true);
  });

  it("a lead spawns only under its own holon; the operator names any parent", async () => {
    const { engine, lead } = await tree();
    const other = (
      await lead.execute("c", {
        op: "spawn",
        parent: "task-999",
        holon: CHILD("lane-z"),
      })
    ).details as { ok: boolean; error: string };
    expect(other.ok).toBe(false);
    expect(other.error).toMatch(/only under its own holon/);
    const handlers = createSwarmMethods(() => engine);
    expect(
      await callMethod(handlers, "swarm.spawn", {
        parent: "task-760/lane-a",
        holon: CHILD("leaf-b"),
      }),
    ).toMatchObject({ ok: true, payload: { taskId: "task-760/lane-a/leaf-b" } });
  });
});

// ARCH §10a parity gate: table-driven over SWARM_OPS, so every op another partition adds is
// checked the moment it gets a row. The required rows are this build's ops.
describe("parity gate (ARCH §10a)", () => {
  // Every new op of steps 3-5 (§10a.4): add, lead, show --tree, spawn, relay-emit, group
  // open/close.
  const REQUIRED = ["add", "lead", "showTree", "spawn", "relay", "group"];
  /** Minimal params per op that reach the op function (it may then refuse; that is fine). */
  const SAMPLE: Record<string, Record<string, unknown>> = {
    add: { holon: "task-740", text: "x" },
    lead: { holon: "task-740", spec: "agent" },
    showTree: { holon: "task-740", tree: true },
    spawn: { parent: "task-740", holon: "id: child-a" },
    relay: { taskId: "task-740", who: "member-1", message: "yes" },
    group: { taskId: "task-740", action: "open" },
  };
  /** CLI argv per verb (positional args), so the verb can be run with --json. */
  const ARGV: Record<string, string[]> = {
    add: ["task-740", "work.md"],
    lead: ["task-740", "agent"],
    show: ["task-740"],
    spawn: ["task-740", "--file", "child.yaml"],
    relay: ["task-740", "yes", "--who", "member-1"],
    group: ["open", "task-740"],
  };
  /** The method params each verb sends (the CLI is a thin client over the table op). */
  const CLI_PARAMS: Record<string, Record<string, unknown>> = {
    spawn: { parent: "task-740", file: path.join(tmp, "child.yaml") },
    relay: { taskId: "task-740", who: "member-1", message: "yes" },
    group: { taskId: "task-740", action: "open" },
  };

  it("has every op of this build", () => {
    for (const name of REQUIRED) {
      expect(SWARM_OPS[name], name).toBeDefined();
    }
    // Lead tool: the holarchy ops; a member's reply and the group are the operator's/channel's.
    expect(leadToolOps()).toEqual(["add", "lead", "showTree", "spawn"]);
  });

  it("every op's method is served from the table, never a bespoke handler", async () => {
    const { engine } = setup();
    const handlers = createSwarmMethods(() => engine);
    for (const [name, op] of Object.entries(SWARM_OPS)) {
      const spy = vi.spyOn(op, "run").mockResolvedValue({ via: name });
      expect(await callMethod(handlers, op.method, SAMPLE[name] ?? {}), name).toMatchObject({
        ok: true,
        payload: { via: name },
      });
      expect(spy, name).toHaveBeenCalledTimes(1);
    }
  });

  it.each(Object.keys(SWARM_OPS))(
    "op %s has a CLI verb that accepts --json and calls its method",
    async (name) => {
      const op = SWARM_OPS[name]!;
      const { program } = await runCli(["list", "--json"], { tasks: [] });
      const swarm = program.commands.find((c) => c.name() === "swarm")!;
      const verb = swarm.commands.find((c) => c.name() === op.cliVerb);
      expect(verb, `swarm ${op.cliVerb}`).toBeDefined();
      expect(verb!.options.map((o) => o.long)).toContain("--json");
      // A verb another partition adds gets its argv row with its op row.
      const argv = ARGV[op.cliVerb] ?? [String(SAMPLE[name]?.holon ?? "task-740")];
      const out = await runCli([op.cliVerb, ...argv, "--json"], { ok: true });
      expect(out.errors).toEqual([]);
      expect(out.call.mock.calls[0]?.[0]).toBe(op.method);
      if (CLI_PARAMS[name]) {
        expect(out.call.mock.calls[0]?.[2]).toEqual(CLI_PARAMS[name]);
      }
      expect(JSON.parse(out.lines.join("\n"))).toEqual({ ok: true });
    },
  );

  it.each(Object.keys(SWARM_OPS))(
    "op %s: the gateway method and the lead tool reach the same op function",
    async (name) => {
      const op = SWARM_OPS[name]!;
      const { engine } = setup();
      const spy = vi.spyOn(op, "run").mockResolvedValue({ via: "op" });
      const handlers = createSwarmMethods(() => engine);
      const params = SAMPLE[name] ?? { holon: "task-740" };
      const viaMethod = await callMethod(handlers, op.method, params);
      expect(viaMethod).toMatchObject({ ok: true, payload: { via: "op" } });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]).toBe(engine);
      expect(spy.mock.calls[0]?.[2]).toEqual({ kind: "operator" });
      if (op.leadTool) {
        expect(leadToolOps()).toContain(name);
        const tool = createSwarmHolonTool({
          engine,
          callerSessionKey: key("task-740", "taskmaster"),
        });
        const viaTool = (await tool.execute("c", { op: name, ...params })).details;
        expect(viaTool).toEqual({ ok: true, result: { via: "op" } });
        expect(spy).toHaveBeenCalledTimes(2);
        expect(spy.mock.calls[1]?.[0]).toBe(engine);
        expect(spy.mock.calls[1]?.[2]).toMatchObject({
          kind: "session",
          taskId: "task-740",
          role: "taskmaster",
        });
      } else {
        expect(leadToolOps()).not.toContain(name);
      }
    },
  );
});

describe("reads with the gateway down (ARCH §9)", () => {
  it("list and show --tree read the files through the same handlers; writes do not fall back", async () => {
    const { runtime, engine, stateDir } = setup();
    await startTask(engine, { contractYaml: HOLON("task-750") });
    await runtime.endAll();
    const listed = (await readOffline(stateDir, "swarm.list", {})) as { tasks: { id: string }[] };
    expect(listed.tasks.map((t) => t.id)).toEqual(["task-750"]);
    const shown = (await readOffline(stateDir, "swarm.show", {
      taskId: "task-750",
      tree: true,
    })) as {
      lead: string;
      tree: unknown[];
    };
    expect(shown.lead).toBe("provider-lead/model-lead (high)");
    expect(shown.tree).toHaveLength(1);
    await expect(
      readOffline(stateDir, "swarm.add", { holon: "task-750", text: "x" }),
    ).rejects.toThrow(/needs the gateway/);
    await expect(readOffline(stateDir, "swarm.show", { taskId: "task-none" })).rejects.toThrow(
      /not found/,
    );
  });

  it("the CLI falls back to the files only for reads and only when the gateway is unreachable", async () => {
    const down = new Error("gateway closed (1006): connect ECONNREFUSED");
    expect(isGatewayUnreachable(down)).toBe(true);
    expect(isGatewayUnreachable(new Error("task not found"))).toBe(false);
    const run = async (argv: string[], err: Error) => {
      const program = new Command().exitOverride();
      const lines: string[] = [];
      const errors: string[] = [];
      const readLocal = vi.fn(async () => ({ tasks: [] }));
      registerSwarmCli({
        program,
        log: (l) => lines.push(l),
        error: (l) => errors.push(l),
        fail: () => undefined,
        call: async () => {
          throw err;
        },
        readLocal,
        cwd: () => tmp,
      });
      await program.parseAsync(["node", "openclaw", "swarm", ...argv]);
      return { lines, errors, readLocal };
    };
    const read = await run(["list"], down);
    expect(read.readLocal).toHaveBeenCalledWith("swarm.list", {});
    expect(read.lines).toEqual(["no swarm tasks"]);
    const write = await run(["lead", "task-1", "agent"], down);
    expect(write.readLocal).not.toHaveBeenCalled();
    expect(write.errors[0]).toMatch(/gateway closed/);
    const refused = await run(["list"], new Error("unauthorized"));
    expect(refused.readLocal).not.toHaveBeenCalled();
  });
});
