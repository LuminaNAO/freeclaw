import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Mark } from "./badges.js";
import { describeModel } from "./catalog.js";
import { targetIdOf } from "./desired.js";
import type { Engine } from "./engine.js";
import { canonicalJSON } from "./hash.js";
import { targetKey } from "./provider.js";
import { vectorAssetSvg, verifyPng } from "./render.js";
import {
  authorize,
  newRuleId,
  validateRuleInput,
  type Requester,
  type StyleRule,
  type StyleRuleInput,
  type StyleStore,
} from "./style.js";

// ARCH §2a.3: the steering operations behind the `model_badge_style` tool and
// `/badge style`. list | preview | add | remove | reset. Preview has no side effects;
// add/remove/reset write style.json and then ask every engine to pick the change up,
// which rebuilds only the affected assets and repaints only the affected targets.

export type SteeringDeps = {
  engines: () => Engine[];
  store: StyleStore;
  operators: () => string[];
  allowGroupMembers: () => boolean;
  configRules: () => StyleRule[];
  now: () => number;
};

export type Sample = { label: string; png: Buffer };

export type PreviewResult = {
  ok: true;
  rules: Array<Omit<StyleRule, "id" | "createdBy" | "createdAt">>;
  changes: Array<{ provider: string; target: string; models: string[] }>;
  unaffectedTargets: number;
  samples: Sample[];
};

export type StyleError = {
  ok: false;
  error: string;
  known?: { providers: string[]; families: string[] };
};

function allModels(engines: Engine[]) {
  const ids = new Set<string>();
  for (const e of engines) {
    for (const m of e.view()?.available ?? []) {
      ids.add(m);
    }
  }
  return [...ids].toSorted().map(describeModel);
}

function allTargetIds(engines: Engine[]): string[] {
  return [...new Set(engines.flatMap((e) => e.refs().map(targetIdOf)))];
}

function markKey(m: Mark) {
  return canonicalJSON(m);
}

export function createSteering(deps: SteeringDeps) {
  async function storedRules(): Promise<StyleRule[]> {
    return deps.store.load();
  }

  function validateAll(
    inputs: StyleRuleInput[],
    who: Requester,
  ): { ok: true; rules: Array<Omit<StyleRule, "id" | "createdBy" | "createdAt">> } | StyleError {
    const engines = deps.engines();
    if (!engines.some((e) => e.view())) {
      return { ok: false, error: "model-badge is not running yet" };
    }
    if (inputs.length === 0) {
      return { ok: false, error: "no rules given" };
    }
    const models = allModels(engines);
    const targetIds = allTargetIds(engines);
    const out: Array<Omit<StyleRule, "id" | "createdBy" | "createdAt">> = [];
    for (const input of inputs) {
      const v = validateRuleInput(input, {
        models,
        targetIds,
        resolveTargetId: (w) => {
          const word = w.trim().toLowerCase();
          if (word === "this" && who.fromTargetId) {
            return who.fromTargetId;
          }
          return targetIds.includes(word) ? word : null;
        },
      });
      if (!v.ok) {
        return v;
      }
      const auth = authorize(v.rule, who, {
        operators: deps.operators(),
        allowGroupMembers: deps.allowGroupMembers(),
      });
      if (!auth.ok) {
        return { ok: false, error: auth.error };
      }
      out.push(v.rule);
    }
    return { ok: true, rules: out };
  }

  async function renderSamples(engine: Engine, marks: Map<string, { mark: Mark; ref: string }>) {
    const renderer = engine.renderer();
    const view = engine.view();
    const samples: Sample[] = [];
    if (!renderer || !view || marks.size === 0) {
      return samples;
    }
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "model-badge-preview-"));
    try {
      let i = 0;
      for (const { mark, ref } of marks.values()) {
        if (i >= 6) {
          break;
        }
        const r = engine.refs().find((x) => targetKey(x) === ref);
        if (!r) {
          continue;
        }
        const base = view.imageWant(r).target.params;
        const size = engine.size();
        const svg = path.join(dir, `${i}.svg`);
        const png = path.join(dir, `${i}.png`);
        await fsp.writeFile(svg, vectorAssetSvg(base, mark, size.width));
        try {
          await renderer.svgToPng(svg, png, size);
          const bytes = await fsp.readFile(png);
          verifyPng(bytes, size);
          samples.push({ label: `${mark.letter} ${mark.color}`, png: bytes });
        } catch {
          // A sample that fails to render is left out; the preview still lists changes.
        }
        i++;
      }
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
    return samples;
  }

  async function preview(
    inputs: StyleRuleInput[],
    who: Requester,
  ): Promise<PreviewResult | StyleError> {
    const v = validateAll(inputs, who);
    if (!v.ok) {
      return v;
    }
    const changes: PreviewResult["changes"] = [];
    let unaffected = 0;
    const samples: Sample[] = [];
    for (const engine of deps.engines()) {
      const before = engine.view();
      const current = engine.rules();
      const candidate = [
        ...current,
        ...v.rules.map((r, i) => ({
          ...r,
          id: `preview-${i}`,
          createdBy: "preview",
          createdAt: 0,
        })),
      ];
      const after = engine.viewWithRules(candidate);
      if (!before || !after) {
        continue;
      }
      const newMarks = new Map<string, { mark: Mark; ref: string }>();
      for (const ref of engine.refs()) {
        const models: string[] = [];
        for (const m of [...after.available].toSorted()) {
          const a = before.markFor(ref, m).mark;
          const b = after.markFor(ref, m).mark;
          if (markKey(a) !== markKey(b)) {
            models.push(m);
            newMarks.set(markKey(b), { mark: b, ref: targetKey(ref) });
          }
        }
        // A target on its own adopted artwork (or an operator file) keeps that base
        // whatever the style says (§2c.8): only a want that is actually used counts.
        const baseChanged =
          !after.baseLocked(ref) &&
          canonicalJSON({
            p: before.imageWant(ref).target.params,
            s: before.imageWant(ref).style,
          }) !==
            canonicalJSON({ p: after.imageWant(ref).target.params, s: after.imageWant(ref).style });
        if (models.length || baseChanged) {
          changes.push({
            provider: engine.provider.id,
            target: targetKey(ref),
            models: baseChanged && !models.length ? ["(base)"] : models,
          });
          if (baseChanged) {
            const { mark } = after.markFor(ref, after.defaultModel);
            newMarks.set(`${markKey(mark)}:${targetKey(ref)}`, { mark, ref: targetKey(ref) });
          }
        } else {
          unaffected++;
        }
      }
      samples.push(...(await renderSamples(engine, newMarks)));
    }
    return { ok: true, rules: v.rules, changes, unaffectedTargets: unaffected, samples };
  }

  async function notify() {
    for (const e of deps.engines()) {
      await e.inputsChanged();
    }
  }

  return {
    async list() {
      return { ok: true as const, config: deps.configRules(), rules: await storedRules() };
    },

    preview,

    async add(inputs: StyleRuleInput[], who: Requester) {
      const v = validateAll(inputs, who);
      if (!v.ok) {
        return v;
      }
      const rules = await storedRules();
      const added: StyleRule[] = [];
      for (const r of v.rules) {
        const draft = { ...r, createdBy: String(who.senderId ?? "unknown"), createdAt: deps.now() };
        const rule = { id: newRuleId(draft, [...rules, ...added]), ...draft };
        added.push(rule);
      }
      await deps.store.save([...rules, ...added]);
      await notify();
      return { ok: true as const, added };
    },

    async remove(ids: string[], who: Requester) {
      const rules = await storedRules();
      const doomed = rules.filter((r) => ids.includes(r.id));
      if (doomed.length === 0) {
        return { ok: false as const, error: "no stored rule has that id" };
      }
      for (const r of doomed) {
        const auth = authorize(r, who, {
          operators: deps.operators(),
          allowGroupMembers: deps.allowGroupMembers(),
        });
        if (!auth.ok) {
          return { ok: false as const, error: auth.error };
        }
      }
      await deps.store.save(rules.filter((r) => !ids.includes(r.id)));
      await notify();
      return { ok: true as const, removed: doomed.map((r) => r.id) };
    },

    async reset(who: Requester) {
      if (!who.senderId || !deps.operators().includes(String(who.senderId))) {
        return { ok: false as const, error: "reset is operator-only" };
      }
      await deps.store.save([]);
      await notify();
      return { ok: true as const };
    },
  };
}

export type Steering = ReturnType<typeof createSteering>;
