import path from "node:path";
import { detectMime, extensionForMime, normalizeMimeType } from "./mime.js";

/** Longest name kept, in characters (code points), extension included. */
export const OUTBOUND_FILE_NAME_MAX_CHARS = 120;
/** Most file systems cap one path segment at 255 bytes; a longer name would fail the write. */
const OUTBOUND_FILE_NAME_MAX_BYTES = 255;
/** Longer "extensions" are just a dot inside a long name; they are not kept when capping. */
const MAX_KEPT_EXTENSION_CHARS = 20;

// C0/C1 controls (NUL included) plus the bidirectional control characters, which only serve to
// make a name display differently from what it is (e.g. "invoice\u202Efdp.exe").
const CONTROL_CHARS_RE = /[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;
const SEPARATORS_RE = /[\\/]/;

function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function capFileName(name: string): string {
  const chars = Array.from(name);
  if (
    chars.length <= OUTBOUND_FILE_NAME_MAX_CHARS &&
    utf8Length(name) <= OUTBOUND_FILE_NAME_MAX_BYTES
  ) {
    return name;
  }
  const ext = path.posix.extname(name);
  const extChars = Array.from(ext);
  const keepExt = ext.length > 0 && extChars.length <= MAX_KEPT_EXTENSION_CHARS;
  const suffix = keepExt ? ext : "";
  const stemChars = keepExt ? chars.slice(0, chars.length - extChars.length) : chars;
  let stem = stemChars.slice(0, OUTBOUND_FILE_NAME_MAX_CHARS - extChars.length * Number(keepExt));
  while (stem.length > 0 && utf8Length(stem.join("") + suffix) > OUTBOUND_FILE_NAME_MAX_BYTES) {
    stem = stem.slice(0, -1);
  }
  const cappedStem = stem.join("").trimEnd();
  return cappedStem ? `${cappedStem}${suffix}` : "";
}

/**
 * signal-attachment-names §2.3: turn a reported source file name into a safe base name for the
 * per-send folder. Returns undefined when nothing usable is left (the caller then falls back to
 * the old `<uuid><ext>` name).
 */
export function sanitizeOutboundFileName(raw: string | null | undefined): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const withoutControls = raw.replace(CONTROL_CHARS_RE, "");
  // Base name: both `/` and `\` are separators; trailing separators are ignored like basename().
  const segments = withoutControls.replace(/[\\/]+$/, "").split(SEPARATORS_RE);
  const base = segments[segments.length - 1] ?? "";
  const withoutLeadingDots = base.trim().replace(/^\.+/, "").trim();
  if (!withoutLeadingDots) {
    return undefined;
  }
  const capped = capFileName(withoutLeadingDots);
  if (!capped || capped === "." || capped === ".." || SEPARATORS_RE.test(capped)) {
    return undefined;
  }
  return capped;
}

/**
 * signal-attachment-names §2.1: a converted image keeps the converted name. loadWebMedia already
 * renames HEIC to `.jpg`; when it re-encodes another image (e.g. PNG or WebP to JPEG) it still
 * reports the source extension, so a known image extension that no longer matches the bytes is
 * replaced by the converted format's extension. Names of anything but images are never touched.
 */
export async function alignConvertedImageExtension(params: {
  fileName: string;
  contentType?: string;
  kind?: string;
}): Promise<string> {
  if (params.kind !== "image") {
    return params.fileName;
  }
  const actualMime = normalizeMimeType(params.contentType);
  const convertedExt = extensionForMime(actualMime);
  const ext = path.posix.extname(params.fileName);
  if (!actualMime || !convertedExt || !ext) {
    return params.fileName;
  }
  const extMime = normalizeMimeType(await detectMime({ filePath: params.fileName }));
  if (!extMime?.startsWith("image/") || extMime === actualMime) {
    return params.fileName;
  }
  return `${params.fileName.slice(0, params.fileName.length - ext.length)}${convertedExt}`;
}
