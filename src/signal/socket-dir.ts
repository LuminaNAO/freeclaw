import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import {
  checkSignalOrphan,
  readSignalOwnerRecord,
  removeSignalOwnerRecord,
} from "./daemon-owner.js";
import { isProcAlive, type ProcTable } from "./proc-table.js";

// sun_path is 108 bytes on Linux and 104 on macOS/BSD, including the trailing NUL.
const SUN_PATH_MAX_BYTES: Partial<Record<NodeJS.Platform, number>> = {
  linux: 107,
  darwin: 103,
  freebsd: 103,
  openbsd: 103,
};

export const SIGNAL_SOCKET_DIR_NAME = "openclaw-signal";

export type SocketFsOps = {
  lstat: (p: string) => Promise<{
    uid: number;
    gid: number;
    mode: number;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    isSocket(): boolean;
  }>;
  mkdir: (p: string, opts: { recursive?: boolean; mode?: number }) => Promise<unknown>;
  chmod: (p: string, mode: number) => Promise<void>;
  chown: (p: string, uid: number, gid: number) => Promise<void>;
  unlink: (p: string) => Promise<void>;
  /** Unused; accepted so injected fs objects with realpath stay compatible. */
  realpath?: (p: string) => Promise<string>;
  readlink?: (p: string) => Promise<string>;
};

export type SocketDirDeps = {
  fs?: SocketFsOps;
  getuid?: () => number;
  platform?: NodeJS.Platform;
  resolveGid?: (group: string) => Promise<number>;
  probeLive?: (socketPath: string) => Promise<"live" | "stale">;
  log?: (message: string) => void;
};

export class SignalSocketSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignalSocketSetupError";
  }
}

const defaultFs: SocketFsOps = {
  lstat: (p) => fs.lstat(p),
  mkdir: (p, opts) => fs.mkdir(p, opts),
  chmod: (p, mode) => fs.chmod(p, mode),
  chown: (p, uid, gid) => fs.chown(p, uid, gid),
  unlink: (p) => fs.unlink(p),
  readlink: (p) => fs.readlink(p),
};

function currentUid(deps: SocketDirDeps): number {
  const getuid = deps.getuid ?? process.getuid?.bind(process);
  if (!getuid) {
    throw new SignalSocketSetupError("unix socket transport requires a POSIX platform");
  }
  return getuid();
}

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function octal(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, "0");
}

/**
 * Default per-uid socket directory: $XDG_RUNTIME_DIR/openclaw-signal when the runtime dir
 * is usable (absolute, ours, no group/other bits), else <stateDir>/signal-sockets.
 * Synchronous because account resolution is synchronous.
 */
export function resolveDefaultSignalSocketDir(
  env: NodeJS.ProcessEnv = process.env,
  deps: { lstatSync?: typeof fsSync.lstatSync; getuid?: () => number } = {},
): string {
  const runtimeDir = env.XDG_RUNTIME_DIR?.trim();
  const getuid = deps.getuid ?? process.getuid?.bind(process);
  if (runtimeDir && path.isAbsolute(runtimeDir) && getuid) {
    try {
      const st = (deps.lstatSync ?? fsSync.lstatSync)(runtimeDir);
      if (
        st.isDirectory() &&
        !st.isSymbolicLink() &&
        st.uid === getuid() &&
        (st.mode & 0o077) === 0
      ) {
        return path.join(runtimeDir, SIGNAL_SOCKET_DIR_NAME);
      }
    } catch {
      // fall through to the state dir
    }
  }
  return path.join(resolveStateDir(env), "signal-sockets");
}

export function resolveSignalSocketPath(dir: string, accountId: string): string {
  return path.join(dir, `${accountId}.sock`);
}

export function assertSocketPathLength(socketPath: string, platform: NodeJS.Platform): void {
  const max = SUN_PATH_MAX_BYTES[platform] ?? 103;
  const bytes = Buffer.byteLength(socketPath, "utf8");
  if (bytes > max) {
    throw new SignalSocketSetupError(
      `Signal socket path is ${bytes} bytes, over the ${max}-byte unix socket limit: ${socketPath}. Set channels.signal.socketPath to a shorter path.`,
    );
  }
}

const MAX_SYMLINK_HOPS = 40;

/**
 * Resolve the parent of `dir` one component at a time (like realpath) and refuse anything
 * another uid could use to redirect it: every directory traversed must not be world-writable
 * without the sticky bit, and every symlink hop (including intermediate hops of a chain) must
 * be owned by us or root, since a link's owner can retarget it after this check. Link modes
 * are meaningless (always 0777) and are not judged.
 */
async function assertAncestorsSafe(dir: string, fsOps: SocketFsOps, uid: number): Promise<void> {
  const readlink = fsOps.readlink ?? ((p: string) => fs.readlink(p));
  const checkDir = (current: string, mode: number) => {
    if ((mode & 0o002) !== 0 && (mode & 0o1000) === 0) {
      throw new SignalSocketSetupError(
        `Signal socket directory ancestor ${current} is world-writable without the sticky bit (mode ${octal(mode)}); refusing to use ${dir}`,
      );
    }
  };
  checkDir("/", (await fsOps.lstat("/")).mode);
  let pending = path.resolve(path.dirname(dir)).split("/").filter(Boolean);
  let resolved = "/";
  let hops = 0;
  while (pending.length > 0) {
    const name = pending.shift() as string;
    if (name === ".") {
      continue;
    }
    if (name === "..") {
      resolved = path.dirname(resolved);
      continue;
    }
    const next = path.join(resolved, name);
    const st = await fsOps.lstat(next);
    if (st.isSymbolicLink()) {
      hops += 1;
      if (hops > MAX_SYMLINK_HOPS) {
        throw new SignalSocketSetupError(`too many symlinks resolving ${dir}`);
      }
      if (st.uid !== uid && st.uid !== 0) {
        throw new SignalSocketSetupError(
          `Signal socket path component ${next} is a symlink owned by uid ${st.uid} (expected ${uid} or root); refusing to use ${dir}`,
        );
      }
      const target = await readlink(next);
      if (path.isAbsolute(target)) {
        resolved = "/";
      }
      pending = [...target.split("/").filter(Boolean), ...pending];
      continue;
    }
    if (!st.isDirectory()) {
      throw new SignalSocketSetupError(`Signal socket path component ${next} is not a directory`);
    }
    checkDir(next, st.mode);
    resolved = next;
  }
}

/**
 * Create (or verify) the socket directory: a real directory owned by us with exactly the
 * policy mode. This directory is the security boundary; the socket mode is defense in depth.
 */
export async function ensureSignalSocketDir(params: {
  dir: string;
  group?: string;
  deps?: SocketDirDeps;
}): Promise<{ gid?: number }> {
  const deps = params.deps ?? {};
  const fsOps = deps.fs ?? defaultFs;
  const uid = currentUid(deps);
  const dir = params.dir;
  const wantMode = params.group ? 0o710 : 0o700;
  let gid: number | undefined;
  if (params.group) {
    if (!deps.resolveGid) {
      throw new SignalSocketSetupError("socketGroup requires a group resolver");
    }
    gid = await deps.resolveGid(params.group);
  }

  // Explicit mode so missing ancestors are never created group/other-writable under a loose
  // umask (they would then fail our own ancestor check).
  await fsOps.mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
  try {
    await fsOps.mkdir(dir, { mode: wantMode });
  } catch (err) {
    if (errnoCode(err) !== "EEXIST") {
      throw err;
    }
  }

  const verify = async () => {
    const st = await fsOps.lstat(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new SignalSocketSetupError(`Signal socket directory ${dir} is not a real directory`);
    }
    if (st.uid !== uid) {
      throw new SignalSocketSetupError(
        `Signal socket directory ${dir} is owned by uid ${st.uid}, expected ${uid}`,
      );
    }
    return st;
  };

  let st = await verify();
  if (gid !== undefined && st.gid !== gid) {
    try {
      await fsOps.chown(dir, uid, gid);
    } catch (err) {
      throw new SignalSocketSetupError(
        `cannot assign Signal socket directory ${dir} to group ${params.group} (${errnoCode(err) ?? String(err)}); the gateway user must be a member of that group`,
      );
    }
    st = await verify();
  }
  if ((st.mode & 0o7777) !== wantMode) {
    await fsOps.chmod(dir, wantMode);
    deps.log?.(
      `signal: tightened socket directory ${dir} from ${octal(st.mode)} to ${octal(wantMode)}`,
    );
    st = await verify();
    if ((st.mode & 0o7777) !== wantMode) {
      throw new SignalSocketSetupError(
        `Signal socket directory ${dir} has mode ${octal(st.mode)} after chmod, expected ${octal(wantMode)}`,
      );
    }
  }
  if (gid !== undefined && st.gid !== gid) {
    throw new SignalSocketSetupError(`Signal socket directory ${dir} is not in group ${gid}`);
  }
  await assertAncestorsSafe(dir, fsOps, uid);
  return { gid };
}

/**
 * Verify an operator-managed socket's parent directory (external daemon). We never
 * modify it; we only refuse to connect through a path other uids could tamper with.
 */
export async function assertExternalSocketDirSafe(
  socketPath: string,
  deps: SocketDirDeps = {},
): Promise<void> {
  const fsOps = deps.fs ?? defaultFs;
  const uid = currentUid(deps);
  const dir = path.dirname(socketPath);
  const st = await fsOps.lstat(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new SignalSocketSetupError(`Signal socket directory ${dir} is not a real directory`);
  }
  if (st.uid !== uid) {
    throw new SignalSocketSetupError(
      `Signal socket directory ${dir} is owned by uid ${st.uid}, expected ${uid}; refusing to connect`,
    );
  }
  if ((st.mode & 0o002) !== 0 && (st.mode & 0o1000) === 0) {
    throw new SignalSocketSetupError(
      `Signal socket directory ${dir} is world-writable without the sticky bit (mode ${octal(st.mode)}); refusing to connect`,
    );
  }
  await assertAncestorsSafe(dir, fsOps, uid);
}

export async function probeSocketLiveness(
  socketPath: string,
  timeoutMs = 500,
): Promise<"live" | "stale"> {
  return await new Promise((resolve, reject) => {
    const sock = net.connect(socketPath);
    const timer = setTimeout(() => {
      sock.destroy();
      // A socket that accepts nothing within the timeout is held by something; treat as live.
      resolve("live");
    }, timeoutMs);
    sock.once("connect", () => {
      clearTimeout(timer);
      sock.destroy();
      resolve("live");
    });
    sock.once("error", (err) => {
      clearTimeout(timer);
      const code = errnoCode(err);
      if (code === "ECONNREFUSED" || code === "ENOENT") {
        resolve("stale");
      } else {
        reject(err);
      }
    });
  });
}

export type ClearStaleSocketDeps = SocketDirDeps & {
  /** Linux process table; tests inject a fake. Omitted on non-Linux (today's behaviour). */
  proc?: ProcTable;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** SIGTERM grace before SIGKILL (ARCH §3.3: 10 s). */
  reapGraceMs?: number;
  pollMs?: number;
};

/** Returned only when our own orphaned daemon was reaped (ARCH §3.3); start proceeds at once. */
export type ClearStaleSocketResult = {
  reaped: { pid: number; gatewayPid: number };
};

const DEFAULT_REAP_GRACE_MS = 10_000;

/** Raised when a live socket is held by a daemon that is not ours (ARCH §3.3, §3.5: retry). */
export class SignalSocketBusyError extends SignalSocketSetupError {
  constructor(message: string) {
    super(message);
    this.name = "SignalSocketBusyError";
  }
}

function describeSocketHolders(socketPath: string, proc: ProcTable | undefined): string {
  const holders = proc?.findSocketHolders(socketPath);
  if (!holders || holders.length === 0) {
    const why = holders === null || !proc ? "holder lookup unavailable" : "no visible holder";
    return ` (${why}; it may run as another user: find it with \`ss -xlp | grep -F ${socketPath}\`)`;
  }
  const lines = holders.map((pid) => {
    const uid = proc?.readUid(pid);
    const cmdline = proc?.readCmdline(pid)?.join(" ") || "?";
    return `pid ${pid} uid ${uid ?? "?"}: ${cmdline}`;
  });
  return `; held by ${lines.join("; ")}. If it is not needed, stop it with \`kill ${holders.join(" ")}\``;
}

async function reapOrphan(params: {
  pid: number;
  startTime: string;
  socketPath: string;
  proc: ProcTable;
  probeLive: (socketPath: string) => Promise<"live" | "stale">;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  graceMs: number;
  pollMs: number;
}): Promise<void> {
  const { pid, startTime, proc } = params;
  const alive = () => isProcAlive(proc, pid, startTime);
  const released = async () => {
    try {
      return (await params.probeLive(params.socketPath)) === "stale";
    } catch {
      return false;
    }
  };
  const waitUntil = async (deadline: number, done: () => Promise<boolean>) => {
    while (!(await done())) {
      if (params.now() >= deadline) {
        return false;
      }
      await params.sleep(params.pollMs);
    }
    return true;
  };
  const send = (signal: NodeJS.Signals) => {
    try {
      proc.kill(pid, signal);
    } catch (err) {
      if (errnoCode(err) !== "ESRCH") {
        throw err;
      }
    }
  };
  send("SIGTERM");
  const exited = await waitUntil(
    params.now() + params.graceMs,
    async () => !alive() && (await released()),
  );
  if (!exited && alive()) {
    // Re-check identity right before SIGKILL so a pid recycled during the grace is never hit.
    send("SIGKILL");
    await waitUntil(params.now() + 2_000, async () => !alive() && (await released()));
    if (alive()) {
      throw new SignalSocketSetupError(
        `orphaned signal-cli pid ${pid} did not exit after SIGKILL; refusing to start a second daemon`,
      );
    }
  }
}

/**
 * Before spawning: a missing path is fine, a stale socket is removed, a live socket served by
 * our own orphaned daemon (owner record matches, ARCH §3.3) is reaped, any other live socket
 * or a non-socket file is a hard error (never delete what we did not create, never run two
 * daemons, never touch someone else's daemon).
 */
export async function clearStaleSignalSocket(params: {
  socketPath: string;
  accountId: string;
  /** signal-cli account (phone/uuid) the daemon is started for; checked against the owner. */
  account?: string;
  deps?: ClearStaleSocketDeps;
}): Promise<ClearStaleSocketResult | undefined> {
  const deps = params.deps ?? {};
  const fsOps = deps.fs ?? defaultFs;
  const probeLive = deps.probeLive ?? probeSocketLiveness;
  let st;
  try {
    st = await fsOps.lstat(params.socketPath);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") {
      return undefined;
    }
    throw err;
  }
  if (!st.isSocket()) {
    throw new SignalSocketSetupError(
      `${params.socketPath} exists and is not a socket; refusing to replace it`,
    );
  }
  const liveness = await probeLive(params.socketPath);
  if (liveness === "live") {
    const base = `another signal-cli is serving ${params.socketPath}; refusing to start a second daemon for account ${params.accountId}`;
    const proc = deps.proc;
    if (!proc) {
      throw new SignalSocketBusyError(base);
    }
    const uid = currentUid(deps);
    const check = checkSignalOrphan({
      owner: readSignalOwnerRecord(params.socketPath, uid),
      socketPath: params.socketPath,
      account: params.account,
      uid,
      proc,
    });
    if (!check.orphan) {
      throw new SignalSocketBusyError(
        `${base}: not ours (${check.reason})${describeSocketHolders(params.socketPath, proc)}`,
      );
    }
    await reapOrphan({
      pid: check.record.pid,
      startTime: check.record.startTime,
      socketPath: params.socketPath,
      proc,
      probeLive,
      sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      now: deps.now ?? Date.now,
      graceMs: deps.reapGraceMs ?? DEFAULT_REAP_GRACE_MS,
      pollMs: deps.pollMs ?? 100,
    });
    if ((await probeLive(params.socketPath)) === "live") {
      throw new SignalSocketBusyError(
        `${base}: orphaned signal-cli pid ${check.record.pid} exited but the socket is still served${describeSocketHolders(params.socketPath, proc)}`,
      );
    }
    await unlinkIfPresent(fsOps, params.socketPath);
    removeSignalOwnerRecord(params.socketPath);
    deps.log?.(
      `signal: reaped orphaned signal-cli pid ${check.record.pid} (previous gateway ${check.record.gatewayPid})`,
    );
    return { reaped: { pid: check.record.pid, gatewayPid: check.record.gatewayPid } };
  }
  await fsOps.unlink(params.socketPath);
  // A stale socket means its daemon is gone; its owner record is stale too.
  removeSignalOwnerRecord(params.socketPath);
  deps.log?.(`signal: removed stale socket ${params.socketPath}`);
  return undefined;
}

async function unlinkIfPresent(fsOps: SocketFsOps, p: string): Promise<void> {
  try {
    await fsOps.unlink(p);
  } catch (err) {
    if (errnoCode(err) !== "ENOENT") {
      throw err;
    }
  }
}

/** After the daemon is ready: enforce and verify the socket's owner/group/mode. */
export async function enforceSignalSocketMode(params: {
  socketPath: string;
  gid?: number;
  deps?: SocketDirDeps;
}): Promise<void> {
  const deps = params.deps ?? {};
  const fsOps = deps.fs ?? defaultFs;
  const uid = currentUid(deps);
  const wantMode = params.gid !== undefined ? 0o660 : 0o600;
  if (params.gid !== undefined) {
    await fsOps.chown(params.socketPath, uid, params.gid);
  }
  await fsOps.chmod(params.socketPath, wantMode);
  const st = await fsOps.lstat(params.socketPath);
  if (!st.isSocket()) {
    throw new SignalSocketSetupError(`${params.socketPath} is not a socket after daemon start`);
  }
  if (st.uid !== uid) {
    throw new SignalSocketSetupError(
      `${params.socketPath} is owned by uid ${st.uid}, expected ${uid}`,
    );
  }
  if ((st.mode & 0o777) !== wantMode) {
    throw new SignalSocketSetupError(
      `${params.socketPath} has mode ${octal(st.mode)}, expected ${octal(wantMode)}`,
    );
  }
  if (params.gid !== undefined && st.gid !== params.gid) {
    throw new SignalSocketSetupError(`${params.socketPath} is not in group ${params.gid}`);
  }
}

/** Resolve a group name or numeric gid via getent (no native deps). */
export async function resolveGroupId(group: string): Promise<number> {
  if (/^\d+$/.test(group)) {
    return Number(group);
  }
  return await new Promise((resolve, reject) => {
    execFile("getent", ["group", group], { timeout: 5_000 }, (err, stdout) => {
      if (err) {
        reject(
          new SignalSocketSetupError(`unknown group "${group}" for channels.signal.socketGroup`),
        );
        return;
      }
      const gid = Number(stdout.split(":")[2]);
      if (!Number.isInteger(gid)) {
        reject(new SignalSocketSetupError(`cannot parse gid for group "${group}"`));
        return;
      }
      resolve(gid);
    });
  });
}
