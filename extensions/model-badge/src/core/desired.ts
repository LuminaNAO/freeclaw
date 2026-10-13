import { createMarkResolver, styleMark, type MarkResult } from "./badges.js";
import type { ImageWant, StoredBase } from "./baseart.js";
import { assetHash, baseIdentity, type AssetBase, type AssetJob } from "./cache.js";
import type { BadgeRule, TargetOverride } from "./config.js";
import { canonicalJSON, sha256 } from "./hash.js";
import { baseParamsForSeed, imageSeedFor, seedFor, type BaseParams } from "./motif.js";
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
  // ARCH §2c.4: imageGen is configured, so every base is meant to be an image base.
  imageMode?: boolean;
  // The base of the avatar of ours a target shows now (null: none). Used to keep that
  // avatar while its image base is not ready.
  held?: (targetKey: string) => HeldBase | null;
  // ARCH §2c.3: the target's generation counter, by base key.
  generation?: (baseKey: string) => number;
};

// What a target shows now: a vector base (with its exact parameters), a stored raster
// base, or something of ours whose base can no longer be rebuilt (kept as it is).
export type HeldBase =
  | { kind: "vector"; params: BaseParams }
  | { kind: "raster"; source: "image" | "file"; sha: string; file: string }
  | { kind: "unknown" };

export type Desired =
  | { ok: false; class: "config" | "waiting-for-image"; message: string }
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

  // `key` is the target's stable base seed (vector params, §2.1); the image seed adds the
  // generation counter (§2c.3). The profile uses its own namespace and prompt (§2c.5).
  function imageWant(ref: TargetRef): ImageWant {
    const id = targetIdOf(ref);
    const ns = ref.kind === "profile" ? "profile" : undefined;
    const key = seedFor(ctx.providerId, id, ns);
    const generation = inputs.generation?.(key) ?? 0;
    const style = { ...inputs.overrides[id], ...baseStyleFor(inputs.rules, id) };
    const portrait = ref.kind === "profile";
    const params = baseParamsForSeed(key, style, { portrait });
    const seed = imageSeedFor(ctx.providerId, id, generation, ns);
    return { key, generation, target: { seed, params, ...(portrait ? { portrait } : {}) }, style };
  }

  // ARCH §2c.4, image first: with imageGen configured a target shows its image base; if
  // that is not ready it keeps the avatar it has, and only a target with no avatar of
  // ours gets a vector base (upgraded as soon as the image exists). null: keep as is.
  function baseFor(ref: TargetRef): AssetBase | null {
    const want = imageWant(ref);
    if (ref.kind === "profile" && inputs.profileFile) {
      return { kind: "raster", key: want.key, source: "file", ...inputs.profileFile };
    }
    const stored = inputs.storedImage(want);
    if (stored) {
      return { kind: "raster", key: want.key, source: "image", sha: stored.sha, file: stored.file };
    }
    const vector: AssetBase = { kind: "vector", key: want.key, params: want.target.params };
    if (!inputs.imageMode) {
      return vector;
    }
    const held = inputs.held?.(targetKey(ref)) ?? null;
    if (!held) {
      return vector;
    }
    if (held.kind === "vector") {
      return { kind: "vector", key: want.key, params: held.params };
    }
    if (held.kind === "raster") {
      return { kind: "raster", key: want.key, source: held.source, sha: held.sha, file: held.file };
    }
    return null;
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
    if (!base) {
      return [];
    }
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
    if (!base) {
      return {
        ok: false,
        class: "waiting-for-image",
        message: "waiting for the image base; keeping the current avatar",
      };
    }
    return { ok: true, hash: assetHash(mark.mark, base, ctx.size), model, pinned, mark, base };
  }

  // Required-set fingerprint (ARCH §3.5): available models, badge rules, steering rules,
  // target ids, generator params and RENDERER_VERSION.
  function fingerprint(refs: TargetRef[]): string {
    const bases: Record<string, unknown> = {};
    for (const ref of refs) {
      const base = baseFor(ref);
      const want = imageWant(ref);
      // The image inputs count too: a target that keeps its avatar while its new image
      // is made (§2c.4) still changes the fingerprint when its style or generation does.
      bases[targetKey(ref)] = {
        base: base ? baseIdentity(base) : { kind: "held" },
        image: inputs.imageMode
          ? { seed: want.target.seed, params: want.target.params, style: want.style }
          : null,
      };
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
