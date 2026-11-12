import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { isPathWithinBase } from "../../test/helpers/paths.js";
import { mockPinnedHostnameResolution } from "../test-helpers/ssrf.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";

// Lets a test replace the file name loadWebMedia reports, so hostile names can be exercised
// through the real resolve path without needing them on disk or in a header.
let reportedFileNameOverride: { value: string | undefined } | null = null;

vi.mock("../web/media.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../web/media.js")>();
  return {
    ...actual,
    loadWebMedia: async (...args: Parameters<typeof actual.loadWebMedia>) => {
      const result = await actual.loadWebMedia(...args);
      return reportedFileNameOverride
        ? { ...result, fileName: reportedFileNameOverride.value }
        : result;
    },
  };
});

const convertHeicToJpegMock = vi.fn();
vi.mock("./image-ops.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./image-ops.js")>();
  return {
    ...actual,
    convertHeicToJpeg: (...args: unknown[]) => convertHeicToJpegMock(...args),
  };
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX = 8 * 1024 * 1024;

describe("resolveOutboundAttachmentFromUrl keeps the file name (signal-attachment-names §3)", () => {
  let tempHome: TempHomeEnv;
  let srcDir = "";
  let outboundDir = "";
  let resolveOutboundAttachmentFromUrl: typeof import("./outbound-attachment.js").resolveOutboundAttachmentFromUrl;
  let store: typeof import("./store.js");

  beforeAll(async () => {
    tempHome = await createTempHomeEnv("openclaw-outbound-names-");
    srcDir = path.join(tempHome.home, "src files");
    await fs.mkdir(srcDir, { recursive: true });
    ({ resolveOutboundAttachmentFromUrl } = await import("./outbound-attachment.js"));
    store = await import("./store.js");
    outboundDir = path.join(store.getMediaDir(), "outbound");
  });

  afterAll(async () => {
    await tempHome.restore();
  });

  afterEach(() => {
    reportedFileNameOverride = null;
    vi.restoreAllMocks();
  });

  async function writeSource(name: string, data: Buffer | string): Promise<string> {
    const file = path.join(srcDir, name);
    await fs.writeFile(file, data);
    return file;
  }

  async function resolveLocal(source: string) {
    return await resolveOutboundAttachmentFromUrl(source, MAX, { localRoots: [srcDir] });
  }

  /** Asserts the §2.2 shape: `media/outbound/<uuid>/<name>`, returns the base name. */
  function expectPerSendPath(resolvedPath: string): string {
    const folder = path.dirname(resolvedPath);
    expect(path.dirname(folder)).toBe(outboundDir);
    expect(path.basename(folder)).toMatch(UUID_RE);
    expect(isPathWithinBase(folder, resolvedPath)).toBe(true);
    return path.basename(resolvedPath);
  }

  function expectLegacyPath(resolvedPath: string, ext: string) {
    expect(path.dirname(resolvedPath)).toBe(outboundDir);
    expect(path.basename(resolvedPath)).toMatch(
      new RegExp(`^[0-9a-f-]{36}${ext.replace(".", "\\.")}$`),
    );
  }

  const pdf = Buffer.from("%PDF-1.4\n% test document\n");

  it("§3.1 local source keeps its base name in a uuid folder, bytes and modes intact", async () => {
    const source = await writeSource("Report Q3 (final).pdf", pdf);

    const resolved = await resolveLocal(source);

    expect(expectPerSendPath(resolved.path)).toBe("Report Q3 (final).pdf");
    expect(resolved.contentType).toBe("application/pdf");
    expect((await fs.readFile(resolved.path)).equals(pdf)).toBe(true);
    if (process.platform !== "win32") {
      expect((await fs.stat(resolved.path)).mode & 0o777).toBe(0o644);
      expect((await fs.stat(path.dirname(resolved.path))).mode & 0o777).toBe(0o700);
    }
  });

  it("§3.1 file:// URL sources keep their base name too", async () => {
    const source = await writeSource("Meeting notes.txt", "notes");

    const resolved = await resolveLocal(`file://${source}`);

    expect(expectPerSendPath(resolved.path)).toBe("Meeting notes.txt");
  });

  it("§3.2 the same name sent twice lands in two folders, both files intact", async () => {
    const first = await writeSource("same.txt", "first");
    const a = await resolveLocal(first);
    await fs.writeFile(first, "second");
    const b = await resolveLocal(first);

    expect(expectPerSendPath(a.path)).toBe("same.txt");
    expect(expectPerSendPath(b.path)).toBe("same.txt");
    expect(path.dirname(a.path)).not.toBe(path.dirname(b.path));
    expect(await fs.readFile(a.path, "utf8")).toBe("first");
    expect(await fs.readFile(b.path, "utf8")).toBe("second");
  });

  describe("§3.3 http(s) sources", () => {
    function mockFetch(params: { body: Buffer; contentType?: string; disposition?: string }) {
      mockPinnedHostnameResolution();
      return vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        body: true,
        arrayBuffer: async () =>
          params.body.buffer.slice(
            params.body.byteOffset,
            params.body.byteOffset + params.body.byteLength,
          ),
        headers: {
          get: (name: string) => {
            if (name === "content-disposition") {
              return params.disposition ?? null;
            }
            if (name === "content-type") {
              return params.contentType ?? null;
            }
            return null;
          },
        },
        status: 200,
      } as unknown as Response);
    }

    it("uses the header name", async () => {
      mockFetch({
        body: pdf,
        contentType: "application/pdf",
        disposition: 'attachment; filename="Quarterly Report.pdf"',
      });
      const resolved = await resolveOutboundAttachmentFromUrl(
        "https://example.com/download?id=1",
        MAX,
      );
      expect(expectPerSendPath(resolved.path)).toBe("Quarterly Report.pdf");
      expect((await fs.readFile(resolved.path)).equals(pdf)).toBe(true);
    });

    it("uses the URL base name without a header name", async () => {
      mockFetch({ body: Buffer.from("plain notes"), contentType: "text/plain" });
      const resolved = await resolveOutboundAttachmentFromUrl(
        "https://example.com/files/notes.txt",
        MAX,
      );
      expect(expectPerSendPath(resolved.path)).toBe("notes.txt");
    });

    it("adds the extension of a known MIME type to a name without one", async () => {
      mockFetch({ body: pdf, contentType: "application/pdf" });
      const resolved = await resolveOutboundAttachmentFromUrl(
        "https://example.com/files/summary",
        MAX,
      );
      expect(expectPerSendPath(resolved.path)).toBe("summary.pdf");
    });

    it("falls back to the uuid name when the URL has no name", async () => {
      mockFetch({ body: pdf, contentType: "application/pdf" });
      const resolved = await resolveOutboundAttachmentFromUrl("https://example.com/", MAX);
      expectLegacyPath(resolved.path, ".pdf");
    });
  });

  it("§2.1 a converted image keeps the converted name (HEIC to .jpg, re-encoded PNG to .jpg)", async () => {
    const jpeg = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "#336699" },
    })
      .jpeg()
      .toBuffer();
    convertHeicToJpegMock.mockResolvedValueOnce(jpeg);
    const heic = await writeSource("IMG_0001.HEIC", "fake-heic");
    const fromHeic = await resolveLocal(heic);
    expect(expectPerSendPath(fromHeic.path)).toBe("IMG_0001.jpg");
    expect(fromHeic.contentType).toBe("image/jpeg");

    const opaquePng = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "#00ff00" },
    })
      .png()
      .toBuffer();
    const png = await writeSource("Screenshot 2026.png", opaquePng);
    const fromPng = await resolveLocal(png);
    expect(fromPng.contentType).toBe("image/jpeg");
    expect(expectPerSendPath(fromPng.path)).toBe("Screenshot 2026.jpg");

    const alphaPng = await sharp({
      create: { width: 8, height: 8, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 0.5 } },
    })
      .png()
      .toBuffer();
    const keptPng = await writeSource("logo.png", alphaPng);
    const fromAlphaPng = await resolveLocal(keptPng);
    expect(fromAlphaPng.contentType).toBe("image/png");
    expect(expectPerSendPath(fromAlphaPng.path)).toBe("logo.png");
  });

  it("§3.4 no usable name falls back to today's media/outbound/<uuid><ext>", async () => {
    const source = await writeSource("plain.pdf", pdf);
    for (const value of [undefined, "", "   ", ".", "..", "....", "/", "\\", "//\\//", " . . "]) {
      reportedFileNameOverride = { value };
      const resolved = await resolveLocal(source);
      expect(path.dirname(resolved.path), JSON.stringify(value)).toBe(outboundDir);
      expectLegacyPath(resolved.path, ".pdf");
      expect((await fs.readFile(resolved.path)).equals(pdf)).toBe(true);
    }
  });

  it("§3.4 a source file named only with dots falls back to the uuid name", async () => {
    const source = await writeSource("...", pdf);
    const resolved = await resolveLocal(source);
    expectLegacyPath(resolved.path, ".pdf");
  });

  it("§3.5 hostile names never escape the folder and never fail the send", async () => {
    const source = await writeSource("hostile-source.pdf", pdf);
    const long = `${"a".repeat(296)}.pdf`;
    const cases: Array<[string, string]> = [
      ["../../x.pdf", "x.pdf"],
      ["../../../../etc/passwd", "passwd"],
      ["/etc/cron.d/evil.pdf", "evil.pdf"],
      ["..\\..\\windows\\evil.pdf", "evil.pdf"],
      ["C:\\Users\\someone\\Desktop\\Plan.pdf", "Plan.pdf"],
      ["dir/sub\\mixed.pdf", "mixed.pdf"],
      ["name\u0000with-nul.pdf", "namewith-nul.pdf"],
      ["evil\u0000/../../x.pdf", "x.pdf"],
      ["line\nbreak\ttab\u0007bell\u007f.pdf", "linebreaktabbell.pdf"],
      ["invoice\u202Efdp.exe", "invoicefdp.exe"],
      [".bashrc", "bashrc"],
      ["...hidden report.pdf", "hidden report.pdf"],
      ["  padded name.pdf  ", "padded name.pdf"],
      ["Отчёт за квартал.pdf", "Отчёт за квартал.pdf"],
      ["報告書 第3四半期.pdf", "報告書 第3四半期.pdf"],
      ["تقرير نهائي.pdf", "تقرير نهائي.pdf"],
      ["Résumé – draft #2 (v1.1) & notes!.pdf", "Résumé – draft #2 (v1.1) & notes!.pdf"],
      [long, `${"a".repeat(116)}.pdf`],
    ];
    for (const [reported, expected] of cases) {
      reportedFileNameOverride = { value: reported };
      const resolved = await resolveLocal(source);
      expect(expectPerSendPath(resolved.path), JSON.stringify(reported)).toBe(expected);
      expect((await fs.readFile(resolved.path)).equals(pdf)).toBe(true);
    }
  });

  it("§3.5 a long non-Latin name keeps its letters and extension within the file-system limit", async () => {
    const source = await writeSource("cap-source.pdf", pdf);
    // 120 three-byte characters would be 360 bytes, over the 255-byte limit of one path
    // segment on common file systems; the name is cut further so the write cannot fail.
    reportedFileNameOverride = { value: `${"報".repeat(296)}.pdf` };
    const resolved = await resolveLocal(source);
    const name = expectPerSendPath(resolved.path);
    expect(name).toBe(`${"報".repeat(83)}.pdf`);
    expect(Array.from(name).length).toBeLessThanOrEqual(120);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255);

    reportedFileNameOverride = { value: `${"é".repeat(296)}.pdf` };
    const twoByte = expectPerSendPath((await resolveLocal(source)).path);
    expect(twoByte).toBe(`${"é".repeat(116)}.pdf`);
  });

  it("§3.5 a write the file system refuses falls back to the uuid name and leaves no folder", async () => {
    const source = await writeSource("refused.pdf", pdf);
    const originalWriteFile = fs.writeFile.bind(fs);
    const refused: string[] = [];
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      const [filePath] = args;
      if (typeof filePath === "string" && filePath.endsWith(`${path.sep}refused.pdf`)) {
        refused.push(filePath);
        const err = new Error("name not allowed") as NodeJS.ErrnoException;
        err.code = "EINVAL";
        throw err;
      }
      return await originalWriteFile(...args);
    });

    const resolved = await resolveLocal(source);

    expect(refused).toHaveLength(1);
    expectLegacyPath(resolved.path, ".pdf");
    await expect(fs.stat(path.dirname(refused[0] ?? ""))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps the size limit unchanged", async () => {
    const source = await writeSource("too big.pdf", Buffer.concat([pdf, Buffer.alloc(2048)]));
    await expect(
      resolveOutboundAttachmentFromUrl(source, 1024, { localRoots: [srcDir] }),
    ).rejects.toThrow(/exceeds/i);
  });

  it("keeps the allowed source roots unchanged", async () => {
    const outside = path.join(tempHome.home, "outside.pdf");
    await fs.writeFile(outside, pdf);
    await expect(resolveLocal(outside)).rejects.toMatchObject({ code: "path-not-allowed" });
  });

  it("§3.8 periodic cleanup removes an expired per-send folder with its file; a fresh one survives", async () => {
    const oldSource = await writeSource("old report.pdf", pdf);
    const freshSource = await writeSource("fresh report.pdf", pdf);
    const old = await resolveLocal(oldSource);
    const fresh = await resolveLocal(freshSource);
    const past = (Date.now() - 10_000) / 1000;
    await fs.utimes(old.path, past, past);

    // Same call the gateway's periodic media cleanup makes (server-maintenance.ts).
    await store.cleanOldMedia(1_000, { recursive: true, pruneEmptyDirs: true });

    await expect(fs.stat(old.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.dirname(old.path))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.stat(fresh.path)).isFile()).toBe(true);
    expect((await fs.readFile(fresh.path)).equals(pdf)).toBe(true);
  });
});
