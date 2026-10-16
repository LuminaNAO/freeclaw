// ARCH §2c.10: generated bases are full-bleed scenes, never a tile. Prompts for every
// motif and the profile carry the full-bleed clause and none of the banned words; a
// member's steering prompt is wrapped in the same template; the generator tag bump
// regenerates generated bases once and leaves adopted ones alone.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BANNED_PROMPT_WORDS,
  BASE_PROMPT_TAG,
  buildPrompt,
  FULL_BLEED,
  MOTIF_SCENES,
  type BaseArtGenerator,
} from "./core/baseart.js";
import { canonicalJSON, sha256 } from "./core/hash.js";
import { baseParamsForSeed, imageSeedFor, MOTIFS, seedFor } from "./core/motif.js";
import { PALETTE_NAMES } from "./core/palette.js";
import { fakePng } from "./test-helpers/fakes.js";
import { createWorld, IDS } from "./test-helpers/world.js";

const BANNED = new RegExp(`\\b(?:${BANNED_PROMPT_WORDS.join("|")})s?\\b`, "i");
// The full-bleed clause itself forbids an inner panel; outside it no banned word appears.
const withoutClause = (p: string) => p.split(FULL_BLEED).join(" ");

function expectSceneOk(p: string) {
  expect(p).toContain(FULL_BLEED);
  expect(p.split(FULL_BLEED)).toHaveLength(2);
  expect(withoutClause(p)).not.toMatch(BANNED);
  expect(p).toMatch(/no text/);
}

const seed = seedFor("signal", "t");
const params = baseParamsForSeed(seed);

describe("generated-base prompts are full-bleed scenes (ARCH §2c.10)", () => {
  it("every motif maps to a scene, and every motif × palette prompt is full-bleed and clean", () => {
    expect(Object.keys(MOTIF_SCENES).toSorted()).toEqual([...MOTIFS].toSorted());
    for (const motif of MOTIFS) {
      for (const palette of PALETTE_NAMES) {
        for (const portrait of [false, true]) {
          const p = buildPrompt(
            {
              seed,
              params: baseParamsForSeed(seed, { motif, palette }),
              ...(portrait ? { portrait } : {}),
            },
            {},
          );
          expectSceneOk(p);
          expect(p).toContain(`A scene of ${MOTIF_SCENES[motif]}`);
          expect(p).toContain(palette);
        }
      }
    }
  });

  it("style motif/palette words choose the scene, not a shape", () => {
    const p = buildPrompt({ seed, params }, { motif: "waves", palette: "ember" });
    expect(p).toContain("A scene of calm ocean waves under a soft evening sky");
    expect(p).toContain("ember colours");
    expect(p).not.toMatch(/\bmotif\b/i);
    expectSceneOk(p);
  });

  it("the profile prompt keeps its circle-safe wording and gets the full-bleed clause", () => {
    const pseed = seedFor("signal", "profile", "profile");
    const p = buildPrompt(
      { seed: pseed, params: baseParamsForSeed(pseed, {}, { portrait: true }), portrait: true },
      {},
    );
    expect(p).toMatch(/portrait-safe/);
    expect(p).toMatch(/cropped to a circle/);
    expectSceneOk(p);
    const house = buildPrompt({ seed, params }, {});
    expect(house).not.toMatch(/portrait-safe/);
  });

  it("a steering prompt is wrapped in the same full-bleed template", () => {
    for (const portrait of [false, true]) {
      const t = { seed, params, ...(portrait ? { portrait } : {}) };
      const p = buildPrompt(t, { prompt: "watercolour ocean" });
      expect(p).toContain("A scene of watercolour ocean.");
      expectSceneOk(p);
      // Same template as an unsteered prompt: only the scene differs.
      const plain = buildPrompt(t, {});
      const scene = (s: string) => s.slice(0, s.indexOf(". "));
      expect(scene(p)).toBe("A scene of watercolour ocean");
      expect(p.slice(scene(p).length)).toBe(plain.slice(scene(plain).length));
    }
  });

  it("banned words in a steering prompt never reach the image model", () => {
    const p = buildPrompt(
      { seed, params },
      { prompt: "Abstract square avatar background tile, paper cranes on a card panel" },
    );
    expect(p).toContain("A scene of paper cranes.");
    expectSceneOk(p);
    // A prompt made only of banned words falls back to the motif scene.
    const q = buildPrompt({ seed, params }, { prompt: "square avatar background" });
    expect(q).toContain(`A scene of ${MOTIF_SCENES[params.motif]}`);
    expectSceneOk(q);
  });

  it("multi-line steering text is one line in the prompt", () => {
    const p = buildPrompt({ seed, params }, { prompt: "paper\ncranes\r\nat dawn" });
    expect(p).toContain("A scene of paper cranes at dawn.");
    expect(p).not.toMatch(/[\r\n]/);
  });

  it("source scan: no banned word in the generated-base prompt code outside the ban list and the clause", () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, "core", "baseart.ts"), "utf8");
    const start = src.indexOf("// ---------------- prompt");
    const end = src.indexOf("export function seedNumber");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const code = src
      .slice(start, end)
      // Comments describe the rule; only code and string literals are prompt text.
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/export const BANNED_PROMPT_WORDS = \[[^\]]*\] as const;/, "")
      .replace(JSON.stringify(FULL_BLEED), "")
      .replace(/BANNED_PROMPT_WORDS|BANNED_RE/g, "");
    expect(code).not.toMatch(BANNED);
    expect(code).toContain("FULL_BLEED");
  });
});

// ---------------- tag bump ----------------

const OWN = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from("their own artwork: a hand-drawn cat"),
]);

function fakeImageGen() {
  const calls: Array<{ seed: string; prompt: string }> = [];
  const gen: BaseArtGenerator & { calls: typeof calls } = {
    id: "fake-image:v1",
    calls,
    available: async () => true,
    async generate(target, style) {
      const prompt = buildPrompt(target, style);
      calls.push({ seed: target.seed, prompt });
      return fakePng(1024, 1024, `generated ${prompt} ${calls.length}`);
    },
  };
  return gen;
}

describe(`generator tag bump to ${BASE_PROMPT_TAG} (ARCH §2c.10)`, () => {
  it("generated bases regenerate exactly once; adopted bases are untouched; then idempotent", async () => {
    expect(BASE_PROMPT_TAG).toBe("scene-v1");
    const gen = fakeImageGen();
    const w = await createWorld({
      targets: [],
      plugin: { imageGen: { kind: "command", command: "/opt/fake/gen" } },
    });
    w.addTarget(IDS.a, { avatar: OWN });
    w.addTarget(IDS.b, {});
    const e = await w.startEngine({ imageGenerator: gen });
    await w.settle();
    await e.stop();
    // A adopted its own artwork; B shows a generated base.
    const seedB = imageSeedFor(w.backend.name, IDS.b.toLowerCase(), 0);
    const seedA = imageSeedFor(w.backend.name, IDS.a.toLowerCase(), 0);
    expect(gen.calls.map((c) => c.seed)).toEqual([seedB]);

    // Rewind B's stored base to a pre-§2c.10 one: its inputs key has no scene tag and an
    // older prompt.
    const manPath = `${w.paths.stateDir}/bases/${seedB}.json`;
    const man = w.fs.getJson<Record<string, unknown>>(manPath);
    man.inputsKey = sha256(
      canonicalJSON({ prompt: "an older template", seed: seedB, generator: gen.id }),
    );
    delete man.prompt;
    w.fs.putJson(manPath, man);

    const a0 = w.targetSends(IDS.a).length;
    const b0 = w.targetSends(IDS.b).length;
    const e2 = await w.startEngine({ imageGenerator: gen, instanceId: "upgrade" });
    await w.settle();
    // B: one new picture from the scene prompt, one repaint. A: nothing.
    expect(gen.calls).toHaveLength(2);
    expect(gen.calls[1]!.seed).toBe(seedB);
    expect(gen.calls[1]!.prompt).toContain(FULL_BLEED);
    expect(gen.calls.some((c) => c.seed === seedA)).toBe(false);
    expect(w.targetSends(IDS.b)).toHaveLength(b0 + 1);
    expect(w.targetSends(IDS.a)).toHaveLength(a0);
    expect(w.fs.getJson<Record<string, unknown>>(manPath)).toMatchObject({
      prompt: BASE_PROMPT_TAG,
    });

    // Idempotent: more passes and a restart generate and repaint nothing.
    await e2.runPass("periodic");
    await w.settle();
    await e2.stop();
    const e3 = await w.startEngine({ imageGenerator: gen, instanceId: "again" });
    await w.settle();
    await e3.runPass("periodic");
    await w.settle();
    expect(gen.calls).toHaveLength(2);
    expect(w.targetSends(IDS.b)).toHaveLength(b0 + 1);
    expect(w.targetSends(IDS.a)).toHaveLength(a0);
    await e3.stop();
  });
});
