// ARCH §2a.7: steering tests — grouping by provider (incl. aliases), rule order and
// override, preview has no side effects, add repaints only affected targets, unknown
// provider rejected with suggestions, authority, contrast guard for every tone.
import { describe, expect, it } from "vitest";
import { describeModel } from "./core/catalog.js";
import { AA_CONTRAST, contrastRatio } from "./core/color.js";
import { createSteering } from "./core/steering.js";
import {
  authorize,
  createStyleStore,
  markStyleFor,
  seededRules,
  validateRuleInput,
  type StyleRule,
} from "./core/style.js";
import { createWorld, IDS } from "./test-helpers/world.js";

const OP = "+10000000002";
const MEMBER = "+10000000077";
const MODELS = {
  anthropic: ["claude-opus-5", "claude-sonnet-5"],
  openai: ["gpt-5", "gpt-5-mini"],
  moonshot: ["kimi-k2"],
  // A proxy key: family still resolves the maker.
  proxy: ["claude-haiku-5"],
};

async function steered(opts: { allowGroupMembers?: boolean } = {}) {
  const w = await createWorld({
    models: MODELS,
    defaultModel: "anthropic/claude-opus-5",
    plugin: { badges: [], steering: { allowGroupMembers: Boolean(opts.allowGroupMembers) } },
    targets: [IDS.a, IDS.b, IDS.c],
  });
  const e = await w.startEngine();
  await w.settle();
  const steering = createSteering({
    engines: () => [e],
    store: createStyleStore({ fs: w.fs, stateDir: w.paths.rootDir }),
    operators: () => [OP],
    allowGroupMembers: () => Boolean(opts.allowGroupMembers),
    configRules: () => [],
    now: () => w.clock.now(),
  });
  return { w, e, steering };
}

const rule = (match: StyleRule["match"], set: StyleRule["set"], id = "r"): StyleRule => ({
  id,
  match,
  set,
  createdBy: OP,
  createdAt: 0,
});

describe("grouping by provider (ARCH §2a.2)", () => {
  const models = Object.entries(MODELS).flatMap(([p, ids]) =>
    ids.map((m) => describeModel(`${p}/${m}`)),
  );

  it("provider comes from the catalog key and the family maker; aliases resolve", () => {
    expect(describeModel("anthropic/claude-opus-5").providers).toEqual(["anthropic"]);
    expect(describeModel("proxy/claude-haiku-5").providers).toEqual(["anthropic", "proxy"]);
    for (const [word, canonical] of [
      ["claude", "anthropic"],
      ["gpt", "openai"],
      ["kimi", "moonshot"],
      ["Anthropic", "anthropic"],
    ]) {
      const v = validateRuleInput(
        { match: { provider: word }, set: { tone: "light" } },
        { models, targetIds: [] },
      );
      expect(v.ok && v.rule.match.provider).toBe(canonical);
    }
    const fam = validateRuleInput(
      { match: { family: "kimi" }, set: { hue: "green" } },
      { models, targetIds: [] },
    );
    expect(fam.ok && fam.rule.match).toEqual({ family: "kimi" });
  });

  it("an instruction that matches nothing is rejected with the known providers and families", () => {
    const v = validateRuleInput(
      { match: { provider: "mistral" }, set: { tone: "dark" } },
      { models, targetIds: [] },
    );
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.error).toMatch(/unknown provider "mistral"/);
      expect(v.known?.providers).toEqual(["anthropic", "moonshot", "openai", "proxy"]);
      expect(v.known?.families).toEqual(["claude", "gpt", "kimi"]);
    }
    const glob = validateRuleInput(
      { match: { modelGlob: "*llama*" }, set: { tone: "dark" } },
      { models, targetIds: [] },
    );
    expect(glob.ok).toBe(false);
    const bad = validateRuleInput(
      { match: { provider: "openai" }, set: { motif: "waves" } },
      { models, targetIds: [] },
    );
    expect(bad.ok).toBe(false);
  });

  it("rule order: later rules win on conflict; a rule never edits another", () => {
    const rules = [
      rule({ provider: "anthropic" }, { tone: "light", letter: "A" }, "1"),
      rule({ modelGlob: "*opus*" }, { tone: "dark" }, "2"),
      rule({ provider: "anthropic" }, { hue: "green" }, "3"),
      rule({ provider: "anthropic" }, { color: "#123456" }, "4"),
    ];
    expect(markStyleFor(rules.slice(0, 2), "t", "anthropic/claude-opus-5")).toEqual({
      tone: "dark",
      letter: "A",
    });
    expect(markStyleFor(rules.slice(0, 2), "t", "anthropic/claude-sonnet-5")).toEqual({
      tone: "light",
      letter: "A",
    });
    expect(markStyleFor(rules.slice(0, 3), "t", "anthropic/claude-opus-5")).toEqual({
      tone: "dark",
      letter: "A",
      hue: "green",
    });
    expect(markStyleFor(rules, "t", "anthropic/claude-opus-5")).toEqual({
      tone: "dark",
      letter: "A",
      color: "#123456",
    });
    expect(markStyleFor(rules, "t", "openai/gpt-5")).toEqual({});
  });
});

describe("steering operations (ARCH §2a.3, §2a.5)", () => {
  it("preview has no side effects: no file written, no render, no send", async () => {
    const { w, steering } = await steered();
    // The lease heartbeat is the only writer while idle; everything else must be untouched.
    const snapshot = () =>
      new Map(
        [...w.fs.files]
          .filter(([k]) => !k.endsWith("writer.lease"))
          .map(([k, v]) => [k, v.mtimeMs]),
      );
    const files = snapshot();
    const sends = w.sends().length;
    const renders = w.renderCalls();
    const p = await steering.preview([{ match: { provider: "claude" }, set: { tone: "light" } }], {
      senderId: OP,
    });
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.changes.map((c) => c.target).toSorted()).toHaveLength(3);
      expect(p.changes[0]!.models).toEqual([
        "anthropic/claude-opus-5",
        "anthropic/claude-sonnet-5",
        "proxy/claude-haiku-5",
      ]);
    }
    await w.settle();
    expect(snapshot()).toEqual(files);
    expect(w.sends()).toHaveLength(sends);
    expect(w.renderCalls()).toBe(renders);
  });

  it("add → only targets whose current model is affected repaint; others get zero writes", async () => {
    const { w, e, steering } = await steered();
    w.pin(IDS.b, "openai/gpt-5");
    await w.settle();
    const sends = w.sends().length;
    // "OpenAI models dark": only B (on gpt-5) shows an OpenAI mark.
    const r = await steering.add(
      [{ match: { provider: "gpt" }, set: { tone: "dark" }, note: "OpenAI dark" }],
      { senderId: OP },
    );
    expect(r.ok).toBe(true);
    await w.settle();
    expect(w.sends()).toHaveLength(sends + 1);
    expect(w.sends().at(-1)!.target).toBe(IDS.b);
    // The new marks were generated for every target (pre-render), not only B.
    expect(e.status().cache.required).toBeGreaterThan(0);
    const stored = await createStyleStore({ fs: w.fs, stateDir: w.paths.rootDir }).load();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      match: { provider: "openai" },
      set: { tone: "dark" },
      createdBy: OP,
      note: "OpenAI dark",
    });
    // remove → back to the previous mark, again only B.
    await steering.remove([stored[0]!.id], { senderId: OP });
    await w.settle();
    expect(w.sends()).toHaveLength(sends + 2);
    expect(w.sends().at(-1)!.target).toBe(IDS.b);
    await e.stop();
  });

  it("a target-scoped base rule (motif) repaints only that target", async () => {
    const { w, e, steering } = await steered();
    const sends = w.sends().length;
    const motif = e.view()!.imageWant({ kind: "group", idLower: IDS.c.toLowerCase() }).target
      .params.motif;
    const r = await steering.add(
      [
        {
          match: { targetId: IDS.c.toLowerCase() },
          set: { motif: motif === "waves" ? "dots" : "waves" },
        },
      ],
      { senderId: OP },
    );
    expect(r.ok).toBe(true);
    await w.settle();
    expect(
      w
        .sends()
        .slice(sends)
        .map((s) => s.target),
    ).toEqual([IDS.c]);
    await e.stop();
  });

  it("unknown provider is rejected with suggestions and nothing is stored", async () => {
    const { w, steering } = await steered();
    const r = await steering.add([{ match: { provider: "llama" }, set: { tone: "dark" } }], {
      senderId: OP,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/known providers: anthropic, moonshot, openai, proxy/);
    }
    expect(w.fs.exists(`${w.paths.rootDir}/style.json`)).toBe(false);
  });

  it("config-seeded rules come first; stored rules follow and win", () => {
    const seeded = seededRules([{ match: { provider: "anthropic" }, set: { tone: "light" } }]);
    expect(seeded[0]).toMatchObject({ id: "config-0", createdBy: "config" });
    const stored = rule({ provider: "anthropic" }, { tone: "dark" });
    expect(markStyleFor([...seeded, stored], "t", "anthropic/claude-opus-5")).toEqual({
      tone: "dark",
    });
  });
});

describe("authority (ARCH §2a.4)", () => {
  const cfg = (allowGroupMembers: boolean) => ({ operators: [OP], allowGroupMembers });

  it("global rules are operator-only", () => {
    expect(
      authorize(rule({ provider: "openai" }, { tone: "dark" }), { senderId: OP }, cfg(true)).ok,
    ).toBe(true);
    const r = authorize(
      rule({ provider: "openai" }, { tone: "dark" }),
      { senderId: MEMBER, fromTargetId: "g1" },
      cfg(true),
    );
    expect(r.ok).toBe(false);
  });

  it("group members may steer only their own group, and only when allowed", () => {
    const own = rule({ targetId: "g1" }, { motif: "waves" });
    expect(authorize(own, { senderId: MEMBER, fromTargetId: "g1" }, cfg(true))).toEqual({
      ok: true,
      as: "member",
    });
    expect(authorize(own, { senderId: MEMBER, fromTargetId: "g2" }, cfg(true)).ok).toBe(false);
    expect(authorize(own, { senderId: MEMBER, fromTargetId: "g1" }, cfg(false)).ok).toBe(false);
    expect(authorize(own, { senderId: null, fromTargetId: "g1" }, cfg(true)).ok).toBe(true);
  });

  it("end to end: a member's global rule is refused; their group rule ('this') is scoped to their group", async () => {
    const { w, e, steering } = await steered({ allowGroupMembers: true });
    const here = { senderId: MEMBER, fromTargetId: IDS.a.toLowerCase() };
    const g = await steering.add(
      [{ match: { provider: "anthropic" }, set: { tone: "dark" } }],
      here,
    );
    expect(g.ok).toBe(false);
    const sends = w.sends().length;
    const mine = await steering.add([{ match: { targetId: "this" }, set: { hue: "green" } }], here);
    expect(mine.ok).toBe(true);
    if (mine.ok) {
      expect(mine.added[0]!.match).toEqual({ targetId: IDS.a.toLowerCase() });
    }
    await w.settle();
    expect(
      w
        .sends()
        .slice(sends)
        .map((s) => s.target),
    ).toEqual([IDS.a]);
    const other = await steering.add(
      [{ match: { targetId: IDS.b.toLowerCase() }, set: { hue: "red" } }],
      here,
    );
    expect(other.ok).toBe(false);
    const reset = await steering.reset(here);
    expect(reset.ok).toBe(false);
    await e.stop();
  });
});

describe("contrast guard (ARCH §2a.6)", () => {
  it("whatever the rule says, the letter colour meets WCAG AA against the badge colour", async () => {
    const { e } = await steered();
    const view = e.view()!;
    const ref = { kind: "group" as const, idLower: IDS.a.toLowerCase() };
    const sets = [
      { tone: "light" as const },
      { tone: "dark" as const },
      ...["red", "yellow", "green", "cyan", "blue", "purple", "pink", 0, 60, 200].flatMap((hue) => [
        { hue },
        { hue, tone: "light" as const },
        { hue, tone: "dark" as const },
      ]),
      { color: "#FFFF00" },
      { color: "#000000" },
      { color: "#808080" },
    ];
    for (const set of sets) {
      const v = e.viewWithRules([rule({ provider: "anthropic" }, set)])!;
      for (const m of view.available) {
        const mark = v.markFor(ref, m).mark;
        expect(contrastRatio(mark.color, mark.text)).toBeGreaterThanOrEqual(AA_CONTRAST);
      }
    }
    // tone picks the badge lightness band, not the letter.
    const light = e
      .viewWithRules([rule({ provider: "anthropic" }, { tone: "light" })])!
      .markFor(ref, "anthropic/claude-opus-5").mark;
    const dark = e
      .viewWithRules([rule({ provider: "anthropic" }, { tone: "dark" })])!
      .markFor(ref, "anthropic/claude-opus-5").mark;
    expect(contrastRatio(light.color, "#FFFFFF")).toBeLessThan(
      contrastRatio(dark.color, "#FFFFFF"),
    );
    await e.stop();
  });
});
