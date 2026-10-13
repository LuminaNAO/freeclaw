import { inflateSync } from "node:zlib";
import { MARK_GEOMETRY, RING } from "./render.js";

// ARCH §2c.9: already-marked artwork is not adopted. A channel may hand an avatar back
// re-encoded (our PNG stamp gone), so besides the stamp and the applied record the
// picture itself is checked: our mark sits at a known place (the ringed disc
// bottom-right and the colour bar along the bottom), so the source is rasterised
// full-frame at the asset size and that region is matched.

export type Pixels = { width: number; height: number; rgba: Uint8Array };

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// Decodes the PNGs our rasterisers write: 8-bit grey, grey+alpha, RGB or RGBA,
// non-interlaced. Anything else throws (the caller then has no pixel verdict).
export function decodePng(buf: Buffer): Pixels {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error("not a png");
  }
  let off = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (data.length !== len) {
      throw new Error("truncated png");
    }
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      const colour = data[9];
      const interlace = data[12];
      channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[colour ?? -1] ?? 0;
      if (depth !== 8 || !channels || interlace !== 0) {
        throw new Error("unsupported png layout");
      }
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  if (!width || !height || !idat.length || width * height > 4096 * 4096) {
    throw new Error("png has no pixels");
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) {
    throw new Error("png pixel data short");
  }
  const rows = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i]!;
      const a = i >= channels ? rows[dst + i - channels]! : 0;
      const b = y > 0 ? rows[dst - stride + i]! : 0;
      const c = i >= channels && y > 0 ? rows[dst - stride + i - channels]! : 0;
      const v =
        filter === 0
          ? x
          : filter === 1
            ? x + a
            : filter === 2
              ? x + b
              : filter === 3
                ? x + ((a + b) >> 1)
                : filter === 4
                  ? x + paeth(a, b, c)
                  : Number.NaN;
      if (Number.isNaN(v)) {
        throw new Error("bad png filter");
      }
      rows[dst + i] = v & 0xff;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const s = p * channels;
    const [r, g, b, a] =
      channels === 4
        ? [rows[s]!, rows[s + 1]!, rows[s + 2]!, rows[s + 3]!]
        : channels === 3
          ? [rows[s]!, rows[s + 1]!, rows[s + 2]!, 255]
          : channels === 2
            ? [rows[s]!, rows[s]!, rows[s]!, rows[s + 1]!]
            : [rows[s]!, rows[s]!, rows[s]!, 255];
    rgba.set([r, g, b, a], p * 4);
  }
  return { width, height, rgba };
}

type RGB = [number, number, number];

function at(img: Pixels, fx: number, fy: number): RGB {
  const x = Math.min(img.width - 1, Math.max(0, Math.round(fx * img.width)));
  const y = Math.min(img.height - 1, Math.max(0, Math.round(fy * img.height)));
  const i = (y * img.width + x) * 4;
  // Composite on black: a transparent pixel is never mistaken for a colour.
  const a = img.rgba[i + 3]! / 255;
  return [img.rgba[i]! * a, img.rgba[i + 1]! * a, img.rgba[i + 2]! * a];
}

const dist = (p: RGB, q: RGB) => Math.max(...p.map((v, i) => Math.abs(v - q[i]!)));

function median(samples: RGB[]): RGB {
  const m = (i: number) =>
    samples.map((s) => s[i]!).toSorted((a, b) => a - b)[samples.length >> 1]!;
  return [m(0), m(1), m(2)];
}

const share = (samples: RGB[], c: RGB, tol: number) =>
  samples.filter((s) => dist(s, c) <= tol).length / samples.length;

const RING_RGB: RGB = [1, 3, 5].map((i) => Number.parseInt(RING.slice(i, i + 2), 16)) as RGB;

// Tolerances absorb a channel's lossy re-encoding (JPEG) and rescaling.
const TOL = 48;
const NEED = 0.8;

// True when the picture carries our mark: the dark ring around the disc, a disc filled
// with one colour (sampled in an annulus clear of the letter) that is not the ring's,
// and the bottom bar in that same colour. A natural picture matching all three is not
// plausible; a picture of ours, re-encoded, matches all three.
export function carriesMark(img: Pixels): boolean {
  const { disc, bar } = MARK_GEOMETRY;
  const around = (radius: number, n = 48): RGB[] =>
    Array.from({ length: n }, (_, k) => {
      const t = (2 * Math.PI * k) / n;
      return at(img, disc.c + radius * Math.cos(t), disc.c + radius * Math.sin(t));
    });
  const ring = around(disc.r);
  if (share(ring, RING_RGB, TOL) < NEED) {
    return false;
  }
  const fill = around(disc.r * 0.8);
  const colour = median(fill);
  if (share(fill, colour, TOL) < NEED || dist(colour, RING_RGB) <= TOL) {
    return false;
  }
  const line = Array.from({ length: 24 }, (_, k) =>
    at(img, bar.x + bar.h + ((bar.w - 2 * bar.h) * k) / 23, bar.y + bar.h / 2),
  );
  return share(line, colour, TOL) >= NEED;
}

// The verdict on PNG bytes from our rasteriser; null when they cannot be decoded (no
// pixel verdict, e.g. a test rasteriser).
export function pngCarriesMark(png: Buffer): boolean | null {
  let img: Pixels;
  try {
    img = decodePng(png);
  } catch {
    return null;
  }
  return carriesMark(img);
}
