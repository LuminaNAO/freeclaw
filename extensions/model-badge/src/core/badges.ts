import { applyTone, colorFromHue, normalizeHex, parseHue, textColorFor } from "./color.js";
import type { BadgeRule } from "./config.js";
import { sha256 } from "./hash.js";
import { MARK_COLORS, UNKNOWN_COLOR, pick } from "./palette.js";
import { modelSuffix } from "./resolve.js";

// ARCH §2.2: the badge mark per model. Config `badges` rules (pattern → {letter,
// color}) first; a deterministic fallback for unmatched models; the fixed "?" mark for
// unknown/unavailable models. Steering (§2a) restyles marks on top. The letter colour
// is always the contrast guard's choice (§2a.6).

export type Mark = {
  letter: string;
  color: string;
  text: string;
  scale: number;
};

export type MarkKind = "rule" | "auto" | "unknown";
export type MarkResult = { mark: Mark; kind: MarkKind; label: string };

export type MarkStyle = {
  tone?: "light" | "dark";
  hue?: string | number;
  color?: string;
  letter?: string;
  letterScale?: number;
};

export const UNKNOWN_MARK: Readonly<Mark> = Object.freeze({
  letter: "?",
  color: UNKNOWN_COLOR,
  text: textColorFor(UNKNOWN_COLOR),
  scale: 1,
});

export function unknownMark(): MarkResult {
  return { mark: { ...UNKNOWN_MARK }, kind: "unknown", label: "unknown" };
}

function alnum(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

// Ordered 2-character candidates for a model whose family letter is shared: the first
// letter of the variant token, then the first digit, then every further character.
function candidates(suffix: string): { first: string; pairs: string[] } {
  const tokens = suffix.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const first = alnum(tokens[0] ?? "").slice(0, 1) || "?";
  const pairs: string[] = [];
  const add = (c: string | undefined) => {
    if (c && !pairs.includes(first + c)) {
      pairs.push(first + c);
    }
  };
  add(alnum(tokens[1] ?? "").slice(0, 1));
  add(/\d/.exec(suffix)?.[0]);
  for (const c of alnum(suffix).slice(1)) {
    add(c);
  }
  return { first, pairs };
}

// Fallback letters for every unmatched model in the available set, unique within it.
// Same-suffix models (one model listed under two catalog keys) share a mark.
export function fallbackLetters(unmatched: Iterable<string>): Map<string, string> {
  const bySuffix = new Map<string, string[]>();
  for (const m of unmatched) {
    const s = modelSuffix(m);
    bySuffix.set(s, [...(bySuffix.get(s) ?? []), m]);
  }
  const suffixes = [...bySuffix.keys()].toSorted();
  const firstCount = new Map<string, number>();
  for (const s of suffixes) {
    const f = candidates(s).first;
    firstCount.set(f, (firstCount.get(f) ?? 0) + 1);
  }
  const taken = new Set<string>();
  const out = new Map<string, string>();
  for (const s of suffixes) {
    const { first, pairs } = candidates(s);
    let letter = first;
    if ((firstCount.get(first) ?? 0) > 1) {
      letter = pairs.find((p) => !taken.has(p)) ?? first;
    }
    taken.add(letter);
    for (const m of bySuffix.get(s) ?? []) {
      out.set(m, letter);
    }
  }
  return out;
}

export function fallbackColor(model: string): string {
  return pick(MARK_COLORS, Number.parseInt(sha256(modelSuffix(model)).slice(0, 8), 16));
}

// Steering on top of a base mark. Explicit `color` is exact; otherwise `hue` sets the
// hue and `tone` the lightness band. The text colour is recomputed by the guard.
export function styleMark(mark: Mark, style: MarkStyle): Mark {
  let color = mark.color;
  const hue = parseHue(style.hue);
  if (typeof style.color === "string") {
    color = normalizeHex(style.color);
  } else if (hue !== null) {
    color = colorFromHue(hue, style.tone);
  } else if (style.tone) {
    color = applyTone(color, style.tone);
  }
  const letter =
    typeof style.letter === "string" && /^[A-Za-z0-9?]{1,2}$/.test(style.letter)
      ? style.letter.toUpperCase()
      : mark.letter;
  const scale =
    typeof style.letterScale === "number" && style.letterScale > 0 ? style.letterScale : mark.scale;
  return { letter, color, text: textColorFor(color), scale };
}

function compileRule(r: BadgeRule): RegExp | null {
  try {
    return new RegExp(r.pattern, "i");
  } catch {
    return null;
  }
}

export function createMarkResolver(rules: BadgeRule[], available: Set<string>) {
  const compiled = rules
    .map((r) => ({ rule: r, re: compileRule(r) }))
    .filter((c): c is { rule: BadgeRule; re: RegExp } => c.re !== null);
  const ruleFor = (model: string) =>
    compiled.find((c) => c.re.test(model) || c.re.test(modelSuffix(model)));
  const unmatched = [...available].filter((m) => !ruleFor(m));
  const letters = fallbackLetters(unmatched);

  // Base mark (before steering) for a model, or the unknown mark when it is not available.
  return function markFor(model: string | null): MarkResult {
    if (!model || !available.has(model)) {
      return unknownMark();
    }
    const hit = ruleFor(model);
    if (hit) {
      const color = normalizeHex(hit.rule.color);
      const prefer =
        hit.rule.textDark === undefined ? undefined : hit.rule.textDark ? "dark" : "light";
      return {
        mark: { letter: hit.rule.letter, color, text: textColorFor(color, prefer), scale: 1 },
        kind: "rule",
        label: `rule:${hit.rule.letter}`,
      };
    }
    const color = fallbackColor(model);
    const letter = letters.get(model) ?? (alnum(modelSuffix(model)).slice(0, 1) || "?");
    return {
      mark: { letter, color, text: textColorFor(color), scale: 1 },
      kind: "auto",
      label: `auto:${letter}`,
    };
  };
}
