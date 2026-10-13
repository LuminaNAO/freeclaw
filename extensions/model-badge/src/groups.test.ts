// Operator addendum to §2c target selection: `signal.groups` { mode: all|include|exclude,
// ids }. Every member of a Signal group shares the group avatar, so two agents running
// model-badge in one group would overwrite each other. An excluded group is skipped
// entirely: no capture (§2c.8) and no paint.
import fsp from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { groupSelected, normalizeConfig } from "./core/config.js";
import { fakePng } from "./test-helpers/fakes.js";
import { createWorld, IDS } from "./test-helpers/world.js";

const OWN = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("their artwork")]);

async function world(
  backend: "signal" | "fakechat",
  groups: Record<string, unknown> | undefined,
  opts: { image?: boolean } = {},
) {
  const gen = opts.image
    ? {
        id: "fake-image:v1",
        calls: [] as string[],
        available: async () => true,
        async generate(t: { seed: string }) {
          gen!.calls.push(t.seed);
          return fakePng(512, 512, t.seed);
        },
      }
    : null;
  const w = await createWorld({
    backend,
    targets: [],
    plugin: {
      ...(groups ? { [backend]: { groups } } : {}),
      ...(opts.image ? { imageGen: { kind: "command", command: "/opt/fake/gen" } } : {}),
    },
  });
  for (const id of [IDS.a, IDS.b, IDS.c]) {
    w.addTarget(id, { avatar: OWN });
  }
  const e = await w.startEngine({ imageGenerator: gen });
  await w.settle();
  return { w, e, gen };
}

for (const backend of ["signal", "fakechat"] as const) {
  describe(`${backend}.groups (operator addendum, §2c target selection) on ${backend}`, () => {
    it("default mode all: every group is driven", async () => {
      const { w, e } = await world(backend, undefined);
      expect(new Set(w.sends().map((s) => s.target))).toEqual(new Set([IDS.a, IDS.b, IDS.c]));
      await e.stop();
    });

    it("an excluded group is never painted and never captured", async () => {
      const { w, e, gen } = await world(
        backend,
        { mode: "exclude", ids: [IDS.b.toUpperCase()] },
        { image: true },
      );
      const others = () => w.sends().filter((s) => s.target !== IDS.b);
      expect(others().length).toBeGreaterThan(0);
      // Through startup, model changes, periodic passes, a restyle-wide input change and
      // a restart: B receives nothing and its avatar is never read.
      w.pin(IDS.b, "prov/opus-a");
      w.setDefault("prov/opus-b");
      await w.settle();
      await e.runPass("periodic");
      await w.settle();
      await e.stop();
      const e2 = await w.startEngine({ instanceId: "restart" });
      await w.settle();
      expect(w.targetSends(IDS.b)).toHaveLength(0);
      // Never captured: only A and C were read; no adopted record or file for B.
      const reads = w.backend.avatarReads();
      expect(reads).toBe(2);
      expect(e2.status().adopted).toMatchObject({ seen: 2 });
      expect(w.fs.list(`${w.paths.stateDir}/adopted/`).join("\n")).not.toContain(
        (await import("./core/motif.js")).seedFor(backend, IDS.b.toLowerCase()),
      );
      // No image generated for it either.
      const bSeed = (await import("./core/motif.js")).imageSeedFor(backend, IDS.b.toLowerCase(), 0);
      expect(gen!.calls).not.toContain(bSeed);
      // Its avatar is still exactly the group's own artwork.
      expect(w.backend.avatar(IDS.b)!.equals(OWN)).toBe(true);
      // And it is not a target: actions on it say why.
      expect(e2.knownTargets()).not.toContain(w.tk(IDS.b));
      expect(await e2.repaint(w.tk(IDS.b))).toMatchObject({
        ok: false,
        message: expect.stringMatching(/not driven by this agent/),
      });
      await e2.stop();
    });

    it("include mode paints only the listed ids", async () => {
      const { w, e } = await world(backend, { mode: "include", ids: [IDS.a, IDS.c] });
      w.pin(IDS.b, "prov/opus-a");
      await w.settle();
      await e.runPass("periodic");
      await w.settle();
      expect(new Set(w.sends().map((s) => s.target))).toEqual(new Set([IDS.a, IDS.c]));
      expect(w.targetSends(IDS.b)).toHaveLength(0);
      expect(w.backend.avatarReads()).toBe(2);
      expect(e.knownTargets().toSorted()).toEqual([w.tk(IDS.a), w.tk(IDS.c)].toSorted());
      await e.stop();
    });

    it("include mode with no ids drives no group", async () => {
      const { w, e } = await world(backend, { mode: "include", ids: [] });
      expect(w.sends()).toHaveLength(0);
      expect(w.backend.avatarReads()).toBe(0);
      await e.stop();
    });

    it("a live config change stops writes to a newly excluded group at once", async () => {
      const { w, e } = await world(backend, undefined);
      w.setPlugin({ [backend]: { groups: { mode: "exclude", ids: [IDS.a] } } });
      await w.settle();
      const before = w.targetSends(IDS.a).length;
      w.pin(IDS.a, "prov/opus-a");
      await w.settle();
      await e.runPass("periodic");
      await w.settle();
      expect(w.targetSends(IDS.a)).toHaveLength(before);
      // Others carry on.
      w.pin(IDS.c, "prov/opus-a");
      await w.settle();
      expect(w.letterOf(w.targetSends(IDS.c).at(-1))).toBe("O");
      await e.stop();
    });
  });
}

describe("groups config", () => {
  it("normalises mode and ids; rejects bad shapes", () => {
    const c = normalizeConfig(
      { signal: { groups: { mode: "exclude", ids: ["group:AbC=", " xyz "] } } },
      { gatewayStateDir: "/s" },
    );
    expect(c.ok).toBe(true);
    expect(c.config.groups.signal).toEqual({ mode: "exclude", ids: ["abc=", "xyz"] });
    expect(normalizeConfig({}, { gatewayStateDir: "/s" }).config.groups.signal).toEqual({
      mode: "all",
      ids: [],
    });
    expect(
      normalizeConfig({ signal: { groups: { mode: "some" } } }, { gatewayStateDir: "/s" }).ok,
    ).toBe(false);
    expect(
      normalizeConfig({ signal: { groups: { ids: "abc" } } }, { gatewayStateDir: "/s" }).ok,
    ).toBe(false);
    expect(groupSelected({ mode: "include", ids: ["a"] }, "a")).toBe(true);
    expect(groupSelected({ mode: "include", ids: ["a"] }, "b")).toBe(false);
    expect(groupSelected({ mode: "exclude", ids: ["a"] }, "a")).toBe(false);
    expect(groupSelected({ mode: "all", ids: ["a"] }, "a")).toBe(true);
  });

  it("the manifest schema and uiHints document signal.groups", async () => {
    const m = JSON.parse(
      await fsp.readFile(path.join(import.meta.dirname, "..", "openclaw.plugin.json"), "utf8"),
    );
    expect(m.configSchema.properties.signal.properties.groups).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        mode: { type: "string", enum: ["all", "include", "exclude"], default: "all" },
        ids: { type: "array", items: { type: "string" } },
      },
    });
    expect(m.uiHints["signal.groups"].help).toMatch(/never captured, never painted/);
    expect(m.uiHints["signal.groups.mode"]).toBeDefined();
    expect(m.uiHints["signal.groups.ids"]).toBeDefined();
  });
});
