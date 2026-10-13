// ARCH §2c.8: a group's own artwork is kept — first sight adopts; restyle keeps adopted;
// regenerate replaces and restore brings it back; a target with no avatar or with our own
// mark gets a generated base; targets.<id>.base adopt|generate overrides per target.
import { describe, expect, it } from "vitest";
import { createActions } from "./actions.js";
import { createBadgeCommand, SLASH_SUBCOMMANDS } from "./commands.js";
import type { BaseArtGenerator } from "./core/baseart.js";
import { normalizeConfig } from "./core/config.js";
import type { Engine } from "./core/engine.js";
import { imageSeedFor, seedFor } from "./core/motif.js";
import { isStamped, stampPng } from "./core/render.js";
import { createSteering } from "./core/steering.js";
import { createStyleStore } from "./core/style.js";
import { fakePng } from "./test-helpers/fakes.js";
import { createWorld, IDS, type World } from "./test-helpers/world.js";

const OP = "+10000000002";
const MEMBER = "+10000000077";
// A group's own avatar: a JPEG-looking picture with a marker, not made by us.
const OWN = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from("their own artwork: a hand-drawn cat"),
]);

function fakeImageGen() {
  const calls: string[] = [];
  const gen: BaseArtGenerator & { calls: string[] } = {
    id: "fake-image:v1",
    calls,
    available: async () => true,
    async generate(target) {
      calls.push(target.seed);
      return fakePng(1024, 1024, `generated ${target.seed}`);
    },
  };
  return gen;
}

const sentText = (w: World, avatar: string) => w.fs.files.get(avatar)!.data.toString("latin1");
// The adopted base (the normalised capture in the state dir) travels base64-embedded in
// the composited SVG; the fake rasteriser keeps that SVG in the PNG it writes.
const adoptedB64 = (w: World, id: string): string | null => {
  const key = seedFor(w.backend.name, id.toLowerCase());
  const f = w.fs.files.get(`${w.paths.stateDir}/adopted/${key}.png`);
  // The tail: it encodes the captured picture itself (the head is the same PNG header
  // and SVG preamble for every raster base).
  return f ? f.data.toString("base64").slice(-120) : null;
};
const showsOwn = (w: World, id: string) => {
  const last = w.targetSends(id).at(-1);
  const own = adoptedB64(w, id);
  return Boolean(last && own && sentText(w, last.avatar).includes(own));
};
const showsGenerated = (w: World, id: string) => {
  const last = w.targetSends(id).at(-1);
  const own = adoptedB64(w, id);
  return Boolean(last && (!own || !sentText(w, last.avatar).includes(own)));
};

async function world(
  opts: {
    backend?: "signal" | "fakechat";
    avatars?: Record<string, Buffer>;
    image?: boolean;
    targets?: Record<string, { base?: string; motif?: string }>;
  } = {},
) {
  const ids = [IDS.a, IDS.b, IDS.c];
  const gen = opts.image ? fakeImageGen() : null;
  const w = await createWorld({
    backend: opts.backend,
    targets: [],
    plugin: {
      ...(opts.image ? { imageGen: { kind: "command", command: "/opt/fake/gen" } } : {}),
      ...(opts.targets ? { targets: opts.targets } : {}),
    },
  });
  for (const id of ids) {
    w.addTarget(id, opts.avatars?.[id] ? { avatar: opts.avatars[id] } : {});
  }
  const e = await w.startEngine({ imageGenerator: gen });
  await w.settle();
  const cfg = normalizeConfig(w.pluginConfig(), { gatewayStateDir: "/s" }).config;
  const steering = createSteering({
    engines: () => [e],
    store: createStyleStore({ fs: w.fs, stateDir: w.paths.rootDir }),
    operators: () => cfg.operators,
    allowGroupMembers: () => true,
    configRules: () => [],
    now: () => w.clock.now(),
  });
  const run = createActions({
    engines: () => [e] as Engine[],
    steering: () => steering,
    operators: () => cfg.operators,
    allowGroupMembers: () => true,
    purge: async () => {},
  });
  const here = (id: string) => ({ kind: "group" as const, idLower: id.toLowerCase() });
  const act = (sender: string, id: string, action: Parameters<typeof run>[0], args = {}) =>
    run(action, args, { senderId: sender, engine: e, here: here(id) });
  return { w, e, gen, act, steering };
}

for (const backend of ["signal", "fakechat"] as const) {
  describe(`a group's own artwork is kept (ARCH §2c.8) on ${backend}`, () => {
    it("first sight adopts: the group's own avatar becomes its base, mark on top; read once", async () => {
      const { w, e } = await world({ backend, avatars: { [IDS.a]: OWN } });
      expect(showsOwn(w, IDS.a)).toBe(true);
      expect(w.letterOf(w.targetSends(IDS.a).at(-1))).toBe("F");
      // Targets with no avatar get a generated base.
      expect(showsGenerated(w, IDS.b)).toBe(true);
      expect(e.targetSummary(w.tk(IDS.a))!.desired).toMatchObject({ base: "raster" });
      expect(e.targetSummary(w.tk(IDS.b))!.desired).toMatchObject({ base: "vector" });
      // Captured once, in the state dir, format-guarded (normalised PNG at the asset size).
      const key = seedFor(backend, IDS.a.toLowerCase());
      const stored = w.fs.files.get(`${w.paths.stateDir}/adopted/${key}.png`)!.data;
      expect(stored.subarray(1, 4).toString()).toBe("PNG");
      expect(stored.readUInt32BE(16)).toBe(512);
      expect(e.status().adopted).toEqual({ seen: 3, adopted: 1, active: 1 });
      // The capture happens once: later passes and restarts never read it again, so our
      // own paint on the group is never mistaken for its artwork.
      const reads = w.backend.avatarReads();
      expect(reads).toBe(3);
      await e.runPass("periodic");
      await e.stop();
      const e2 = await w.startEngine({ instanceId: "restart" });
      await w.settle();
      expect(w.backend.avatarReads()).toBe(reads);
      expect(showsOwn(w, IDS.a)).toBe(true);
      await e2.stop();
    });

    it("a model change keeps the adopted base under the new mark", async () => {
      const { w, e } = await world({ backend, avatars: { [IDS.a]: OWN } });
      w.pin(IDS.a, "prov/opus-a");
      await w.settle();
      expect(w.letterOf(w.targetSends(IDS.a).at(-1))).toBe("O");
      expect(showsOwn(w, IDS.a)).toBe(true);
      await e.stop();
    });

    it("restyle from a member keeps the adopted base; marks may still change", async () => {
      const { w, e, act, gen } = await world({ backend, avatars: { [IDS.a]: OWN }, image: true });
      const sends = w.targetSends(IDS.a).length;
      const preview = await act(MEMBER, IDS.a, "style.preview", {
        rules: [{ match: { targetId: "this" }, set: { motif: "waves", prompt: "neon city" } }],
      });
      expect(preview.ok).toBe(true);
      // The base does not change, so preview reports no change for this target.
      expect((preview.details as { changes: unknown[] }).changes).toEqual([]);
      const add = await act(MEMBER, IDS.a, "style.add", {
        rules: [{ match: { targetId: "this" }, set: { motif: "waves", prompt: "neon city" } }],
      });
      expect(add.ok).toBe(true);
      await w.settle();
      expect(w.targetSends(IDS.a)).toHaveLength(sends);
      expect(showsOwn(w, IDS.a)).toBe(true);
      // No image is ever generated for an adopted target.
      expect(gen!.calls).not.toContain(imageSeedFor(backend, IDS.a.toLowerCase(), 0));
      // A mark restyle still applies, on top of the adopted base.
      const mark = await act(MEMBER, IDS.a, "style.add", {
        rules: [{ match: { targetId: "this" }, set: { hue: "green" } }],
      });
      expect(mark.ok).toBe(true);
      await w.settle();
      expect(w.targetSends(IDS.a)).toHaveLength(sends + 1);
      expect(showsOwn(w, IDS.a)).toBe(true);
      await e.stop();
    });

    it("regenerate replaces the adopted base; restore brings it back (member, own group)", async () => {
      const { w, e, act, gen } = await world({ backend, avatars: { [IDS.a]: OWN }, image: true });
      // Only the two targets without artwork asked the image model for a base.
      expect(gen!.calls).toHaveLength(2);
      const r = await act(MEMBER, IDS.a, "regenerate");
      expect(r.ok).toBe(true);
      expect(r.text).toMatch(/own artwork is kept and can be restored/);
      await w.settle();
      expect(gen!.calls).toHaveLength(3);
      expect(showsGenerated(w, IDS.a)).toBe(true);
      expect(sentText(w, w.targetSends(IDS.a).at(-1)!.avatar)).toContain("<image");
      // The adopted bytes are kept on disk.
      const key = seedFor(backend, IDS.a.toLowerCase());
      expect(w.fs.exists(`${w.paths.stateDir}/adopted/${key}.png`)).toBe(true);
      // A further regenerate now makes a new generated picture (§2c.3).
      expect((await act(MEMBER, IDS.a, "regenerate")).details).toMatchObject({ generation: 1 });
      await w.settle();
      expect(gen!.calls).toHaveLength(4);
      // Restore puts the group's own artwork back.
      const back = await act(MEMBER, IDS.a, "restore");
      expect(back.ok).toBe(true);
      await w.settle();
      expect(showsOwn(w, IDS.a)).toBe(true);
      expect((await act(MEMBER, IDS.a, "restore")).text).toMatch(/already in use/);
      // And it survives a restart.
      await e.stop();
      const e2 = await w.startEngine({ instanceId: "restart" });
      await w.settle();
      expect(e2.targetSummary(w.tk(IDS.a))!.converged).toBe(true);
      expect(showsOwn(w, IDS.a)).toBe(true);
      await e2.stop();
    });

    it("regenerate works on an adopted target even with no image generator (vector base)", async () => {
      const { w, e, act } = await world({ backend, avatars: { [IDS.a]: OWN } });
      expect((await act(OP, IDS.a, "regenerate")).ok).toBe(true);
      await w.settle();
      expect(showsGenerated(w, IDS.a)).toBe(true);
      expect((await act(OP, IDS.a, "restore")).ok).toBe(true);
      await w.settle();
      expect(showsOwn(w, IDS.a)).toBe(true);
      await e.stop();
    });

    it("regenerate and restore follow §2c.2 authority: other groups are refused for members", async () => {
      const { w, e, act } = await world({ backend, avatars: { [IDS.a]: OWN } });
      for (const action of ["regenerate", "restore"] as const) {
        const r = await act(MEMBER, IDS.b, action, { target: IDS.a });
        expect(r.ok, action).toBe(false);
        expect(r.details).toMatchObject({ refused: true });
      }
      expect(showsOwn(w, IDS.a)).toBe(true);
      expect((await act(OP, IDS.b, "regenerate", { target: IDS.a })).ok).toBe(true);
      expect((await act(OP, IDS.b, "restore", { target: IDS.a })).ok).toBe(true);
      await e.stop();
    });

    it("restore on a target with nothing adopted says so", async () => {
      const { e, act } = await world({ backend });
      const r = await act(MEMBER, IDS.b, "restore");
      expect(r.ok).toBe(false);
      expect(r.text).toMatch(/no adopted artwork/);
      await e.stop();
    });

    it("a target that shows our own mark gets a generated base, not adopted", async () => {
      const ours = stampPng(fakePng(512, 512, '<svg data-mark="F"/>'));
      expect(isStamped(ours)).toBe(true);
      const { w, e } = await world({ backend, avatars: { [IDS.a]: ours } });
      expect(showsGenerated(w, IDS.a)).toBe(true);
      expect(e.status().adopted).toMatchObject({ adopted: 0 });
      expect(sentText(w, w.targetSends(IDS.a).at(-1)!.avatar)).not.toContain(
        ours.toString("base64").slice(0, 40),
      );
      await e.stop();
    });

    it("every asset we send carries our stamp", async () => {
      const { w, e } = await world({ backend, avatars: { [IDS.a]: OWN } });
      for (const s of w.sends()) {
        expect(isStamped(w.fs.files.get(s.avatar)!.data)).toBe(true);
      }
      await e.stop();
    });

    it("bytes that are not an image are not adopted (format guard) → generated base", async () => {
      const { w, e } = await world({
        backend,
        avatars: { [IDS.a]: Buffer.from("<html>not a picture</html>") },
      });
      expect(showsGenerated(w, IDS.a)).toBe(true);
      expect(e.status().adopted).toMatchObject({ adopted: 0 });
      await e.stop();
    });

    it("a target added later is adopted on first sight, before it is ever painted", async () => {
      const { w, e } = await world({ backend });
      w.addTarget("FakeTargetDdddddddddddddddddddddddddddddddddddD=", { avatar: OWN });
      await w.settle();
      await e.runPass("periodic");
      await w.settle();
      const D = "FakeTargetDdddddddddddddddddddddddddddddddddddD=";
      const sends = w.targetSends(D);
      expect(sends.length).toBeGreaterThan(0);
      expect(sentText(w, sends[0]!.avatar)).toContain(adoptedB64(w, D)!);
      await e.stop();
    });

    it("targets.<id>.base generate overrides adoption; adopt is the default", async () => {
      const { w, e, act } = await world({
        backend,
        avatars: { [IDS.a]: OWN, [IDS.b]: OWN },
        targets: {
          [IDS.a.toLowerCase()]: { base: "generate" },
          [IDS.b.toLowerCase()]: { base: "adopt" },
        },
      });
      expect(showsGenerated(w, IDS.a)).toBe(true);
      expect(showsOwn(w, IDS.b)).toBe(true);
      expect((await act(OP, IDS.a, "restore")).text).toMatch(/operator set this target/);
      // The operator turns adoption back on for A: its captured artwork returns.
      w.setPlugin({ targets: {} });
      await w.settle();
      expect(showsOwn(w, IDS.a)).toBe(true);
      await e.stop();
    });
  });
}

describe("§2c.8 config, provider and parity", () => {
  it("targets.<id>.base accepts adopt|generate only", () => {
    const ok = normalizeConfig(
      { targets: { g: { base: "generate" }, h: { base: "adopt" } } },
      { gatewayStateDir: "/s" },
    );
    expect(ok.ok).toBe(true);
    expect(ok.config.targets.g!.base).toBe("generate");
    const bad = normalizeConfig({ targets: { g: { base: "keep" } } }, { gatewayStateDir: "/s" });
    expect(bad.ok).toBe(false);
  });

  it("the manifest schema and uiHints document targets.<id>.base", async () => {
    const fsp = await import("node:fs/promises");
    const path = await import("node:path");
    const m = JSON.parse(
      await fsp.readFile(path.join(import.meta.dirname, "..", "openclaw.plugin.json"), "utf8"),
    );
    expect(m.configSchema.properties.targets.additionalProperties.properties.base).toEqual({
      type: "string",
      enum: ["adopt", "generate"],
      default: "adopt",
    });
    expect(m.uiHints.targets.help).toMatch(/base: adopt\|generate/);
  });

  it("restore is a slash subcommand and a tool action with the same result", async () => {
    expect(SLASH_SUBCOMMANDS.restore!.action).toBe("restore");
    const { w, e, steering } = await world({ avatars: { [IDS.a]: OWN } });
    await e.regenerate(w.tk(IDS.a));
    await w.settle();
    const slash = createBadgeCommand({
      engines: () => [e],
      steering: () => steering,
      operators: () => [OP],
      purge: async () => {},
    });
    const text = (
      await slash({
        channel: "signal",
        from: `signal:group:${IDS.a}`,
        senderId: MEMBER,
        args: "restore",
      })
    ).text;
    expect(text).toBe("Restore queued: the group's own artwork is back.");
    await e.stop();
  });

  it("signal provider reads the group avatar with getAvatar; missing → none; unknown method → unsupported", async () => {
    const { createSignalProvider } = await import("./providers/signal/provider.js");
    const { parseAgentSessionKey } = await import("openclaw/plugin-sdk/model-badge");
    const S = await import("./test-helpers/signal-fixtures.js");
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    let reply: unknown = { result: { data: OWN.toString("base64") } };
    const p = createSignalProvider({
      config: { agentId: "main", accountId: null, profileSessionKey: null, profileBaseImage: null },
      endpoint: { baseUrl: "http://127.0.0.1:1", account: S.ACCOUNT },
      rpc: async (method, params) => {
        calls.push({ method, params });
        return S.ok({ jsonrpc: "2.0", id: 1, ...(reply as object) });
      },
      parseSessionKey: parseAgentSessionKey,
      clock: { now: () => 0 } as never,
    });
    const t = { ref: { kind: "group" as const, idLower: "g" }, realId: "G" };
    const r = await p.currentAvatar!(t);
    expect(r.kind === "image" && r.bytes.equals(OWN)).toBe(true);
    expect(calls[0]).toEqual({ method: "getAvatar", params: { account: S.ACCOUNT, groupId: "G" } });
    reply = { error: { code: -1, message: "Could not find avatar" } };
    expect(await p.currentAvatar!(t)).toEqual({ kind: "none" });
    reply = { error: { code: -32601, message: "Method not found" } };
    expect(await p.currentAvatar!(t)).toEqual({ kind: "unsupported" });
    reply = { error: { code: -3, message: "An error occurred reading avatar" } };
    expect((await p.currentAvatar!(t)).kind).toBe("retry");
    expect(
      await p.currentAvatar!({ ref: { kind: "profile", idLower: "profile" }, realId: "profile" }),
    ).toEqual({ kind: "none" });
  });

  it("a target is never painted before its avatar has been looked at", async () => {
    // The avatar read fails transiently and keeps failing: the target must wait, not be
    // painted over (painting first would destroy the artwork that is meant to be kept).
    const w = await createWorld({ targets: [] });
    w.addTarget(IDS.a, { avatar: OWN });
    const e = w.makeEngine();
    const provider = e.provider as { currentAvatar?: unknown };
    let reads = 0;
    provider.currentAvatar = async () => {
      reads++;
      return { kind: "retry", message: "daemon busy" };
    };
    await e.start();
    await w.settle();
    await e.runPass("periodic");
    await w.settle();
    expect(reads).toBeGreaterThan(0);
    expect(w.sends()).toHaveLength(0);
    expect(e.targetSummary(w.tk(IDS.a))!.waiting).toMatchObject({
      reason: "waiting-for-adoption",
    });
    await e.stop();
  });

  it("a transient read failure delays adoption (no paint) and retries on the next pass", async () => {
    const w = await createWorld({ targets: [] });
    w.addTarget(IDS.a, { avatar: OWN });
    w.backend.setDown(true);
    const e = await w.startEngine();
    await w.settle();
    expect(w.sends()).toHaveLength(0);
    w.backend.setDown(false);
    await w.clock.advance(15 * 60_000);
    await e.runPass("periodic");
    await w.settle();
    expect(showsOwn(w, IDS.a)).toBe(true);
    await e.stop();
  });
});
