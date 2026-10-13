import path from "node:path";
import type { Clock, Logger } from "./clock.js";
import type { CoreFs } from "./fsio.js";
import { sha256 } from "./hash.js";
import { pngCarriesMark } from "./marked.js";
import {
  ADOPTED_LAYOUT,
  adoptedBaseSvg,
  isStamped,
  sniffImage,
  verifyPng,
  type Renderer,
  type RenderSize,
} from "./render.js";

// ARCH §2c.8: a group's own artwork is kept. The first time the extension sees a target
// that already shows an avatar not made by us, those bytes are captured once
// (format-guarded) as the target's adopted base. The original bytes are stored; the
// renderer draws them full-frame (§2c.9). It is the target's background until an explicit
// `regenerate`; the bytes stay on disk so `restore` can put them back. Only a removed
// target or `purge` deletes them.
//
// §2c.9: artwork that already carries our mark is never adopted (record `none: "ours"`),
// so a mark is never stacked on a mark. Our stamp or our applied record says so at once;
// otherwise the guard's full-frame decode is checked for the mark at its corner position
// (a channel may re-encode an avatar and drop the stamp).

export type AdoptedRecord = {
  // When the target was first seen. A record exists for every target seen, adopted or not,
  // so the capture happens exactly once.
  seenAt: number;
  // Why nothing was adopted: no avatar, our own mark (stamp, pixels or a record that we
  // painted it), unreadable.
  none?: "no-avatar" | "ours" | "unsupported" | "bad-format" | "config-generate";
  // The adopted base (normalised PNG), when one was captured.
  sha?: string;
  // Whether the adopted base is in use. `regenerate` clears it; `restore` sets it.
  active?: boolean;
  // §2c.9: the layout under which the bytes were checked for our mark. A base adopted
  // before (contain-v1) is checked once on load.
  checked?: string;
};

export type AdoptedBase = { sha: string; file: string };

type Index = { version: 1; targets: Record<string, AdoptedRecord> };

export function createAdoptedStore(opts: {
  fs: CoreFs;
  dir: string;
  renderer: Renderer | null;
  size: RenderSize;
  clock: Clock;
  log: Logger;
}) {
  const { fs, dir, clock } = opts;
  const indexPath = path.join(dir, "index.json");
  const fileFor = (key: string) => path.join(dir, `${key}.img`);
  const MAX_BYTES = 8 << 20;
  let index: Index = { version: 1, targets: {} };

  async function save() {
    await fs.mkdirp(dir);
    await fs.writeAtomic(indexPath, JSON.stringify(index, null, 1));
  }

  // Format guard: PNG/JPEG signature, size bound, and a full decode by our rasteriser,
  // full-frame at the asset size (a non-square source is centre-cropped only here, after
  // the signature check). The original bytes are kept. Returns whether the decoded
  // picture carries our mark (§2c.9).
  async function verify(bytes: Buffer, key: string): Promise<{ marked: boolean }> {
    const mime = sniffImage(bytes);
    if (!mime) {
      throw new Error("the avatar is not a PNG or JPEG");
    }
    if (bytes.length > MAX_BYTES) {
      throw new Error("the avatar is too large");
    }
    if (!opts.renderer) {
      throw new Error("no rasteriser to verify the avatar");
    }
    const tmp = path.join(dir, `${key}.${clock.now()}`);
    await fs.mkdirp(dir);
    await fs.writeFile(`${tmp}.svg.tmp`, adoptedBaseSvg({ mime, bytes }, opts.size.width));
    try {
      await opts.renderer.svgToPng(`${tmp}.svg.tmp`, `${tmp}.png.tmp`, opts.size);
      const png = await fs.readFile(`${tmp}.png.tmp`);
      verifyPng(png, opts.size);
      return { marked: isStamped(bytes) || pngCarriesMark(png) === true };
    } finally {
      await fs.unlink(`${tmp}.svg.tmp`);
      await fs.unlink(`${tmp}.png.tmp`);
    }
  }

  const refuse = (seenAt: number): AdoptedRecord => ({ seenAt, none: "ours" });

  return {
    async load() {
      index = { version: 1, targets: {} };
      try {
        const raw = JSON.parse(await fs.readText(indexPath)) as Partial<Index>;
        if (raw?.targets && typeof raw.targets === "object") {
          index.targets = raw.targets;
        }
      } catch {
        // Nothing seen yet.
      }
      // A record whose bytes are gone or changed is no longer usable as a base.
      let dirty = false;
      for (const [key, r] of Object.entries(index.targets)) {
        // Before §2c.9 a target we had painted was recorded as "painted": that is ours.
        if ((r.none as string | undefined) === "painted") {
          index.targets[key] = refuse(r.seenAt);
          dirty = true;
          continue;
        }
        if (!r.sha) {
          continue;
        }
        let bytes: Buffer;
        try {
          bytes = await fs.readFile(fileFor(key));
          if (sha256(bytes) !== r.sha) {
            throw new Error("changed");
          }
        } catch {
          index.targets[key] = { seenAt: r.seenAt, none: "bad-format" };
          continue;
        }
        // §2c.9: a base adopted under an earlier layout is checked once for our mark; a
        // marked one is refused and the target gets a generated base. Its bytes stay on
        // disk (a removed target or purge deletes them), so a false verdict loses nothing.
        if (r.checked === ADOPTED_LAYOUT) {
          continue;
        }
        try {
          const { marked } = await verify(bytes, key);
          if (marked) {
            opts.log.warn(
              "[model-badge] an adopted base already carries our mark; it is no longer used",
            );
            index.targets[key] = refuse(r.seenAt);
          } else {
            r.checked = ADOPTED_LAYOUT;
          }
          dirty = true;
        } catch {
          // No rasteriser right now: checked on a later load; the bytes stay in use.
        }
      }
      if (dirty) {
        await save();
      }
    },

    seen: (key: string) => key in index.targets,
    record: (key: string): AdoptedRecord | null => index.targets[key] ?? null,

    // The adopted base a target uses now, if any.
    active(key: string): AdoptedBase | null {
      const r = index.targets[key];
      return r?.sha && r.active ? { sha: r.sha, file: fileFor(key) } : null;
    },

    // The adopted base by its bytes' hash (a target may still show it after a regenerate).
    bySha(sha: string): AdoptedBase | null {
      for (const [key, r] of Object.entries(index.targets)) {
        if (r.sha === sha) {
          return { sha, file: fileFor(key) };
        }
      }
      return null;
    },

    async markSeen(key: string, none: NonNullable<AdoptedRecord["none"]>) {
      index.targets[key] = { seenAt: clock.now(), none };
      await save();
    },

    // Captures the target's own avatar once. Returns what was recorded.
    async adopt(key: string, bytes: Buffer): Promise<AdoptedRecord> {
      let rec: AdoptedRecord;
      try {
        const { marked } = await verify(bytes, key);
        if (marked) {
          opts.log.info(
            "[model-badge] a target's avatar already carries our mark; it is not adopted",
          );
          rec = refuse(clock.now());
        } else {
          await fs.mkdirp(dir);
          await fs.writeAtomic(fileFor(key), bytes);
          rec = { seenAt: clock.now(), sha: sha256(bytes), active: true, checked: ADOPTED_LAYOUT };
        }
      } catch (err) {
        opts.log.warn(
          `[model-badge] a target's own avatar could not be adopted (${String((err as Error)?.message ?? err).slice(0, 120)}); it gets a generated base`,
        );
        rec = { seenAt: clock.now(), none: "bad-format" };
      }
      index.targets[key] = rec;
      await save();
      return rec;
    },

    async setActive(key: string, active: boolean): Promise<boolean> {
      const r = index.targets[key];
      if (!r?.sha) {
        return false;
      }
      if (r.active !== active) {
        r.active = active;
        await save();
      }
      return true;
    },

    async remove(key: string) {
      if (key in index.targets) {
        delete index.targets[key];
        await fs.unlink(fileFor(key));
        await save();
      }
    },

    status() {
      const recs = Object.values(index.targets);
      return {
        seen: recs.length,
        adopted: recs.filter((r) => r.sha).length,
        active: recs.filter((r) => r.sha && r.active).length,
      };
    },
  };
}

export type AdoptedStore = ReturnType<typeof createAdoptedStore>;
