// ARCH §5.4 / §6: the real render pipeline, with the real rasteriser on this host. It
// skips only with an explicit "renderer unavailable" reason when neither rsvg-convert
// nor magick exists; CI notes the skip (see README "Tests").
import { execFileSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAdoptedStore } from "./adopted.js";
import { createImageBases, type BaseArtGenerator } from "./baseart.js";
import { assetHash, createAssetCache, type AssetBase, type AssetJob } from "./cache.js";
import { contrastRatio, TEXT_DARK, TEXT_LIGHT } from "./color.js";
import { createNodeFs } from "./fsio.js";
import { sha256 } from "./hash.js";
import { carriesMark, decodePng } from "./marked.js";
import { baseParamsForSeed, renderBaseSvg, seedFor } from "./motif.js";
import {
  adoptedAssetSvg,
  adoptedBaseSvg,
  createRenderer,
  detectRasteriser,
  isStamped,
  MARK_GEOMETRY,
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

  // ARCH §2c.9: a source with a distinct colour in each corner region and at the centre,
  // so an inset, a blur or a darkening shows up at once.
  async function quadrantSource(dir: string, w = 512, h = 512): Promise<Buffer> {
    const srcSvg = path.join(dir, `own-${w}x${h}.svg`);
    await fsp.writeFile(
      srcSvg,
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
        `<rect width="${w}" height="${h}" fill="#F0F0F0"/>` +
        `<rect width="${w / 2}" height="${h / 2}" fill="#FF0000"/>` +
        `<rect x="${w / 2}" width="${w / 2}" height="${h / 2}" fill="#0000FF"/>` +
        `<rect y="${h / 2}" width="${w / 2}" height="${h / 2}" fill="#00FF00"/>` +
        `<rect x="${w / 2}" y="${h / 2}" width="${w / 2}" height="${h / 2}" fill="#FFFF00"/>` +
        `<rect x="${w / 2 - 20}" y="${h / 2 - 20}" width="40" height="40" fill="#FF00FF"/></svg>`,
    );
    const srcPng = path.join(dir, `own-${w}x${h}.png`);
    await renderer().svgToPng(srcSvg, srcPng, { width: w, height: h });
    return fsp.readFile(srcPng);
  }

  const px = (img: ReturnType<typeof decodePng>, x: number, y: number) => {
    const i = (y * img.width + x) * 4;
    return [img.rgba[i]!, img.rgba[i + 1]!, img.rgba[i + 2]!];
  };

  it("ARCH §2c.9: an adopted base renders full-frame (centre and the four corners), mark once on top", async () => {
    await withDir(async (dir) => {
      const bytes = await quadrantSource(dir);
      const mark = { letter: "O", color: "#9B59D0", text: TEXT_LIGHT, scale: 1 };
      const svgText = adoptedAssetSvg({ mime: "image/png", bytes }, mark, SIZE.width);
      // No blur filter, no darkening overlay, one image, one mark.
      expect(svgText).not.toMatch(/<filter|feGaussianBlur|mb-blur|fill-opacity/);
      expect(svgText.match(/<image/g)).toHaveLength(1);
      expect(svgText.match(/data-mark=/g)).toHaveLength(1);
      const svg = path.join(dir, "a.svg");
      await fsp.writeFile(svg, svgText);
      const out = path.join(dir, "a.png");
      await renderer().svgToPng(svg, out, SIZE);
      const img = decodePng(await fsp.readFile(out));
      const S = SIZE.width;
      // The artwork's own colours, undimmed, right to the edges: centre and the four
      // corners (bottom-right sampled at the corner, which lies outside the mark disc).
      expect(near(px(img, S / 2, S / 2), hex("#FF00FF"))).toBe(true);
      expect(near(px(img, 2, 2), hex("#FF0000"))).toBe(true);
      expect(near(px(img, S - 3, 2), hex("#0000FF"))).toBe(true);
      expect(near(px(img, 2, S - 3), hex("#00FF00"))).toBe(true);
      expect(near(px(img, S - 3, S - 3), hex("#FFFF00"))).toBe(true);
      // Those corners are outside the mark (bar and disc).
      const { disc } = MARK_GEOMETRY;
      expect(Math.hypot(S - 3 - disc.c * S, S - 3 - disc.c * S)).toBeGreaterThan(
        (disc.r + disc.stroke / 2) * S,
      );
      // The mark is there, in the corner mark position, and detected as ours.
      expect(
        near(px(img, Math.round(0.79 * S), Math.round(0.79 * S - 0.12 * S)), hex("#9B59D0")),
      ).toBe(true);
      expect(carriesMark(img)).toBe(true);
      // The base alone does not carry it.
      const base = path.join(dir, "b.svg");
      await fsp.writeFile(base, adoptedBaseSvg({ mime: "image/png", bytes }, S));
      await renderer().svgToPng(base, path.join(dir, "b.png"), SIZE);
      expect(carriesMark(decodePng(await fsp.readFile(path.join(dir, "b.png"))))).toBe(false);
    });
  });

  it("ARCH §2c.9: a non-square source is centre-cropped to fill the square, after the format guard", async () => {
    await withDir(async (dir) => {
      const bytes = await quadrantSource(dir, 800, 400);
      const svg = path.join(dir, "w.svg");
      await fsp.writeFile(svg, adoptedBaseSvg({ mime: "image/png", bytes }, SIZE.width));
      const out = path.join(dir, "w.png");
      await renderer().svgToPng(svg, out, SIZE);
      const img = decodePng(await fsp.readFile(out));
      const S = SIZE.width;
      // Filled edge to edge: the corners are the source's quadrant colours, no letterbox.
      expect(near(px(img, 2, 2), hex("#FF0000"))).toBe(true);
      expect(near(px(img, S - 3, S - 3), hex("#FFFF00"))).toBe(true);
      expect(near(px(img, S / 2, S / 2), hex("#FF00FF"))).toBe(true);
    });
  });

  it("ARCH §2c.9: artwork that already carries our mark is refused as a base, even re-encoded without the stamp", async () => {
    await withDir(async (dir) => {
      const fs = createNodeFs();
      const S = SIZE.width;
      const marks = [
        { letter: "F", color: "#FFD700", text: TEXT_DARK, scale: 1 },
        { letter: "KL", color: "#6C3483", text: TEXT_LIGHT, scale: 1 },
        { letter: "?", color: "#95A5A6", text: TEXT_DARK, scale: 1 },
      ];
      const ourAssets: Buffer[] = [];
      for (const [i, mark] of marks.entries()) {
        const base = vectorBase(`marked-${i}`);
        const h = assetHash(mark, base, SIZE);
        const cacheDir = path.join(dir, "assets");
        await createAssetCache({
          fs,
          renderer: renderer(),
          cacheDir,
          size: SIZE,
          clock,
          log,
        }).ensure(new Map([[h, { hash: h, mark, base }]]));
        ourAssets.push(await fsp.readFile(path.join(cacheDir, `${h}.png`)));
      }
      // Our assets over an adopted (full-frame) base too: the mark sits on their artwork.
      const own = await quadrantSource(dir);
      const ownSvg = path.join(dir, "own-marked.svg");
      await fsp.writeFile(ownSvg, adoptedAssetSvg({ mime: "image/png", bytes: own }, marks[0]!, S));
      await renderer().svgToPng(ownSvg, path.join(dir, "own-marked.png"), SIZE);
      ourAssets.push(await fsp.readFile(path.join(dir, "own-marked.png")));

      // A channel hands the avatar back re-encoded: no stamp, and (with magick) lossy JPEG.
      const reencoded: Buffer[] = [];
      for (const [i, a] of ourAssets.entries()) {
        const plainSvg = path.join(dir, `plain-${i}.svg`);
        await fsp.writeFile(plainSvg, adoptedBaseSvg({ mime: "image/png", bytes: a }, S));
        const plain = path.join(dir, `plain-${i}.png`);
        await renderer().svgToPng(plainSvg, plain, SIZE);
        const b = await fsp.readFile(plain);
        expect(isStamped(b)).toBe(false);
        reencoded.push(b);
        if (hasMagick) {
          const jpg = path.join(dir, `plain-${i}.jpg`);
          execFileSync("magick", [plain, "-quality", "70", jpg]);
          reencoded.push(await fsp.readFile(jpg));
        }
      }
      const store = createAdoptedStore({
        fs,
        dir: path.join(dir, "adopted"),
        renderer: renderer(),
        size: SIZE,
        clock,
        log,
      });
      await store.load();
      for (const [i, b] of reencoded.entries()) {
        const rec = await store.adopt(`k${i}`, b);
        expect(rec, `source ${i}`).toMatchObject({ none: "ours" });
        expect(rec.sha).toBeUndefined();
        expect(store.active(`k${i}`)).toBeNull();
      }
      // Pictures without our mark are adopted: the plain quadrant artwork and vector bases.
      const clean = [own];
      for (const t of ["clean-a", "clean-b", "clean-c", "clean-d"]) {
        const p = path.join(dir, `${t}.svg`);
        await fsp.writeFile(p, renderBaseSvg(baseParamsForSeed(seedFor("signal", t)), S));
        await renderer().svgToPng(p, path.join(dir, `${t}.png`), SIZE);
        clean.push(await fsp.readFile(path.join(dir, `${t}.png`)));
      }
      for (const [i, b] of clean.entries()) {
        const rec = await store.adopt(`c${i}`, b);
        expect(rec.none, `clean ${i}`).toBeUndefined();
        expect(store.active(`c${i}`)?.sha).toBe(sha256(b));
      }
    });
  });

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
