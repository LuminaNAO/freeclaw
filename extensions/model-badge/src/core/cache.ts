import path from "node:path";
import type { Mark } from "./badges.js";
import type { Clock, Logger } from "./clock.js";
import type { CoreFs } from "./fsio.js";
import { canonicalJSON, sha256 } from "./hash.js";
import type { BaseParams } from "./motif.js";
import {
  ADOPTED_LAYOUT,
  adoptedAssetSvg,
  RENDERER_VERSION,
  rasterAssetSvg,
  sniffImage,
  stampPng,
  vectorAssetSvg,
  verifyPng,
  type Renderer,
  type RenderSize,
} from "./render.js";

// Layer 1: the asset cache (ARCH §2.5, standalone O1/O2). An asset is identified by a
// hash of its generator inputs — the mark, the base parameters (or the base bytes' hash
// for a raster base), RENDERER_VERSION and the size — so re-rendering the same inputs
// never changes a hash and never causes a repaint.

export type AssetBase =
  | { kind: "vector"; key: string; params: BaseParams }
  | {
      kind: "raster";
      key: string;
      source: "image" | "file" | "adopted";
      sha: string;
      file: string;
    };

export function baseIdentity(base: AssetBase): Record<string, unknown> {
  if (base.kind === "vector") {
    return { kind: "vector", ...base.params };
  }
  // §2c.8: an adopted base is laid out differently (contain on a blurred fill), so its
  // layout is part of the identity.
  return base.source === "adopted"
    ? { kind: "raster", sha: base.sha, layout: ADOPTED_LAYOUT }
    : { kind: "raster", sha: base.sha };
}

export function assetHash(mark: Mark, base: AssetBase, size: RenderSize): string {
  return sha256(
    canonicalJSON({
      badge: { letter: mark.letter, color: mark.color, text: mark.text, scale: mark.scale },
      base: baseIdentity(base),
      renderer: RENDERER_VERSION,
      size,
    }),
  );
}

export type AssetJob = { hash: string; mark: Mark; base: AssetBase };

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const out: R[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

export type AssetManifest = {
  hash: string;
  badge: Mark;
  base: { kind: string; key: string };
  renderer: number;
  rasteriser: string;
  bytes: number;
  width: number;
  height: number;
  builtAt: number;
};

export function createAssetCache(opts: {
  fs: CoreFs;
  renderer: Renderer;
  cacheDir: string;
  size: RenderSize;
  clock: Clock;
  log: Logger;
  concurrency?: number;
}) {
  const { fs, renderer, cacheDir, size, clock, log } = opts;
  const pngPath = (h: string) => path.join(cacheDir, `${h}.png`);
  const manifestPath = (h: string) => path.join(cacheDir, `${h}.json`);
  const verified = new Set<string>();
  let rasteriser: string | null = null;
  let seq = 0;

  async function isValid(h: string): Promise<boolean> {
    if (verified.has(h)) {
      if (await fs.stat(pngPath(h))) {
        return true;
      }
      verified.delete(h);
    }
    try {
      const [buf, man] = await Promise.all([fs.readFile(pngPath(h)), fs.readText(manifestPath(h))]);
      verifyPng(buf, size);
      if ((JSON.parse(man) as { hash?: string }).hash !== h) {
        return false;
      }
      verified.add(h);
      return true;
    } catch {
      return false;
    }
  }

  async function svgFor(job: AssetJob): Promise<string> {
    if (job.base.kind === "vector") {
      return vectorAssetSvg(job.base.params, job.mark, size.width);
    }
    const bytes = await fs.readFile(job.base.file);
    if (sha256(bytes) !== job.base.sha) {
      throw new Error("raster base changed on disk since it was recorded");
    }
    const mime = sniffImage(bytes);
    if (!mime) {
      throw new Error("raster base is not a PNG or JPEG");
    }
    // §2c.8: a group's own artwork is never slice-cropped.
    return job.base.source === "adopted"
      ? adoptedAssetSvg({ mime, bytes }, job.mark, size.width)
      : rasterAssetSvg({ mime, bytes }, job.mark, size.width);
  }

  async function renderOne(job: AssetJob): Promise<{ hash: string; ok: boolean; error?: string }> {
    const h = job.hash;
    const tmp = path.join(cacheDir, `${h}.${process.pid}.${++seq}`);
    const tmpSvg = `${tmp}.svg.tmp`;
    const tmpPng = `${tmp}.png.tmp`;
    try {
      await fs.writeFile(tmpSvg, await svgFor(job));
      await renderer.svgToPng(tmpSvg, tmpPng, size);
      // Every asset carries our stamp, so reading it back off a channel is never mistaken
      // for a group's own artwork (ARCH §2c.8).
      const buf = stampPng(await fs.readFile(tmpPng));
      const dims = verifyPng(buf, size);
      await fs.writeAtomic(pngPath(h), buf);
      await fs.unlink(tmpPng);
      rasteriser ??= await renderer.version();
      const manifest: AssetManifest = {
        hash: h,
        badge: job.mark,
        base: { kind: job.base.kind, key: job.base.key },
        renderer: RENDERER_VERSION,
        rasteriser,
        bytes: buf.length,
        width: dims.width,
        height: dims.height,
        builtAt: clock.now(),
      };
      await fs.writeAtomic(manifestPath(h), JSON.stringify(manifest, null, 1));
      verified.add(h);
      return { hash: h, ok: true };
    } catch (err) {
      await fs.unlink(tmpPng);
      return { hash: h, ok: false, error: String((err as Error)?.message ?? err).slice(0, 300) };
    } finally {
      await fs.unlink(tmpSvg);
    }
  }

  return {
    cacheDir,
    pngPath,
    has: (h: string) => isValid(h),

    // Renders only what is missing or fails verification (re-rendered in place).
    async ensure(jobs: Map<string, AssetJob>) {
      await fs.mkdirp(cacheDir);
      const missing: AssetJob[] = [];
      for (const j of jobs.values()) {
        if (!(await isValid(j.hash))) {
          missing.push(j);
        }
      }
      const results = await mapLimit(missing, opts.concurrency ?? 2, renderOne);
      const failed = results.filter((r) => !r.ok);
      for (const f of failed) {
        log.error(`[model-badge] render failed for asset ${f.hash.slice(0, 12)}: ${f.error}`);
      }
      return { required: jobs.size, rendered: results.length - failed.length, failed };
    },

    // Deletes an unused asset once it is older than the grace period. Assets whose base
    // belongs to a removed target go at once (ARCH §3.3). `keep` already contains every
    // required, applied and in-flight hash.
    async prune({
      keep,
      graceMs,
      removedBases,
    }: {
      keep: Set<string>;
      graceMs: number;
      removedBases?: Set<string>;
    }) {
      let names: string[];
      try {
        names = await fs.readdir(cacheDir);
      } catch {
        return { pruned: 0 };
      }
      const now = clock.now();
      let pruned = 0;
      for (const name of names) {
        const m = /^([0-9a-f]{64})\.json$/.exec(name);
        if (!m || keep.has(m[1] as string)) {
          continue;
        }
        const h = m[1] as string;
        let man: Partial<AssetManifest>;
        try {
          man = JSON.parse(await fs.readText(manifestPath(h))) as Partial<AssetManifest>;
        } catch {
          continue;
        }
        const gone = Boolean(man.base?.key && removedBases?.has(man.base.key));
        if (!gone && now - (Number(man.builtAt) || now) < graceMs) {
          continue;
        }
        await fs.unlink(pngPath(h));
        await fs.unlink(manifestPath(h));
        verified.delete(h);
        pruned++;
      }
      // Leftovers of an interrupted render.
      for (const name of names) {
        if (name.endsWith(".tmp")) {
          await fs.unlink(path.join(cacheDir, name));
        }
      }
      return { pruned };
    },
  };
}

export type AssetCache = ReturnType<typeof createAssetCache>;
