import { describe, expect, it } from "vitest";
import { createMarkResolver, fallbackLetters, styleMark, UNKNOWN_MARK } from "./badges.js";
import { assetHash, type AssetBase } from "./cache.js";
import { AA_CONTRAST, contrastRatio, TEXT_DARK, TEXT_LIGHT, textColorFor } from "./color.js";
import { normalizeConfig } from "./config.js";
import { baseParamsForSeed, MOTIFS, renderBaseSvg, seedFor } from "./motif.js";
import { MARK_COLORS, PALETTE_NAMES } from "./palette.js";
import { markLayerSvg, RENDERER_VERSION, vectorAssetSvg } from "./render.js";
import { availableModels, defaultModelOf, resolveModel } from "./resolve.js";

const SIZE = { width: 512, height: 512 };

// ARCH §6.1: generator determinism.
describe("generator determinism (ARCH §2.1, §6.1)", () => {
  it("same target → same base bytes; different targets → different bases", () => {
    const a1 = renderBaseSvg(baseParamsForSeed(seedFor("signal", "group-x")));
    const a2 = renderBaseSvg(baseParamsForSeed(seedFor("signal", "group-x")));
    expect(a1).toBe(a2);
    const bases = new Set<string>();
    for (let i = 0; i < 40; i++) {
      bases.add(renderBaseSvg(baseParamsForSeed(seedFor("signal", `group-${i}`))));
    }
    expect(bases.size).toBe(40);
  });

  it("different targets are visibly different: palettes and motifs both vary across targets", () => {
    const params = Array.from({ length: 40 }, (_, i) =>
      baseParamsForSeed(seedFor("signal", `t${i}`)),
    );
    expect(new Set(params.map((p) => p.motif)).size).toBe(MOTIFS.length);
    expect(new Set(params.map((p) => p.palette)).size).toBeGreaterThan(4);
  });

  it("seed = sha256(providerId:targetId); the profile uses a distinct namespace", () => {
    expect(seedFor("signal", "t1")).toMatch(/^[0-9a-f]{64}$/);
    expect(seedFor("signal", "t1")).not.toBe(seedFor("fakechat", "t1"));
    expect(seedFor("signal", "t1", "profile")).not.toBe(seedFor("signal", "t1"));
    // The plain target id never appears in the generated art.
    expect(renderBaseSvg(baseParamsForSeed(seedFor("signal", "secret-target")))).not.toContain(
      "secret-target",
    );
  });

  it("the profile base is portrait-safe: radially centred motifs only", () => {
    const motifs = new Set(
      Array.from(
        { length: 30 },
        (_, i) =>
          baseParamsForSeed(seedFor("signal", `p${i}`, "profile"), {}, { portrait: true }).motif,
      ),
    );
    expect([...motifs].toSorted()).toEqual(["facets", "rings"]);
  });

  it("operator overrides (motif, palette) change the base deterministically", () => {
    const seed = seedFor("signal", "group-x");
    const plain = baseParamsForSeed(seed);
    const other = MOTIFS.find((m) => m !== plain.motif)!;
    const over = baseParamsForSeed(seed, { motif: other, palette: "mint" });
    expect(over.motif).toBe(other);
    expect(over.palette).toBe("mint");
    expect(renderBaseSvg(over)).toContain(`data-motif="${other}"`);
    expect(renderBaseSvg(baseParamsForSeed(seed, { motif: other, palette: "mint" }))).toBe(
      renderBaseSvg(over),
    );
  });

  it("generated art is geometric primitives only: no embedded images, no text in the base", () => {
    for (let i = 0; i < 20; i++) {
      const svg = renderBaseSvg(baseParamsForSeed(seedFor("signal", `t${i}`)));
      expect(svg).not.toMatch(/<image|<text|base64|xlink:href/);
      const tags = new Set([...svg.matchAll(/<([a-zA-Z]+)/g)].map((m) => m[1]));
      for (const t of tags) {
        expect([
          "svg",
          "defs",
          "linearGradient",
          "stop",
          "rect",
          "g",
          "circle",
          "path",
          "polygon",
        ]).toContain(t);
      }
    }
  });

  it("same model → same mark; asset hash covers generator inputs only", () => {
    const avail = new Set(["p/alpha-1", "p/beta"]);
    const r = createMarkResolver([], avail);
    expect(r("p/alpha-1")).toEqual(r("p/alpha-1"));
    const base: AssetBase = {
      kind: "vector",
      key: "k",
      params: baseParamsForSeed(seedFor("signal", "t")),
    };
    const m = r("p/alpha-1").mark;
    expect(assetHash(m, base, SIZE)).toBe(assetHash({ ...m }, { ...base, key: "other-key" }, SIZE));
    expect(assetHash(m, base, SIZE)).not.toBe(assetHash({ ...m, color: "#000000" }, base, SIZE));
    const other: AssetBase = {
      kind: "vector",
      key: "k",
      params: baseParamsForSeed(seedFor("signal", "u")),
    };
    expect(assetHash(m, base, SIZE)).not.toBe(assetHash(m, other, SIZE));
    expect(assetHash(m, base, SIZE)).not.toBe(assetHash(m, base, { width: 256, height: 256 }));
    expect(RENDERER_VERSION).toBeGreaterThanOrEqual(1);
  });

  it("asset SVG composites our mark (letter as text) over the generated base", () => {
    const svg = vectorAssetSvg(
      baseParamsForSeed(seedFor("signal", "t")),
      { letter: "O", color: "#9B59D0", text: TEXT_LIGHT, scale: 1 },
      512,
    );
    expect(svg).toContain('data-mark="O"');
    expect(svg).toMatch(/<text[^>]*fill="#FFFFFF"[^>]*>O<\/text>/);
    expect(
      markLayerSvg({ letter: "<", color: "#000000", text: TEXT_LIGHT, scale: 1 }, 512),
    ).toContain(">&#60;</text>");
  });
});

// ARCH §6.2: mark derivation.
describe("mark derivation (ARCH §2.2, §6.2)", () => {
  const rules = normalizeConfig(
    {
      badges: [
        { pattern: "opus", letter: "O", color: "#9B59D0" },
        { pattern: "^prov/fable", letter: "F", color: "#FFD700", textDark: true },
      ],
    },
    { gatewayStateDir: "/s" },
  ).config.badges;

  it("rules match by pattern (on the full id or the model part), exact letter and colour", () => {
    const avail = new Set(["prov/opus-a", "other/opus-b", "prov/fable-model"]);
    const r = createMarkResolver(rules, avail);
    expect(r("prov/opus-a").mark).toMatchObject({
      letter: "O",
      color: "#9B59D0",
      text: textColorFor("#9B59D0"),
    });
    expect(r("prov/opus-a").mark).toEqual(r("other/opus-b").mark);
    expect(r("prov/fable-model")).toMatchObject({
      kind: "rule",
      mark: { letter: "F", text: TEXT_DARK },
    });
  });

  it("unknown/unavailable models get the fixed '?' mark", () => {
    const r = createMarkResolver(rules, new Set(["prov/opus-a"]));
    expect(r("prov/gone")).toMatchObject({ kind: "unknown", mark: UNKNOWN_MARK });
    expect(r(null).mark.letter).toBe("?");
  });

  it("fallback letters: family letter; a variant letter/digit only when needed; unique in the set", () => {
    expect(fallbackLetters(["p/zeta"]).get("p/zeta")).toBe("Z");
    const set = ["p/gpt-5", "p/gpt-4o", "p/gemini-pro", "p/grok-3", "p/kimi-k2", "p/qwen3-max"];
    const letters = fallbackLetters(set);
    expect(new Set(letters.values()).size).toBe(set.length);
    expect(letters.get("p/kimi-k2")).toBe("K");
    expect(letters.get("p/qwen3-max")).toBe("Q");
    for (const m of ["p/gpt-5", "p/gpt-4o", "p/gemini-pro", "p/grok-3"]) {
      expect(letters.get(m)).toMatch(/^G[A-Z0-9]$/);
    }
    // One model listed under two catalog keys keeps one mark.
    const dup = fallbackLetters(["a/gpt-5", "b/gpt-5", "a/gemini"]);
    expect(dup.get("a/gpt-5")).toBe(dup.get("b/gpt-5"));
    // Deterministic regardless of iteration order.
    expect([...fallbackLetters([...set].reverse())].toSorted()).toEqual([...letters].toSorted());
  });

  it("fallback letters stay unique for many near-identical ids", () => {
    const set = Array.from({ length: 12 }, (_, i) => `p/model-${i}`);
    expect(new Set(fallbackLetters(set).values()).size).toBe(12);
  });

  it("fallback colour comes from the built-in list by hash; text from WCAG contrast", () => {
    const r = createMarkResolver([], new Set(["p/zeta", "q/zeta"]));
    const m = r("p/zeta").mark;
    expect(MARK_COLORS).toContain(m.color);
    expect(r("q/zeta").mark.color).toBe(m.color);
    expect(m.text).toBe(textColorFor(m.color));
  });

  it("contrast: every built-in mark colour reaches WCAG AA with the chosen text colour", () => {
    for (const c of [
      ...MARK_COLORS,
      UNKNOWN_MARK.color,
      "#FFD700",
      "#FFFFFF",
      "#000000",
      "#777777",
    ]) {
      expect(contrastRatio(c, textColorFor(c))).toBeGreaterThanOrEqual(AA_CONTRAST);
    }
    // A rule's textDark preference is honoured only if it still meets AA.
    expect(textColorFor("#111111", "dark")).toBe(TEXT_LIGHT);
    expect(textColorFor("#FFD700", "dark")).toBe(TEXT_DARK);
  });

  it("styleMark recomputes the text colour for whatever colour steering sets", () => {
    const base = { letter: "C", color: "#2E86DE", text: TEXT_LIGHT, scale: 1 };
    for (const style of [
      { tone: "light" as const },
      { tone: "dark" as const },
      { hue: "green" },
      { color: "#FFFF00" },
    ]) {
      const m = styleMark(base, style);
      expect(contrastRatio(m.color, m.text)).toBeGreaterThanOrEqual(AA_CONTRAST);
    }
    expect(styleMark(base, { letter: "x", letterScale: 1.3 })).toMatchObject({
      letter: "X",
      scale: 1.3,
    });
  });

  it("config validation rejects bad rules and unknown motif/palette names", () => {
    const bad = normalizeConfig(
      {
        badges: [
          { pattern: "x", letter: "ABC", color: "#000000" },
          { pattern: "y", letter: "A", color: "red" },
        ],
        targets: { t: { motif: "flowers", palette: "neon" } },
      },
      { gatewayStateDir: "/s" },
    );
    expect(bad.ok).toBe(false);
    expect(bad.ok ? [] : bad.errors).toHaveLength(4);
    expect(PALETTE_NAMES.length).toBeGreaterThanOrEqual(6);
    const good = normalizeConfig({}, { gatewayStateDir: "/s" });
    expect(good.ok).toBe(true);
    expect(good.config.stateDir).toBe("/s/plugins/model-badge");
    expect(good.config.providers).toEqual(["signal"]);
  });
});

describe("model resolution (ported)", () => {
  it("an override pair pins; anything else falls to the default; entry.model is ignored", () => {
    expect(
      resolveModel({ providerOverride: "p", modelOverride: "m", model: "x/y" }, "d/d"),
    ).toEqual({ model: "p/m", pinned: true });
    expect(resolveModel({ model: "x/y" }, "d/d")).toEqual({ model: "d/d", pinned: false });
    expect(resolveModel({ providerOverride: "p", modelOverride: "" }, "d/d")).toEqual({
      model: "d/d",
      pinned: false,
    });
    expect(defaultModelOf({ agents: { defaults: { model: "a/b" } } })).toBe("a/b");
    expect(defaultModelOf({ agents: { defaults: { model: { primary: "c/d" } } } })).toBe("c/d");
    expect(defaultModelOf({})).toBeNull();
  });

  it("available = qualified ids from models.json (ids may contain '/') plus the default", () => {
    const s = availableModels(
      { providers: { p: { models: [{ id: "a" }, { id: "x/y" }] }, q: {} } },
      "z/default",
    );
    expect([...s].toSorted()).toEqual(["p/a", "p/x/y", "z/default"]);
  });
});
