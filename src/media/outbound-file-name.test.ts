import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import {
  alignConvertedImageExtension,
  OUTBOUND_FILE_NAME_MAX_CHARS,
  sanitizeOutboundFileName,
} from "./outbound-file-name.js";

describe("sanitizeOutboundFileName (signal-attachment-names §2.3)", () => {
  it("keeps ordinary names exactly", () => {
    for (const name of [
      "Report Q3 (final).pdf",
      "Name With Spaces.pdf",
      "a,b;c=d+e@f [1] {2} ~3 'q' \"dq\".txt",
      "Ünïcödé naïve café.docx",
      "Отчёт.pdf",
      "写真 2026-11-12.jpg",
      "no-extension",
    ]) {
      expect(sanitizeOutboundFileName(name)).toBe(name);
    }
  });

  it("takes the base name with both separators", () => {
    expect(sanitizeOutboundFileName("../../x.pdf")).toBe("x.pdf");
    expect(sanitizeOutboundFileName("/abs/path/y.pdf")).toBe("y.pdf");
    expect(sanitizeOutboundFileName("..\\..\\z.pdf")).toBe("z.pdf");
    expect(sanitizeOutboundFileName("C:\\dir\\w.pdf")).toBe("w.pdf");
    expect(sanitizeOutboundFileName("dir/trailing/")).toBe("trailing");
  });

  it("drops controls and NUL, trims, drops leading dots", () => {
    expect(sanitizeOutboundFileName("a\u0000b\u001fc\u0085d.txt")).toBe("abcd.txt");
    expect(sanitizeOutboundFileName("  ..env  ")).toBe("env");
    expect(sanitizeOutboundFileName(". hidden.txt")).toBe("hidden.txt");
  });

  it("returns undefined when nothing usable is left", () => {
    for (const name of [undefined, null, "", "  ", ".", "..", "...", "/", "\\", "a/..", "\u0000"]) {
      expect(sanitizeOutboundFileName(name), JSON.stringify(name)).toBeUndefined();
    }
  });

  it("caps at 120 characters keeping the extension", () => {
    const capped = sanitizeOutboundFileName(`${"x".repeat(300)}.tar.gz`);
    expect(capped).toBe(`${"x".repeat(OUTBOUND_FILE_NAME_MAX_CHARS - 3)}.gz`);
    expect(sanitizeOutboundFileName("y".repeat(300))).toBe("y".repeat(120));
    // a "dot" deep inside a long name is not an extension worth keeping
    expect(sanitizeOutboundFileName(`a.${"b".repeat(200)}`)).toHaveLength(120);
  });
});

describe("alignConvertedImageExtension (signal-attachment-names §2.1)", () => {
  it("renames only images whose bytes were converted", async () => {
    await expect(
      alignConvertedImageExtension({ fileName: "a.png", contentType: "image/jpeg", kind: "image" }),
    ).resolves.toBe("a.jpg");
    await expect(
      alignConvertedImageExtension({
        fileName: "a.webp",
        contentType: "image/jpeg",
        kind: "image",
      }),
    ).resolves.toBe("a.jpg");
    await expect(
      alignConvertedImageExtension({
        fileName: "a.JPEG",
        contentType: "image/jpeg",
        kind: "image",
      }),
    ).resolves.toBe("a.JPEG");
    await expect(
      alignConvertedImageExtension({ fileName: "a.gif", contentType: "image/gif", kind: "image" }),
    ).resolves.toBe("a.gif");
    await expect(
      alignConvertedImageExtension({ fileName: "a.bin", contentType: "image/jpeg", kind: "image" }),
    ).resolves.toBe("a.bin");
    await expect(
      alignConvertedImageExtension({
        fileName: "voice.opus",
        contentType: "audio/ogg",
        kind: "audio",
      }),
    ).resolves.toBe("voice.opus");
    await expect(
      alignConvertedImageExtension({ fileName: "doc.png", contentType: "application/pdf" }),
    ).resolves.toBe("doc.png");
  });
});

describe("saveMediaBufferInOwnFolder (signal-attachment-names §2.2, §2.3)", () => {
  let tempHome: TempHomeEnv;
  let store: typeof import("./store.js");

  beforeAll(async () => {
    tempHome = await createTempHomeEnv("openclaw-outbound-folder-");
    store = await import("./store.js");
  });

  afterAll(async () => {
    await tempHome.restore();
  });

  it("refuses a name that is not a plain base name before writing anything", async () => {
    const outbound = path.join(store.getMediaDir(), "outbound");
    for (const name of ["../escape.txt", "a/b.txt", "..", ".", ""]) {
      await expect(
        store.saveMediaBufferInOwnFolder(Buffer.from("x"), "text/plain", "outbound", 1024, name),
        JSON.stringify(name),
      ).rejects.toThrow(/plain base name/);
    }
    const entries = await fs.readdir(outbound).catch(() => []);
    expect(entries).toEqual([]);
    await expect(fs.stat(path.join(store.getMediaDir(), "escape.txt"))).rejects.toThrow();
  });

  it("enforces the size limit like saveMediaBuffer", async () => {
    await expect(
      store.saveMediaBufferInOwnFolder(Buffer.alloc(2048), undefined, "outbound", 1024, "big.bin"),
    ).rejects.toThrow(/exceeds/);
  });
});
