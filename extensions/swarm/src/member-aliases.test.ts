import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { validateJsonSchemaValue } from "../../../src/plugins/schema-validator.js";
import { createTestPluginApi } from "../../test-utils/plugin-api.js";
import { createPluginRuntimeMock } from "../../test-utils/plugin-runtime-mock.js";
import register from "../index.js";
import { SwarmEngine } from "./engine.js";
import { FakeChannel } from "./fake-channel.js";
import { parseHolon } from "./holon.js";
import { createSwarmHooks } from "./hooks.js";
import {
  canonicalEventName,
  LEGACY_EVENT_NAMES,
  LEGACY_MEMBER_KIND,
  memberConfigOf,
} from "./member-aliases.js";
import { MemberChannels } from "./members.js";
import { describeLead, parseLeadSpec } from "./ops.js";
import { attachRelay, relayMemberReply } from "./relay.js";
import { resumeOpenTasks } from "./resume.js";
import { eventsPath } from "./store.js";
import { readEvents, readTasksIndex } from "./store.js";
import { showTask, startTask } from "./tasks.js";
import { makeStubRuntime } from "./test-runtime.js";

// ARCH §10b.3, §10b.4: members over a channel are one kind, whoever is on the other end; the
// step-5 spellings stay accepted as aliases. Fake loopback channel only: no daemon, no real
// group, nobody is messaged. Ids are generic placeholders.

const tmp = fs.mkdtempSync(path.join(tmpdir(), "swarm-member-aliases-test-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const OLD = LEGACY_MEMBER_KIND;
const LEAD_ID = "member-lead-0001";
const AGENT_ID = "agent-member-0005";
const OWNER = "root-owner-0003";
const MODEL = "provider-a/model-a";

const holonYaml = (id: string, kind: string, who = LEAD_ID) => `id: ${id}
kind: build
goal: add a greeting
done_when: the unit test passes
lead: { kind: ${kind}, who: [${who}], channel: fake }
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
`;

const key = (task: string, role: string) => `agent:main:swarm:${task}:${role}`;

function setup(name: string, fake = new FakeChannel()) {
  const stateDir = path.join(tmp, name);
  fs.mkdirSync(stateDir, { recursive: true });
  const runtime = makeStubRuntime();
  const engine = new SwarmEngine({
    stateDir,
    runtime,
    memberChannels: new MemberChannels({ channels: { fake }, owners: { fake: [OWNER] } }),
  });
  createSwarmHooks(() => engine).attach(engine);
  attachRelay(engine);
  fake.inbound = (msg) => relayMemberReply(engine, msg);
  const settle = async () => {
    await runtime.drain();
    await engine.memberChannels.idle();
    await runtime.drain();
  };
  return {
    stateDir,
    runtime,
    fake,
    engine,
    settle,
    events: (t: string) => readEvents(stateDir, t),
  };
}

/** The approve flow of members.test.ts, as a trace that does not depend on the task id. */
async function approveTrace(name: string, kind: string) {
  const { runtime, fake, engine, settle, events } = setup(name);
  // The same task id in its own state dir, so both traces (message ids too) are comparable.
  const T = "approve-task";
  await startTask(engine, { contractYaml: holonYaml(T, kind) });
  await settle();
  await engine.emit(T, "build", { event: "PLAN", sha: "init", body: "three steps" });
  await runtime.end(key(T, "build"));
  await settle();
  const group = [...fake.groups.values()][0]!;
  const relayed = await fake.reply(group.groupId, LEAD_ID, "looks good, go ahead");
  await settle();
  const approved = await engine.emit(T, "relay", {
    event: "APPROVED",
    sha: "init",
    body: "Approved the plan; build goes on.",
  });
  await runtime.end(key(T, "relay"));
  await settle();
  const strip = (s: string) => s.replaceAll(T, "<task>");
  return {
    lead: engine.loadState(T).holon.lead,
    relayed,
    approved,
    posts: group.posts.map(strip),
    members: group.members,
    runs: runtime.runs.map((r) => strip(`${r.sessionKey} ${r.message}`)),
    events: events(T).map((e) => `${e.kind}:${e.event}:${e.from ?? ""}>${e.to ?? ""}`),
  };
}

describe("§10b.3 aliases: the step-5 kind, lead spec and plugin config", () => {
  it("a holon file with the old kind loads as a member and runs exactly the same", async () => {
    const holon = parseHolon(holonYaml("alias-parse", OLD));
    expect(holon.lead).toEqual({ kind: "member", who: [LEAD_ID], channel: "fake" });
    const withParticipant = parseHolon(
      `${holonYaml("alias-part", "agent")}participants:\n  - { kind: ${OLD}, who: x-1, channel: fake, role: review }\n`.replace(
        `{ kind: agent, who: [${LEAD_ID}], channel: fake }`,
        "{ kind: agent }",
      ),
    );
    expect(withParticipant.participants).toEqual([
      { kind: "member", who: ["x-1"], channel: "fake", role: "review" },
    ]);

    const before = await approveTrace("alias-old", OLD);
    const after = await approveTrace("alias-new", "member");
    expect(before.relayed).toMatchObject({ ok: true, role: "taskmaster" });
    expect(before.approved).toMatchObject({ ok: true, routedTo: "build" });
    expect(before).toEqual(after);
    expect(before.events.some((e) => e.includes("MEMBER_POSTED"))).toBe(true);
  });

  it("the old lead spec short form is a member lead; new specs say member", () => {
    const want = { kind: "member", who: ["a-1", "b-2"], channel: "fake" };
    expect(parseLeadSpec(`${OLD}:fake:a-1,b-2`)).toEqual(want);
    expect(parseLeadSpec("member:fake:a-1,b-2")).toEqual(want);
    expect(parseLeadSpec(`{ kind: ${OLD}, who: [a-1, b-2], channel: fake }`)).toEqual(want);
    expect(describeLead(parseLeadSpec("member:fake:a-1"))).toBe("member@fake");
    expect(() => parseLeadSpec("robot:x")).toThrow(/member:<channel>:<who>/);
  });

  it("plugin config: the old key is an alias of members; members wins per channel kind", () => {
    const legacy = { channels: { fake: {} }, owners: { fake: ["o-1"] } };
    expect(memberConfigOf({ [`${OLD}s`]: legacy })).toEqual(legacy);
    expect(memberConfigOf({ members: legacy })).toEqual(legacy);
    expect(memberConfigOf({})).toBeUndefined();
    expect(
      memberConfigOf({
        [`${OLD}s`]: { channels: { fake: {}, other: {} }, owners: { fake: ["old"] } },
        members: { owners: { fake: ["new"] } },
      }),
    ).toEqual({ channels: { fake: {}, other: {} }, owners: { fake: ["new"] } });
  });

  it("the plugin manifest accepts both config keys, and either wires the channel hooks", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "openclaw.plugin.json"), "utf8"));
    const value = { channels: { fake: {} }, owners: { fake: ["o-1"] } };
    for (const cfgKey of ["members", `${OLD}s`]) {
      expect(
        validateJsonSchemaValue({
          schema: manifest.configSchema,
          cacheKey: `swarm-manifest-${cfgKey}`,
          value: { [cfgKey]: value },
        }),
      ).toEqual({ ok: true });
      const hooks: string[] = [];
      register(
        createTestPluginApi({
          id: "swarm",
          name: "Swarm",
          source: "test",
          config: {},
          pluginConfig: { [cfgKey]: value },
          runtime: createPluginRuntimeMock(),
          on: (name) => hooks.push(name),
        }),
      );
      expect(hooks).toEqual([
        "llm_input",
        "message_received",
        "message_sending",
        "before_tool_call",
      ]);
    }
  });
});

describe("§10b.3: event logs written with the step-5 names", () => {
  it("old names read as their member names; anything else is unchanged", () => {
    for (const [old, now] of Object.entries(LEGACY_EVENT_NAMES)) {
      expect(old.startsWith(`${OLD.toUpperCase()}_`)).toBe(true);
      expect(canonicalEventName(old)).toBe(now);
      expect(now.startsWith("MEMBER_")).toBe(true);
    }
    expect(canonicalEventName("MEMBER_REPLY")).toBe("MEMBER_REPLY");
    expect(canonicalEventName("BUILD_DONE")).toBe("BUILD_DONE");
  });

  /**
   * Run a holon to the point where a line was not posted and a reply is unanswered, kill the
   * gateway, optionally rewrite its log to the step-5 names, and resume on a fresh engine.
   */
  async function resumeTrace(name: string, oldLog: boolean) {
    const first = setup(name);
    const T = "resume-task";
    await startTask(first.engine, { contractYaml: holonYaml(T, "member") });
    await first.settle();
    const group = [...first.fake.groups.values()][0]!;
    first.fake.failNext.post = 1;
    await first.engine.emit(T, "build", { event: "PLAN", sha: "init", body: "the plan" });
    await first.fake.reply(group.groupId, LEAD_ID, "approved");
    await first.settle();
    const file = eventsPath(first.stateDir, T);
    const written = fs.readFileSync(file, "utf8");
    expect(written).toContain('"MEMBER_POST_FAILED"');
    expect(written).toContain('"MEMBER_REPLY"');
    if (oldLog) {
      const old = written.replace(/"MEMBER_(POSTED|POST_FAILED|REPLY|IGNORED)"/g, (_, n) =>
        JSON.stringify(`${OLD.toUpperCase()}_${n}`),
      );
      expect(old).not.toContain('"MEMBER_');
      fs.writeFileSync(file, old);
    }
    const linesBefore = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length;

    // Restart: a fresh engine on the same state dir and the same (still existing) group.
    const runtime = makeStubRuntime();
    const engine = new SwarmEngine({
      stateDir: first.stateDir,
      runtime,
      memberChannels: new MemberChannels({ channels: { fake: first.fake } }),
    });
    createSwarmHooks(() => engine).attach(engine);
    attachRelay(engine);
    first.fake.inbound = (msg) => relayMemberReply(engine, msg);
    const summary = await resumeOpenTasks(engine);
    await runtime.drain();
    const strip = (s: string) => s.replaceAll(T, "<task>");
    const relayRuns = runtime.runs
      .filter((r) => r.sessionKey === key(T, "relay"))
      .map((r) => strip(r.message));
    // The relay answers; the holon goes on.
    const approved = await engine.emit(T, "relay", {
      event: "APPROVED",
      sha: "init",
      body: "Approved.",
    });
    await engine.memberChannels.idle();
    const shown = showTask(engine, T);
    const appended = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(linesBefore);
    return {
      summary,
      relayRuns,
      approved,
      posts: group.posts.map(strip),
      shownEvents: shown.events.map((e) => e.event),
      appended: appended.map((l) => (JSON.parse(l) as { event: string }).event),
    };
  }

  it("resume over a log with the old names behaves exactly as over a new log", async () => {
    const now = await resumeTrace("log-new", false);
    const old = await resumeTrace("log-old", true);
    // The unposted PLAN line is posted again and the unanswered reply reaches the relay.
    expect(now.posts.filter((p) => p === "the plan")).toHaveLength(1);
    expect(now.relayRuns.at(-1)).toMatch(/gateway restarted[\s\S]*Reply: approved/);
    expect(now.approved).toMatchObject({ ok: true, routedTo: "build" });
    expect(old).toEqual(now);
    // show reads the old names as member names; new lines are written with member names only.
    expect(old.shownEvents).toContain("MEMBER_REPLY");
    expect(old.shownEvents).toContain("MEMBER_POST_FAILED");
    expect(old.shownEvents.some((e) => e.startsWith(`${OLD.toUpperCase()}_`))).toBe(false);
    expect(old.appended).toContain("MEMBER_POSTED");
    expect(old.appended.some((e) => e.startsWith(`${OLD.toUpperCase()}_`))).toBe(false);
  });

  it("the relay counts an old-log reply as answered once it has its event", async () => {
    const { runtime, fake, engine, settle, stateDir } = setup("log-relay");
    const T = "log-relay-task";
    await startTask(engine, { contractYaml: holonYaml(T, "member") });
    await engine.emit(T, "build", { event: "PLAN", sha: "init", body: "p" });
    await runtime.end(key(T, "build"));
    await settle();
    const group = [...fake.groups.values()][0]!;
    await fake.reply(group.groupId, LEAD_ID, "yes");
    await settle();
    const file = eventsPath(stateDir, T);
    fs.writeFileSync(
      file,
      fs.readFileSync(file, "utf8").replaceAll('"MEMBER_', `"${OLD.toUpperCase()}_`),
    );
    expect(
      await engine.emit(T, "relay", { event: "APPROVED", sha: "init", body: "Approved." }),
    ).toMatchObject({ ok: true, routedTo: "build" });
    expect(await engine.emit(T, "relay", { event: "DONE", sha: "init", body: "x" })).toMatchObject({
      ok: false,
    });
  });
});

/**
 * A member that is another agent, not a person (ARCH §10b): a fake channel whose group
 * replies come from a scripted agent reading each posted line. The swarm cannot tell.
 */
class ScriptedAgentChannel extends FakeChannel {
  readonly pending: Array<Promise<unknown>> = [];
  readonly said: string[] = [];

  constructor(
    private readonly me: string,
    private readonly script: (line: string) => string | undefined,
  ) {
    super("fake");
  }

  override async post(groupId: string, text: string): Promise<void> {
    await super.post(groupId, text);
    const answer = this.script(text);
    if (answer) {
      // The agent answers after the post, as a separate inbound message (never inside it).
      this.pending.push(
        new Promise((r) => setTimeout(r, 0)).then(() => {
          this.said.push(answer);
          return this.reply(groupId, this.me, answer);
        }),
      );
    }
  }

  async idle(): Promise<void> {
    while (this.pending.length > 0) {
      await Promise.allSettled(this.pending.splice(0));
    }
  }
}

describe("§10b.4: an agent member leads a holon over the fake channel", () => {
  it("a scripted agent approves the plan and then says done; the holon is DONE", async () => {
    const agent = new ScriptedAgentChannel(AGENT_ID, (line) => {
      // ARCH §10b.5: the agent sees only the sender's words, as a person would.
      if (line === "two steps") {
        return "Plan accepted. Proceed.";
      }
      if (line === "green") {
        return "All checks green. Finished.";
      }
      return undefined;
    });
    const { runtime, engine, settle, events } = setup("agent-member", agent);
    const all = async () => {
      await settle();
      await agent.idle();
      await settle();
    };
    const T = "agent-member-task";
    await startTask(engine, { contractYaml: holonYaml(T, "member", AGENT_ID) });
    await all();
    const group = [...agent.groups.values()][0]!;
    expect(group.members.toSorted()).toEqual([AGENT_ID, OWNER].toSorted());
    expect(agent.said).toEqual([]);

    // build asks for approval; the agent member answers in the group; the relay routes it.
    await engine.emit(T, "build", { event: "PLAN", sha: "init", body: "two steps" });
    await runtime.end(key(T, "build"));
    await all();
    expect(agent.said).toEqual(["Plan accepted. Proceed."]);
    const relayRun = runtime.runs.at(-1)!;
    expect(relayRun.sessionKey).toBe(key(T, "relay"));
    expect(relayRun.message).toContain("Reply: Plan accepted. Proceed.");
    expect(relayRun.extraSystemPrompt).toMatch(/a person or another agent/);
    expect(
      await engine.emit(T, "relay", { event: "APPROVED", sha: "init", body: "Plan approved." }),
    ).toMatchObject({ ok: true, routedTo: "build" });
    await runtime.end(key(T, "relay"));
    await all();
    const buildRun = runtime.runs.filter((r) => r.sessionKey === key(T, "build")).at(-1);
    expect(buildRun?.message).toMatch(/EVENT APPROVED/);

    // The lanes finish; the gate result goes to the agent lead, which says done.
    await engine.emit(T, "build", { event: "BUILD_DONE", sha: "abc", body: "built" });
    await engine.emit(T, "audit", { event: "AUDIT_PASS", sha: "abc", body: "fine" });
    await engine.emit(T, "test", { event: "TEST_PASS", sha: "abc", body: "green" });
    for (const role of ["build", "audit", "test"]) {
      await runtime.end(key(T, role));
    }
    await all();
    expect(agent.said.at(-1)).toBe("All checks green. Finished.");
    expect(runtime.runs.at(-1)?.message).toContain("Reply: All checks green. Finished.");
    // The relay's turn: one event for the reply, then the turn ends.
    expect(
      await engine.emit(T, "relay", { event: "DONE", sha: "abc", body: "Marked done." }),
    ).toMatchObject({ ok: true, routedTo: "upstream" });
    await runtime.end(key(T, "relay"));
    await all();

    expect(readTasksIndex(engine.stateDir)[T]?.status).toBe("done");
    expect(group.closed).toBe(true);
    const log = events(T);
    expect(log.filter((e) => e.event === "MEMBER_REPLY" && e.kind === "system")).toHaveLength(2);
    expect(
      log.filter((e) => e.kind === "emit" && e.from === "taskmaster").map((e) => e.event),
    ).toEqual(["APPROVED", "DONE"]);
    expect(log.some((e) => e.event === "RELAY_SILENT" || e.event === "MEMBER_IGNORED")).toBe(false);
  });
});

describe("§10b.4 grep gate", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const self = fileURLToPath(import.meta.url);
  const aliasModule = path.join(root, "src", "member-aliases.ts");
  const manifest = path.join(root, "openclaw.plugin.json");

  function files(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        return d.name === "node_modules" ? [] : files(full);
      }
      return [full];
    });
  }

  it(`no "${OLD}" left in extensions/swarm except the alias handling and its tests`, () => {
    const word = new RegExp(OLD, "i");
    const offenders: string[] = [];
    for (const file of files(root)) {
      // ARCH.md is operator-owned (only the operator edits it); the alias module and this test
      // are the alias handling and its tests.
      if (file === path.join(root, "ARCH.md") || file === aliasModule || file === self) {
        continue;
      }
      fs.readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (!word.test(line)) {
            return;
          }
          // The manifest's config schema declares the alias key (and nothing else may say it).
          if (file === manifest && line.trim() === `"${OLD}s": {`) {
            return;
          }
          offenders.push(`${path.relative(root, file)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it("the gate itself catches a stray use", () => {
    const word = new RegExp(OLD, "i");
    expect(word.test(`const x = "${OLD.toUpperCase()}_REPLY";`)).toBe(true);
    expect(word.test("const x = MEMBER_REPLY;")).toBe(false);
  });
});
