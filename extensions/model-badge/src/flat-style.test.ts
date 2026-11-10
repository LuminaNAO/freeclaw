// ARCH §2c.13: the house art style is flat 2D, not photographic. Both templates carry the
// style clause and none of the banned words; the scene writer is told to describe a flat
// illustration and its photo words are rejected; `imageGen.style` overrides the clause
// (banned-word check, "" = none); a steered prompt keeps the member's words first and the
// clause last; the tag bump to scene-v2 regenerates generated bases once and leaves adopted
// ones alone, and written scenes are re-wrapped, not rewritten.
import fsp from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateJsonSchemaValue } from "../../../src/plugins/schema-validator.js";
import {
  BANNED_PROMPT_WORDS,
  BASE_PROMPT_TAG,
  buildPrompt,
  FULL_BLEED,
  HOUSE_STYLE,
  MOTIF_SCENES,
  NO_MARKS,
  type BaseArtGenerator,
} from "./core/baseart.js";
import { normalizeConfig } from "./core/config.js";
import { canonicalJSON, sha256 } from "./core/hash.js";
import { baseParamsForSeed, imageSeedFor, MOTIFS, seedFor } from "./core/motif.js";
import { PALETTE_NAMES } from "./core/palette.js";
import {
  PHOTO_WORDS,
  validateScene,
  WRITER_INSTRUCTION,
  type SceneWriteRequest,
  type SceneWriter,
} from "./core/scene.js";
import { fakePng } from "./test-helpers/fakes.js";
import { createWorld, IDS } from "./test-helpers/world.js";

const ARCH_CLAUSE =
  "Clean modern flat vector illustration, simple bold shapes, smooth gradients, limited calm palette, minimal elegant composition, crisp edges, not a photograph, not 3D, no realistic textures";
const BANNED = new RegExp(`\\b(?:${BANNED_PROMPT_WORDS.join("|")})s?\\b`, "i");
const withoutFullBleed = (p: string) => p.split(FULL_BLEED).join(" ");

const seed = seedFor("signal", "t");
const params = baseParamsForSeed(seed);
const pseed = seedFor("signal", "profile", "profile");
const pparams = baseParamsForSeed(pseed, {}, { portrait: true });
const house = (style = {}) => buildPrompt({ seed, params }, style);
const profile = (style = {}) =>
  buildPrompt({ seed: pseed, params: pparams, portrait: true }, style);

describe("both templates end with the flat style clause (ARCH §2c.13)", () => {
  it("the clause is the ARCH text verbatim and has no banned word", () => {
    expect(HOUSE_STYLE).toBe(ARCH_CLAUSE);
    expect(HOUSE_STYLE).not.toMatch(BANNED);
  });

  it("house and profile prompts: full-bleed clause, then the style clause, then no-marks, last", () => {
    for (const p of [house(), profile()]) {
      expect(p).toContain(FULL_BLEED);
      expect(p.endsWith(`${HOUSE_STYLE}, ${NO_MARKS}.`)).toBe(true);
      expect(p.indexOf(FULL_BLEED)).toBeLessThan(p.indexOf(HOUSE_STYLE));
      expect(p).not.toMatch(/soft light|rich detail/i);
      expect(withoutFullBleed(p)).not.toMatch(BANNED);
    }
    expect(profile()).toMatch(/portrait-safe/);
  });

  it("every motif × palette, group and profile, carries the clause and no banned word", () => {
    for (const motif of MOTIFS) {
      for (const palette of PALETTE_NAMES) {
        for (const portrait of [false, true]) {
          const p = buildPrompt(
            {
              seed,
              params: baseParamsForSeed(seed, { motif, palette }, { portrait }),
              ...(portrait ? { portrait } : {}),
            },
            {},
          );
          expect(p).toContain(`A scene of ${MOTIF_SCENES[motif]}`);
          expect(p).toContain(`${HOUSE_STYLE}, ${NO_MARKS}.`);
          expect(withoutFullBleed(p)).not.toMatch(BANNED);
        }
      }
    }
  });

  it("a written scene gets the clause too", () => {
    const p = house({ scene: "rows of tomatoes beside a wooden shed" });
    expect(p.startsWith("A scene of rows of tomatoes beside a wooden shed.")).toBe(true);
    expect(p.endsWith(`${HOUSE_STYLE}, ${NO_MARKS}.`)).toBe(true);
  });

  it("source scan: the templates use the clause, and the old photographic finish is gone", async () => {
    const src = await fsp.readFile(path.join(import.meta.dirname, "core", "baseart.ts"), "utf8");
    expect(src).not.toMatch(/Soft light, rich detail/);
    const tmpl = src.match(/const (?:HOUSE|PROFILE)_TEMPLATE =[\s\S]*?;\n/g) ?? [];
    expect(tmpl).toHaveLength(2);
    for (const t of tmpl) {
      expect(t).toContain("{finish}");
      expect(t).toContain("FULL_BLEED");
    }
  });
});

describe("steered prompts: the member's words first, the clause last (ARCH §2c.13)", () => {
  it("watercolour leads and the house clause is still appended, group and profile", () => {
    for (const p of [
      house({ prompt: "watercolour ocean" }),
      profile({ prompt: "watercolour ocean" }),
    ]) {
      expect(p.startsWith("A scene of watercolour ocean.")).toBe(true);
      expect(p.indexOf("watercolour")).toBeLessThan(p.indexOf(HOUSE_STYLE));
      expect(p.endsWith(`${HOUSE_STYLE}, ${NO_MARKS}.`)).toBe(true);
    }
  });

  it("a steering prompt overrides a written scene and still gets the clause", () => {
    const p = house({ prompt: "paper cranes at dawn", scene: "a quiet allotment" });
    expect(p).not.toContain("allotment");
    expect(p.startsWith("A scene of paper cranes at dawn.")).toBe(true);
    expect(p.endsWith(`${HOUSE_STYLE}, ${NO_MARKS}.`)).toBe(true);
  });

  it("an install style applies to steered prompts the same way", () => {
    const p = house({ prompt: "watercolour ocean", look: "paper cut-out collage" });
    expect(p.startsWith("A scene of watercolour ocean.")).toBe(true);
    expect(p.endsWith(`paper cut-out collage, ${NO_MARKS}.`)).toBe(true);
  });

  it("braces in a member's words are kept as text, never read as a placeholder", () => {
    const p = house({ prompt: "a {finish} lantern" });
    expect(p.startsWith("A scene of a {finish} lantern.")).toBe(true);
    expect(p.split(HOUSE_STYLE)).toHaveLength(2);
  });
});

describe("the scene writer is told the style; photo words are rejected (ARCH §2c.13)", () => {
  it("the instruction asks for a flat vector illustration with no lighting, camera or photo words", () => {
    expect(WRITER_INSTRUCTION).toMatch(/flat vector illustration/);
    expect(WRITER_INSTRUCTION).toMatch(/objects and a setting/);
    expect(WRITER_INSTRUCTION).toMatch(/no lighting, camera or photo words/);
  });

  it("the list is the ARCH list", () => {
    expect([...PHOTO_WORDS]).toEqual([
      "photo",
      "photograph",
      "photorealistic",
      "realistic",
      "3d",
      "render",
      "cinematic",
      "bokeh",
      "lens",
    ]);
  });

  for (const word of PHOTO_WORDS) {
    it(`"${word}" is rejected (any case)`, () => {
      expect(validateScene(`a quiet harbour at dawn, ${word}`, "Harbour Club")).toEqual({
        ok: false,
        reason: "photo-word",
      });
      expect(validateScene(`a ${word.toUpperCase()} of a quiet harbour`, "n")).toMatchObject({
        ok: false,
      });
    });
  }

  it("simple inflections are rejected; unrelated words that contain them are not", () => {
    for (const s of [
      "photos of a harbour",
      "a rendered harbour",
      "a photographic harbour",
      "realistically drawn boats",
      "lenses over a harbour",
    ]) {
      expect(validateScene(s, "n"), s).toEqual({ ok: false, reason: "photo-word" });
    }
    for (const s of [
      "a lentil field beside a lighthouse",
      "a surrendered flag on a sandcastle",
      "a realm of paper boats",
    ]) {
      expect(validateScene(s, "n"), s).toMatchObject({ ok: true });
    }
  });

  it("a writer answer with a photo word falls back to the motif scene", async () => {
    const calls: SceneWriteRequest[] = [];
    const writer: SceneWriter = {
      async write(req) {
        calls.push(req);
        return "a cinematic harbour at dawn with fishing boats";
      },
    };
    const gen = fakeImageGen();
    const w = await createWorld({
      targets: [],
      plugin: { imageGen: { kind: "command", command: "/opt/fake/gen" } },
    });
    w.addTarget(IDS.a);
    const e = await w.startEngine({ imageGenerator: gen, sceneWriter: writer });
    await w.settle();
    await e.groupNamed(IDS.a, "Harbour Club");
    await w.settle();
    await e.idle();
    await w.settle();
    expect(calls).toHaveLength(1);
    const want = e.view()!.imageWant({ kind: "group", idLower: IDS.a.toLowerCase() });
    const p = gen.calls.filter((c) => c.seed === want.target.seed).at(-1)!.prompt;
    expect(p).toContain(`A scene of ${MOTIF_SCENES[want.target.params.motif]}`);
    expect(p).not.toContain("cinematic");
    expect(e.targetSummary(w.tk(IDS.a))!.scene).toMatchObject({
      source: "motif",
      why: "rejected (photo-word)",
    });
    await e.stop();
  });
});

// ---------------- imageGen.style ----------------

const CMD = { kind: "command", command: "/opt/fake/gen" };
const norm = (imageGen: Record<string, unknown>) =>
  normalizeConfig({ imageGen }, { gatewayStateDir: "/s" });

describe("imageGen.style config (ARCH §2c.13)", () => {
  it("absent: the house clause", () => {
    const n = norm(CMD);
    expect(n.ok).toBe(true);
    expect(n.config.imageGen!.style).toBeUndefined();
    expect(house({})).toContain(HOUSE_STYLE);
  });

  it("an override replaces the clause, trimmed, before the no-marks clause", () => {
    const n = norm({ ...CMD, style: "  soft pastel paper cut-out collage, gentle shapes. " });
    expect(n.ok).toBe(true);
    expect(n.config.imageGen!.style).toBe("soft pastel paper cut-out collage, gentle shapes");
    const look = n.config.imageGen!.style!;
    for (const p of [house({ look }), profile({ look })]) {
      expect(p).not.toContain(HOUSE_STYLE);
      expect(p.endsWith(`${look}, ${NO_MARKS}.`)).toBe(true);
      expect(p).toContain(FULL_BLEED);
    }
  });

  it("empty string: no style clause at all; full-bleed and no-marks stay", () => {
    const n = norm({ ...CMD, style: "" });
    expect(n.ok).toBe(true);
    expect(n.config.imageGen!.style).toBe("");
    for (const p of [house({ look: "" }), profile({ look: "" })]) {
      expect(p).not.toContain(HOUSE_STYLE);
      expect(p).not.toMatch(/illustration|soft light/i);
      expect(p.endsWith(`A ${FULL_BLEED}. No ${NO_MARKS.slice(3)}.`)).toBe(true);
    }
    // Whitespace only is the same as empty.
    expect(norm({ ...CMD, style: "   " }).config.imageGen!.style).toBe("");
  });

  it("each banned word is a config error and the house clause stays", () => {
    for (const word of BANNED_PROMPT_WORDS) {
      for (const style of [`flat ${word} art`, `flat ${word.toUpperCase()}S art`]) {
        const n = norm({ ...CMD, style });
        expect(n.ok, style).toBe(false);
        expect(!n.ok && n.errors.join("\n"), style).toMatch(/imageGen\.style must not contain/);
        expect(n.config.imageGen!.style).toBeUndefined();
      }
    }
    // A word that merely contains one is fine.
    expect(norm({ ...CMD, style: "cardinal red flat shapes" }).ok).toBe(true);
  });

  it("a non-string is a config error", () => {
    const n = norm({ ...CMD, style: 42 });
    expect(n.ok).toBe(false);
    expect(!n.ok && n.errors).toContain("imageGen.style must be a string");
  });

  it("works on the openai-images backend too", () => {
    const n = norm({
      kind: "openai-images",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "m",
      apiKey: { source: "env", provider: "default", id: "K" },
      style: "",
    });
    expect(n.ok).toBe(true);
    expect(n.config.imageGen!.style).toBe("");
  });

  it("manifest: schema and uiHints document it; gateway config validation rejects banned words", async () => {
    const m = JSON.parse(
      await fsp.readFile(path.join(import.meta.dirname, "..", "openclaw.plugin.json"), "utf8"),
    );
    expect(m.configSchema.properties.imageGen.properties.style.type).toBe("string");
    expect(m.uiHints["imageGen.style"].help).toMatch(/empty string adds no style clause/i);
    const check = (style: unknown) =>
      validateJsonSchemaValue({
        schema: m.configSchema,
        cacheKey: "model-badge-flat-style-test",
        value: { imageGen: { ...CMD, style } },
      }).ok;
    expect(check(HOUSE_STYLE)).toBe(true);
    expect(check("")).toBe(true);
    expect(check("cardinal red flat shapes")).toBe(true);
    for (const word of BANNED_PROMPT_WORDS) {
      expect(check(`flat ${word} art`), word).toBe(false);
      expect(check(`flat ${word.toUpperCase()}S art`), word).toBe(false);
    }
    expect(check(42)).toBe(false);
  });

  it("the engine uses the configured style for every generated base", async () => {
    const gen = fakeImageGen();
    const w = await createWorld({
      targets: [IDS.a],
      profile: true,
      plugin: { imageGen: { ...CMD, style: "paper cut-out collage" } },
    });
    const e = await w.startEngine({ imageGenerator: gen });
    await w.settle();
    expect(gen.calls.length).toBeGreaterThanOrEqual(2);
    expect(gen.calls.some((c) => c.portrait)).toBe(true);
    for (const c of gen.calls) {
      expect(c.prompt.endsWith(`paper cut-out collage, ${NO_MARKS}.`)).toBe(true);
      expect(c.prompt).not.toContain(HOUSE_STYLE);
    }
    await e.stop();
  });
});

// ---------------- tag bump ----------------

const OWN = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from("their own artwork: a hand-drawn cat"),
]);

function fakeImageGen() {
  const calls: Array<{ seed: string; prompt: string; portrait: boolean }> = [];
  const gen: BaseArtGenerator & { calls: typeof calls } = {
    id: "fake-image:v1",
    calls,
    available: async () => true,
    async generate(target, style) {
      const prompt = buildPrompt(target, style);
      calls.push({ seed: target.seed, prompt, portrait: Boolean(target.portrait) });
      return fakePng(1024, 1024, `generated ${prompt} ${calls.length}`);
    },
  };
  return gen;
}

// What a scene-v1 base's inputs key was: the old "Soft light, rich detail" finish, tag v1.
function sceneV1InputsKey(prompt: string, imageSeed: string, generator: string) {
  const v1 = prompt.replace(
    `${HOUSE_STYLE}, ${NO_MARKS}.`,
    `Soft light, rich detail, ${NO_MARKS}.`,
  );
  expect(v1).not.toBe(prompt);
  return sha256(canonicalJSON({ prompt: v1, tag: "scene-v1", seed: imageSeed, generator }));
}

describe("BASE_PROMPT_TAG scene-v2 (ARCH §2c.13)", () => {
  it("is scene-v2", () => {
    expect(BASE_PROMPT_TAG).toBe("scene-v2");
  });

  it("scene-v1 generated bases regenerate exactly once; adopted bases are untouched; written scenes are re-wrapped, not rewritten", async () => {
    const SCENE = "rows of tomatoes and runner beans beside a wooden shed";
    const writerCalls: SceneWriteRequest[] = [];
    const writer: SceneWriter = {
      async write(req) {
        writerCalls.push(req);
        return SCENE;
      },
    };
    const gen = fakeImageGen();
    const w = await createWorld({
      targets: [],
      plugin: { imageGen: { ...CMD, maxPerRun: 50, maxPerDay: 500 } },
    });
    w.addTarget(IDS.a, { avatar: OWN });
    w.addTarget(IDS.b, {});
    w.addTarget(IDS.c, {});
    const e = await w.startEngine({ imageGenerator: gen, sceneWriter: writer });
    await w.settle();
    await e.groupNamed(IDS.c, "Garden Club");
    await w.settle();
    await e.idle();
    await w.settle();
    await e.stop();
    expect(writerCalls).toHaveLength(1);

    const seedA = imageSeedFor(w.backend.name, IDS.a.toLowerCase(), 0);
    const seedB = imageSeedFor(w.backend.name, IDS.b.toLowerCase(), 0);
    const seedC = imageSeedFor(w.backend.name, IDS.c.toLowerCase(), 0);
    expect(gen.calls.some((c) => c.seed === seedA)).toBe(false);
    const lastFor = (s: string) => gen.calls.filter((c) => c.seed === s).at(-1)!.prompt;
    expect(lastFor(seedC)).toContain(`A scene of ${SCENE}.`);

    // Rewind B and C to what scene-v1 stored: same scene, the old photographic finish.
    for (const s of [seedB, seedC]) {
      const manPath = `${w.paths.stateDir}/bases/${s}.json`;
      const man = w.fs.getJson<Record<string, unknown>>(manPath);
      man.inputsKey = sceneV1InputsKey(lastFor(s), s, gen.id);
      man.prompt = "scene-v1";
      w.fs.putJson(manPath, man);
    }

    const before = gen.calls.length;
    const sends0 = {
      a: w.targetSends(IDS.a).length,
      b: w.targetSends(IDS.b).length,
      c: w.targetSends(IDS.c).length,
    };
    const e2 = await w.startEngine({ imageGenerator: gen, sceneWriter: writer, instanceId: "up" });
    await w.settle();
    await e2.idle();
    await w.settle();
    const fresh = gen.calls.slice(before);
    // One new picture each for B and C, none for A.
    expect(fresh.map((c) => c.seed).toSorted()).toEqual([seedB, seedC].toSorted());
    for (const c of fresh) {
      expect(c.prompt.endsWith(`${HOUSE_STYLE}, ${NO_MARKS}.`)).toBe(true);
    }
    // C's written scene is kept and re-wrapped; the writer is not called again.
    expect(fresh.find((c) => c.seed === seedC)!.prompt).toContain(`A scene of ${SCENE}.`);
    expect(writerCalls).toHaveLength(1);
    expect(w.targetSends(IDS.a)).toHaveLength(sends0.a);
    expect(w.targetSends(IDS.b)).toHaveLength(sends0.b + 1);
    expect(w.targetSends(IDS.c)).toHaveLength(sends0.c + 1);
    for (const s of [seedB, seedC]) {
      expect(
        w.fs.getJson<Record<string, unknown>>(`${w.paths.stateDir}/bases/${s}.json`),
      ).toMatchObject({ prompt: "scene-v2" });
    }

    // Idempotent: more passes and a restart generate and repaint nothing.
    await e2.runPass("periodic");
    await w.settle();
    await e2.stop();
    const e3 = await w.startEngine({
      imageGenerator: gen,
      sceneWriter: writer,
      instanceId: "again",
    });
    await w.settle();
    await e3.runPass("periodic");
    await w.settle();
    expect(gen.calls).toHaveLength(before + 2);
    expect(writerCalls).toHaveLength(1);
    expect(w.targetSends(IDS.a)).toHaveLength(sends0.a);
    expect(w.targetSends(IDS.b)).toHaveLength(sends0.b + 1);
    expect(w.targetSends(IDS.c)).toHaveLength(sends0.c + 1);
    await e3.stop();
  });
});
