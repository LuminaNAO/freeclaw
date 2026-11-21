// ARCH §2c.14: ask before painting a group we know nothing about. A group first seen with
// no avatar is painted without a question when group memory knows its purpose; otherwise it
// is `pending` (nothing painted, nothing sent by the extension) and the agent is told, in
// that group's own session turn only, to ask in its reply. Delivery is known from the
// message_sent hook only. Placeholders only: no real names, ids or numbers.
import { describe, expect, it } from "vitest";
import { createTestPluginApi } from "../../test-utils/plugin-api.js";
import { registerModelBadge } from "../index.js";
import { createActions } from "./actions.js";
import { createBadgeCommand } from "./commands.js";
import { buildPrompt, type BaseArtGenerator } from "./core/baseart.js";
import { normalizeConfig } from "./core/config.js";
import type { Engine } from "./core/engine.js";
import { ANSWER_TEXT, ASK_TEXT, cleanPurpose, PURPOSE_MAX_CHARS } from "./core/picture.js";
import type { SceneWriteRequest, SceneWriter } from "./core/scene.js";
import { createSteering } from "./core/steering.js";
import { createStyleStore } from "./core/style.js";
import { fakePng } from "./test-helpers/fakes.js";
import { createWorld, IDS, type World } from "./test-helpers/world.js";

const OP = "+10000000002";
const MEMBER = "+10000000077";
const GOOD = "sunlit allotment rows of tomatoes and runner beans beside a wooden shed at dawn";
const OWN = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("their own art")]);
const PURPOSE_A = "Neighbours sharing a community vegetable garden and its harvest.";
const PURPOSE_ANSWER = "A weekly running club for beginners.";
const LOCAL_CMD = { kind: "command", command: "/opt/fake/gen" };
const DAY = 24 * 60 * 60 * 1000;

function fakeImageGen() {
  const prompts: Array<{ seed: string; prompt: string }> = [];
  const gen: BaseArtGenerator & { prompts: typeof prompts } = {
    id: "fake-image:v1",
    prompts,
    available: async () => true,
    async generate(target, style) {
      prompts.push({ seed: target.seed, prompt: buildPrompt(target, style) });
      return fakePng(1024, 1024, `generated ${target.seed}`);
    },
  };
  return gen;
}

type FakeWriter = SceneWriter & { calls: SceneWriteRequest[] };
function fakeWriter(): FakeWriter {
  const calls: SceneWriteRequest[] = [];
  return {
    calls,
    async write(req) {
      calls.push(req);
      return GOOD;
    },
  };
}

type Opts = {
  backend?: "signal" | "fakechat";
  ask?: Record<string, unknown>;
  purposes?: Record<string, string>;
  avatars?: Record<string, Buffer>;
  targets?: string[];
  plugin?: Record<string, unknown>;
  profile?: boolean;
  imageGen?: Record<string, unknown> | null;
};

async function world(opts: Opts = {}) {
  const gen = fakeImageGen();
  const writer = fakeWriter();
  const w = await createWorld({
    backend: opts.backend,
    targets: [],
    profile: opts.profile,
    purposes: opts.purposes,
    plugin: {
      imageGen: opts.imageGen === undefined ? LOCAL_CMD : opts.imageGen,
      ask: { mode: "ask", ...opts.ask },
      ...opts.plugin,
    },
  });
  for (const id of opts.targets ?? [IDS.a]) {
    w.addTarget(id, opts.avatars?.[id] ? { avatar: opts.avatars[id] } : {});
  }
  const e = await w.startEngine({ imageGenerator: gen, sceneWriter: writer });
  await w.settle();
  await e.idle();
  return { w, e, gen, writer, ...actionsFor(w, e) };
}

function actionsFor(w: World, e: Engine) {
  const cfg = normalizeConfig(w.pluginConfig(), { gatewayStateDir: "/s" }).config;
  const steering = createSteering({
    engines: () => [e],
    store: createStyleStore({ fs: w.fs, stateDir: w.paths.rootDir }),
    operators: () => cfg.operators,
    allowGroupMembers: () => true,
    configRules: () => [],
    now: () => w.clock.now(),
  });
  const deps = {
    engines: () => [e] as Engine[],
    steering: () => steering,
    operators: () => cfg.operators,
    allowGroupMembers: () => true,
    purge: async () => {},
  };
  const run = createActions(deps);
  const here = (id: string) => ({ kind: "group" as const, idLower: id.toLowerCase() });
  const act = (sender: string, id: string, action: Parameters<typeof run>[0], args = {}) =>
    run(action, args, { senderId: sender, engine: e, here: here(id) });
  const slash = createBadgeCommand(deps);
  return { act, slash };
}

async function step(w: World, e: Engine) {
  await w.settle();
  await e.idle();
  await w.settle();
  await e.idle();
}

const picture = (e: Engine, w: World, id: string) => e.pictureState(w.tk(id));
const painted = (w: World, id: string) => w.targetSends(id).length > 0;
const promptsFor = (w: World, e: Engine, gen: ReturnType<typeof fakeImageGen>, id: string) => {
  const seed = e.view()!.imageWant({ kind: "group", idLower: id.toLowerCase() }).target.seed;
  return gen.prompts.filter((p) => p.seed === seed).map((p) => p.prompt);
};
// A turn of the agent in `id`'s own session: the per-turn text it got.
const turn = (w: World, e: Engine, id: string) => e.promptContext(w.sk(id));
// The reply of that turn delivered (or failed) to the group.
const delivered = (w: World, e: Engine, id: string, success = true) =>
  e.replyDelivered(w.sk(id), success);

describe("purpose known → painted, no question (ARCH §2c.14)", () => {
  it("no avatar + purpose known → painted, the writer got the purpose first, no text injected", async () => {
    const { w, e, gen, writer } = await world({ purposes: { [IDS.a]: PURPOSE_A } });
    expect(picture(e, w, IDS.a)).toBe("accepted (purpose-known)");
    expect(writer.calls).toHaveLength(1);
    expect(writer.calls[0]!.purpose).toBe(PURPOSE_A);
    expect(painted(w, IDS.a)).toBe(true);
    expect(promptsFor(w, e, gen, IDS.a).at(-1)).toContain(GOOD);
    expect(await turn(w, e, IDS.a)).toBeNull();
    await e.stop();
  });

  it("operator config targets.<id>.base: generate paints without a question", async () => {
    const { w, e } = await world({
      plugin: { targets: { [IDS.a.toLowerCase()]: { base: "generate" } } },
    });
    expect(picture(e, w, IDS.a)).toBe("accepted (operator-config)");
    expect(painted(w, IDS.a)).toBe(true);
    expect(await turn(w, e, IDS.a)).toBeNull();
    await e.stop();
  });
});

describe("purpose unknown → pending (ARCH §2c.14)", () => {
  it("no avatar + unknown → nothing applied, nothing sent, pending; no asset made for it", async () => {
    const { w, e, gen, writer } = await world({
      targets: [IDS.a, IDS.b],
      purposes: { [IDS.b]: PURPOSE_A },
    });
    expect(picture(e, w, IDS.a)).toBe("pending");
    expect(w.targetSends(IDS.a)).toEqual([]);
    expect(w.applied()[w.tk(IDS.a)]).toBeUndefined();
    expect(promptsFor(w, e, gen, IDS.a)).toEqual([]);
    expect(writer.calls.every((c) => c.purpose === PURPOSE_A)).toBe(true);
    // No avatar write was ever made for A.
    expect(
      w.backend
        .rpcLog()
        .filter((c) => c.method === "updateGroup" && String(c.params.groupId) === IDS.a),
    ).toEqual([]);
    // B (purpose known) is painted as usual.
    expect(painted(w, IDS.b)).toBe(true);
    // Status shows it; the target is not converged and waits for the picture.
    const s = e.targetSummary(w.tk(IDS.a))!;
    expect(s.picture).toBe("pending");
    expect(s.converged).toBe(false);
    expect(s.waiting).toMatchObject({ reason: "waiting-for-picture" });
    // Passes and time change nothing.
    await e.runPass("periodic");
    await w.settle(10 * 60_000);
    expect(w.targetSends(IDS.a)).toEqual([]);
    await e.stop();
  });

  it("purpose appears while pending → painted without asking (periodic pass and group-memory event)", async () => {
    const { w, e, writer } = await world({ targets: [IDS.a, IDS.b] });
    expect(picture(e, w, IDS.a)).toBe("pending");
    w.setPurpose(IDS.a, PURPOSE_A);
    await e.runPass("periodic");
    await step(w, e);
    expect(picture(e, w, IDS.a)).toBe("accepted (purpose-known)");
    expect(painted(w, IDS.a)).toBe(true);
    expect(writer.calls.find((c) => c.purpose === PURPOSE_A)).toBeTruthy();
    // The group-memory event re-reads it too.
    w.setPurpose(IDS.b, "Parents organising the school bake sale.");
    await e.groupNamed(`group:${IDS.b}`, "Placeholder Name");
    await step(w, e);
    expect(picture(e, w, IDS.b)).toBe("accepted (purpose-known)");
    expect(painted(w, IDS.b)).toBe(true);
    expect(await turn(w, e, IDS.a)).toBeNull();
    expect(await turn(w, e, IDS.b)).toBeNull();
    await e.stop();
  });
});

describe("the agent asks, once, in its own reply (ARCH §2c.14)", () => {
  it("a turn in that session gets the ask text; other sessions and direct chats never do", async () => {
    const { w, e } = await world({ targets: [IDS.a, IDS.b], purposes: { [IDS.b]: PURPOSE_A } });
    expect(await turn(w, e, IDS.a)).toBe(ASK_TEXT);
    // Another group (painted), a direct chat, another agent's session of the same group,
    // a thread under the group, a cron or subagent session: nothing.
    expect(await turn(w, e, IDS.b)).toBeNull();
    for (const key of [
      "agent:main:signal:direct:+10000000099",
      "agent:main:main",
      `agent:other:signal:group:${IDS.a.toLowerCase()}`,
      `agent:main:signal:group:${IDS.a.toLowerCase()}:thread:1`,
      "agent:main:cron:job-1",
      "agent:main:subagent:x",
      undefined,
    ]) {
      expect(await e.promptContext(key), String(key)).toBeNull();
    }
    // The extension sent nothing.
    expect(w.targetSends(IDS.a)).toEqual([]);
    await e.stop();
  });

  it("delivered reply → asked; a silent turn stays pending and the line comes again", async () => {
    const { w, e } = await world();
    // A delivered reply before any ask was injected does not count.
    expect(await delivered(w, e, IDS.a)).toBe(false);
    expect(picture(e, w, IDS.a)).toBe("pending");
    // Silent turn: the ask is injected but nothing is delivered.
    expect(await turn(w, e, IDS.a)).toBe(ASK_TEXT);
    expect(picture(e, w, IDS.a)).toBe("pending");
    // Next turn carries it again; its reply is delivered → asked.
    expect(await turn(w, e, IDS.a)).toBe(ASK_TEXT);
    expect(await delivered(w, e, IDS.a)).toBe(true);
    expect(picture(e, w, IDS.a)).toBe("asked");
    // Only the first delivery counts; later ones change nothing.
    expect(await delivered(w, e, IDS.a)).toBe(false);
    // While asked, turns carry the answer line, never the ask again.
    expect(await turn(w, e, IDS.a)).toBe(ANSWER_TEXT);
    expect(w.targetSends(IDS.a)).toEqual([]);
    await e.stop();
  });

  it("a success:false event leaves the group pending", async () => {
    const { w, e } = await world();
    expect(await turn(w, e, IDS.a)).toBe(ASK_TEXT);
    expect(await delivered(w, e, IDS.a, false)).toBe(false);
    expect(picture(e, w, IDS.a)).toBe("pending");
    await e.stop();
  });

  it("a delivery of another session (another group, a direct chat) never marks this group", async () => {
    const { w, e } = await world({ targets: [IDS.a, IDS.b] });
    expect(await turn(w, e, IDS.a)).toBe(ASK_TEXT);
    expect(await delivered(w, e, IDS.b)).toBe(false);
    expect(await e.replyDelivered("agent:main:signal:direct:+10000000099", true)).toBe(false);
    expect(picture(e, w, IDS.a)).toBe("pending");
    expect(picture(e, w, IDS.b)).toBe("pending");
    await e.stop();
  });
});

describe("the answer (ARCH §2c.14)", () => {
  async function asked(opts: Opts = {}) {
    const x = await world(opts);
    await turn(x.w, x.e, IDS.a);
    await delivered(x.w, x.e, IDS.a);
    expect(picture(x.e, x.w, IDS.a)).toBe("asked");
    return x;
  }

  it("picture yes with purpose → writer input, painted", async () => {
    const { w, e, writer, act } = await asked();
    const r = await act(MEMBER, IDS.a, "picture", { decision: "yes", purpose: PURPOSE_ANSWER });
    expect(r.ok).toBe(true);
    await step(w, e);
    expect(picture(e, w, IDS.a)).toBe("accepted (answer)");
    expect(writer.calls.at(-1)!.purpose).toBe(PURPOSE_ANSWER);
    expect(painted(w, IDS.a)).toBe(true);
    expect(await turn(w, e, IDS.a)).toBeNull();
    await e.stop();
  });

  it("picture yes without a purpose paints from the motif or name", async () => {
    const { w, e, act } = await asked();
    expect((await act(MEMBER, IDS.a, "picture", { decision: "yes" })).ok).toBe(true);
    await step(w, e);
    expect(painted(w, IDS.a)).toBe(true);
    await e.stop();
  });

  it("picture no → never painted, no more text", async () => {
    const { w, e, act } = await asked();
    expect((await act(MEMBER, IDS.a, "picture", { decision: "no" })).ok).toBe(true);
    expect(picture(e, w, IDS.a)).toBe("declined");
    await e.runPass("periodic");
    await w.settle(DAY);
    expect(w.targetSends(IDS.a)).toEqual([]);
    expect(await turn(w, e, IDS.a)).toBeNull();
    // Purpose becoming known later does not paint either.
    w.setPurpose(IDS.a, PURPOSE_A);
    await e.runPass("periodic");
    await step(w, e);
    expect(w.targetSends(IDS.a)).toEqual([]);
    await e.stop();
  });

  it("expiry → declined (no-answer), the line stops", async () => {
    const { w, e } = await asked({ ask: { expireMs: 2 * DAY } });
    expect(await turn(w, e, IDS.a)).toBe(ANSWER_TEXT);
    await w.clock.advance(2 * DAY);
    expect(await turn(w, e, IDS.a)).toBeNull();
    expect(picture(e, w, IDS.a)).toBe("declined (no-answer)");
    expect(w.targetSends(IDS.a)).toEqual([]);
    await e.stop();
  });

  it("expiry is also applied by the periodic pass, without a turn", async () => {
    const { w, e } = await asked({ ask: { expireMs: DAY } });
    await w.clock.advance(DAY + 1);
    await e.runPass("periodic");
    expect(picture(e, w, IDS.a)).toBe("declined (no-answer)");
    await e.stop();
  });

  it("purpose known while asked → still not painted (only an answer paints)", async () => {
    const { w, e } = await asked();
    w.setPurpose(IDS.a, PURPOSE_A);
    await e.runPass("periodic");
    await e.groupNamed(`group:${IDS.a}`, "Placeholder Name");
    await step(w, e);
    expect(picture(e, w, IDS.a)).toBe("asked");
    expect(w.targetSends(IDS.a)).toEqual([]);
    await e.stop();
  });

  it("member of another group refused, operator allowed; the profile is not asked about", async () => {
    const { w, e, act } = await world({ targets: [IDS.a, IDS.b] });
    const r = await act(MEMBER, IDS.b, "picture", { decision: "yes", target: IDS.a });
    expect(r.ok).toBe(false);
    expect(r.details).toMatchObject({ refused: true });
    expect(picture(e, w, IDS.a)).toBe("pending");
    // No sender at all: refused.
    const anon = await createActions({
      engines: () => [e],
      steering: () => null,
      operators: () => [OP],
      allowGroupMembers: () => true,
      purge: async () => {},
    })("picture", { decision: "yes" }, { senderId: null, engine: e, here: null });
    expect(anon.details).toMatchObject({ refused: true });
    const ok = await act(OP, IDS.b, "picture", {
      decision: "yes",
      target: IDS.a,
      purpose: PURPOSE_ANSWER,
    });
    expect(ok.ok).toBe(true);
    await step(w, e);
    expect(picture(e, w, IDS.a)).toBe("accepted (answer)");
    expect(painted(w, IDS.a)).toBe(true);
    expect((await act(OP, IDS.b, "picture", { decision: "yes", target: "profile" })).ok).toBe(
      false,
    );
    await e.stop();
  });

  it("an operator can declare a group's purpose before it is first seen", async () => {
    const { w, e, act, writer } = await world({ targets: [] });
    const r = await act(OP, IDS.b, "picture", {
      decision: "yes",
      target: IDS.c,
      purpose: PURPOSE_ANSWER,
    });
    expect(r.ok).toBe(true);
    w.addTarget(IDS.c);
    await e.runPass("periodic");
    await step(w, e);
    expect(picture(e, w, IDS.c)).toBe("accepted (answer)");
    expect(painted(w, IDS.c)).toBe(true);
    expect(writer.calls.at(-1)!.purpose).toBe(PURPOSE_ANSWER);
    await e.stop();
  });

  it("a purpose over 300 characters or a bad decision is refused", async () => {
    const { w, e, act } = await asked();
    const long = "x".repeat(PURPOSE_MAX_CHARS + 1);
    expect((await act(MEMBER, IDS.a, "picture", { decision: "yes", purpose: long })).ok).toBe(
      false,
    );
    expect((await act(MEMBER, IDS.a, "picture", { decision: "maybe" })).ok).toBe(false);
    expect(picture(e, w, IDS.a)).toBe("asked");
    expect(cleanPurpose("  one\nsentence  ")).toEqual({ ok: true, purpose: "one sentence" });
    await e.stop();
  });
});

describe("regenerate counts as yes (ARCH §2c.14)", () => {
  for (const state of ["pending", "asked", "declined"] as const) {
    it(`regenerate on a ${state} group paints`, async () => {
      const { w, e, act } = await world();
      if (state !== "pending") {
        await turn(w, e, IDS.a);
        await delivered(w, e, IDS.a);
      }
      if (state === "declined") {
        await act(MEMBER, IDS.a, "picture", { decision: "no" });
      }
      expect(picture(e, w, IDS.a)).toBe(state);
      const r = await act(MEMBER, IDS.a, "regenerate");
      expect(r.ok).toBe(true);
      await step(w, e);
      expect(picture(e, w, IDS.a)).toBe("accepted (regenerate)");
      expect(painted(w, IDS.a)).toBe(true);
      await e.stop();
    });
  }
});

describe("ask.mode (ARCH §2c.14)", () => {
  it("paint: the behaviour before asking, a name-only scene and no question", async () => {
    const { w, e, writer } = await world({
      ask: { mode: "paint" },
      purposes: { [IDS.a]: PURPOSE_A },
    });
    await e.groupNamed(IDS.a, "Placeholder Name");
    await step(w, e);
    expect(painted(w, IDS.a)).toBe(true);
    expect(await turn(w, e, IDS.a)).toBeNull();
    expect(writer.calls.at(-1)).toMatchObject({ name: "Placeholder Name" });
    expect(writer.calls.every((c) => c.purpose === undefined)).toBe(true);
    await e.stop();
  });

  it("skip: never painted, never asked", async () => {
    const { w, e } = await world({ ask: { mode: "skip" } });
    expect(picture(e, w, IDS.a)).toBe("pending");
    expect(await turn(w, e, IDS.a)).toBeNull();
    await e.runPass("periodic");
    await w.settle(DAY);
    expect(w.targetSends(IDS.a)).toEqual([]);
    await e.stop();
  });

  it("switching ask → paint releases pending and asked groups", async () => {
    const { w, e } = await world({ targets: [IDS.a, IDS.b] });
    await turn(w, e, IDS.b);
    await delivered(w, e, IDS.b);
    w.setPlugin({ ask: { mode: "paint" } });
    await e.runPass("periodic");
    await step(w, e);
    expect(picture(e, w, IDS.a)).toBe("accepted (ask-mode-paint)");
    expect(picture(e, w, IDS.b)).toBe("accepted (ask-mode-paint)");
    expect(painted(w, IDS.a)).toBe(true);
    expect(painted(w, IDS.b)).toBe(true);
    await e.stop();
  });

  it("config validation: an unknown mode or a bad expireMs is an error", () => {
    const bad = normalizeConfig(
      { ask: { mode: "maybe", expireMs: -1 } },
      { gatewayStateDir: "/s" },
    );
    expect(bad.ok).toBe(false);
    const errors = bad.ok ? [] : bad.errors;
    expect(errors.join(" ")).toMatch(/ask\.mode/);
    expect(errors.join(" ")).toMatch(/ask\.expireMs/);
    const def = normalizeConfig({}, { gatewayStateDir: "/s" }).config.ask;
    expect(def).toEqual({ mode: "ask", expireMs: 7 * DAY });
  });
});

describe("never asked: adopted art, excluded groups, the profile, targets already painted (ARCH §2c.14)", () => {
  it("adopted art: painted over its own artwork, never asked", async () => {
    const { w, e } = await world({ avatars: { [IDS.a]: OWN } });
    expect(picture(e, w, IDS.a)).toBeNull();
    expect(painted(w, IDS.a)).toBe(true);
    expect(await turn(w, e, IDS.a)).toBeNull();
    await e.stop();
  });

  it("excluded groups: never asked, never painted", async () => {
    const { w, e } = await world({
      targets: [IDS.a, IDS.b],
      plugin: { signal: { groups: { mode: "exclude", ids: [IDS.a] } } },
    });
    expect(picture(e, w, IDS.a)).toBeNull();
    expect(await turn(w, e, IDS.a)).toBeNull();
    expect(w.targetSends(IDS.a)).toEqual([]);
    expect(picture(e, w, IDS.b)).toBe("pending");
    await e.stop();
  });

  it("the profile: painted as before, never asked", async () => {
    const { w, e } = await world({ profile: true, targets: [IDS.a] });
    const profileKey = "agent:main:signal:direct:+10000000001";
    expect(await e.promptContext(profileKey)).toBeNull();
    expect(w.sends().some((s) => s.kind === "profile")).toBe(true);
    await e.stop();
  });

  it("a target painted before this section (ask.mode was paint) is never asked after the switch", async () => {
    const w = await createWorld({ targets: [IDS.a], plugin: { imageGen: LOCAL_CMD } });
    const e1 = await w.startEngine({ imageGenerator: fakeImageGen(), sceneWriter: fakeWriter() });
    await step(w, e1);
    expect(painted(w, IDS.a)).toBe(true);
    await e1.stop();
    // Records from before §2c.14 have no picture entry at all.
    w.fs.files.delete(`${w.paths.stateDir}/pictures/pictures.json`);
    w.setPlugin({ ask: { mode: "ask" } });
    const e2 = await w.startEngine({ imageGenerator: fakeImageGen(), sceneWriter: fakeWriter() });
    await step(w, e2);
    expect(e2.pictureState(w.tk(IDS.a))).toBeNull();
    expect(await e2.promptContext(w.sk(IDS.a))).toBeNull();
    const before = w.targetSends(IDS.a).length;
    await e2.repaint(w.tk(IDS.a));
    await step(w, e2);
    expect(w.targetSends(IDS.a).length).toBeGreaterThan(before);
    await e2.stop();
  });
});

describe("state survives restart (ARCH §2c.14)", () => {
  it("pending, injected, asked and declined are kept across a restart; removing the target drops it", async () => {
    const { w, e } = await world({ targets: [IDS.a, IDS.b] });
    await turn(w, e, IDS.a);
    await e.stop();
    // Restart between the injection and the delivery: the delivery still counts.
    const e2 = await w.startEngine({ imageGenerator: fakeImageGen(), sceneWriter: fakeWriter() });
    await step(w, e2);
    expect(e2.pictureState(w.tk(IDS.a))).toBe("pending");
    expect(await e2.replyDelivered(w.sk(IDS.a), true)).toBe(true);
    expect(e2.pictureState(w.tk(IDS.a))).toBe("asked");
    await e2.stop();
    const e3 = await w.startEngine({ imageGenerator: fakeImageGen(), sceneWriter: fakeWriter() });
    await step(w, e3);
    expect(e3.pictureState(w.tk(IDS.a))).toBe("asked");
    expect(e3.pictureState(w.tk(IDS.b))).toBe("pending");
    expect(await e3.promptContext(w.sk(IDS.a))).toBe(ANSWER_TEXT);
    // §3.3: a removed target drops its picture state.
    w.backend.dropTarget(IDS.b);
    await e3.runPass("periodic");
    const file = w.fs.getJson<{ targets: Record<string, unknown> }>(
      `${w.paths.stateDir}/pictures/pictures.json`,
    );
    expect(Object.keys(file.targets)).toHaveLength(1);
    await e3.stop();
  });
});

describe("slash/tool parity for picture (ARCH §2c.1, §2c.14)", () => {
  it("/badge picture yes|no [target] [purpose] runs the same action", async () => {
    const { w, e, slash } = await world({ targets: [IDS.a, IDS.b] });
    const inGroup = (id: string) => ({
      channel: "signal",
      from: `signal:group:${id}`,
      to: `group:${id}`,
    });
    const r = await slash({
      ...inGroup(IDS.a),
      senderId: MEMBER,
      args: `picture yes ${PURPOSE_ANSWER}`,
    });
    expect(r.text).toMatch(/gets a picture/);
    expect(picture(e, w, IDS.a)).toBe("accepted (answer)");
    // A named target: the operator, from another chat.
    const r2 = await slash({ ...inGroup(IDS.a), senderId: OP, args: `picture no ${IDS.b}` });
    expect(r2.text).toMatch(/no picture/);
    expect(picture(e, w, IDS.b)).toBe("declined");
    // Usage on a bad decision.
    expect(
      (await slash({ ...inGroup(IDS.a), senderId: MEMBER, args: "picture maybe" })).text,
    ).toMatch(/Usage/);
    await e.stop();
  });

  it("status shows picture: pending | asked | accepted | declined (reason)", async () => {
    const { w, e, act } = await world();
    expect((await act(MEMBER, IDS.a, "status")).text).toContain("Picture: pending");
    await turn(w, e, IDS.a);
    await delivered(w, e, IDS.a);
    expect((await act(MEMBER, IDS.a, "status")).text).toContain("Picture: asked");
    await act(MEMBER, IDS.a, "picture", { decision: "yes" });
    expect((await act(MEMBER, IDS.a, "status")).text).toContain("Picture: accepted (answer)");
    await e.stop();
  });
});

describe("privacy: the injected texts, logs and the image backend (ARCH §2c.14)", () => {
  it("injected texts contain no name or id (fixture asserts)", async () => {
    const NAME = "Placeholder Garden Group";
    const { w, e } = await world({ targets: [IDS.a] });
    await e.groupNamed(IDS.a, NAME);
    const ask = (await turn(w, e, IDS.a))!;
    await delivered(w, e, IDS.a);
    const answer = (await turn(w, e, IDS.a))!;
    for (const text of [ask, answer]) {
      expect(text).not.toContain(NAME);
      expect(text.toLowerCase()).not.toContain(IDS.a.toLowerCase());
      expect(text).not.toMatch(/\+?\d{6,}/);
      expect(text).not.toMatch(/[A-Za-z0-9+/=]{20,}/);
      expect(text.length).toBeLessThan(400);
    }
    await e.stop();
  });

  it("logs carry no group id, name or purpose text", async () => {
    const NAME = "Placeholder Garden Group";
    const { w, e, act } = await world({
      targets: [IDS.a, IDS.b],
      purposes: { [IDS.b]: PURPOSE_A },
    });
    await e.groupNamed(IDS.a, NAME);
    await turn(w, e, IDS.a);
    await delivered(w, e, IDS.a);
    await act(MEMBER, IDS.a, "picture", { decision: "yes", purpose: PURPOSE_ANSWER });
    await step(w, e);
    const all = JSON.stringify(w.log.lines);
    expect(all).toMatch(/picture is accepted/);
    for (const secret of [
      NAME,
      PURPOSE_A,
      PURPOSE_ANSWER,
      IDS.a,
      IDS.a.toLowerCase(),
      IDS.b.toLowerCase(),
    ]) {
      expect(all).not.toContain(secret);
    }
    await e.stop();
  });

  it("non-private imageGen → the purpose never reaches a prompt (motif scene)", async () => {
    const remote = {
      kind: "openai-images",
      baseUrl: "https://images.example.invalid",
      model: "m",
      apiKey: { source: "env", provider: "default", id: "K" },
    };
    const { w, e, gen, writer, act } = await world({
      imageGen: remote,
      targets: [IDS.a, IDS.b],
      purposes: { [IDS.b]: PURPOSE_A },
    });
    await turn(w, e, IDS.a);
    await delivered(w, e, IDS.a);
    await act(MEMBER, IDS.a, "picture", { decision: "yes", purpose: PURPOSE_ANSWER });
    await step(w, e);
    expect(writer.calls).toEqual([]);
    expect(gen.prompts.length).toBeGreaterThan(0);
    expect(painted(w, IDS.a)).toBe(true);
    expect(painted(w, IDS.b)).toBe(true);
    for (const p of gen.prompts) {
      expect(p.prompt).not.toContain(PURPOSE_A);
      expect(p.prompt).not.toContain(PURPOSE_ANSWER);
      expect(p.prompt).not.toContain("garden");
    }
    expect(e.targetSummary(w.tk(IDS.b))!.scene).toMatchObject({ source: "motif" });
    await e.stop();
  });
});

describe("plugin hooks (ARCH §2c.14)", () => {
  async function wired(e: Engine) {
    const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    let service: { start: (ctx: unknown) => Promise<void> } | undefined;
    registerModelBadge(
      createTestPluginApi({
        id: "model-badge",
        name: "Model Badge",
        source: "test",
        config: {},
        runtime: {} as never,
        registerService: ((s: typeof service) => void (service = s)) as never,
        registerCommand: () => {},
        registerTool: () => {},
        on: ((name: string, fn: (event: unknown, ctx: unknown) => unknown) =>
          void hooks.set(name, fn)) as never,
      }),
      {
        buildRuntime: async () =>
          ({
            config: normalizeConfig({}, { gatewayStateDir: "/virtual/state" }).config,
            engines: [e],
            errors: [],
            start: async () => {},
            stop: async () => {},
          }) as never,
      },
    );
    await service!.start({ config: {}, stateDir: "/virtual/state", logger: console });
    return {
      prompt: (ctx: Record<string, unknown>) =>
        Promise.resolve(hooks.get("before_prompt_build")!({ prompt: "hi", messages: [] }, ctx)),
      sent: (event: Record<string, unknown>, ctx: Record<string, unknown>) =>
        Promise.resolve(hooks.get("message_sent")!(event, ctx)),
    };
  }

  it("before_prompt_build injects only into the group's own user turn; message_sent marks asked", async () => {
    const { w, e } = await world({ targets: [IDS.a, IDS.b] });
    const h = await wired(e);
    // Not a user turn (heartbeat, cron, memory flush): nothing.
    expect(await h.prompt({ sessionKey: w.sk(IDS.a), trigger: "heartbeat" })).toBeUndefined();
    expect(await h.prompt({ sessionKey: w.sk(IDS.a), trigger: "memory" })).toBeUndefined();
    // Direct chat and no session: nothing.
    expect(
      await h.prompt({ sessionKey: "agent:main:signal:direct:+10000000099", trigger: "user" }),
    ).toBeUndefined();
    expect(await h.prompt({ trigger: "user" })).toBeUndefined();
    // The group's own turn.
    expect(await h.prompt({ sessionKey: w.sk(IDS.a), trigger: "user" })).toEqual({
      prependContext: ASK_TEXT,
    });
    // A failed send and a send without a session change nothing.
    await h.sent(
      { to: `group:${IDS.a}`, content: "x", success: false, error: "e" },
      { channelId: "signal", sessionKey: w.sk(IDS.a) },
    );
    await h.sent({ to: `group:${IDS.a}`, content: "x", success: true }, { channelId: "signal" });
    // Another channel's send with the same session key shape does not count.
    await h.sent(
      { to: `group:${IDS.a}`, content: "x", success: true },
      { channelId: "telegram", sessionKey: w.sk(IDS.a) },
    );
    expect(picture(e, w, IDS.a)).toBe("pending");
    await h.sent(
      { to: `group:${IDS.a}`, content: "x", success: true },
      { channelId: "signal", sessionKey: w.sk(IDS.a) },
    );
    expect(picture(e, w, IDS.a)).toBe("asked");
    expect(picture(e, w, IDS.b)).toBe("pending");
    expect(await h.prompt({ sessionKey: w.sk(IDS.a), trigger: "user" })).toEqual({
      prependContext: ANSWER_TEXT,
    });
    // The extension itself never sent a message.
    expect(w.sends()).toEqual([]);
    await e.stop();
  });
});
