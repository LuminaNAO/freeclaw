import path from "node:path";
import type { MarkStyle } from "./badges.js";
import {
  canonicalFamily,
  canonicalProvider,
  describeModel,
  globToRegExp,
  knownGroups,
  type ModelInfo,
} from "./catalog.js";
import { isHex, parseHue, HUE_NAMES } from "./color.js";
import type { CoreFs } from "./fsio.js";
import { sha256 } from "./hash.js";
import { isMotif, MOTIFS } from "./motif.js";
import { PALETTE_NAMES } from "./palette.js";

// ARCH §2a: steering. Style rules are data: an ordered list in `<stateDir>/style.json`,
// written only through this module (the agent tool and `/badge style`), optionally
// seeded by operator defaults from config. Later rules win on conflict; a rule never
// edits another.

export type StyleMatch = {
  provider?: string;
  family?: string;
  modelGlob?: string;
  targetId?: string;
};

export type StyleSet = {
  tone?: "light" | "dark";
  hue?: string | number;
  color?: string;
  letter?: string;
  motif?: string;
  palette?: string;
  letterScale?: number;
  prompt?: string;
};

export type StyleRule = {
  id: string;
  match: StyleMatch;
  set: StyleSet;
  createdBy: string;
  createdAt: number;
  note?: string;
};

export type StyleRuleInput = { match?: unknown; set?: unknown; note?: unknown };

export const STYLE_FILE = "style.json";

const MARK_KEYS = ["tone", "hue", "color", "letter", "letterScale"] as const;
const BASE_KEYS = ["motif", "palette", "prompt"] as const;

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function isGlobal(rule: Pick<StyleRule, "match">): boolean {
  return !rule.match.targetId;
}

export function hasModelScope(match: StyleMatch): boolean {
  return Boolean(match.provider || match.family || match.modelGlob);
}

// ---------------- validation (rejects anything that would match nothing) ----------------

export type ValidateContext = {
  models: ModelInfo[];
  // Canonical target ids the rule may name (provider-scoped keys).
  targetIds: string[];
  resolveTargetId?: (word: string) => string | null;
};

export type ValidateResult =
  | { ok: true; rule: Omit<StyleRule, "id" | "createdBy" | "createdAt"> }
  | { ok: false; error: string; known?: { providers: string[]; families: string[] } };

export function validateRuleInput(input: StyleRuleInput, ctx: ValidateContext): ValidateResult {
  const m = obj(input.match);
  const s = obj(input.set);
  const known = knownGroups(ctx.models);
  const match: StyleMatch = {};

  if (m.provider !== undefined) {
    const p = typeof m.provider === "string" ? canonicalProvider(m.provider, ctx.models) : null;
    if (!p) {
      return {
        ok: false,
        error: `unknown provider "${String(m.provider)}"; known providers: ${known.providers.join(", ") || "none"}`,
        known,
      };
    }
    match.provider = p;
  }
  if (m.family !== undefined) {
    const f = typeof m.family === "string" ? canonicalFamily(m.family, ctx.models) : null;
    if (!f) {
      // A family word that is really a provider alias ("kimi") is resolved as a provider.
      const asProvider =
        typeof m.family === "string" && !match.provider
          ? canonicalProvider(m.family, ctx.models)
          : null;
      if (!asProvider) {
        return {
          ok: false,
          error: `unknown model family "${String(m.family)}"; known families: ${known.families.join(", ") || "none"}`,
          known,
        };
      }
      match.provider = asProvider;
    } else {
      match.family = f;
    }
  }
  if (m.modelGlob !== undefined) {
    if (typeof m.modelGlob !== "string" || !m.modelGlob.trim()) {
      return { ok: false, error: "modelGlob must be a non-empty string" };
    }
    match.modelGlob = m.modelGlob.trim();
  }
  if (m.targetId !== undefined) {
    const t =
      typeof m.targetId === "string"
        ? (ctx.resolveTargetId?.(m.targetId) ??
          (ctx.targetIds.includes(m.targetId) ? m.targetId : null))
        : null;
    if (!t) {
      return { ok: false, error: `unknown target "${String(m.targetId)}"` };
    }
    match.targetId = t;
  }

  const set: StyleSet = {};
  if (s.tone !== undefined) {
    if (s.tone !== "light" && s.tone !== "dark") {
      return { ok: false, error: 'tone must be "light" or "dark"' };
    }
    set.tone = s.tone;
  }
  if (s.hue !== undefined) {
    if (parseHue(s.hue) === null) {
      return {
        ok: false,
        error: `hue must be a degree or one of ${Object.keys(HUE_NAMES).join(", ")}`,
      };
    }
    set.hue = s.hue as string | number;
  }
  if (s.color !== undefined) {
    if (!isHex(s.color)) {
      return { ok: false, error: "color must be #RRGGBB" };
    }
    set.color = s.color.toUpperCase();
  }
  if (s.letter !== undefined) {
    if (typeof s.letter !== "string" || !/^[A-Za-z0-9?]{1,2}$/.test(s.letter)) {
      return { ok: false, error: "letter must be 1-2 letters or digits" };
    }
    set.letter = s.letter.toUpperCase();
  }
  if (s.letterScale !== undefined) {
    if (typeof s.letterScale !== "number" || !(s.letterScale >= 0.5 && s.letterScale <= 1.6)) {
      return { ok: false, error: "letterScale must be a number between 0.5 and 1.6" };
    }
    set.letterScale = s.letterScale;
  }
  if (s.motif !== undefined) {
    if (!isMotif(s.motif)) {
      return { ok: false, error: `motif must be one of ${MOTIFS.join(", ")}` };
    }
    set.motif = s.motif;
  }
  if (s.palette !== undefined) {
    if (typeof s.palette !== "string" || !PALETTE_NAMES.includes(s.palette.toLowerCase())) {
      return { ok: false, error: `palette must be one of ${PALETTE_NAMES.join(", ")}` };
    }
    set.palette = s.palette.toLowerCase();
  }
  if (s.prompt !== undefined) {
    if (typeof s.prompt !== "string" || !s.prompt.trim() || s.prompt.length > 200) {
      return { ok: false, error: "prompt must be 1-200 characters" };
    }
    set.prompt = s.prompt.trim();
  }
  if (Object.keys(set).length === 0) {
    return { ok: false, error: "the rule sets nothing" };
  }
  if (hasModelScope(match) && BASE_KEYS.some((k) => k in set)) {
    return {
      ok: false,
      error: "motif, palette and prompt shape a target's base; they cannot be scoped to models",
    };
  }
  // Must match something now: a model-scoped rule must hit at least one known model.
  if (hasModelScope(match) && !ctx.models.some((mi) => modelMatches(match, mi))) {
    return {
      ok: false,
      error: `the rule matches no available model; known providers: ${known.providers.join(", ") || "none"}; families: ${known.families.join(", ") || "none"}`,
      known,
    };
  }
  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim() : undefined;
  return { ok: true, rule: { match, set, note } };
}

// ---------------- matching ----------------

export function modelMatches(match: StyleMatch, mi: ModelInfo): boolean {
  if (match.provider && !mi.providers.includes(match.provider)) {
    return false;
  }
  if (match.family && mi.family !== match.family) {
    return false;
  }
  if (match.modelGlob) {
    const re = globToRegExp(match.modelGlob);
    if (!re.test(mi.id) && !re.test(mi.id.slice(mi.id.indexOf("/") + 1))) {
      return false;
    }
  }
  return true;
}

function targetMatches(match: StyleMatch, targetId: string): boolean {
  return !match.targetId || match.targetId === targetId;
}

// Mark style for (target, model): every rule whose target and model scopes both match,
// in order; later rules overwrite earlier keys.
export function markStyleFor(rules: StyleRule[], targetId: string, model: string): MarkStyle {
  const mi = describeModel(model);
  const out: Record<string, unknown> = {};
  for (const r of rules) {
    if (!targetMatches(r.match, targetId) || !modelMatches(r.match, mi)) {
      continue;
    }
    for (const k of MARK_KEYS) {
      if (r.set[k] !== undefined) {
        out[k] = r.set[k];
        // An explicit colour and a hue are alternatives: the later one wins outright.
        if (k === "color") {
          delete out.hue;
        }
        if (k === "hue") {
          delete out.color;
        }
      }
    }
  }
  return out as MarkStyle;
}

// Base style for a target: rules without model scope that are global or name this target.
export function baseStyleFor(
  rules: StyleRule[],
  targetId: string,
): { motif?: string; palette?: string; prompt?: string } {
  const out: { motif?: string; palette?: string; prompt?: string } = {};
  for (const r of rules) {
    if (hasModelScope(r.match) || !targetMatches(r.match, targetId)) {
      continue;
    }
    for (const k of BASE_KEYS) {
      if (r.set[k] !== undefined) {
        out[k] = r.set[k] as string;
      }
    }
  }
  return out;
}

// ---------------- authority (§2a.4) ----------------

export type Requester = {
  senderId?: string | null;
  // Canonical target id of the chat the request came from, if it is a badge target.
  fromTargetId?: string | null;
};

export function authorize(
  rule: Pick<StyleRule, "match">,
  who: Requester,
  cfg: { operators: string[]; allowGroupMembers: boolean },
): { ok: true; as: "operator" | "member" } | { ok: false; error: string } {
  if (who.senderId && cfg.operators.includes(String(who.senderId))) {
    return { ok: true, as: "operator" };
  }
  if (isGlobal(rule)) {
    return { ok: false, error: "global rules (provider/family/model) are operator-only" };
  }
  if (!cfg.allowGroupMembers) {
    return { ok: false, error: "steering is operator-only (steering.allowGroupMembers is off)" };
  }
  if (who.fromTargetId && who.fromTargetId === rule.match.targetId) {
    return { ok: true, as: "member" };
  }
  return { ok: false, error: "group members may only add rules for the group they are in" };
}

// ---------------- the store ----------------

export function newRuleId(rule: Omit<StyleRule, "id">, existing: StyleRule[]): string {
  const base = sha256(JSON.stringify([rule, existing.length])).slice(0, 8);
  let id = `r-${base}`;
  for (let i = 2; existing.some((r) => r.id === id); i++) {
    id = `r-${base}-${i}`;
  }
  return id;
}

function sanitizeStored(raw: unknown): StyleRule[] {
  const list = Array.isArray(obj(raw).rules) ? (obj(raw).rules as unknown[]) : [];
  const out: StyleRule[] = [];
  for (const r of list) {
    const o = obj(r);
    if (typeof o.id !== "string") {
      continue;
    }
    out.push({
      id: o.id,
      match: obj(o.match) as StyleMatch,
      set: obj(o.set) as StyleSet,
      createdBy: typeof o.createdBy === "string" ? o.createdBy : "unknown",
      createdAt: typeof o.createdAt === "number" ? o.createdAt : 0,
      note: typeof o.note === "string" ? o.note : undefined,
    });
  }
  return out;
}

// Operator-seeded defaults from config come first; stored rules follow (later wins).
export function seededRules(raw: unknown[]): StyleRule[] {
  return sanitizeStored({
    rules: raw.map((r, i) => ({ id: `config-${i}`, createdBy: "config", ...obj(r) })),
  });
}

export function createStyleStore({ fs, stateDir }: { fs: CoreFs; stateDir: string }) {
  const file = path.join(stateDir, STYLE_FILE);
  return {
    file,
    async load(): Promise<StyleRule[]> {
      try {
        return sanitizeStored(JSON.parse(await fs.readText(file)));
      } catch (err) {
        if ((await fs.stat(file)) === null) {
          return [];
        }
        throw err;
      }
    },
    async save(rules: StyleRule[]): Promise<void> {
      await fs.mkdirp(stateDir);
      await fs.writeAtomic(file, JSON.stringify({ version: 1, rules }, null, 1));
    },
  };
}

export type StyleStore = ReturnType<typeof createStyleStore>;
