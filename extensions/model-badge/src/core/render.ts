import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { crc32 } from "node:zlib";
import type { Mark } from "./badges.js";
import { baseSvgBody, type BaseParams } from "./motif.js";

const execFileP = promisify(execFile);

// Bump whenever the base generator, the mark layout or the compositing changes. It is
// part of every asset hash (ARCH §2.5); the rasteriser's own version is recorded in the
// manifest for diagnostics only, so a distro upgrade never repaints anything.
export const RENDERER_VERSION = 1;

// The dark ring around the mark disc, so the mark reads on any base.
export const RING = "#14181F";

export type RenderSize = { width: number; height: number };

function xmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// Mark geometry as fractions of the asset size: the colour bar along the bottom and the
// letter disc bottom-right (with its ring). Shared with the mark detector (§2c.9), which
// refuses artwork that already carries our mark.
export const MARK_GEOMETRY = {
  bar: { x: 0.08, y: 0.9, w: 0.5, h: 0.025 },
  disc: { c: 0.79, r: 0.15, stroke: 0.022 },
} as const;

// The mark layer: colour bar along the bottom and a letter disc bottom-right. Letters
// are always composited from text by us, never generated (ARCH §2b.3).
export function markLayerSvg(mark: Mark, size: number): string {
  const two = [...mark.letter].length > 1;
  const r = size * MARK_GEOMETRY.disc.r;
  const c = size * MARK_GEOMETRY.disc.c;
  const font = size * (two ? 0.11 : 0.15) * mark.scale;
  const baseline = c + font * 0.36;
  const n = (v: number) => (Math.round(v * 10) / 10).toString();
  return (
    `<g data-mark="${xmlEscape(mark.letter)}">` +
    `<rect x="${n(size * MARK_GEOMETRY.bar.x)}" y="${n(size * MARK_GEOMETRY.bar.y)}" ` +
    `width="${n(size * MARK_GEOMETRY.bar.w)}" height="${n(size * MARK_GEOMETRY.bar.h)}" ` +
    `rx="${n((size * MARK_GEOMETRY.bar.h) / 2)}" fill="${mark.color}"/>` +
    `<circle cx="${n(c)}" cy="${n(c)}" r="${n(r)}" fill="${mark.color}" stroke="${RING}" ` +
    `stroke-width="${n(size * MARK_GEOMETRY.disc.stroke)}"/>` +
    `<text x="${n(c)}" y="${n(baseline)}" font-family="DejaVu Sans, Verdana, sans-serif" ` +
    `font-weight="bold" font-size="${n(font)}" fill="${mark.text}" text-anchor="middle">` +
    `${xmlEscape(mark.letter)}</text></g>`
  );
}

export type RasterBase = { mime: "image/png" | "image/jpeg"; bytes: Buffer };

function svgDoc(size: number, body: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${body}</svg>`
  );
}

// A raster base (image generator output or an operator's profile image) embedded at
// runtime, square-cropped and scaled to the asset size.
function rasterBody(base: RasterBase, size: number): string {
  const href = `data:${base.mime};base64,${base.bytes.toString("base64")}`;
  return (
    `<image width="${size}" height="${size}" preserveAspectRatio="xMidYMid slice" ` +
    `href="${href}" xlink:href="${href}"/>`
  );
}

// ---------------- adopted bases (§2c.9): full-frame ----------------

// Layout tag in the adopted base's identity (§2c.9): changing the layout repaints adopted
// targets once, and nothing else. `contain-v1` (§2c.8, an inset frame on a blurred fill)
// is retired.
export const ADOPTED_LAYOUT = "full-v1";

// A group's own artwork drawn full-frame: one image filling the whole square, no inset,
// no blurred background, no darkening. Avatars are square already; a non-square source
// is centre-cropped (slice) here, after the format guard has accepted it.
function adoptedBody(base: RasterBase, size: number): string {
  const href = `data:${base.mime};base64,${base.bytes.toString("base64")}`;
  return (
    `<image data-adopted="full" width="${size}" height="${size}" ` +
    `preserveAspectRatio="xMidYMid slice" href="${href}" xlink:href="${href}"/>`
  );
}

// The base alone, full-frame: the format guard's decode step for an adopted base, and
// the picture the mark detector looks at.
export function adoptedBaseSvg(base: RasterBase, size: number): string {
  return svgDoc(size, adoptedBody(base, size));
}

// The adopted base with the model mark composited once, in the corner mark position.
export function adoptedAssetSvg(base: RasterBase, mark: Mark, size: number): string {
  return svgDoc(size, adoptedBody(base, size) + markLayerSvg(mark, size));
}

export function vectorAssetSvg(params: BaseParams, mark: Mark, size: number): string {
  return svgDoc(size, baseSvgBody(params, size) + markLayerSvg(mark, size));
}

export function rasterAssetSvg(base: RasterBase, mark: Mark, size: number): string {
  return svgDoc(size, rasterBody(base, size) + markLayerSvg(mark, size));
}

// The base alone, square-cropped and resized: the format guard's decode step (§2b.7).
export function rasterBaseSvg(base: RasterBase, size: number): string {
  return svgDoc(size, rasterBody(base, size));
}

export function sniffImage(bytes: Buffer): RasterBase["mime"] | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIG)) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  return null;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Signature, IHDR and dimensions. Throws on anything else.
// ARCH §2c.8: every asset we render carries this tEXt chunk, so an avatar read back from
// a channel can be told apart from a group's own artwork. Ancillary chunks are ignored
// by decoders, so the picture is unchanged.
const STAMP_KEYWORD = "Software";
const STAMP_TEXT = "openclaw-model-badge";
const STAMP = Buffer.from(`tEXt${STAMP_KEYWORD}\0${STAMP_TEXT}`, "latin1");

export function stampPng(buf: Buffer): Buffer {
  if (isStamped(buf) || buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    return buf;
  }
  // Right after IHDR (signature 8 + IHDR length/type/data/crc 25).
  const data = STAMP.subarray(4);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  STAMP.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(STAMP) >>> 0, 8 + data.length);
  return Buffer.concat([buf.subarray(0, 33), chunk, buf.subarray(33)]);
}

export function isStamped(buf: Buffer): boolean {
  return Buffer.isBuffer(buf) && buf.includes(STAMP);
}

export function verifyPng(buf: Buffer, expect?: RenderSize): RenderSize {
  if (!Buffer.isBuffer(buf) || buf.length < 33) {
    throw new Error("png too small");
  }
  if (!buf.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error("png signature mismatch");
  }
  if (buf.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("png missing IHDR");
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (expect && (width !== expect.width || height !== expect.height)) {
    throw new Error(`png is ${width}x${height}, expected ${expect.width}x${expect.height}`);
  }
  return { width, height };
}

// The rasteriser seam. The real one shells out (async, bounded by a timeout); tests use
// a fake.
export interface Renderer {
  readonly id: string;
  version(): Promise<string>;
  svgToPng(svgPath: string, pngPath: string, size: RenderSize): Promise<void>;
}

export type RasteriserId = "rsvg-convert" | "magick";

async function runs(bin: string, args: string[]): Promise<boolean> {
  try {
    await execFileP(bin, args, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// ARCH §5.4: rsvg-convert if present, else magick; null when neither exists (the caller
// reports health `renderer-missing` and keeps the writer idle).
export async function detectRasteriser(
  probe: (bin: string, args: string[]) => Promise<boolean> = runs,
): Promise<RasteriserId | null> {
  if (await probe("rsvg-convert", ["--version"])) {
    return "rsvg-convert";
  }
  if (await probe("magick", ["-version"])) {
    return "magick";
  }
  return null;
}

export function createRenderer(bin: RasteriserId, timeoutMs = 20_000): Renderer {
  const run = (args: string[]) => execFileP(bin, args, { timeout: timeoutMs, maxBuffer: 4 << 20 });
  return {
    id: bin,
    async version() {
      try {
        const { stdout } = await run([bin === "rsvg-convert" ? "--version" : "-version"]);
        return stdout.trim().split("\n")[0] ?? bin;
      } catch {
        return `${bin} (version unknown)`;
      }
    },
    async svgToPng(svgPath, pngPath, { width, height }) {
      if (bin === "rsvg-convert") {
        await run(["-w", String(width), "-h", String(height), svgPath, "-o", pngPath]);
      } else {
        await run([
          "-background",
          "none",
          svgPath,
          "-resize",
          `${width}x${height}!`,
          `PNG32:${pngPath}`,
        ]);
      }
    },
  };
}
