import { sha256 } from "./hash.js";
import { PALETTES, paletteByName, pick, type Palette } from "./palette.js";

// ARCH §2.1: the vector base generator. A target's base is derived from a seed by
// built-in parametric SVG motifs made only of geometric primitives (rings, waves,
// facets, dots). No drawn or imported artwork exists anywhere in the repo: every
// coordinate below is computed from a handful of small integers taken from the seed.

export const MOTIFS = ["rings", "waves", "facets", "dots"] as const;
export type MotifName = (typeof MOTIFS)[number];

export function isMotif(v: unknown): v is MotifName {
  return typeof v === "string" && (MOTIFS as readonly string[]).includes(v);
}

export type MotifParams = { n: number; step: number; phase: number };

export type BaseParams = {
  motif: MotifName;
  motifParams: MotifParams;
  palette: string;
  colors: [string, string];
  accent: string;
  angle: number;
};

export type BaseOverrides = { motif?: string; palette?: string };

// ARCH §2.3: the profile base is a portrait-safe abstract. Profile pictures are shown
// cropped to a circle, so only radially centred motifs are picked for it.
export const PORTRAIT_MOTIFS: readonly MotifName[] = ["rings", "facets"];

// seed = sha256(providerId + ":" + targetId) (ARCH §2.1). The profile base uses the
// same generator under a distinct namespace (§2.3). Only the hash is ever stored.
export function seedFor(providerId: string, targetId: string, namespace?: "profile"): string {
  const plain = `${providerId}:${targetId}`;
  return sha256(namespace ? `${namespace}:${plain}` : plain);
}

function word(seed: string, i: number): number {
  return Number.parseInt(seed.slice((i * 8) % 56, ((i * 8) % 56) + 8), 16);
}

export function baseParamsForSeed(
  seed: string,
  overrides: BaseOverrides = {},
  opts: { portrait?: boolean } = {},
): BaseParams {
  const palette: Palette = paletteByName(overrides.palette) ?? pick(PALETTES, word(seed, 0));
  const g1 = word(seed, 1) % palette.grounds.length;
  let g2 = word(seed, 2) % palette.grounds.length;
  if (g2 === g1) {
    g2 = (g2 + 1) % palette.grounds.length;
  }
  const motif = isMotif(overrides.motif)
    ? overrides.motif
    : pick(opts.portrait ? PORTRAIT_MOTIFS : MOTIFS, word(seed, 3));
  return {
    motif,
    motifParams: { n: word(seed, 4) % 97, step: word(seed, 5) % 89, phase: word(seed, 6) % 83 },
    palette: palette.name,
    colors: [palette.grounds[g1] as string, palette.grounds[g2] as string],
    accent: pick(palette.accents, word(seed, 7)),
    angle: (word(seed, 1) % 8) * 45,
  };
}

const fx = (v: number) => (Math.round(v * 10) / 10).toString();

function rings(p: MotifParams, accent: string, size: number): string {
  const c = size / 2;
  const count = 3 + (p.n % 4);
  const max = size * 0.46;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const r = (max * (i + 1)) / count;
    const w = 4 + ((p.step + i) % 5) * 3;
    const op = 0.14 + 0.1 * ((p.phase + i) % 4);
    out.push(
      `<circle cx="${fx(c)}" cy="${fx(c)}" r="${fx(r)}" fill="none" stroke="${accent}" ` +
        `stroke-width="${w}" opacity="${op.toFixed(2)}"/>`,
    );
  }
  return out.join("");
}

function waves(p: MotifParams, accent: string, size: number): string {
  const lines = 3 + (p.n % 4);
  const amp = size * (0.03 + (p.step % 5) * 0.012);
  const period = size * (0.2 + (p.phase % 4) * 0.08);
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    const y0 = (size * (i + 1)) / (lines + 1);
    const pts: string[] = [];
    for (let x = 0; x <= size; x += size / 32) {
      const y = y0 + amp * Math.sin(((x + p.phase * 7 + i * 29) / period) * Math.PI * 2);
      pts.push(`${pts.length ? "L" : "M"}${fx(x)} ${fx(y)}`);
    }
    const w = 4 + ((p.step + i) % 4) * 3;
    const op = 0.16 + 0.1 * ((p.phase + i) % 4);
    out.push(
      `<path d="${pts.join(" ")}" fill="none" stroke="${accent}" stroke-width="${w}" ` +
        `stroke-linecap="round" opacity="${op.toFixed(2)}"/>`,
    );
  }
  return out.join("");
}

function facets(p: MotifParams, accent: string, size: number): string {
  const sides = 3 + (p.n % 5);
  const count = 4 + (p.step % 4);
  const c = size / 2;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const r = size * (0.1 + 0.085 * i);
    const rot = ((p.phase * 17 + i * 31) % 360) * (Math.PI / 180);
    const pts: string[] = [];
    for (let k = 0; k < sides; k++) {
      const a = rot + (k / sides) * Math.PI * 2;
      pts.push(`${fx(c + r * Math.cos(a))},${fx(c + r * Math.sin(a))}`);
    }
    const op = 0.08 + 0.06 * ((p.phase + i) % 4);
    out.push(`<polygon points="${pts.join(" ")}" fill="${accent}" opacity="${op.toFixed(2)}"/>`);
  }
  return out.join("");
}

function dots(p: MotifParams, accent: string, size: number): string {
  const cols = 5 + (p.n % 3);
  const cell = size / cols;
  const out: string[] = [];
  let k = 0;
  for (let gy = 0; gy < cols; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const sel = (k * 31 + p.phase * 7 + p.step * 13) % 100;
      if (sel < 50) {
        const r = cell * (0.08 + ((sel + p.step) % 5) * 0.04);
        const op = 0.18 + 0.5 * (sel / 100);
        out.push(
          `<circle cx="${fx(cell * (gx + 0.5))}" cy="${fx(cell * (gy + 0.5))}" r="${fx(r)}" ` +
            `fill="${accent}" opacity="${op.toFixed(2)}"/>`,
        );
      }
      k++;
    }
  }
  return out.join("");
}

const MOTIF_RENDER: Record<MotifName, (p: MotifParams, accent: string, size: number) => string> = {
  rings,
  waves,
  facets,
  dots,
};

// The base's inner SVG (no <svg> wrapper), so a mark can be composited on top.
export function baseSvgBody(bp: BaseParams, size: number): string {
  const [c1, c2] = bp.colors;
  const a = (bp.angle * Math.PI) / 180;
  const x2 = 0.5 + 0.5 * Math.cos(a);
  const y2 = 0.5 + 0.5 * Math.sin(a);
  return (
    `<defs><linearGradient id="mb-ground" x1="${fx(1 - x2)}" y1="${fx(1 - y2)}" ` +
    `x2="${fx(x2)}" y2="${fx(y2)}"><stop offset="0" stop-color="${c1}"/>` +
    `<stop offset="1" stop-color="${c2}"/></linearGradient></defs>` +
    `<rect width="${size}" height="${size}" fill="url(#mb-ground)"/>` +
    `<g data-motif="${bp.motif}">${MOTIF_RENDER[bp.motif](bp.motifParams, bp.accent, size)}</g>`
  );
}

// A standalone base SVG. Same params → same bytes.
export function renderBaseSvg(bp: BaseParams, size = 512): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${size} ${size}">${baseSvgBody(bp, size)}</svg>`
  );
}
