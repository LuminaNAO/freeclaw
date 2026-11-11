import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { spawnChild } from "./children.js";
import { continueTask } from "./continue.js";
import { SwarmEngine } from "./engine.js";
import { FakeChannel } from "./fake-channel.js";
import {
  GROUP_CLOSE_MAX_TRIES,
  GROUP_CLOSE_STEPS,
  groupCloseDelayMs,
  skipAfter,
  type GroupCloseStep,
} from "./group-close.js";
import { holonStateFrom } from "./holon.js";
import { createSwarmHooks } from "./hooks.js";
import { closeHolonGroup, groupNameFor, MemberChannels, openHolonGroup } from "./members.js";
import { attachRelay, relayMemberReply } from "./relay.js";
import { resumeOpenTasks } from "./resume.js";
import { createSignalHolonChannel, otherMembers } from "./signal-channel.js";
import { readEvents, readTasksIndex, updateTaskIndexEntry } from "./store.js";
import { cancelTask, startTask } from "./tasks.js";
import { makeFakeClock, makeStubRuntime } from "./test-runtime.js";

// ARCH §10c: a done, failed or cancelled holon's group self-destructs (farewell, rename, remove
// every other member, leave and delete, verify). Fake loopback channel and a stub Signal rpc
// only: no daemon, no real group, nobody is messaged. Ids are generic placeholders.

const tmp = fs.mkdtempSync(path.join(tmpdir(), "swarm-group-close-test-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const MEMBER = "member-lead-0001";
const REVIEWER = "member-reviewer-0002";
const OWNER = "root-owner-0003";
const PENDING = "member-pending-0004";
const MODEL = "cb-sonnet/claude-sonnet-5-5";
const MIN = 60_000;
const UP = "agent:main:up";

/** An agent lead with one member participant: the lead decides DONE / FAILED itself. */
const HOLON = (id: string) => `id: ${id}
kind: build
goal: add a greeting
done_when: the unit test passes
lead: { kind: agent, model: ${MODEL} }
participants:
  - { kind: member, who: ${REVIEWER}, channel: fake, role: review }
lanes:
  build: { model: ${MODEL}, thinking: "off" }
  audit: { model: ${MODEL}, thinking: "off" }
  test: { model: ${MODEL}, thinking: "off" }
canon:
  never: [push]
  relay: { model: ${MODEL}, thinking: "off" }
upstream:
  sessionKey: ${UP}
  events: [DONE, BLOCKED, FAILED]
`;

const FAREWELL = (id: string, state: string) =>
  `Task ${id} is ${state}. This group will now self-destruct; you can safely delete it.`;

function setup(name: string, fake = new FakeChannel()) {
  const stateDir = path.join(tmp, name);
  fs.mkdirSync(stateDir, { recursive: true });
  return engineOn(stateDir, fake);
}

/** A (fresh) engine on a state dir: a gateway start is a new engine on the same files. */
function engineOn(stateDir: string, fake: FakeChannel) {
  const runtime = makeStubRuntime();
  const clock = makeFakeClock();
  const engine = new SwarmEngine({
    stateDir,
    runtime,
    clock: clock.clock,
    memberChannels: new MemberChannels({ channels: { fake }, owners: { fake: [OWNER] } }),
  });
  createSwarmHooks(() => engine).attach(engine);
  attachRelay(engine);
  fake.inbound = (msg) => relayMemberReply(engine, msg);
  const events = (task: string) => readEvents(stateDir, task);
  const named = (task: string, event: string) => events(task).filter((e) => e.event === event);
  const settle = async () => {
    await runtime.drain();
    await engine.memberChannels.idle();
    await runtime.drain();
  };
  return { stateDir, runtime, clock, fake, engine, events, named, settle };
}

type Ctx = ReturnType<typeof setup>;

/** Start the holon, open its group and add one pending (invited, not joined) member. */
async function started(ctx: Ctx, T: string) {
  await startTask(ctx.engine, { contractYaml: HOLON(T) });
  const opened = await openHolonGroup(ctx.engine, T);
  if (!opened.ok) {
    throw new Error(opened.reason);
  }
  ctx.fake.invite(opened.groupId, PENDING);
  await ctx.settle();
  return ctx.fake.groups.get(opened.groupId)!;
}

async function leadSays(ctx: Ctx, T: string, event: "DONE" | "FAILED") {
  const res = await ctx.engine.emit(T, "taskmaster", { event, sha: "abc", body: "finished" });
  expect(res).toMatchObject({ ok: true, routedTo: "upstream" });
  await ctx.settle();
}

describe("ARCH §10c.2: the steps, in order", () => {
  it("farewell → rename → removeMember (every other member, pending included) → quit with delete → verify", async () => {
    const ctx = setup("order");
    const T = "close-order";
    const group = await started(ctx, T);
    const before = ctx.fake.calls.length;
    await leadSays(ctx, T, "DONE");

    const name = `${groupNameFor(T, T)} [done]`;
    expect(ctx.fake.calls.slice(before)).toEqual([
      { op: "post", groupId: group.groupId, text: FAREWELL(T, "done") },
      { op: "rename", groupId: group.groupId, name },
      { op: "listGroups", detailed: true },
      { op: "removeMember", groupId: group.groupId, members: [REVIEWER, OWNER, PENDING] },
      { op: "quitGroup", groupId: group.groupId, delete: true },
      { op: "listGroups", detailed: false },
    ]);
    expect(ctx.fake.listed(group.groupId)).toBe(false);
    expect(group).toMatchObject({ name, members: [], pending: [], closed: true, deleted: true });
    const closed = ctx.named(T, "GROUP_CLOSED");
    expect(closed).toHaveLength(1);
    expect(closed[0]?.data).toMatchObject({
      groupId: group.groupId,
      renamed: true,
      removed: 3,
      deleted: true,
    });
    expect(ctx.named(T, "GROUP_CLOSE_FAILED")).toEqual([]);
    // Triggered after the final upstream event is recorded (§10c.1).
    const upstreamDone = ctx.events(T).find((e) => e.kind === "upstream" && e.event === "DONE");
    expect(upstreamDone!.seq).toBeLessThan(closed[0]!.seq);
  });

  it("last-admin case: the agent is the only admin and others remain; the close still succeeds", async () => {
    const ctx = setup("last-admin");
    const T = "close-last-admin";
    const group = await started(ctx, T);
    // The fake refuses a quit by the last admin while anyone else is in the group, as Signal
    // does (the 6 Nov failure): a plain rename + quit, the old close, leaves the group up.
    const plain = await ctx.fake.closeGroup(group.groupId, {
      name: "x",
      farewell: "x",
      skip: ["farewell", "remove"],
    });
    expect(plain.failures).toEqual([
      { step: "quit", error: expect.stringMatching(/last admin/) },
      { step: "verify", error: expect.any(String) },
    ]);
    expect(ctx.fake.listed(group.groupId)).toBe(true);

    // The self-destruct removes everyone first, so the agent is alone and the quit works.
    await leadSays(ctx, T, "DONE");
    expect(ctx.fake.listed(group.groupId)).toBe(false);
    expect(ctx.named(T, "GROUP_CLOSED")).toHaveLength(1);
  });

  for (const step of GROUP_CLOSE_STEPS) {
    it(`${step} failing alone: the other steps still run and GROUP_CLOSE_FAILED names ${step}`, async () => {
      const ctx = setup(`fail-${step}`);
      const T = `close-fail-${step}`;
      const group = await started(ctx, T);
      ctx.fake.failNext[step] = 1;
      const before = ctx.fake.calls.length;
      await leadSays(ctx, T, "DONE");

      const ops = ctx.fake.calls.slice(before).map((c) => c.op);
      // Every step after the failed one was attempted.
      const expected: Record<GroupCloseStep, string[]> = {
        farewell: ["rename", "listGroups", "removeMember", "quitGroup", "listGroups"],
        rename: ["post", "listGroups", "removeMember", "quitGroup", "listGroups"],
        // Remove failed: the quit is still tried (and refused: the agent is the last admin).
        remove: ["post", "rename", "listGroups", "quitGroup", "listGroups"],
        quit: ["post", "rename", "listGroups", "removeMember", "listGroups"],
        verify: ["post", "rename", "listGroups", "removeMember", "quitGroup", "listGroups"],
      };
      expect(ops).toEqual(expected[step]);
      const failed = ctx.named(T, "GROUP_CLOSE_FAILED");
      expect(failed).toHaveLength(1);
      expect(failed[0]?.data).toMatchObject({ groupId: group.groupId, step, attempt: 1 });
      expect(typeof failed[0]?.data?.error).toBe("string");
      expect(ctx.named(T, "GROUP_CLOSED")).toEqual([]);
    });
  }
});

describe("ARCH §10c.3: retry with backoff, then BLOCKED one level up", () => {
  it("a failed close is retried after 1 min and succeeds; the farewell and rename are not repeated", async () => {
    const ctx = setup("retry");
    const T = "close-retry";
    const group = await started(ctx, T);
    ctx.fake.failNext.quit = 1;
    await leadSays(ctx, T, "DONE");
    const failed = ctx.named(T, "GROUP_CLOSE_FAILED");
    expect(failed[0]?.data).toMatchObject({ step: "quit", attempt: 1 });
    expect(Number(failed[0]?.data?.at) - ctx.clock.clock.now()).toBe(MIN);
    expect(ctx.fake.listed(group.groupId)).toBe(true);
    // Nothing is posted to a group whose self-destruct has started.
    expect(ctx.engine.memberChannels.findHolonByGroup(ctx.engine, "fake", group.groupId)).toBe(
      undefined,
    );

    await ctx.clock.advance(MIN - 1);
    expect(ctx.named(T, "GROUP_CLOSED")).toEqual([]);
    await ctx.clock.advance(1);
    await ctx.settle();
    expect(ctx.named(T, "GROUP_CLOSED")[0]?.data).toMatchObject({
      groupId: group.groupId,
      renamed: true,
      deleted: true,
      attempt: 2,
    });
    expect(ctx.fake.listed(group.groupId)).toBe(false);
    expect(group.posts.filter((p) => p === FAREWELL(T, "done"))).toHaveLength(1);
    expect(ctx.fake.calls.filter((c) => c.op === "rename")).toHaveLength(1);
    expect(ctx.clock.pending()).toEqual([]);
  });

  it("1 min doubling to 30 min, 10 tries, then BLOCKED: group not destroyed one level up, once", async () => {
    expect(Array.from({ length: 9 }, (_, i) => groupCloseDelayMs(i + 1) / MIN)).toEqual([
      1, 2, 4, 8, 16, 30, 30, 30, 30,
    ]);
    const ctx = setup("exhaust");
    const T = "close-exhaust";
    const group = await started(ctx, T);
    ctx.fake.failNext.quit = 100;
    await leadSays(ctx, T, "DONE");
    for (let attempt = 1; attempt < GROUP_CLOSE_MAX_TRIES; attempt += 1) {
      expect(ctx.clock.pending()).toEqual([groupCloseDelayMs(attempt)]);
      await ctx.clock.advance(groupCloseDelayMs(attempt));
      await ctx.settle();
    }
    const failed = ctx.named(T, "GROUP_CLOSE_FAILED");
    expect(failed.map((e) => e.data?.attempt)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(failed.at(-1)?.data?.at).toBeUndefined();
    expect(ctx.clock.pending()).toEqual([]);
    const blocked = ctx.events(T).filter((e) => e.kind === "upstream" && e.event === "BLOCKED");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.body).toMatch(/^BLOCKED: group not destroyed\./);
    await ctx.runtime.endAll();
    expect(
      ctx.runtime.runs.filter((r) => r.sessionKey === UP && /group not destroyed/.test(r.message)),
    ).toHaveLength(1);
    // The holon stays done: a late BLOCKED does not reopen it (ARCH §2 derived state).
    expect(readTasksIndex(ctx.stateDir)[T]?.status).toBe("done");
    expect(holonStateFrom(ctx.events(T))).toBe("done");
    // Still retried on gateway start, without a second BLOCKED; then it succeeds.
    ctx.fake.failNext.quit = 0;
    const next = engineOn(ctx.stateDir, ctx.fake);
    const summary = await resumeOpenTasks(next.engine);
    await next.settle();
    expect(summary.groupsReclosed).toBe(1);
    expect(ctx.fake.listed(group.groupId)).toBe(false);
    expect(next.named(T, "GROUP_CLOSED")).toHaveLength(1);
    expect(
      next.events(T).filter((e) => e.kind === "upstream" && e.event === "BLOCKED"),
    ).toHaveLength(1);
  });

  it("a child's BLOCKED: group not destroyed goes to its parent lead (one level up)", async () => {
    const ctx = setup("child-blocked");
    const ROOT = "close-root";
    await startTask(ctx.engine, {
      contractYaml: HOLON(ROOT).replace(/participants:\n.*\n/, ""),
    });
    // A child inherits the canon (§5.2); it has no upstream of its own.
    const childYaml = HOLON("lane-a")
      .replace(/upstream:\n(?:  .*\n)+/, "")
      .replace(/  relay: .*\n/, "");
    const { taskId: C } = await spawnChild(ctx.engine, ROOT, childYaml);
    const opened = await openHolonGroup(ctx.engine, C);
    expect(opened.ok).toBe(true);
    await ctx.settle();
    ctx.fake.failNext.quit = 100;
    await leadSays(ctx, C, "DONE");
    for (let attempt = 1; attempt < GROUP_CLOSE_MAX_TRIES; attempt += 1) {
      await ctx.clock.advance(groupCloseDelayMs(attempt));
      await ctx.settle();
    }
    const toParent = ctx.events(C).filter((e) => e.kind === "upstream" && e.event === "BLOCKED");
    expect(toParent).toHaveLength(1);
    expect(toParent[0]).toMatchObject({ to: "parent" });
    const parentNotice = ctx.events(ROOT).filter((e) => e.event === "CHILD_BLOCKED");
    expect(parentNotice).toHaveLength(1);
    expect(parentNotice[0]?.body).toMatch(/group not destroyed/);
    // The root's own upstream hears nothing of it: escalation climbs one level at a time.
    expect(ctx.events(ROOT).filter((e) => e.kind === "upstream")).toEqual([]);
  });
});

describe("ARCH §10c.3: re-close on resume, gateway start and swarm continue", () => {
  it("resume re-closes a group left open by a failed close (fresh engine, timers lost)", async () => {
    const ctx = setup("resume-failed");
    const T = "close-resume-failed";
    const group = await started(ctx, T);
    ctx.fake.failNext.remove = 1;
    await leadSays(ctx, T, "DONE");
    expect(ctx.fake.listed(group.groupId)).toBe(true);
    // The gateway dies; the retry timer dies with it.
    const next = engineOn(ctx.stateDir, ctx.fake);
    expect((await resumeOpenTasks(next.engine)).groupsReclosed).toBe(1);
    await next.settle();
    expect(ctx.fake.listed(group.groupId)).toBe(false);
    expect(next.named(T, "GROUP_CLOSED")[0]?.data).toMatchObject({ attempt: 2, deleted: true });
    expect(group.posts.filter((p) => p === FAREWELL(T, "done"))).toHaveLength(1);
    // A second start finds nothing to do.
    const third = engineOn(ctx.stateDir, ctx.fake);
    expect((await resumeOpenTasks(third.engine)).groupsReclosed).toBe(0);
  });

  it("resume closes a group a crash left up before any close was tried", async () => {
    const ctx = setup("resume-crash");
    const T = "close-resume-crash";
    const group = await started(ctx, T);
    // The holon was closed on disk, but the gateway died before the group close ran.
    updateTaskIndexEntry(ctx.stateDir, T, { status: "cancelled" });
    const next = engineOn(ctx.stateDir, ctx.fake);
    expect((await resumeOpenTasks(next.engine)).groupsReclosed).toBe(1);
    await next.settle();
    expect(ctx.fake.listed(group.groupId)).toBe(false);
    expect(group.posts.at(-1)).toBe(FAREWELL(T, "cancelled"));
    expect(group.name).toBe(`${groupNameFor(T, T)} [cancelled]`);
  });

  it("swarm continue on a done holon re-closes its group first", async () => {
    const ctx = setup("continue");
    const T = "close-continue";
    const group = await started(ctx, T);
    ctx.fake.failNext.verify = 1;
    await leadSays(ctx, T, "DONE");
    expect(ctx.named(T, "GROUP_CLOSE_FAILED")[0]?.data).toMatchObject({ step: "verify" });
    await continueTask(ctx.engine, T, { followUpYaml: "input: round two\n" });
    await ctx.settle();
    const closed = ctx.named(T, "GROUP_CLOSED");
    expect(closed).toHaveLength(1);
    const round = ctx.named(T, "ROUND_STARTED");
    expect(closed[0]!.seq).toBeLessThan(round[0]!.seq);
    expect(ctx.fake.listed(group.groupId)).toBe(false);
    // The armed retry finds the holon open again and closes nothing more.
    await ctx.clock.advance(MIN);
    expect(ctx.named(T, "GROUP_CLOSED")).toHaveLength(1);
    expect(ctx.named(T, "GROUP_CLOSE_FAILED")).toHaveLength(1);
  });

  it("swarm group close (ops) retries a failed close on demand", async () => {
    const ctx = setup("ops");
    const T = "close-ops";
    const group = await started(ctx, T);
    ctx.fake.failNext.rename = 1;
    await leadSays(ctx, T, "DONE");
    expect(await closeHolonGroup(ctx.engine, T)).toMatchObject({ ok: true });
    expect(ctx.fake.listed(group.groupId)).toBe(false);
    expect(await closeHolonGroup(ctx.engine, T)).toMatchObject({ ok: false });
  });
});

describe("ARCH §10c.1: failed and cancelled holons close too; agent-only holons record nothing", () => {
  it("a failed holon's group: farewell says failed, renamed [failed]", async () => {
    const ctx = setup("failed");
    const T = "close-failed";
    const group = await started(ctx, T);
    await leadSays(ctx, T, "FAILED");
    expect(readTasksIndex(ctx.stateDir)[T]?.status).toBe("failed");
    expect(group.posts.at(-1)).toBe(FAREWELL(T, "failed"));
    expect(group.name).toBe(`${groupNameFor(T, T)} [failed]`);
    expect(ctx.fake.listed(group.groupId)).toBe(false);
    expect(ctx.named(T, "GROUP_CLOSED")).toHaveLength(1);
  });

  it("a cancelled holon's group: the CANCELLED line, then the farewell, renamed [cancelled]", async () => {
    const ctx = setup("cancelled");
    const T = "close-cancelled";
    const group = await started(ctx, T);
    await cancelTask(ctx.engine, T, "not needed");
    await ctx.settle();
    expect(group.posts.at(-2)).toMatch(/cancelled \(not needed\)/);
    expect(group.posts.at(-1)).toBe(FAREWELL(T, "cancelled"));
    expect(group.name).toBe(`${groupNameFor(T, T)} [cancelled]`);
    expect(ctx.fake.listed(group.groupId)).toBe(false);
    expect(ctx.named(T, "GROUP_CLOSED")).toHaveLength(1);
  });

  it("an agent-only holon (no group) records nothing", async () => {
    const ctx = setup("agent-only");
    const T = "close-agent-only";
    await startTask(ctx.engine, {
      contractYaml: HOLON(T).replace(/participants:\n.*\n/, ""),
    });
    await leadSays(ctx, T, "DONE");
    expect(ctx.fake.groups.size).toBe(0);
    expect(ctx.fake.calls).toEqual([]);
    expect(ctx.events(T).filter((e) => e.event.startsWith("GROUP_"))).toEqual([]);
    expect((await resumeOpenTasks(engineOn(ctx.stateDir, ctx.fake).engine)).groupsReclosed).toBe(0);
  });
});

describe("skipAfter: what a retry repeats", () => {
  it("never repeats the farewell or a done rename; remove and quit run again", () => {
    expect(skipAfter(["farewell", "rename", "remove"])).toEqual(["farewell", "rename"]);
    expect(skipAfter(["remove", "quit"])).toEqual([]);
  });
});

describe("Signal closeGroup (ARCH §10c.4), driven by a stub rpc: never a daemon", () => {
  const SELF_UUID = "00000000-0000-4000-8000-0000000000aa";
  const SELF_NUMBER = "+10000000000";
  const OTHER_UUID = "00000000-0000-4000-8000-0000000000bb";
  const PENDING_UUID = "00000000-0000-4000-8000-0000000000cc";
  const GID = "gid-placeholder";

  /** A stub signal-cli: the agent is the last admin; quit is refused while others remain. */
  function stubSignal(opts: { fail?: string } = {}) {
    const calls: Array<[string, Record<string, unknown>]> = [];
    let members = [
      { uuid: SELF_UUID, number: SELF_NUMBER },
      { uuid: OTHER_UUID, number: null },
      { uuid: null, number: "+10000000002" },
    ];
    let pending = [{ uuid: PENDING_UUID, number: null }];
    let listed = true;
    const rpc = async (method: string, params: Record<string, unknown>) => {
      calls.push([method, params]);
      if (opts.fail === method) {
        throw new Error(`signal ${method} failed`);
      }
      if (method === "listGroups") {
        return listed
          ? [
              { id: "another-group", members: [], pendingMembers: [] },
              { id: GID, members, pendingMembers: pending, admins: [{ uuid: SELF_UUID }] },
            ]
          : [{ id: "another-group", members: [], pendingMembers: [] }];
      }
      if (method === "updateGroup" && Array.isArray(params.removeMember)) {
        const gone = new Set(params.removeMember as string[]);
        members = members.filter((m) => !gone.has(m.uuid ?? "") && !gone.has(m.number ?? ""));
        pending = pending.filter((m) => !gone.has(m.uuid ?? ""));
      }
      if (method === "quitGroup") {
        if (members.length > 1 || pending.length > 0) {
          throw new Error("last admin cannot leave the group");
        }
        listed = params.delete !== true;
      }
      return {};
    };
    const channel = createSignalHolonChannel({
      rpc,
      account: SELF_NUMBER,
      accountUuid: SELF_UUID,
    });
    return { calls, channel };
  }

  it("send farewell → updateGroup name → listGroups detailed → updateGroup removeMember (all others, pending included) → quitGroup delete → listGroups", async () => {
    const { calls, channel } = stubSignal();
    const result = await channel.closeGroup(GID, { name: "r · h [done]", farewell: "bye" });
    expect(result).toEqual({
      ok: ["farewell", "rename", "remove", "quit", "verify"],
      failures: [],
      removed: 3,
    });
    expect(calls).toEqual([
      ["send", { account: SELF_NUMBER, groupId: GID, message: "bye" }],
      ["updateGroup", { account: SELF_NUMBER, groupId: GID, name: "r · h [done]" }],
      ["listGroups", { account: SELF_NUMBER, detailed: true }],
      [
        "updateGroup",
        {
          account: SELF_NUMBER,
          groupId: GID,
          removeMember: [OTHER_UUID, "+10000000002", PENDING_UUID],
        },
      ],
      ["quitGroup", { account: SELF_NUMBER, groupId: GID, delete: true }],
      ["listGroups", { account: SELF_NUMBER }],
    ]);
  });

  it("each rpc failing still runs the rest and names the step", async () => {
    const send = await stubSignal({ fail: "send" }).channel.closeGroup(GID, {
      name: "n",
      farewell: "bye",
    });
    expect(send.failures.map((f) => f.step)).toEqual(["farewell"]);
    expect(send.ok).toEqual(["rename", "remove", "quit", "verify"]);
    const quit = await stubSignal({ fail: "quitGroup" }).channel.closeGroup(GID, {
      name: "n",
      farewell: "bye",
    });
    expect(quit.failures.map((f) => f.step)).toEqual(["quit", "verify"]);
    const list = await stubSignal({ fail: "listGroups" }).channel.closeGroup(GID, {
      name: "n",
      farewell: "bye",
    });
    // Without a member list nobody is removed, so the last-admin quit is refused too.
    expect(list.failures.map((f) => f.step)).toEqual(["remove", "quit", "verify"]);
  });

  it("a retry of a group already gone only verifies", async () => {
    const { calls, channel } = stubSignal();
    await channel.closeGroup(GID, { name: "n", farewell: "bye" });
    calls.length = 0;
    expect(await channel.closeGroup(GID, { name: "n", farewell: "bye", retry: true })).toEqual({
      ok: ["verify"],
      failures: [],
      removed: 0,
    });
    expect(calls.map(([m]) => m)).toEqual(["listGroups"]);
  });

  it("refuses to guess who the agent is: no own account configured fails the remove step", async () => {
    const channel = createSignalHolonChannel({
      rpc: async (method) => (method === "listGroups" ? [{ id: GID, members: [] }] : {}),
    });
    const res = await channel.closeGroup(GID, { name: "n", farewell: "bye" });
    expect(res.failures[0]).toMatchObject({ step: "remove", error: /own Signal account/ });
  });

  it("otherMembers drops the agent by uuid or number and keeps pending members", () => {
    expect(
      otherMembers(
        {
          members: [
            { uuid: SELF_UUID.toUpperCase() },
            { number: SELF_NUMBER },
            { uuid: OTHER_UUID },
          ],
          pendingMembers: [{ uuid: PENDING_UUID }],
        },
        [`uuid:${SELF_UUID}`, SELF_NUMBER],
      ),
    ).toEqual([OTHER_UUID, PENDING_UUID]);
  });
});
