// Colour maths for marks: WCAG 2.x relative luminance and contrast, and HSL bands for
// steering tones (ARCH §2.2, §2a.6).

export const TEXT_DARK = "#000000";
export const TEXT_LIGHT = "#FFFFFF";
// WCAG AA for normal text. Black or white against any colour always reaches at least
// ~4.58:1, so this bound holds for every mark whatever a rule asks for.
export const AA_CONTRAST = 4.5;

export function isHex(v: unknown): v is string {
  return typeof v === "string" && /^#[0-9A-Fa-f]{6}$/.test(v);
}

export function normalizeHex(v: string): string {
  return v.toUpperCase();
}

function channels(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// The letter colour with the higher contrast against the badge colour. A preferred
// colour (from a config rule) is honoured only when it still meets AA.
export function textColorFor(badge: string, prefer?: "dark" | "light"): string {
  const dark = contrastRatio(badge, TEXT_DARK);
  const light = contrastRatio(badge, TEXT_LIGHT);
  if (prefer === "dark" && dark >= AA_CONTRAST) {
    return TEXT_DARK;
  }
  if (prefer === "light" && light >= AA_CONTRAST) {
    return TEXT_LIGHT;
  }
  return dark >= light ? TEXT_DARK : TEXT_LIGHT;
}

export function rgbToHsl(hex: string): [number, number, number] {
  const [r, g, b] = channels(hex).map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) {
    return [0, 0, l];
  }
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) {
    h = (g - b) / d + (g < b ? 6 : 0);
  } else if (max === g) {
    h = (b - r) / d + 2;
  } else {
    h = (r - g) / d + 4;
  }
  return [h * 60, s, l];
}

export function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    hue < 60
      ? [c, x, 0]
      : hue < 120
        ? [x, c, 0]
        : hue < 180
          ? [0, c, x]
          : hue < 240
            ? [0, x, c]
            : hue < 300
              ? [x, 0, c]
              : [c, 0, x];
  const hex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`.toUpperCase();
}

// Plain-language hues the agent may pass for "Kimi should be green" (§2a.1 `hue`).
export const HUE_NAMES: Record<string, number> = {
  red: 0,
  orange: 28,
  amber: 42,
  yellow: 52,
  lime: 85,
  green: 130,
  teal: 172,
  cyan: 188,
  blue: 212,
  indigo: 240,
  purple: 275,
  violet: 285,
  magenta: 305,
  pink: 330,
};

export function parseHue(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    return ((v % 360) + 360) % 360;
  }
  if (typeof v === "string") {
    const key = v.trim().toLowerCase();
    if (key in HUE_NAMES) {
      return HUE_NAMES[key];
    }
    const n = Number(key);
    if (key && Number.isFinite(n)) {
      return ((n % 360) + 360) % 360;
    }
  }
  return null;
}

// Lightness bands for `tone`: tone picks the badge lightness, never the letter (§2a.6).
export const TONE_LIGHTNESS = { light: 0.74, dark: 0.3 } as const;
export const TONE_SATURATION = 0.62;

export function applyTone(color: string, tone: "light" | "dark"): string {
  const [h, s] = rgbToHsl(color);
  return hslToHex(h, Math.max(s, 0.35), TONE_LIGHTNESS[tone]);
}

export function colorFromHue(hue: number, tone?: "light" | "dark"): string {
  return hslToHex(hue, TONE_SATURATION, tone ? TONE_LIGHTNESS[tone] : 0.5);
}
