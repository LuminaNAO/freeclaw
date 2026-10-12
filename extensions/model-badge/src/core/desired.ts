import { createMarkResolver, styleMark, type MarkResult } from "./badges.js";
import type { ImageWant, StoredBase } from "./baseart.js";
import { assetHash, baseIdentity, type AssetBase, type AssetJob } from "./cache.js";
import type { BadgeRule, TargetOverride } from "./config.js";
import { canonicalJSON, sha256 } from "./hash.js";
import { baseParamsForSeed, seedFor } from "./motif.js";
import { targetKey, type TargetRef } from "./provider.js";
import { RENDERER_VERSION, type RenderSize } from "./render.js";
import { availableModels, defaultModelOf, resolveModel, type SessionEntryLike } from "./resolve.js";
import { baseStyleFor, markStyleFor, type StyleRule } from "./style.js";

// Desired state: a pure function of the inputs (ARCH §2, §3.5). Nothing here reads a
// file or calls a provider.

export type ViewInputs = {
  store: Record<string, SessionEntryLike>;
  modelsJson: unknown;
  gatewayConfig: unknown;
  badges: BadgeRule[];
  rules: StyleRule[];
  overrides: Record<string, TargetOverride>;
  // The provider's profile base image, if the operator configured one (§2.3).
  profileFile: { file: string; sha: string } | null;
  // A stored image-generated base for a target, when the image backend is in use (§2b).
  storedImage: (want: ImageWant) => StoredBase | null;
};

export type Desired =
  | { ok: false; class: "config"; message: string }
  | {
      ok: true;
      hash: string;
      model: string;
      pinned: boolean;
      mark: MarkResult;
      base: AssetBase;
    };

// The id config, steering and the seed use for a target.
export function targetIdOf(ref: TargetRef): string {
  return ref.kind === "profile" ? "profile" : ref.idLower;
}

export function createView(inputs: ViewInputs, ctx: { providerId: string; size: RenderSize }) {
  const defaultModel = defaultModelOf(inputs.gatewayConfig);
  const available = availableModels(inputs.modelsJson, defaultModel);
  const baseMarkFor = createMarkResolver(inputs.badges, available);

  function imageWant(ref: TargetRef): ImageWant {
    const id = targetIdOf(ref);
    const seed = seedFor(ctx.providerId, id, ref.kind === "profile" ? "profile" : undefined);
    const style = { ...inputs.overrides[id], ...baseStyleFor(inputs.rules, id) };
    const params = baseParamsForSeed(seed, style, { portrait: ref.kind === "profile" });
    return { key: seed, target: { seed, params }, style };
  }

  function baseFor(ref: TargetRef): AssetBase {
    const want = imageWant(ref);
    if (ref.kind === "profile" && inputs.profileFile) {
      return { kind: "raster", key: want.key, source: "file", ...inputs.profileFile };
    }
    const stored = inputs.storedImage(want);
    if (stored) {
      return { kind: "raster", key: want.key, source: "image", sha: stored.sha, file: stored.file };
    }
    return { kind: "vector", key: want.key, params: want.target.params };
  }

  function markFor(ref: TargetRef, model: string | null): MarkResult {
    const base = baseMarkFor(model);
    if (base.kind === "unknown" || !model) {
      return base;
    }
    const style = markStyleFor(inputs.rules, targetIdOf(ref), model);
    return Object.keys(style).length ? { ...base, mark: styleMark(base.mark, style) } : base;
  }

  // Every asset a target needs: one per mark of every available model, plus "?".
  function requiredFor(ref: TargetRef): AssetJob[] {
    const base = baseFor(ref);
    const out = new Map<string, AssetJob>();
    for (const m of [...available, null]) {
      const { mark } = markFor(ref, m);
      const hash = assetHash(mark, base, ctx.size);
      out.set(hash, { hash, mark, base });
    }
    return [...out.values()];
  }

  function desired(ref: TargetRef, sessionKey: string | null): Desired {
    const entry = sessionKey ? inputs.store[sessionKey] : undefined;
    const { model, pinned } = resolveModel(entry, defaultModel);
    if (!model) {
      return { ok: false, class: "config", message: "no default model configured" };
    }
    const mark = markFor(ref, model);
    const base = baseFor(ref);
    return { ok: true, hash: assetHash(mark.mark, base, ctx.size), model, pinned, mark, base };
  }

  // Required-set fingerprint (ARCH §3.5): available models, badge rules, steering rules,
  // target ids, generator params and RENDERER_VERSION.
  function fingerprint(refs: TargetRef[]): string {
    const bases: Record<string, unknown> = {};
    for (const ref of refs) {
      bases[targetKey(ref)] = baseIdentity(baseFor(ref));
    }
    return sha256(
      canonicalJSON({
        available: [...available].toSorted(),
        badges: inputs.badges,
        rules: inputs.rules.map((r) => ({ match: r.match, set: r.set })),
        bases,
        renderer: RENDERER_VERSION,
        size: ctx.size,
      }),
    );
  }

  return {
    defaultModel,
    available,
    imageWant,
    baseFor,
    markFor,
    requiredFor,
    desired,
    fingerprint,
  };
}

export type View = ReturnType<typeof createView>;
