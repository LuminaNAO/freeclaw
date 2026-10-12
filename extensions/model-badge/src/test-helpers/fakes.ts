import path from "node:path";
import type { Clock } from "../core/clock.js";
import type { CoreFs, FsStat } from "../core/fsio.js";
import type { Renderer, RenderSize } from "../core/render.js";

// Test seams (ported from the standalone suite): fake timers, an in-memory filesystem,
// a fake rasteriser and a capturing logger. All data is synthetic.

export type FakeClock = Clock & {
  pending(): number;
  flush(): Promise<void>;
  advance(ms: number): Promise<void>;
};

export function createFakeClock(start = 1_000_000): FakeClock {
  let now = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => unknown; id: number }>();
  const clock: FakeClock = {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: now + Math.max(0, ms), fn, id });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id as number);
    },
    pending: () => timers.size,
    async flush() {
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setImmediate(r));
      }
    },
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        await clock.flush();
        let next: { at: number; fn: () => unknown; id: number } | null = null;
        for (const t of timers.values()) {
          if (t.at <= until && (!next || t.at < next.at || (t.at === next.at && t.id < next.id))) {
            next = t;
          }
        }
        if (!next) {
          break;
        }
        timers.delete(next.id);
        now = Math.max(now, next.at);
        await next.fn();
      }
      now = until;
      await clock.flush();
    },
  };
  return clock;
}

export type MemFs = CoreFs & {
  files: Map<string, { data: Buffer; mtimeMs: number }>;
  faults: { failWriteAtomic: ((p: string) => boolean) | null };
  put(p: string, data: string | Buffer): void;
  putJson(p: string, v: unknown): void;
  getJson<T = unknown>(p: string): T;
  exists(p: string): boolean;
  list(prefix: string): string[];
};

export function createMemFs(clock: Clock): MemFs {
  const files = new Map<string, { data: Buffer; mtimeMs: number }>();
  const dirs = new Map<string, number>();
  const faults: MemFs["faults"] = { failWriteAtomic: null };
  const touchDir = (d: string) => {
    for (let p = d; ; p = path.dirname(p)) {
      if (!dirs.has(p)) {
        dirs.set(p, clock.now());
      }
      if (p === path.dirname(p)) {
        break;
      }
    }
    dirs.set(d, clock.now());
  };
  const put = (p: string, data: string | Buffer) => {
    touchDir(path.dirname(p));
    files.set(p, { data: Buffer.from(data), mtimeMs: clock.now() });
  };
  const enoent = (p: string) => Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });

  const fs: MemFs = {
    files,
    faults,
    put,
    putJson: (p, v) => put(p, JSON.stringify(v, null, 1)),
    getJson: <T>(p: string) => JSON.parse(files.get(p)!.data.toString("utf8")) as T,
    exists: (p) => files.has(p),
    list: (prefix) => [...files.keys()].filter((f) => f.startsWith(prefix)).toSorted(),
    async stat(p): Promise<FsStat | null> {
      const f = files.get(p);
      if (f) {
        return { mtimeMs: f.mtimeMs, size: f.data.length, isDir: false };
      }
      return dirs.has(p) ? { mtimeMs: dirs.get(p)!, size: 0, isDir: true } : null;
    },
    async readFile(p) {
      const f = files.get(p);
      if (!f) {
        throw enoent(p);
      }
      return Buffer.from(f.data);
    },
    async readText(p) {
      return (await fs.readFile(p)).toString("utf8");
    },
    async readdir(p) {
      if (!dirs.has(p)) {
        throw enoent(p);
      }
      const out = new Set<string>();
      for (const f of files.keys()) {
        if (path.dirname(f) === p) {
          out.add(path.basename(f));
        }
      }
      for (const d of dirs.keys()) {
        if (d !== p && path.dirname(d) === p) {
          out.add(path.basename(d));
        }
      }
      return [...out].toSorted();
    },
    async mkdirp(p) {
      touchDir(p);
    },
    async unlink(p) {
      if (files.delete(p)) {
        dirs.set(path.dirname(p), clock.now());
      }
    },
    async rename(a, b) {
      const f = files.get(a);
      if (!f) {
        throw enoent(a);
      }
      files.set(b, { ...f, mtimeMs: clock.now() });
      files.delete(a);
      dirs.set(path.dirname(b), clock.now());
    },
    async link(a, b) {
      if (files.has(b)) {
        throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
      }
      const f = files.get(a);
      if (!f) {
        throw enoent(a);
      }
      put(b, f.data);
    },
    async writeFile(p, data) {
      put(p, data);
    },
    async writeAtomic(p, data) {
      if (faults.failWriteAtomic?.(p)) {
        throw new Error(`injected crash before rename of ${path.basename(p)}`);
      }
      put(p, data);
    },
    async rmrf(p) {
      for (const f of [...files.keys()]) {
        if (f === p || f.startsWith(`${p}/`)) {
          files.delete(f);
        }
      }
      for (const d of [...dirs.keys()]) {
        if (d === p || d.startsWith(`${p}/`)) {
          dirs.delete(d);
        }
      }
    },
  };
  return fs;
}

// A minimal valid PNG header (signature + IHDR) of the requested size, with a marker.
export function fakePng(width: number, height: number, marker = ""): Buffer {
  const b = Buffer.alloc(64 + Buffer.byteLength(marker));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b.write(marker, 64, "utf8");
  return b;
}

export type FakeRenderer = Renderer & { calls: Array<{ svg: string }> };

// Writes a valid PNG whose tail is the input SVG, so tests can see what went in.
export function createFakeRenderer(
  fs: CoreFs,
  opts: { failWhen?: (svg: string) => boolean } = {},
): FakeRenderer {
  const calls: Array<{ svg: string }> = [];
  return {
    id: "fake",
    calls,
    async version() {
      return "fake-rasteriser 1";
    },
    async svgToPng(svgPath: string, pngPath: string, size: RenderSize) {
      const svg = await fs.readText(svgPath);
      calls.push({ svg });
      if (opts.failWhen?.(svg)) {
        throw new Error("injected render failure");
      }
      await fs.writeFile(pngPath, fakePng(size.width, size.height, svg));
    },
  };
}

export type CapturedLog = {
  lines: Array<{ level: string; msg: string }>;
  info(m: string): void;
  warn(m: string): void;
  error(m: string): void;
  text(): string;
};

export function createLog(): CapturedLog {
  const lines: Array<{ level: string; msg: string }> = [];
  const add = (level: string) => (msg: string) => lines.push({ level, msg: String(msg) });
  return {
    lines,
    info: add("info"),
    warn: add("warn"),
    error: add("error"),
    text: () => lines.map((l) => `${l.level}: ${l.msg}`).join("\n"),
  };
}

// Which mark letter an asset carries (the fake PNG embeds the composited SVG).
export function markLetterOf(png: Buffer | undefined): string | null {
  const m = /data-mark="([^"]*)"/.exec(png?.toString("utf8") ?? "");
  return m?.[1]
    ? m[1].replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    : null;
}
