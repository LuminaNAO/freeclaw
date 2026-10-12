// ARCH §2.1 / §2.4: built-in palettes. Background gradients, motif accents and fallback
// mark colours come from these lists only. Operators pick a palette by name at runtime
// (`targets.<id>.palette`, steering `palette`); nothing operator-specific is in the repo.

export type Palette = {
  name: string;
  // Gradient grounds, dark enough that a mark with a dark ring reads on top.
  grounds: readonly string[];
  // Motif strokes and fills.
  accents: readonly string[];
};

export const PALETTES: readonly Palette[] = [
  {
    name: "ocean",
    grounds: ["#0B2545", "#13315C", "#134074", "#0E3B43"],
    accents: ["#8DA9C4", "#5FA8D3", "#62B6CB", "#CAE9FF"],
  },
  {
    name: "forest",
    grounds: ["#1B3A2B", "#22413A", "#2D4A35", "#14322A"],
    accents: ["#8FC1A9", "#A3C9A8", "#69B578", "#D0E8C5"],
  },
  {
    name: "dusk",
    grounds: ["#2B2D42", "#3D2C5E", "#2E1F47", "#40335A"],
    accents: ["#B8A1E3", "#E2A3C7", "#8D99AE", "#F2D0E6"],
  },
  {
    name: "ember",
    grounds: ["#3B1F1A", "#4A2321", "#3A2618", "#2F1B19"],
    accents: ["#F4A261", "#E76F51", "#F6BD60", "#FFD6A5"],
  },
  {
    name: "slate",
    grounds: ["#1F2933", "#27323F", "#323F4B", "#1A222B"],
    accents: ["#9AA5B1", "#CBD2D9", "#7B8794", "#E4E7EB"],
  },
  {
    name: "plum",
    grounds: ["#3A1C3F", "#2E1A36", "#45213F", "#2B1530"],
    accents: ["#D291BC", "#FEC8D8", "#957DAD", "#E0BBE4"],
  },
  {
    name: "sand",
    grounds: ["#3E3426", "#4A3F2E", "#352C21", "#2F2A22"],
    accents: ["#E9C46A", "#D4A373", "#FAEDCD", "#CCD5AE"],
  },
  {
    name: "mint",
    grounds: ["#103830", "#0F2F2E", "#1A4140", "#123A35"],
    accents: ["#7AE7C7", "#B8F2E6", "#5EC2B7", "#AED9E0"],
  },
];

export const PALETTE_NAMES: readonly string[] = PALETTES.map((p) => p.name);

export function paletteByName(name: string | undefined): Palette | null {
  if (!name) {
    return null;
  }
  const key = name.trim().toLowerCase();
  return PALETTES.find((p) => p.name === key) ?? null;
}

// Fallback mark colours for models no `badges` rule matches (ARCH §2.2): saturated
// mid-tones so either black or white text reaches AA on them.
export const MARK_COLORS: readonly string[] = [
  "#2E86DE",
  "#10AC84",
  "#EE5253",
  "#F39C12",
  "#8E44AD",
  "#16A085",
  "#D35400",
  "#C0392B",
  "#2980B9",
  "#27AE60",
  "#E84393",
  "#6C5CE7",
];

// The fixed mark for an unknown/unavailable model.
export const UNKNOWN_COLOR = "#95A5A6";

export function pick<T>(list: readonly T[], n: number): T {
  return list[((n % list.length) + list.length) % list.length] as T;
}
