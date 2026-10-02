import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertExternalSocketDirSafe,
  assertSocketPathLength,
  clearStaleSignalSocket,
  enforceSignalSocketMode,
  ensureSignalSocketDir,
  resolveDefaultSignalSocketDir,
  type SocketFsOps,
} from "./socket-dir.js";

const roots: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sigdir-"));
  fs.chmodSync(dir, 0o700);
  roots.push(dir);
  return dir;
}
afterEach(() => {
  while (roots.length) {
    const dir = roots.pop() as string;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const mode = (p: string) => fs.lstatSync(p).mode & 0o7777;

async function bindSocket(p: string): Promise<net.Server> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(p, resolve));
  return server;
}

describe("ensureSignalSocketDir", () => {
  it("creates the leaf with 0700", async () => {
    const dir = path.join(tmpRoot(), "openclaw-signal");
    await ensureSignalSocketDir({ dir });
    expect(mode(dir)).toBe(0o700);
  });

  it.each([0o755, 0o777, 0o750])("tightens an existing leaf from %o to 0700", async (m) => {
    const dir = path.join(tmpRoot(), "leaf");
    fs.mkdirSync(dir);
    fs.chmodSync(dir, m);
    const log = vi.fn();
    await ensureSignalSocketDir({ dir, deps: { log } });
    expect(mode(dir)).toBe(0o700);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("tightened"));
  });

  it("refuses a symlinked leaf", async () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, "real"), { mode: 0o700 });
    fs.symlinkSync(path.join(root, "real"), path.join(root, "link"));
    await expect(ensureSignalSocketDir({ dir: path.join(root, "link") })).rejects.toThrow(
      /not a real directory/,
    );
  });

  it("refuses a leaf owned by another uid (simulated)", async () => {
    const dir = path.join(tmpRoot(), "leaf");
    fs.mkdirSync(dir, { mode: 0o700 });
    await expect(
      ensureSignalSocketDir({ dir, deps: { getuid: () => (process.getuid?.() ?? 0) + 4242 } }),
    ).rejects.toThrow(/owned by uid/);
  });

  it("refuses a world-writable non-sticky ancestor, accepts a sticky one", async () => {
    const root = tmpRoot();
    const open = path.join(root, "open");
    fs.mkdirSync(open);
    fs.chmodSync(open, 0o777);
    await expect(ensureSignalSocketDir({ dir: path.join(open, "leaf") })).rejects.toThrow(
      /world-writable without the sticky bit/,
    );
    const sticky = path.join(root, "sticky");
    fs.mkdirSync(sticky);
    fs.chmodSync(sticky, 0o1777);
    await expect(ensureSignalSocketDir({ dir: path.join(sticky, "leaf") })).resolves.toEqual({
      gid: undefined,
    });
  });

  it("group mode: 0710 + chown to the resolved gid; EPERM is a hard error", async () => {
    const dir = path.join(tmpRoot(), "leaf");
    const gid = process.getgid?.() ?? 0;
    await ensureSignalSocketDir({ dir, group: String(gid), deps: { resolveGid: async () => gid } });
    expect(mode(dir)).toBe(0o710);

    const dir2 = path.join(tmpRoot(), "leaf2");
    const realFs: SocketFsOps = {
      lstat: (p) => fs.promises.lstat(p),
      mkdir: (p, o) => fs.promises.mkdir(p, o),
      chmod: (p, m) => fs.promises.chmod(p, m),
      chown: async () => {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      },
      unlink: (p) => fs.promises.unlink(p),
    };
    await expect(
      ensureSignalSocketDir({
        dir: dir2,
        group: "sig",
        deps: { fs: realFs, resolveGid: async () => gid + 1 },
      }),
    ).rejects.toThrow(/must be a member of that group/);
  });
});

describe("ancestor checks through symlinks", () => {
  it("accepts a symlinked ancestor that resolves to a private directory", async () => {
    const root = tmpRoot();
    const real = path.join(root, "real");
    fs.mkdirSync(real, { mode: 0o700 });
    fs.symlinkSync(real, path.join(root, "link"));
    await expect(
      ensureSignalSocketDir({ dir: path.join(root, "link", "signal-sockets") }),
    ).resolves.toEqual({ gid: undefined });
    fs.mkdirSync(path.join(real, "ext"), { mode: 0o700 });
    await expect(
      assertExternalSocketDirSafe(path.join(root, "link", "ext", "s.sock")),
    ).resolves.toBeUndefined();
  });

  it("still rejects a world-writable non-sticky directory reached through a symlink", async () => {
    const root = tmpRoot();
    const open = path.join(root, "open");
    fs.mkdirSync(open);
    fs.chmodSync(open, 0o777);
    fs.symlinkSync(open, path.join(root, "link"));
    await expect(ensureSignalSocketDir({ dir: path.join(root, "link", "leaf") })).rejects.toThrow(
      /world-writable without the sticky bit/,
    );
  });

  function fsWithLinkOwner(linkPath: string, owner: number): SocketFsOps {
    return {
      lstat: async (p) => {
        const st = await fs.promises.lstat(p);
        if (p !== linkPath) {
          return st;
        }
        return {
          uid: owner,
          gid: st.gid,
          mode: st.mode,
          isDirectory: () => st.isDirectory(),
          isSymbolicLink: () => st.isSymbolicLink(),
          isSocket: () => st.isSocket(),
        };
      },
      mkdir: (p, o) => fs.promises.mkdir(p, o),
      chmod: (p, m) => fs.promises.chmod(p, m),
      chown: (p, u, g) => fs.promises.chown(p, u, g),
      unlink: (p) => fs.promises.unlink(p),
    };
  }

  function linkedLayout() {
    const root = tmpRoot();
    const real = path.join(root, "real");
    fs.mkdirSync(real, { mode: 0o700 });
    const link = path.join(root, "link");
    fs.symlinkSync(real, link);
    return { real, link };
  }

  it("refuses a symlink ancestor owned by another uid (simulated), accepts root-owned", async () => {
    const other = (process.getuid?.() ?? 0) + 4242;
    const a = linkedLayout();
    await expect(
      ensureSignalSocketDir({
        dir: path.join(a.link, "s"),
        deps: { fs: fsWithLinkOwner(a.link, other) },
      }),
    ).rejects.toThrow(/symlink owned by uid/);
    fs.mkdirSync(path.join(a.real, "ext"), { mode: 0o700 });
    await expect(
      assertExternalSocketDirSafe(path.join(a.link, "ext", "s.sock"), {
        fs: fsWithLinkOwner(a.link, other),
      }),
    ).rejects.toThrow(/symlink owned by uid/);
    const b = linkedLayout();
    await expect(
      ensureSignalSocketDir({
        dir: path.join(b.link, "s"),
        deps: { fs: fsWithLinkOwner(b.link, 0) },
      }),
    ).resolves.toEqual({ gid: undefined });
  });

  it("checks every hop of a symlink chain, not just the first", async () => {
    const other = (process.getuid?.() ?? 0) + 4242;
    const a = linkedLayout();
    const hop2 = path.join(path.dirname(a.link), "hop2");
    fs.symlinkSync(a.link, hop2);
    await expect(
      ensureSignalSocketDir({
        dir: path.join(hop2, "s"),
        deps: { fs: fsWithLinkOwner(a.link, other) },
      }),
    ).rejects.toThrow(/symlink owned by uid/);
    await expect(ensureSignalSocketDir({ dir: path.join(hop2, "s2") })).resolves.toEqual({
      gid: undefined,
    });
  });

  it("follows relative symlink targets", async () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, "real"), { mode: 0o700 });
    fs.symlinkSync("real", path.join(root, "rel"));
    await expect(ensureSignalSocketDir({ dir: path.join(root, "rel", "s") })).resolves.toEqual({
      gid: undefined,
    });
  });

  it("creates missing ancestors private even under umask 000", async () => {
    const old = process.umask(0o000);
    try {
      const root = tmpRoot();
      const dir = path.join(root, "a", "b", "sockets");
      await expect(ensureSignalSocketDir({ dir })).resolves.toEqual({ gid: undefined });
      expect(mode(path.join(root, "a")) & 0o077).toBe(0);
      expect(mode(dir)).toBe(0o700);
    } finally {
      process.umask(old);
    }
  });
});

describe("assertSocketPathLength", () => {
  it("allows 107 bytes on linux and rejects 108", () => {
    const at = `/${"a".repeat(106)}`;
    expect(Buffer.byteLength(at)).toBe(107);
    expect(() => assertSocketPathLength(at, "linux")).not.toThrow();
    expect(() => assertSocketPathLength(`${at}b`, "linux")).toThrow(/108 bytes/);
    expect(() => assertSocketPathLength(at, "darwin")).toThrow(/103-byte/);
  });
});

describe("clearStaleSignalSocket", () => {
  it("is a no-op when the path is missing", async () => {
    const p = path.join(tmpRoot(), "a.sock");
    await expect(clearStaleSignalSocket({ socketPath: p, accountId: "default" })).resolves.toBe(
      undefined,
    );
  });

  it("unlinks a genuinely stale socket left by a killed daemon", async () => {
    const p = path.join(tmpRoot(), "a.sock");
    // SIGKILL skips cleanup, leaving a socket inode with no listener (ECONNREFUSED).
    const child = spawn(
      process.execPath,
      [
        "-e",
        `require("net").createServer().listen(${JSON.stringify(p)}, () => process.stdout.write("up"))`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    await new Promise<void>((resolve) => child.stdout?.once("data", () => resolve()));
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(fs.lstatSync(p).isSocket()).toBe(true);
    await clearStaleSignalSocket({ socketPath: p, accountId: "default" });
    expect(fs.existsSync(p)).toBe(false);
  });

  it("refuses a live socket (never two daemons for one account)", async () => {
    const p = path.join(tmpRoot(), "a.sock");
    const server = await bindSocket(p);
    try {
      await expect(clearStaleSignalSocket({ socketPath: p, accountId: "acct1" })).rejects.toThrow(
        /another signal-cli is serving .* account acct1/,
      );
    } finally {
      server.close();
    }
  });

  it("never deletes a non-socket", async () => {
    const p = path.join(tmpRoot(), "a.sock");
    fs.writeFileSync(p, "keep");
    await expect(clearStaleSignalSocket({ socketPath: p, accountId: "default" })).rejects.toThrow(
      /not a socket/,
    );
    expect(fs.readFileSync(p, "utf8")).toBe("keep");
  });
});

describe("enforceSignalSocketMode", () => {
  it("tightens the umask-created socket to 0600 and verifies", async () => {
    const p = path.join(tmpRoot(), "a.sock");
    const server = await bindSocket(p);
    try {
      fs.chmodSync(p, 0o755);
      await enforceSignalSocketMode({ socketPath: p });
      expect(mode(p) & 0o777).toBe(0o600);
    } finally {
      server.close();
    }
  });

  it("fails when the socket is owned by another uid (simulated)", async () => {
    const p = path.join(tmpRoot(), "a.sock");
    const server = await bindSocket(p);
    try {
      await expect(
        enforceSignalSocketMode({
          socketPath: p,
          deps: { getuid: () => (process.getuid?.() ?? 0) + 4242 },
        }),
      ).rejects.toThrow(/owned by uid/);
    } finally {
      server.close();
    }
  });
});

describe("assertExternalSocketDirSafe", () => {
  it("accepts our 0700 dir, rejects a world-writable non-sticky dir", async () => {
    const root = tmpRoot();
    await expect(assertExternalSocketDirSafe(path.join(root, "x.sock"))).resolves.toBeUndefined();
    const open = path.join(root, "open");
    fs.mkdirSync(open);
    fs.chmodSync(open, 0o777);
    await expect(assertExternalSocketDirSafe(path.join(open, "x.sock"))).rejects.toThrow(
      /refusing to connect/,
    );
  });
});

describe("resolveDefaultSignalSocketDir", () => {
  it("uses XDG_RUNTIME_DIR when it is ours and private", () => {
    const runtime = tmpRoot();
    expect(resolveDefaultSignalSocketDir({ XDG_RUNTIME_DIR: runtime, HOME: runtime })).toBe(
      path.join(runtime, "openclaw-signal"),
    );
  });

  it("falls back to the state dir when XDG_RUNTIME_DIR is unset, loose, or relative", () => {
    const home = tmpRoot();
    const loose = tmpRoot();
    fs.chmodSync(loose, 0o755);
    const expected = path.join(home, ".openclaw", "signal-sockets");
    const env = { HOME: home, OPENCLAW_TEST_FAST: "1" };
    expect(resolveDefaultSignalSocketDir(env)).toBe(expected);
    expect(resolveDefaultSignalSocketDir({ ...env, XDG_RUNTIME_DIR: loose })).toBe(expected);
    expect(resolveDefaultSignalSocketDir({ ...env, XDG_RUNTIME_DIR: "run/user" })).toBe(expected);
  });
});
