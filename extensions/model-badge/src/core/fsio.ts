import fsp from "node:fs/promises";
import path from "node:path";

// The only filesystem surface the core uses, so tests can substitute an in-memory fake.
export type FsStat = { mtimeMs: number; size: number; isDir: boolean };

export interface CoreFs {
  stat(p: string): Promise<FsStat | null>;
  readFile(p: string): Promise<Buffer>;
  readText(p: string): Promise<string>;
  readdir(p: string): Promise<string[]>;
  mkdirp(p: string): Promise<void>;
  unlink(p: string): Promise<void>;
  rename(a: string, b: string): Promise<void>;
  link(a: string, b: string): Promise<void>;
  writeFile(p: string, data: string | Buffer): Promise<void>;
  // tmp + fsync + rename + fsync(dir): readers see either the old or the new file.
  writeAtomic(p: string, data: string | Buffer): Promise<void>;
  // Recursive delete of a directory this extension owns (purge only).
  rmrf(p: string): Promise<void>;
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

export function createNodeFs(): CoreFs {
  return {
    async stat(p) {
      try {
        const s = await fsp.stat(p);
        return { mtimeMs: s.mtimeMs, size: s.size, isDir: s.isDirectory() };
      } catch (err) {
        if (isEnoent(err)) {
          return null;
        }
        throw err;
      }
    },
    readFile: (p) => fsp.readFile(p),
    readText: (p) => fsp.readFile(p, "utf8"),
    readdir: (p) => fsp.readdir(p),
    async mkdirp(p) {
      await fsp.mkdir(p, { recursive: true });
    },
    async unlink(p) {
      try {
        await fsp.unlink(p);
      } catch (err) {
        if (!isEnoent(err)) {
          throw err;
        }
      }
    },
    rename: (a, b) => fsp.rename(a, b),
    link: (a, b) => fsp.link(a, b),
    writeFile: (p, data) => fsp.writeFile(p, data),
    async writeAtomic(p, data) {
      const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
      const fh = await fsp.open(tmp, "w", 0o644);
      try {
        await fh.writeFile(data);
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fsp.rename(tmp, p);
      try {
        const dh = await fsp.open(path.dirname(p), "r");
        try {
          await dh.sync();
        } finally {
          await dh.close();
        }
      } catch {
        // Directory fsync is unsupported on some filesystems; the rename is still atomic.
      }
    },
    async rmrf(p) {
      await fsp.rm(p, { recursive: true, force: true });
    },
  };
}
