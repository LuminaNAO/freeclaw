// ARCH §2c.7: agentic first, image first — slash/tool parity, authority on the
// gateway-provided sender id, regenerate gives a new picture, image-first selection.
import { describe, expect, it } from "vitest";
import { ACTIONS, createActions } from "./actions.js";
import { createBadgeCommand, SLASH_SUBCOMMANDS } from "./commands.js";
import { buildPrompt, createOpenAiImagesGenerator, type BaseArtGenerator } from "./core/baseart.js";
import { IMAGE_DEFAULTS, normalizeConfig } from "./core/config.js";
import type { Engine } from "./core/engine.js";
import { imageSeedFor, seedFor } from "./core/motif.js";
import { createSteering } from "./core/steering.js";
import { createStyleStore } from "./core/style.js";
import { fakePng } from "./test-helpers/fakes.js";
import { createWorld, IDS, type World } from "./test-helpers/world.js";
import { BADGE_TOOL, createBadgeTool, STYLE_TOOL, TOOL_DESCRIPTION } from "./tool.js";

const OP = "+10000000002";
const MEMBER = "+10000000077";

function fakeImageGen(opts: { up?: () => boolean; fail?: (seed: string) => boolean } = {}) {
  const calls: Array<{ seed: string; prompt: string; portrait: boolean }> = [];
  const gen: BaseArtGenerator & { calls: typeof calls } = {
    id: "fake-image:v1",
    calls,
    available: async () => opts.up?.() ?? true,
    async generate(target, style) {
      const prompt = buildPrompt(target, style);
      calls.push({ seed: target.seed, prompt, portrait: Boolean(target.portrait) });
      if (opts.fail?.(target.seed)) {
        throw new Error("backend error");
      }
      return fakePng(1024, 1024, `image ${prompt} ${target.seed}`);
    },
  };
  return gen;
}

const IMAGE_CFG = { kind: "command", command: "/opt/fake/gen", maxPerDay: 50, maxPerRun: 50 };
const imgSeed = (id: string, g = 0) => imageSeedFor("signal", id.toLowerCase(), g);

// Whether an avatar that was sent is composited on an image base (vs vector art).
const isImage = (w: World, avatar: string) =>
  w.fs.files.get(avatar)!.data.toString().includes("<image");

async function world(
  opts: {
    image?: Record<string, unknown> | null;
    gen?: BaseArtGenerator | null;
    allowGroupMembers?: boolean;
    targets?: string[];
    profile?: boolean;
    timing?: Record<string, number>;
  } = {},
) {
  const steeringCfg =
    opts.allowGroupMembers === undefined ? {} : { allowGroupMembers: opts.allowGroupMembers };
  const w = await createWorld({
    targets: opts.targets ?? [IDS.a, IDS.b],
    profile: opts.profile,
    plugin: {
      ...(opts.image ? { imageGen: opts.image } : {}),
      steering: steeringCfg,
    },
    timing: { imageGenBackoffMs: 60_000, ...opts.timing },
  });
  const e = await w.startEngine({ imageGenerator: opts.gen ?? null });
  await w.settle();
  const cfg = normalizeConfig(w.pluginConfig(), { gatewayStateDir: "/s" }).config;
  const steering = createSteering({
    engines: () => [e],
    store: createStyleStore({ fs: w.fs, stateDir: w.paths.rootDir }),
    operators: () => cfg.operators,
    allowGroupMembers: () => cfg.steering.allowGroupMembers,
    configRules: () => [],
    now: () => w.clock.now(),
  });
  let purged = false;
  const deps = {
    engines: () => [e] as Engine[],
    steering: () => steering,
    operators: () => cfg.operators,
    allowGroupMembers: () => cfg.steering.allowGroupMembers,
    purge: async () => {
      purged = true;
    },
    now: () => w.clock.now(),
  };
  // The gateway hands the tool factory the authenticated sender and the session key.
  const tool = (senderId: string | undefined, groupId: string | null, name = BADGE_TOOL) =>
    createBadgeTool({
      ...deps,
      name: name as typeof BADGE_TOOL,
      senderId,
      sessionKey: groupId ? w.sk(groupId) : undefined,
    });
  const call = async (
    senderId: string | undefined,
    groupId: string | null,
    args: Record<string, unknown>,
  ) =>
    (
      (await tool(senderId, groupId).execute("c", args)) as {
        details: Record<string, unknown> & { ok: boolean; message: string };
      }
    ).details;
  const slash = createBadgeCommand(deps);
  const inGroup = (id: string) => ({
    channel: "signal",
    from: `signal:group:${id}`,
    to: `group:${id}`,
  });
  return { w, e, steering, tool, call, slash, inGroup, cfg, purged: () => purged };
}

describe("one agent tool covers every /badge subcommand (ARCH §2c.1)", () => {
  it("parity enumeration: every slash subcommand has a tool action, and every action a subcommand", async () => {
    const { tool, e } = await world();
    const schema = tool(OP, IDS.a).parameters as {
      properties: { action: { anyOf: Array<{ const: string }> } };
    };
    const toolActions = schema.properties.action.anyOf.map((x) => x.const);
    const slashActions = Object.values(SLASH_SUBCOMMANDS).map((s) => s.action);
    for (const [name, sub] of Object.entries(SLASH_SUBCOMMANDS)) {
      expect(toolActions, `/badge ${name}`).toContain(sub.action);
    }
    expect([...toolActions].toSorted()).toEqual([...ACTIONS].toSorted());
    expect([...new Set(slashActions)].toSorted()).toEqual([...ACTIONS].toSorted());
    // The documented subcommand list is exactly the table the parser runs on.
    expect(Object.keys(SLASH_SUBCOMMANDS).toSorted()).toEqual(
      [
        "status",
        "repaint",
        "regenerate",
        "restore",
        "audit",
        "purge",
        "style list",
        "style preview",
        "style add",
        "style remove",
        "style reset",
      ].toSorted(),
    );
    await e.stop();
  });

  it("the same subcommand and tool action give the same result", async () => {
    const { w, e, call, slash, inGroup } = await world();
    const rule = { match: { modelGlob: "*fable*" }, set: { hue: "green" } };
    const pairs: Array<[string, Record<string, unknown>]> = [
      ["status", { action: "status" }],
      ["audit", { action: "audit" }],
      ["style list", { action: "style.list" }],
      [`style preview ${JSON.stringify(rule)}`, { action: "style.preview", rules: [rule] }],
      ["regenerate this", { action: "regenerate" }],
      ["purge", { action: "purge" }],
    ];
    for (const [args, toolArgs] of pairs) {
      const viaSlash = (await slash({ ...inGroup(IDS.a), senderId: OP, args })).text;
      const viaTool = (await call(OP, IDS.a, toolArgs)).message;
      expect(viaTool, args).toBe(viaSlash);
    }
    const n = w.sends().length;
    expect((await call(OP, IDS.a, { action: "repaint" })).message).toBe("Repaint queued.");
    await w.settle();
    expect(w.sends()).toHaveLength(n + 1);
    await e.stop();
  });

  it("purge stays operator-only by slash and tool alike, and needs confirm", async () => {
    const { e, call, slash, inGroup, purged } = await world();
    const m = await call(MEMBER, IDS.a, { action: "purge", confirm: true });
    expect(m).toMatchObject({ ok: false, refused: true });
    expect(m.message).toMatch(/operators only/);
    expect((await slash({ ...inGroup(IDS.a), senderId: MEMBER, args: "purge confirm" })).text).toBe(
      m.message,
    );
    expect(purged()).toBe(false);
    expect((await call(OP, IDS.a, { action: "purge" })).ok).toBe(false);
    expect(purged()).toBe(false);
    expect((await call(OP, IDS.a, { action: "purge", confirm: true })).ok).toBe(true);
    expect(purged()).toBe(true);
    await e.stop();
  });

  it("the old tool name is an alias with the old short actions", async () => {
    const { w, e, tool } = await world();
    const alias = tool(OP, IDS.a, STYLE_TOOL);
    expect(alias.name).toBe(STYLE_TOOL);
    const r = (await alias.execute("c", {
      action: "add",
      rules: [{ match: { modelGlob: "*fable*" }, set: { tone: "dark" } }],
    })) as { details: { ok: boolean } };
    expect(r.details.ok).toBe(true);
    expect(w.fs.exists(`${w.paths.rootDir}/style.json`)).toBe(true);
    const s = (await alias.execute("c", { action: "status" })) as { details: { ok: boolean } };
    expect(s.details.ok).toBe(true);
    await e.stop();
  });

  it("the tool tells the agent it can restyle, repaint and regenerate on request, preview first", () => {
    expect(TOOL_DESCRIPTION).toMatch(/restyle, repaint and regenerate/);
    expect(TOOL_DESCRIPTION).toMatch(/member/);
    expect(TOOL_DESCRIPTION).toMatch(/style\.preview first/);
    expect(TOOL_DESCRIPTION).toMatch(/only after the user confirms/);
    expect(TOOL_DESCRIPTION).toMatch(/says why and who can/);
  });
});

describe("authority on the gateway-provided sender id (ARCH §2c.2)", () => {
  it("steering.allowGroupMembers defaults to true; false restores operator-only", () => {
    expect(normalizeConfig({}, { gatewayStateDir: "/s" }).config.steering.allowGroupMembers).toBe(
      true,
    );
    expect(
      normalizeConfig({ steering: { allowGroupMembers: false } }, { gatewayStateDir: "/s" }).config
        .steering.allowGroupMembers,
    ).toBe(false);
  });

  it("a member may restyle, repaint, regenerate and check the status of their own group", async () => {
    const gen = fakeImageGen();
    const { w, e, call } = await world({ image: IMAGE_CFG, gen });
    const st = await call(MEMBER, IDS.a, { action: "status" });
    expect(st.ok).toBe(true);
    expect(st.target).toBe(w.tk(IDS.a));
    const preview = await call(MEMBER, IDS.a, {
      action: "style.preview",
      rules: [{ match: { targetId: "this" }, set: { prompt: "watercolour ocean" } }],
    });
    expect(preview.ok).toBe(true);
    const sends = w.sends().length;
    const add = await call(MEMBER, IDS.a, {
      action: "style.add",
      rules: [{ match: { targetId: "this" }, set: { prompt: "watercolour ocean" } }],
    });
    expect(add.ok).toBe(true);
    await w.settle();
    expect(gen.calls.at(-1)!.prompt).toContain("watercolour ocean");
    expect(
      w
        .sends()
        .slice(sends)
        .map((s) => s.target),
    ).toEqual([IDS.a]);
    expect((await call(MEMBER, IDS.a, { action: "repaint" })).ok).toBe(true);
    expect((await call(MEMBER, IDS.a, { action: "regenerate", target: "this" })).ok).toBe(true);
    expect((await call(MEMBER, IDS.a, { action: "audit" })).ok).toBe(true);
    await e.stop();
  });

  it("a member is refused for another group and for global rules, with the reason and who can", async () => {
    const { w, e, call } = await world();
    for (const args of [
      { action: "repaint", target: IDS.b },
      { action: "regenerate", target: IDS.b },
      { action: "status", target: IDS.b },
      { action: "status", all: true },
      { action: "repaint", target: "profile" },
    ]) {
      const r = await call(MEMBER, IDS.a, args);
      expect(r, JSON.stringify(args)).toMatchObject({ ok: false, refused: true });
      expect(r.message).toMatch(/^Refused: .+\. Who can: .+\.$/);
    }
    const other = await call(MEMBER, IDS.a, {
      action: "style.add",
      rules: [{ match: { targetId: IDS.b.toLowerCase() }, set: { hue: "red" } }],
    });
    expect(other.ok).toBe(false);
    expect(other.message).toMatch(/only add rules for the group they are in/);
    const global = await call(MEMBER, IDS.a, {
      action: "style.add",
      rules: [{ match: { provider: "prov" }, set: { tone: "dark" } }],
    });
    expect(global.ok).toBe(false);
    expect(global.message).toMatch(/operator-only/);
    const reset = await call(MEMBER, IDS.a, { action: "style.reset" });
    expect(reset).toMatchObject({ ok: false, refused: true });
    // Outside a group chat (a DM) a non-operator has no group to act on.
    expect(await call(MEMBER, null, { action: "repaint", target: IDS.a })).toMatchObject({
      ok: false,
      refused: true,
    });
    // No authenticated sender at all: refused.
    expect(await call(undefined, IDS.a, { action: "repaint" })).toMatchObject({
      ok: false,
      refused: true,
    });
    expect(w.fs.exists(`${w.paths.rootDir}/style.json`)).toBe(false);
    await e.stop();
  });

  it("tool arguments cannot claim another sender or group", async () => {
    const { e, call } = await world();
    const r = await call(MEMBER, IDS.a, {
      action: "repaint",
      target: IDS.b,
      senderId: OP,
      sessionKey: "agent:main:signal:group:" + IDS.b.toLowerCase(),
      fromTargetId: IDS.b.toLowerCase(),
    });
    expect(r).toMatchObject({ ok: false, refused: true });
    await e.stop();
  });

  it("an operator may act everywhere, from any chat", async () => {
    const { w, e, call } = await world();
    expect((await call(OP, IDS.a, { action: "repaint", target: IDS.b })).ok).toBe(true);
    expect((await call(OP, null, { action: "status", all: true })).ok).toBe(true);
    const g = await call(OP, IDS.a, {
      action: "style.add",
      rules: [{ match: { modelGlob: "*fable*" }, set: { tone: "dark" } }],
    });
    expect(g.ok).toBe(true);
    const o = await call(OP, IDS.a, {
      action: "style.add",
      rules: [{ match: { targetId: IDS.b.toLowerCase() }, set: { hue: "red" } }],
    });
    expect(o.ok).toBe(true);
    expect((await call(OP, null, { action: "style.reset" })).ok).toBe(true);
    await w.settle();
    expect((await call(OP, null, { action: "audit" })).message).toMatch(/2\/2 converged/);
    await e.stop();
  });

  it("with allowGroupMembers false a member is refused everything; operators are not", async () => {
    const { e, call } = await world({ allowGroupMembers: false });
    for (const action of ["status", "repaint", "regenerate", "audit", "style.list"]) {
      const r = await call(MEMBER, IDS.a, { action });
      expect(r, action).toMatchObject({ ok: false, refused: true });
      expect(r.message).toMatch(/allowGroupMembers is off/);
    }
    expect((await call(OP, IDS.a, { action: "repaint" })).ok).toBe(true);
    await e.stop();
  });

  it("the dispatcher is the single authority check for slash and tool", async () => {
    const { e, slash, inGroup } = await world();
    expect(
      (await slash({ ...inGroup(IDS.a), senderId: MEMBER, args: `repaint ${IDS.b}` })).text,
    ).toMatch(/^Refused: repaint of another group/);
    expect((await slash({ ...inGroup(IDS.a), senderId: MEMBER, args: "repaint" })).text).toBe(
      "Repaint queued.",
    );
    const run = createActions({
      engines: () => [e],
      steering: () => null,
      operators: () => [OP],
      allowGroupMembers: () => true,
      purge: async () => {},
    });
    expect(
      (await run("repaint", { target: "this" }, { senderId: MEMBER, engine: e, here: null })).ok,
    ).toBe(false);
    await e.stop();
  });
});

describe("regenerate gives a new picture (ARCH §2c.3)", () => {
  it("regenerate changes the seed and the image request; a style change does not bump it", async () => {
    const gen = fakeImageGen();
    const { w, e, call } = await world({ image: IMAGE_CFG, gen });
    expect(gen.calls.map((c) => c.seed)).toEqual([imgSeed(IDS.a), imgSeed(IDS.b)]);
    const before = w.targetSends(IDS.a).at(-1)!.avatar;
    const r = await call(OP, IDS.a, { action: "regenerate" });
    expect(r).toMatchObject({ ok: true, generation: 1 });
    await w.settle();
    const last = gen.calls.at(-1)!;
    expect(last.seed).toBe(imgSeed(IDS.a, 1));
    expect(last.seed).not.toBe(imgSeed(IDS.a));
    // Same style → same prompt; only the seed differs.
    expect(last.prompt).toBe(gen.calls[0]!.prompt);
    const after = w.targetSends(IDS.a).at(-1)!.avatar;
    expect(after).not.toBe(before);
    expect(isImage(w, after)).toBe(true);
    // The counter is in the state dir and survives a restart.
    expect(w.fs.getJson(`${w.paths.stateDir}/bases/generations.json`)).toEqual({
      [seedFor("signal", IDS.a.toLowerCase())]: 1,
    });
    // The old generation's base is pruned once the new one is applied.
    expect(w.fs.exists(`${w.paths.stateDir}/bases/${imgSeed(IDS.a)}.png`)).toBe(false);
    expect(w.fs.exists(`${w.paths.stateDir}/bases/${imgSeed(IDS.a, 1)}.png`)).toBe(true);
    // A style change keeps the counter: same seed, new prompt.
    await call(OP, IDS.a, {
      action: "style.add",
      rules: [{ match: { targetId: "this" }, set: { prompt: "paper cranes" } }],
    });
    await w.settle();
    expect(gen.calls.at(-1)).toMatchObject({ seed: imgSeed(IDS.a, 1) });
    expect(gen.calls.at(-1)!.prompt).toContain("paper cranes");
    await e.stop();
  });

  it("the image request itself carries the new seed (openai-images backend)", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const cfg = normalizeConfig(
      {
        imageGen: {
          kind: "openai-images",
          baseUrl: "http://127.0.0.1:9",
          model: "m",
          apiKey: { source: "env", provider: "default", id: "K" },
          seed: true,
        },
      },
      { gatewayStateDir: "/s" },
    ).config.imageGen!;
    const gen = createOpenAiImagesGenerator({
      config: cfg as never,
      apiKey: async () => "k",
      fetch: async (u, init) => {
        if (u.endsWith("/models")) {
          return new Response("{}");
        }
        bodies.push(JSON.parse(String(init.body)));
        return new Response(
          JSON.stringify({ data: [{ b64_json: fakePng(8, 8).toString("base64") }] }),
        );
      },
    });
    const { w, e, call } = await world({ image: IMAGE_CFG, gen, targets: [IDS.a] });
    await call(OP, IDS.a, { action: "regenerate" });
    await w.settle();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.seed).not.toBe(bodies[0]!.seed);
    expect(bodies[1]!.prompt).toBe(bodies[0]!.prompt);
    await e.stop();
  });

  it("regenerate with no image generator configured says so", async () => {
    const { e, call } = await world();
    expect((await call(OP, IDS.a, { action: "regenerate" })).message).toBe(
      "Not queued: image generation is unconfigured.",
    );
    await e.stop();
  });
});

describe("image first (ARCH §2c.4)", () => {
  it("new defaults: maxPerRun 16, maxPerDay 200, maxAttempts 10, backoff capped at 30 min", () => {
    expect(IMAGE_DEFAULTS).toMatchObject({ maxPerRun: 16, maxPerDay: 200, maxAttempts: 10 });
    const c = normalizeConfig(
      { imageGen: { kind: "command", command: "/opt/fake/gen" } },
      { gatewayStateDir: "/s" },
    ).config;
    expect(c.imageGen).toMatchObject({ maxPerRun: 16, maxPerDay: 200, maxAttempts: 10 });
    expect(c.timing.imageGenMaxBackoffMs).toBe(30 * 60_000);
  });

  it("unconfigured → vector is the base generator; health unconfigured", async () => {
    const { w, e } = await world();
    expect(e.status().health.imageGen).toBe("unconfigured");
    expect(w.sends().every((s) => !isImage(w, s.avatar))).toBe(true);
    await e.stop();
  });

  it("probe failure then recovery upgrades bases without a restart", async () => {
    let up = false;
    const gen = fakeImageGen({ up: () => up });
    const { w, e } = await world({ image: IMAGE_CFG, gen });
    expect(e.status().health.imageGen).toBe("retrying");
    // Targets with no avatar of ours get vector meanwhile.
    expect(w.sends()).toHaveLength(2);
    expect(w.sends().every((s) => !isImage(w, s.avatar))).toBe(true);
    // Still down at the next pass: still retrying, still nothing generated.
    await w.clock.advance(60_000);
    await e.runPass("periodic");
    expect(e.status().health.imageGen).toBe("retrying");
    expect(gen.calls).toHaveLength(0);
    // It comes up: the next due pass probes again and upgrades every base, same engine.
    up = true;
    await w.clock.advance(10 * 60_000);
    await e.runPass("periodic");
    await w.settle();
    expect(e.status().health.imageGen).toBe("ok");
    expect(gen.calls).toHaveLength(2);
    for (const id of [IDS.a, IDS.b]) {
      expect(isImage(w, w.targetSends(id).at(-1)!.avatar)).toBe(true);
    }
    await e.stop();
  });

  it("the probe backoff is capped at 30 min", async () => {
    const gen = fakeImageGen({ up: () => false });
    const { w, e } = await world({ image: IMAGE_CFG, gen, targets: [IDS.a] });
    for (let i = 0; i < 12; i++) {
      await w.clock.advance(31 * 60_000);
      await e.runPass("periodic");
    }
    const next = e.status().imageGen.nextProbeAt as number;
    expect(next - w.clock.now()).toBeLessThanOrEqual(30 * 60_000);
    await e.stop();
  });

  it("a target with no avatar gets vector, then upgrades to the image base", async () => {
    let failing = true;
    const gen = fakeImageGen({ fail: () => failing });
    const { w, e } = await world({ image: IMAGE_CFG, gen, targets: [IDS.a] });
    expect(w.targetSends(IDS.a)).toHaveLength(1);
    expect(isImage(w, w.targetSends(IDS.a)[0]!.avatar)).toBe(false);
    failing = false;
    await w.clock.advance(60_000);
    await e.runPass("periodic");
    await w.settle();
    expect(w.targetSends(IDS.a)).toHaveLength(2);
    expect(isImage(w, w.targetSends(IDS.a)[1]!.avatar)).toBe(true);
    await e.stop();
  });

  it("a capped target keeps its existing avatar (no vector repaint), then upgrades", async () => {
    const gen = fakeImageGen();
    const { w, e, call } = await world({
      image: { ...IMAGE_CFG, maxPerDay: 2 },
      gen,
    });
    expect(w.sends().every((s) => isImage(w, s.avatar))).toBe(true);
    const sends = w.sends().length;
    // The daily budget is spent; B's style changes, so it needs a new image.
    const r = await call(OP, IDS.b, {
      action: "style.add",
      rules: [{ match: { targetId: "this" }, set: { prompt: "paper cranes" } }],
    });
    expect(r.ok).toBe(true);
    await w.settle();
    await e.runPass("periodic");
    await w.settle();
    expect(gen.calls).toHaveLength(2);
    // Nothing was sent: B keeps its image avatar instead of going to vector.
    expect(w.sends()).toHaveLength(sends);
    expect(e.targetSummary(w.tk(IDS.b))!.converged).toBe(true);
    // A model change on the capped target keeps its current image base under the new mark.
    w.pin(IDS.b, "prov/opus-a");
    await w.settle();
    const pinned = w.targetSends(IDS.b).at(-1)!;
    expect(w.letterOf(pinned)).toBe("O");
    expect(isImage(w, pinned.avatar)).toBe(true);
    // Next UTC day: B's new image is generated and applied.
    await w.clock.advance(24 * 3_600_000);
    await e.runPass("periodic");
    await w.settle();
    expect(gen.calls).toHaveLength(3);
    expect(gen.calls.at(-1)!.prompt).toContain("paper cranes");
    expect(isImage(w, w.targetSends(IDS.b).at(-1)!.avatar)).toBe(true);
    await e.stop();
  });

  it("a transient failure never takes a target from an image base back to vector", async () => {
    let failing = false;
    const gen = fakeImageGen({ fail: () => failing });
    const { w, e, call } = await world({ image: IMAGE_CFG, gen, targets: [IDS.a] });
    expect(isImage(w, w.targetSends(IDS.a).at(-1)!.avatar)).toBe(true);
    failing = true;
    await call(OP, IDS.a, { action: "regenerate" });
    await w.settle();
    for (let i = 0; i < 3; i++) {
      await w.clock.advance(10 * 60_000);
      await e.runPass("periodic");
      await w.settle();
    }
    expect(w.targetSends(IDS.a).every((s) => isImage(w, s.avatar))).toBe(true);
    // Repaint resends what it shows, still the image base.
    await call(OP, IDS.a, { action: "repaint" });
    await w.settle();
    expect(isImage(w, w.targetSends(IDS.a).at(-1)!.avatar)).toBe(true);
    // After a restart the record still says what it shows.
    await e.stop();
    const e2 = await w.startEngine({ imageGenerator: gen, instanceId: "restart" });
    await w.settle();
    expect(w.targetSends(IDS.a).every((s) => isImage(w, s.avatar))).toBe(true);
    failing = false;
    await w.clock.advance(40 * 60_000);
    await e2.runPass("periodic");
    await w.settle();
    expect(gen.calls.at(-1)!.seed).toBe(imgSeed(IDS.a, 1));
    expect(e2.targetSummary(w.tk(IDS.a))!.converged).toBe(true);
    await e2.stop();
  });
});

describe("profile via the image generator (ARCH §2c.5)", () => {
  it("the profile base is an image from a portrait-safe full-bleed scene prompt", async () => {
    const gen = fakeImageGen();
    const { w, e } = await world({ image: IMAGE_CFG, gen, profile: true, targets: [IDS.a] });
    const prof = gen.calls.find((c) => c.portrait);
    expect(prof).toBeDefined();
    expect(prof!.seed).toBe(imageSeedFor("signal", "profile", 0, "profile"));
    expect(prof!.prompt).toMatch(/portrait-safe/);
    expect(prof!.prompt).toMatch(/no text/);
    const group = gen.calls.find((c) => !c.portrait)!;
    expect(group.prompt).not.toMatch(/portrait-safe/);
    const sent = w.sends().find((s) => s.kind === "profile")!;
    expect(isImage(w, sent.avatar)).toBe(true);
    await e.stop();
  });
});
