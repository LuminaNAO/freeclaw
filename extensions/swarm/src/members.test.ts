import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterAll, describe, expect, it, vi } from "vitest";
import { registerSwarmCli } from "./cli.js";
import { SwarmEngine } from "./engine.js";
import { FakeChannel } from "./fake-channel.js";
import { parseHolon } from "./holon.js";
import { createSwarmHooks } from "./hooks.js";
import { MemberChannels, groupNameFor, memberLine, MEMBER_LINE_MAX } from "./members.js";
import * as membersOps from "./members.js";
import { createSwarmMethods } from "./methods.js";
import { attachRelay, relayMemberReply } from "./relay.js";
import * as relayOps from "./relay.js";
import { resumeOpenTasks } from "./resume.js";
import { createSignalHolonChannel } from "./signal-channel.js";
import { readEvents, readTasksIndex } from "./store.js";
import { startTask } from "./tasks.js";
import { makeStubRuntime } from "./test-runtime.js";

// ARCH §3.3, §8, §10a.3, §10a.4, §12.6: members over a channel. Fake loopback channel only:
// no daemon, no real group, nobody is messaged. Ids are generic placeholders.

const tmp = fs.mkdtempSync(path.join(tmpdir(), "swarm-members-test-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const MEMBER = "member-lead-0001";
const REVIEWER = "member-reviewer-0002";
const OWNER = "root-owner-0003";
const STRANGER = "someone-else-0004";
const MODEL = "cb-sonnet/claude-sonnet-5-5";

const MEMBER_LEAD = (id: string, extra = "") => `id: ${id}
kind: build
goal: add a greeting
done_when: the unit test passes
lead: { kind: member, who: [${MEMBER}], channel: fake }
lanes:
  build: { model: ${MODEL}, thinking: "off" }
  audit: { model: ${MODEL}, thinking: "off" }
  test: { model: ${MODEL}, thinking: "off" }
canon:
  never: [push]
  relay: { model: ${MODEL}, thinking: "off" }
upstream:
  sessionKey: agent:main:up
  events: [DONE, BLOCKED, FAILED]
${extra}`;

const key = (task: string, role: string) => `agent:main:swarm:${task}:${role}`;

function setup(name: string, opts: { channel?: boolean } = {}) {
  const stateDir = path.join(tmp, name);
  fs.mkdirSync(stateDir, { recursive: true });
  const runtime = makeStubRuntime();
  const fake = new FakeChannel();
  const memberChannels = new MemberChannels({
    channels: opts.channel === false ? {} : { fake },
    owners: { fake: [OWNER] },
  });
  const engine = new SwarmEngine({ stateDir, runtime, memberChannels });
  const hooks = createSwarmHooks(() => engine);
  hooks.attach(engine);
  attachRelay(engine);
  fake.inbound = (msg) => relayMemberReply(engine, msg);
  const events = (task: string) => readEvents(stateDir, task);
  const settle = async () => {
    await runtime.drain();
    await engine.memberChannels.idle();
    await runtime.drain();
  };
  return { stateDir, runtime, fake, engine, hooks, events, settle };
}

describe("holon file: member lead and participants (ARCH §10a.3)", () => {
  it("parses a member lead and participants; v1 and agent leads are unchanged", () => {
    const holon = parseHolon(
      MEMBER_LEAD(
        "members-parse",
        `participants:\n  - { kind: member, who: ${REVIEWER}, channel: fake, role: review }\n`,
      ),
    );
    expect(holon.lead).toEqual({ kind: "member", who: [MEMBER], channel: "fake" });
    expect(holon.participants).toEqual([
      { kind: "member", who: [REVIEWER], channel: "fake", role: "review" },
    ]);
    expect(holon.canon.relay).toEqual({ model: MODEL, thinking: "off" });
    expect(holon.contract.workers.review).toEqual({ count: 1 });
    expect(holon.lanes.map((l) => l.role)).toEqual(["build", "audit", "test"]);
  });

  it("refuses a member lead without who or channel, a model on a member, and two channels", () => {
    const bad = (lead: string, extra = "") =>
      MEMBER_LEAD("members-bad", extra).replace(/lead: .*\n/, `lead: ${lead}\n`);
    expect(() => parseHolon(bad("{ kind: member, channel: fake }"))).toThrow(/lead\.who/);
    expect(() => parseHolon(bad(`{ kind: member, who: [${MEMBER}] }`))).toThrow(/lead\.channel/);
    expect(() =>
      parseHolon(bad(`{ kind: member, who: [${MEMBER}], channel: fake, model: ${MODEL} }`)),
    ).toThrow(/lead\.model is not a field of a member lead/);
    expect(() =>
      parseHolon(
        MEMBER_LEAD(
          "members-two",
          `participants:\n  - { kind: member, who: ${REVIEWER}, channel: other, role: review }\n`,
        ),
      ),
    ).toThrow(/one group on one channel/);
    expect(() =>
      parseHolon(
        MEMBER_LEAD(
          "members-clash",
          `participants:\n  - { kind: member, who: ${REVIEWER}, channel: fake, role: build }\n`,
        ),
      ),
    ).toThrow(/also a lane/);
    expect(() =>
      parseHolon(
        MEMBER_LEAD(
          "members-reserved",
          `participants:\n  - { kind: member, who: ${REVIEWER}, channel: fake, role: relay }\n`,
        ),
      ),
    ).toThrow(/not a usable role/);
  });
});

describe("one short plain line per event (ARCH §3.3)", () => {
  it("says what happened, what is needed and the sha, on one short line", () => {
    const line = memberLine({
      event: "PLAN",
      from: "build",
      to: "taskmaster",
      sha: "0123456789abcdef",
      body: `plan for approval\n${"split into three steps ".repeat(30)}`,
    });
    expect(line).not.toContain("\n");
    expect(line.length).toBeLessThanOrEqual(MEMBER_LINE_MAX);
    expect(line).toMatch(/^PLAN from build @ 0123456789: plan for approval: split into three/);
    expect(line).toMatch(/…\. Needed: approve, or say what to change\.$/);
    expect(line).not.toMatch(/TASK |MSG /);
  });
});

describe("member lead over the fake channel (ARCH §10a.4, §12.6)", () => {
  it("a member lead approves a plan in plain words; the relay emits APPROVED once and the holon proceeds", async () => {
    const { runtime, fake, engine, events, settle } = setup("approve");
    const T = "members-approve";
    await startTask(engine, { contractYaml: MEMBER_LEAD(T) });
    await settle();
    // No session for a member lead: build got its brief, the lead got one line in the group.
    expect(runtime.runs.map((r) => r.sessionKey)).toEqual([key(T, "build")]);
    const [group] = [...fake.groups.values()];
    expect(group?.name).toBe(groupNameFor(T, T));
    expect(group?.members.toSorted()).toEqual([MEMBER, OWNER].toSorted());
    expect(events(T).find((e) => e.event === "GROUP_OPENED")?.data).toMatchObject({
      channel: "fake",
      groupId: group?.groupId,
    });
    expect(group?.posts).toHaveLength(1);
    expect(group?.posts[0]).toMatch(/^TASK_STARTED from upstream/);

    // build asks the lead to approve its plan.
    const planned = await engine.emit(T, "build", {
      event: "PLAN",
      sha: "init",
      body: "three steps: parser, greet(), unit test",
    });
    expect(planned).toMatchObject({ ok: true, routedTo: "taskmaster" });
    await runtime.end(key(T, "build"));
    await settle();
    expect(group?.posts.at(-1)).toMatch(
      /^PLAN from build: plan for approval: three steps: parser.*Needed: approve/,
    );

    // The member answers in plain words; the reply goes to the relay session.
    const relayed = await fake.reply(group!.groupId, MEMBER, "looks good, go ahead");
    expect(relayed).toMatchObject({ ok: true, role: "taskmaster" });
    await settle();
    const relayRun = runtime.runs.at(-1)!;
    expect(relayRun.sessionKey).toBe(key(T, "relay"));
    expect(relayRun.message).toContain("Reply: looks good, go ahead");
    expect(relayRun.message).toContain("That line came from role build.");
    expect(relayRun.extraSystemPrompt).toMatch(/exactly one swarm event/);
    expect(runtime.patches.find((p) => p.sessionKey === key(T, "relay"))).toMatchObject({
      model: MODEL,
      thinkingLevel: "off",
    });

    // The relay emits APPROVED once (no role: it answers the line from build).
    const approved = await engine.emit(T, "relay", {
      event: "APPROVED",
      sha: "init",
      body: "Approved the plan; build goes on.",
    });
    expect(approved).toMatchObject({ ok: true, routedTo: "build" });
    // A second event for the same reply is refused: exactly one per reply.
    const again = await engine.emit(T, "relay", { event: "DONE", sha: "init", body: "done" });
    expect(again).toMatchObject({ ok: false });
    await runtime.end(key(T, "relay"));
    await settle();

    const log = events(T);
    const routed = log.filter((e) => e.kind === "emit" && e.event === "APPROVED");
    expect(routed).toHaveLength(1);
    expect(routed[0]).toMatchObject({ from: "taskmaster", to: "build" });
    expect(routed[0]?.body).toContain("looks good, go ahead");
    expect(group?.posts.at(-1)).toBe("Understood: Approved the plan; build goes on.");
    // The holon proceeds: build got the approval as its next input.
    const buildRun = runtime.runs.filter((r) => r.sessionKey === key(T, "build")).at(-1);
    expect(buildRun?.message).toMatch(/EVENT APPROVED[\s\S]*approved: go on/);
    expect(log.filter((e) => e.event === "RELAY_SILENT")).toHaveLength(0);
  });

  it("an unclear reply gets exactly one question; the next reply is turned into one event", async () => {
    const { runtime, fake, engine, events, settle } = setup("unclear");
    const T = "members-unclear";
    await startTask(engine, { contractYaml: MEMBER_LEAD(T) });
    await engine.emit(T, "build", { event: "PLAN", sha: "init", body: "two options: A or B" });
    await runtime.end(key(T, "build"));
    await settle();
    const group = [...fake.groups.values()][0]!;

    await fake.reply(group.groupId, MEMBER, "hmm");
    await settle();
    const asked = await engine.emit(T, "relay", {
      event: "ASK",
      sha: "init",
      body: "Do you approve the plan, or should build change it?",
    });
    expect(asked).toMatchObject({ ok: true });
    // The relay may ask only once.
    const twice = await engine.emit(T, "relay", { event: "ASK", sha: "init", body: "again?" });
    expect(twice).toMatchObject({ ok: false });
    await runtime.end(key(T, "relay"));
    await settle();
    expect(group.posts.filter((p) => p.startsWith("Question:"))).toEqual([
      "Question: Do you approve the plan, or should build change it?",
    ]);
    expect(events(T).filter((e) => e.event === "RELAY_ASKED")).toHaveLength(1);
    expect(events(T).some((e) => e.kind === "emit" && e.from === "taskmaster")).toBe(false);

    await fake.reply(group.groupId, MEMBER, "yes approve it");
    await settle();
    expect(runtime.runs.at(-1)?.message).toContain("You already asked once: do not ask again.");
    const third = await engine.emit(T, "relay", { event: "ASK", sha: "init", body: "sure?" });
    expect(third).toMatchObject({ ok: false });
    const ok = await engine.emit(T, "relay", {
      event: "APPROVED",
      sha: "init",
      body: "Approved.",
      role: "build",
    });
    expect(ok).toMatchObject({ ok: true, routedTo: "build" });
    expect(events(T).filter((e) => e.kind === "emit" && e.event === "APPROVED")).toHaveLength(1);
  });

  it("a stranger's message never reaches the relay; a member emits only through the relay", async () => {
    const { runtime, fake, engine, events, settle } = setup("stranger");
    const T = "members-stranger";
    await startTask(engine, { contractYaml: MEMBER_LEAD(T) });
    await settle();
    const group = [...fake.groups.values()][0]!;
    const runs = runtime.runs.length;
    expect(await fake.reply(group.groupId, STRANGER, "approve")).toMatchObject({ ok: false });
    expect(await fake.reply("fake-group-999", MEMBER, "approve")).toMatchObject({ ok: false });
    await settle();
    expect(runtime.runs).toHaveLength(runs);
    expect(events(T).filter((e) => e.event === "MEMBER_IGNORED")).toHaveLength(1);
    // Nothing can emit as the member lead but the relay; the relay needs a reply to answer.
    expect(await engine.emit(T, "relay", { event: "DONE", sha: "init", body: "x" })).toMatchObject({
      ok: false,
    });
  });

  it("a silent relay turn is re-prompted once, then BLOCKED with the member's words; never quiet", async () => {
    const { runtime, fake, engine, events, settle } = setup("silent");
    const T = "members-silent";
    await startTask(engine, { contractYaml: MEMBER_LEAD(T) });
    await settle();
    const group = [...fake.groups.values()][0]!;
    await fake.reply(group.groupId, MEMBER, "whatever you think");
    await settle();
    await runtime.end(key(T, "relay"));
    await settle();
    expect(runtime.runs.at(-1)).toMatchObject({ sessionKey: key(T, "relay") });
    expect(runtime.runs.at(-1)?.message).toMatch(/ended without swarm_emit/);
    await runtime.end(key(T, "relay"));
    await settle();
    // BLOCKED from a member lead goes up one level: to upstream (the root's parent).
    const up = runtime.runs.filter((r) => r.sessionKey === "agent:main:up");
    expect(up.at(-1)?.message).toMatch(/EVENT BLOCKED[\s\S]*whatever you think/);
    expect(events(T).filter((e) => e.event === "RELAY_SILENT")).toHaveLength(2);
  });

  it("the relay has no tools except swarm_emit", () => {
    const { hooks } = setup("tools");
    const relayKey = key("members-tools", "relay");
    expect(
      hooks.onBeforeToolCall(
        { toolName: "exec", params: {} },
        { sessionKey: relayKey, toolName: "exec" },
      ),
    ).toMatchObject({ block: true });
    expect(
      hooks.onBeforeToolCall(
        { toolName: "swarm_emit", params: {} },
        { sessionKey: relayKey, toolName: "swarm_emit" },
      ),
    ).toBeUndefined();
    expect(
      hooks.onBeforeToolCall(
        { toolName: "exec", params: {} },
        { sessionKey: key("members-tools", "build"), toolName: "exec" },
      ),
    ).toBeUndefined();
  });

  it("a channel message hook in the holon's group reaches the relay (inbound path)", async () => {
    const { runtime, fake, engine, hooks, settle } = setup("hook");
    const T = "members-hook";
    await startTask(engine, { contractYaml: MEMBER_LEAD(T) });
    await settle();
    const group = [...fake.groups.values()][0]!;
    await hooks.onMessageReceived(
      { from: `group:${group.groupId}`, content: "ok", metadata: { senderId: MEMBER } },
      { channelId: "fake", conversationId: `group:${group.groupId}` },
    );
    await settle();
    expect(runtime.runs.at(-1)?.sessionKey).toBe(key(T, "relay"));
    // A message in any other conversation is ignored.
    const before = runtime.runs.length;
    await hooks.onMessageReceived(
      { from: "x", content: "ok", metadata: { senderId: MEMBER } },
      { channelId: "fake", conversationId: "group:other" },
    );
    expect(runtime.runs).toHaveLength(before);
    // An ordinary agent reply into the holon's group is cancelled; other targets pass.
    expect(
      hooks.onMessageSending(
        { to: `group:${group.groupId}`, content: "hi" },
        { channelId: "fake" },
      ),
    ).toEqual({ cancel: true });
    expect(
      hooks.onMessageSending({ to: "group:other", content: "hi" }, { channelId: "fake" }),
    ).toBeUndefined();
  });
});

describe("group lifecycle (ARCH §8.1, §8.3)", () => {
  it("the group closes [done] when the member lead says done; the close is in the events", async () => {
    const { runtime, fake, engine, events, settle } = setup("done");
    const T = "members-done";
    await startTask(engine, { contractYaml: MEMBER_LEAD(T) });
    await engine.emit(T, "build", { event: "BUILD_DONE", sha: "abc", body: "built" });
    await engine.emit(T, "audit", { event: "AUDIT_PASS", sha: "abc", body: "fine" });
    await engine.emit(T, "test", { event: "TEST_PASS", sha: "abc", body: "green" });
    await runtime.settleAll();
    await settle();
    const group = [...fake.groups.values()][0]!;
    expect(group.posts.at(-1)).toMatch(/^TEST_PASS from test @ abc.*Needed: say done/);
    await fake.reply(group.groupId, MEMBER, "great, that's done");
    await settle();
    expect(
      await engine.emit(T, "relay", { event: "DONE", sha: "abc", body: "Marked done." }),
    ).toMatchObject({ ok: true, routedTo: "upstream" });
    await settle();
    expect(readTasksIndex(engine.stateDir)[T]?.status).toBe("done");
    expect(group.closed).toBe(true);
    expect(group.name).toBe(`${groupNameFor(T, T)} [done]`);
    // The confirmation reached the group before it closed.
    expect(group.posts.at(-1)).toBe("Understood: Marked done.");
    expect(events(T).find((e) => e.event === "GROUP_CLOSED")?.data).toMatchObject({
      groupId: group.groupId,
    });
  });

  it("agent-only holons get no group", async () => {
    const { fake, engine, settle } = setup("agents");
    await startTask(engine, {
      contractYaml: MEMBER_LEAD("agents-only").replace(/lead: .*\n/, "lead: { kind: agent }\n"),
    });
    await settle();
    expect(fake.groups.size).toBe(0);
  });

  it("no channel: everything still runs and the holon escalates BLOCKED: no channel one level up, once", async () => {
    const { runtime, engine, events, settle } = setup("nochan", { channel: false });
    const T = "members-nochan";
    await startTask(engine, { contractYaml: MEMBER_LEAD(T) });
    await settle();
    expect(runtime.runs.some((r) => r.sessionKey === key(T, "build"))).toBe(true);
    const up = runtime.runs.filter((r) => r.sessionKey === "agent:main:up");
    expect(up).toHaveLength(1);
    expect(up[0]?.message).toMatch(/EVENT BLOCKED[\s\S]*BLOCKED: no channel/);
    await engine.emit(T, "build", { event: "PLAN", sha: "init", body: "plan" });
    await settle();
    expect(runtime.runs.filter((r) => r.sessionKey === "agent:main:up")).toHaveLength(1);
    expect(events(T).filter((e) => e.event === "MEMBER_POST_FAILED")).toHaveLength(2);
  });

  it("a member participant under an agent lead: no channel → BLOCKED to that lead", async () => {
    const { runtime, engine, settle } = setup("nochan-part", { channel: false });
    const T = "members-part";
    const yaml = MEMBER_LEAD(
      T,
      `participants:\n  - { kind: member, who: ${REVIEWER}, channel: fake, role: review }\n`,
    ).replace(/lead: .*\n/, `lead: { kind: agent, model: ${MODEL} }\n`);
    await startTask(engine, { contractYaml: yaml });
    await settle();
    // Group opens on first need: nothing for the reviewer yet, so no escalation.
    expect(runtime.runs.filter((r) => r.message.includes("no channel"))).toHaveLength(0);
    await engine.emit(T, "taskmaster", {
      event: "RETRY",
      sha: "init",
      body: "please review",
      role: "review",
    });
    await runtime.settleAll();
    await settle();
    const lead = runtime.runs.filter((r) => r.sessionKey === key(T, "taskmaster"));
    expect(lead.some((r) => /EVENT BLOCKED[\s\S]*BLOCKED: no channel/.test(r.message))).toBe(true);
  });
});

describe("resume over the member side (ARCH §7, §10a.4)", () => {
  it("after two gateway kills, an unposted line is posted and an unanswered reply reaches the relay; the holon finishes", async () => {
    const first = setup("resume");
    const T = "members-resume";
    await startTask(first.engine, { contractYaml: MEMBER_LEAD(T) });
    await first.settle();
    const group = [...first.fake.groups.values()][0]!;
    // The channel drops the next post; the gateway dies before anything else happens.
    first.fake.failNext.post = 1;
    await first.engine.emit(T, "build", { event: "PLAN", sha: "init", body: "the plan" });
    expect(group.posts.some((p) => p.startsWith("PLAN"))).toBe(false);

    // Restart 1: a fresh engine on the same state dir and the same (still existing) group.
    const runtime2 = makeStubRuntime();
    const engine2 = new SwarmEngine({
      stateDir: first.stateDir,
      runtime: runtime2,
      memberChannels: new MemberChannels({ channels: { fake: first.fake } }),
    });
    createSwarmHooks(() => engine2).attach(engine2);
    attachRelay(engine2);
    first.fake.inbound = (msg) => relayMemberReply(engine2, msg);
    await resumeOpenTasks(engine2);
    await runtime2.drain();
    expect(group.posts.filter((p) => p.startsWith("PLAN"))).toHaveLength(1);
    // The member answers; the gateway dies again before the relay's turn ends.
    await first.fake.reply(group.groupId, MEMBER, "approved");
    await runtime2.drain();
    expect(runtime2.runs.at(-1)?.sessionKey).toBe(key(T, "relay"));

    // Restart 2: the reply is still unanswered, so the relay gets it again.
    const runtime3 = makeStubRuntime();
    const engine3 = new SwarmEngine({
      stateDir: first.stateDir,
      runtime: runtime3,
      memberChannels: new MemberChannels({ channels: { fake: first.fake } }),
    });
    createSwarmHooks(() => engine3).attach(engine3);
    attachRelay(engine3);
    await resumeOpenTasks(engine3);
    await runtime3.drain();
    const relayRun = runtime3.runs.find((r) => r.sessionKey === key(T, "relay"));
    expect(relayRun?.message).toMatch(/gateway restarted[\s\S]*Reply: approved/);
    // A second resume never posts the PLAN line twice.
    expect(group.posts.filter((p) => p.startsWith("PLAN"))).toHaveLength(1);
    expect(
      await engine3.emit(T, "relay", { event: "APPROVED", sha: "init", body: "Approved." }),
    ).toMatchObject({ ok: true, routedTo: "build" });
    await engine3.emit(T, "build", { event: "BUILD_DONE", sha: "abc", body: "built" });
    await engine3.emit(T, "audit", { event: "AUDIT_PASS", sha: "abc", body: "ok" });
    await engine3.emit(T, "test", { event: "TEST_PASS", sha: "abc", body: "ok" });
    await runtime3.settleAll();
    await engine3.memberChannels.idle();
    await first.fake.reply(group.groupId, MEMBER, "done");
    await runtime3.drain();
    await engine3.emit(T, "relay", { event: "DONE", sha: "abc", body: "Done." });
    await engine3.memberChannels.idle();
    expect(readTasksIndex(first.stateDir)[T]?.status).toBe("done");
    expect(group.closed).toBe(true);
  });
});

describe("parity: every member op has a CLI verb with --json over the same function (ARCH §10a)", () => {
  async function callMethod(engine: SwarmEngine, method: string, params: Record<string, unknown>) {
    let out: { ok: boolean; payload: unknown } | undefined;
    await createSwarmMethods(() => engine)[method]!({
      params,
      respond: (ok: boolean, payload: unknown) => {
        out = { ok, payload };
      },
    } as never);
    return out!;
  }

  const ROWS = [
    {
      op: "group open",
      argv: ["group", "open", "task-1", "--json"],
      method: "swarm.group",
      params: { taskId: "task-1", action: "open" },
      fn: [membersOps, "openHolonGroup"] as const,
    },
    {
      op: "group close",
      argv: ["group", "close", "task-1", "--json"],
      method: "swarm.group",
      params: { taskId: "task-1", action: "close" },
      fn: [membersOps, "closeHolonGroup"] as const,
    },
    {
      op: "relay reply",
      argv: ["relay", "task-1", "approved", "--who", MEMBER, "--json"],
      method: "swarm.relay",
      params: { taskId: "task-1", who: MEMBER, message: "approved" },
      fn: [relayOps, "relayMemberReply"] as const,
    },
  ];

  for (const row of ROWS) {
    it(`${row.op}: CLI --json → ${row.method} → the ops function`, async () => {
      const reply = { ok: true, marker: row.op };
      const call = vi.fn(async () => reply);
      const lines: string[] = [];
      const program = new Command().exitOverride();
      registerSwarmCli({ program, log: (l) => lines.push(l), call });
      await program.parseAsync(["node", "openclaw", "swarm", ...row.argv]);
      expect(call).toHaveBeenCalledWith(row.method, expect.anything(), row.params);
      expect(JSON.parse(lines.join("\n"))).toEqual(reply);

      // The method handler calls the exported ops function itself (no duplicated logic).
      const { engine } = setup(`parity-${row.op.replace(/\s/g, "-")}`);
      const [mod, name] = row.fn as unknown as [Record<string, () => Promise<unknown>>, string];
      const spy = vi.spyOn(mod, name).mockResolvedValue({ ok: true });
      try {
        const out = await callMethod(engine, row.method, row.params);
        expect(out.ok).toBe(true);
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    });
  }

  it("the channel hook, the fake channel and swarm.relay reach the same relay function", async () => {
    const { engine, fake, hooks } = setup("parity-paths");
    const spy = vi.spyOn(relayOps, "relayMemberReply");
    fake.inbound = (msg) => relayOps.relayMemberReply(engine, msg);
    await fake.reply("fake-group-1", MEMBER, "x");
    await hooks.onMessageReceived(
      { from: "x", content: "x", metadata: { senderId: MEMBER } },
      { channelId: "fake", conversationId: "group:fake-group-1" },
    );
    await callMethod(engine, "swarm.relay", { taskId: "none-1", who: MEMBER, message: "x" });
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });
});

describe("signal group API (ARCH §10a.3), driven by a stub rpc: never a daemon", () => {
  it("creates with updateGroup, posts with send, closes by rename + quitGroup, by account", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const channel = createSignalHolonChannel({
      account: "account-placeholder",
      rpc: async (method, params) => {
        calls.push([method, params]);
        return method === "updateGroup" && !params.groupId ? { groupId: "gid-placeholder" } : {};
      },
    });
    expect(await channel.createGroup({ name: "r · h", members: [MEMBER] })).toEqual({
      groupId: "gid-placeholder",
    });
    await channel.post("gid-placeholder", "line");
    await channel.closeGroup("gid-placeholder", { name: "r · h [done]" });
    expect(calls.map(([m]) => m)).toEqual(["updateGroup", "send", "updateGroup", "quitGroup"]);
    expect(calls.every(([, p]) => p.account === "account-placeholder")).toBe(true);
    expect(calls[0]?.[1]).toMatchObject({ name: "r · h", members: [MEMBER] });
    expect(calls[2]?.[1]).toMatchObject({ groupId: "gid-placeholder", name: "r · h [done]" });
  });

  it("a create without a group id is an error (the holon then escalates no channel)", async () => {
    const channel = createSignalHolonChannel({ rpc: async () => ({}) });
    await expect(channel.createGroup({ name: "n", members: [] })).rejects.toThrow(/no group id/);
  });
});
