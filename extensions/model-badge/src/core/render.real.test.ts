// ARCH §5.4 / §6: the real render pipeline, with the real rasteriser on this host. It
// skips only with an explicit "renderer unavailable" reason when neither rsvg-convert
// nor magick exists; CI notes the skip (see README "Tests").
import { execFileSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createImageBases, type BaseArtGenerator } from "./baseart.js";
import { assetHash, createAssetCache, type AssetBase, type AssetJob } from "./cache.js";
import { contrastRatio, TEXT_DARK, TEXT_LIGHT } from "./color.js";
import { createNodeFs } from "./fsio.js";
import { sha256 } from "./hash.js";
import { baseParamsForSeed, renderBaseSvg, seedFor } from "./motif.js";
import {
  ADOPTED_FRAME,
  adoptedAssetSvg,
  createRenderer,
  detectRasteriser,
  isStamped,
  rasterBaseSvg,
  verifyPng,
  type RasteriserId,
} from "./render.js";

const SIZE = { width: 512, height: 512 };
const clock = { now: () => Date.now(), setTimeout: () => 0, clearTimeout: () => {} };
const log = { info() {}, warn() {}, error() {} };

const rasteriser = await detectRasteriser();
export const RENDERER_UNAVAILABLE =
  "renderer unavailable: neither rsvg-convert nor magick is on PATH";
const hasMagick = await detectRasteriser(async (bin, args) => {
  if (bin !== "magick") {
    return false;
  }
  try {
    execFileSync(bin, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
});

// Pixel sampling via ImageMagick (test-only).
function pixel(png: string, x: number, y: number): number[] {
  const fx = `%[fx:int(255*p{${x},${y}}.r)],%[fx:int(255*p{${x},${y}}.g)],%[fx:int(255*p{${x},${y}}.b)]`;
  return execFileSync("magick", [png, "-format", fx, "info:"]).toString().split(",").map(Number);
}
const hex = (h: string) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
const near = (a: number[], b: number[], tol = 8) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "model-badge-render-"));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

function vectorBase(target: string): AssetBase {
  const seed = seedFor("signal", target);
  return { kind: "vector", key: seed, params: baseParamsForSeed(seed) };
}

describe.skipIf(!rasteriser)(`real render pipeline (${rasteriser ?? RENDERER_UNAVAILABLE})`, () => {
  const renderer = () => createRenderer(rasteriser as RasteriserId);

  for (const [name, mark] of [
    ["1 letter, dark text", { letter: "F", color: "#FFD700", text: TEXT_DARK, scale: 1 }],
    ["2 letters, light text", { letter: "KL", color: "#6C3483", text: TEXT_LIGHT, scale: 1 }],
    ["unknown '?'", { letter: "?", color: "#95A5A6", text: TEXT_DARK, scale: 1 }],
  ] as const) {
    it(`renders ${name} over a generated base → verified 512×512 PNG`, async () => {
      await withDir(async (dir) => {
        const cache = createAssetCache({
          fs: createNodeFs(),
          renderer: renderer(),
          cacheDir: dir,
          size: SIZE,
          clock,
          log,
        });
        const base = vectorBase("t-render");
        const h = assetHash(mark, base, SIZE);
        const r = await cache.ensure(new Map([[h, { hash: h, mark, base }]]));
        expect(r.failed).toEqual([]);
        const png = path.join(dir, `${h}.png`);
        const buf = await fsp.readFile(png);
        expect(verifyPng(buf, SIZE)).toEqual(SIZE);
        expect(buf.length).toBeGreaterThan(1000);
        const man = JSON.parse(await fsp.readFile(path.join(dir, `${h}.json`), "utf8"));
        expect(man).toMatchObject({ hash: h, width: 512, height: 512 });
        if (hasMagick) {
          // Disc edge carries the mark colour; the bar too.
          expect(
            near(
              pixel(png, Math.round(512 * 0.79 - 512 * 0.15 + 14), Math.round(512 * 0.79)),
              hex(mark.color),
            ),
          ).toBe(true);
          expect(
            near(pixel(png, Math.round(512 * 0.2), Math.round(512 * 0.9125)), hex(mark.color)),
          ).toBe(true);
          let found = false;
          const c = Math.round(512 * 0.79);
          for (let x = c - 30; x <= c + 30 && !found; x += 2) {
            for (let y = c - 30; y <= c + 30 && !found; y += 2) {
              found = near(pixel(png, x, y), hex(mark.text), 30);
            }
          }
          expect(found).toBe(true);
          expect(contrastRatio(mark.color, mark.text)).toBeGreaterThanOrEqual(4.5);
        }
      });
    });
  }

  it("rebuild: 5 generated bases × 4 marks = 20 verified assets; a second rebuild renders 0", async () => {
    await withDir(async (dir) => {
      const cache = createAssetCache({
        fs: createNodeFs(),
        renderer: renderer(),
        cacheDir: dir,
        size: SIZE,
        clock,
        log,
        concurrency: 2,
      });
      const marks = [
        { letter: "F", color: "#FFD700", text: TEXT_DARK, scale: 1 },
        { letter: "O", color: "#9B59D0", text: TEXT_LIGHT, scale: 1 },
        { letter: "KL", color: "#6C3483", text: TEXT_LIGHT, scale: 1 },
        { letter: "?", color: "#95A5A6", text: TEXT_DARK, scale: 1 },
      ];
      const jobs = new Map<string, AssetJob>();
      for (const t of ["t1", "t2", "t3", "t4", "t5"]) {
        const base = vectorBase(t);
        for (const mark of marks) {
          const h = assetHash(mark, base, SIZE);
          jobs.set(h, { hash: h, mark, base });
        }
      }
      const first = await cache.ensure(jobs);
      expect(first).toMatchObject({ required: 20, rendered: 20, failed: [] });
      for (const h of jobs.keys()) {
        verifyPng(await fsp.readFile(path.join(dir, `${h}.png`)), SIZE);
      }
      expect((await cache.ensure(jobs)).rendered).toBe(0);
    });
  });

  it("same inputs → the same base PNG bytes (deterministic rasterisation)", async () => {
    await withDir(async (dir) => {
      const r = renderer();
      const svg = path.join(dir, "b.svg");
      await fsp.writeFile(svg, renderBaseSvg(baseParamsForSeed(seedFor("signal", "det"))));
      await r.svgToPng(svg, path.join(dir, "1.png"), SIZE);
      await r.svgToPng(svg, path.join(dir, "2.png"), SIZE);
      expect(sha256(await fsp.readFile(path.join(dir, "1.png")))).toBe(
        sha256(await fsp.readFile(path.join(dir, "2.png"))),
      );
    });
  });

  it("a raster base (non-square image) is cropped square and the mark composited over it", async () => {
    await withDir(async (dir) => {
      const r = renderer();
      // A wide raster picture made at runtime (never committed): 800×400 solid colour.
      const srcSvg = path.join(dir, "src.svg");
      await fsp.writeFile(
        srcSvg,
        '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"><rect width="800" height="400" fill="#335577"/></svg>',
      );
      const srcPng = path.join(dir, "src.png");
      await r.svgToPng(srcSvg, srcPng, { width: 800, height: 400 });
      const fs = createNodeFs();
      const gen: BaseArtGenerator = {
        id: "test-image",
        available: async () => true,
        generate: async () => fsp.readFile(srcPng),
      };
      const bases = createImageBases({
        fs,
        dir: path.join(dir, "bases"),
        generator: gen,
        renderer: r,
        size: SIZE,
        clock,
        log,
        limits: { maxPerDay: 5, maxPerRun: 5, maxAttempts: 1, backoffMs: 1 },
      });
      await bases.probe();
      const seed = seedFor("signal", "img");
      const want = {
        key: seed,
        generation: 0,
        target: { seed, params: baseParamsForSeed(seed) },
        style: {},
      };
      expect((await bases.ensure([want])).generated).toBe(1);
      const stored = bases.current(want)!;
      expect(verifyPng(await fsp.readFile(stored.file), SIZE)).toEqual(SIZE);
      const cache = createAssetCache({
        fs,
        renderer: r,
        cacheDir: path.join(dir, "c"),
        size: SIZE,
        clock,
        log,
      });
      const mark = { letter: "O", color: "#9B59D0", text: TEXT_LIGHT, scale: 1 };
      const base: AssetBase = {
        kind: "raster",
        key: seed,
        source: "image",
        sha: stored.sha,
        file: stored.file,
      };
      const h = assetHash(mark, base, SIZE);
      expect((await cache.ensure(new Map([[h, { hash: h, mark, base }]]))).failed).toEqual([]);
      const png = path.join(dir, "c", `${h}.png`);
      verifyPng(await fsp.readFile(png), SIZE);
      if (hasMagick) {
        expect(near(pixel(png, 10, 10), hex("#335577"))).toBe(true);
        expect(
          near(
            pixel(png, Math.round(512 * 0.79 - 512 * 0.15 + 14), Math.round(512 * 0.79)),
            hex("#9B59D0"),
          ),
        ).toBe(true);
      }
    });
  });

  it("ARCH §2c.8: rendered assets carry our stamp and still decode as a valid image", async () => {
    await withDir(async (dir) => {
      const fs = createNodeFs();
      const mark = { letter: "S", color: "#2E86C1", text: TEXT_LIGHT, scale: 1 };
      const base = vectorBase("stamp");
      const h = assetHash(mark, base, SIZE);
      await createAssetCache({
        fs,
        renderer: renderer(),
        cacheDir: dir,
        size: SIZE,
        clock,
        log,
      }).ensure(new Map([[h, { hash: h, mark, base }]]));
      const png = await fsp.readFile(path.join(dir, `${h}.png`));
      expect(isStamped(png)).toBe(true);
      // The stamped PNG round-trips through the rasteriser (CRC and chunk layout are valid).
      const svg = path.join(dir, "rt.svg");
      await fsp.writeFile(svg, rasterBaseSvg({ mime: "image/png", bytes: png }, SIZE.width));
      await renderer().svgToPng(svg, path.join(dir, "rt.png"), SIZE);
      expect(verifyPng(await fsp.readFile(path.join(dir, "rt.png")), SIZE)).toEqual(SIZE);
      if (hasMagick) {
        execFileSync("magick", [path.join(dir, `${h}.png`), "-format", "%w", "info:"]);
      }
    });
  });

  it.skipIf(!hasMagick)(
    "ARCH §2c.8: an adopted image is shown whole (contain) on a darkened blurred fill; its corners are visible and clear of the mark",
    async () => {
      await withDir(async (dir) => {
        const r = renderer();
        // A wide picture with text-like detail at its very edges: red left edge, blue
        // right edge, green bottom strip ("logo text" at the bottom). Slice-cropping
        // would drop the side edges; covering would hide the bottom strip.
        const srcSvg = path.join(dir, "own.svg");
        await fsp.writeFile(
          srcSvg,
          '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400">' +
            '<rect width="800" height="400" fill="#F0F0F0"/>' +
            '<rect width="40" height="400" fill="#FF0000"/>' +
            '<rect x="760" width="40" height="400" fill="#0000FF"/>' +
            '<rect y="360" width="800" height="40" fill="#00FF00"/></svg>',
        );
        const srcPng = path.join(dir, "own.png");
        await r.svgToPng(srcSvg, srcPng, { width: 800, height: 400 });
        const bytes = await fsp.readFile(srcPng);
        const mark = { letter: "O", color: "#9B59D0", text: TEXT_LIGHT, scale: 1 };
        const svg = path.join(dir, "a.svg");
        await fsp.writeFile(svg, adoptedAssetSvg({ mime: "image/png", bytes }, mark, SIZE.width));
        const out = path.join(dir, "a.png");
        await r.svgToPng(svg, out, SIZE);
        const S = SIZE.width;
        const f = ADOPTED_FRAME;
        // Contained: an 800×400 image in the s×s frame is s wide, s/2 tall, centred.
        const x0 = f.x * S;
        const x1 = (f.x + f.s) * S;
        const top = (f.y + f.s / 4) * S;
        const bottom = (f.y + (3 * f.s) / 4) * S;
        const midY = (top + bottom) / 2;
        expect(near(pixel(out, Math.round(x0 + 3), Math.round(midY)), hex("#FF0000"), 40)).toBe(
          true,
        );
        expect(near(pixel(out, Math.round(x1 - 4), Math.round(midY)), hex("#0000FF"), 40)).toBe(
          true,
        );
        expect(
          near(pixel(out, Math.round((x0 + x1) / 2), Math.round(bottom - 3)), hex("#00FF00"), 40),
        ).toBe(true);
        // The image corners are inside the visible circle and outside the mark.
        for (const [cx, cy] of [
          [x0, top],
          [x1, top],
          [x0, bottom],
          [x1, bottom],
        ] as const) {
          expect(Math.hypot(cx - S / 2, cy - S / 2)).toBeLessThan(S / 2);
          expect(Math.hypot(cx - 0.79 * S, cy - 0.79 * S)).toBeGreaterThan(0.161 * S);
        }
        // Outside the frame is the darkened blurred copy, not the light original.
        const fill = pixel(out, 6, Math.round(S / 2));
        expect(fill.every((v) => v < 200)).toBe(true);
        // The mark is still composited on top.
        expect(
          near(pixel(out, Math.round(0.79 * S), Math.round(0.79 * S - 0.12 * S)), hex("#9B59D0")),
        ).toBe(true);
      });
    },
  );

  it("a corrupt cached PNG fails verification and is re-rendered in place", async () => {
    await withDir(async (dir) => {
      const fs = createNodeFs();
      const mark = { letter: "F", color: "#FFD700", text: TEXT_DARK, scale: 1 };
      const base = vectorBase("corrupt");
      const h = assetHash(mark, base, SIZE);
      const jobs = new Map([[h, { hash: h, mark, base }]]);
      await createAssetCache({
        fs,
        renderer: renderer(),
        cacheDir: dir,
        size: SIZE,
        clock,
        log,
      }).ensure(jobs);
      await fsp.writeFile(path.join(dir, `${h}.png`), "garbage");
      const r = await createAssetCache({
        fs,
        renderer: renderer(),
        cacheDir: dir,
        size: SIZE,
        clock,
        log,
      }).ensure(jobs);
      expect(r.rendered).toBe(1);
      verifyPng(await fsp.readFile(path.join(dir, `${h}.png`)), SIZE);
    });
  });
});

describe("rasteriser detection (ARCH §5.4)", () => {
  it("prefers rsvg-convert, falls back to magick, reports none", async () => {
    expect(await detectRasteriser(async () => true)).toBe("rsvg-convert");
    expect(await detectRasteriser(async (bin) => bin === "magick")).toBe("magick");
    expect(await detectRasteriser(async () => false)).toBeNull();
  });

  it.skipIf(rasteriser)(`skips the real-render tests explicitly: ${RENDERER_UNAVAILABLE}`, () => {
    expect(rasteriser).toBeNull();
  });
});
