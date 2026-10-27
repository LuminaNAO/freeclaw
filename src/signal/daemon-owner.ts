import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ProcTable } from "./proc-table.js";
import { isProcAlive } from "./proc-table.js";

/**
 * Ownership record for a gateway-spawned signal-cli daemon (signal-daemon-lifecycle ARCH §3.1).
 * Lives next to the socket as `<socket>.owner.json`, 0600, written by temp file + rename.
 */
export type SignalDaemonOwnerRecord = {
  pid: number;
  /** /proc/<pid>/stat field 22 of the daemon at spawn time. */
  startTime: string;
  account?: string;
  socketPath: string;
  gatewayPid: number;
  stateDir?: string;
  cliPath: string;
};

export function resolveSignalOwnerPath(socketPath: string): string {
  return `${socketPath}.owner.json`;
}

export function writeSignalOwnerRecord(record: SignalDaemonOwnerRecord): string {
  const target = resolveSignalOwnerPath(record.socketPath);
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`,
  );
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    // openSync honours the umask; make the mode exact before the file becomes visible.
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return target;
}

function isRecord(value: unknown): value is SignalDaemonOwnerRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    Number.isInteger(v.pid) &&
    (v.pid as number) > 1 &&
    typeof v.startTime === "string" &&
    /^\d+$/.test(v.startTime) &&
    typeof v.socketPath === "string" &&
    Number.isInteger(v.gatewayPid) &&
    typeof v.cliPath === "string" &&
    (v.account === undefined || typeof v.account === "string")
  );
}

export type OwnerReadResult =
  | { kind: "missing" }
  | { kind: "invalid"; reason: string }
  | { kind: "ok"; record: SignalDaemonOwnerRecord };

/** Read the owner record; refuses symlinks, other owners and group/other-accessible files. */
export function readSignalOwnerRecord(socketPath: string, uid: number): OwnerReadResult {
  const ownerPath = resolveSignalOwnerPath(socketPath);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(ownerPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing" };
    }
    return { kind: "invalid", reason: `cannot stat ${ownerPath}: ${String(err)}` };
  }
  if (!st.isFile()) {
    return { kind: "invalid", reason: `${ownerPath} is not a regular file` };
  }
  if (st.uid !== uid) {
    return { kind: "invalid", reason: `${ownerPath} is owned by uid ${st.uid}, expected ${uid}` };
  }
  if ((st.mode & 0o077) !== 0) {
    return { kind: "invalid", reason: `${ownerPath} is accessible by group/other` };
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
    if (!isRecord(parsed)) {
      return { kind: "invalid", reason: `${ownerPath} is not a valid owner record` };
    }
    return { kind: "ok", record: parsed };
  } catch (err) {
    return { kind: "invalid", reason: `cannot read ${ownerPath}: ${String(err)}` };
  }
}

/** Remove the owner record, but only if it still describes `pid` (a newer daemon may own it). */
export function removeSignalOwnerRecord(socketPath: string, pid?: number): void {
  const ownerPath = resolveSignalOwnerPath(socketPath);
  if (pid !== undefined) {
    try {
      const parsed = JSON.parse(fs.readFileSync(ownerPath, "utf8")) as { pid?: unknown };
      if (parsed.pid !== pid) {
        return;
      }
    } catch {
      return;
    }
  }
  try {
    fs.unlinkSync(ownerPath);
  } catch {
    // already gone
  }
}

function cmdlineIsSignalCli(cmdline: string[], cliPath: string): boolean {
  const cliBase = path.basename(cliPath);
  return cmdline.some((arg) => {
    const base = path.basename(arg);
    return (
      base === cliBase ||
      base === "signal-cli" ||
      arg.includes("org.asamk.signal") ||
      /(^|\/)signal-cli[^/]*\.jar$/.test(arg)
    );
  });
}

function cmdlineHasAccount(cmdline: string[], account: string): boolean {
  for (let i = 0; i < cmdline.length; i += 1) {
    const arg = cmdline[i];
    if ((arg === "-a" || arg === "-u" || arg === "--account") && cmdline[i + 1] === account) {
      return true;
    }
    if (arg === `--account=${account}`) {
      return true;
    }
  }
  return false;
}

export type OrphanCheck =
  | { orphan: true; record: SignalDaemonOwnerRecord }
  | { orphan: false; reason: string; record?: SignalDaemonOwnerRecord };

/**
 * Decide whether the daemon described by the owner record is our orphan (ARCH §3.3): pid alive,
 * same start time, signal-cli for the same account and socket, same uid. Anything else is
 * someone else's daemon and must never be touched.
 */
export function checkSignalOrphan(params: {
  owner: OwnerReadResult;
  socketPath: string;
  account?: string;
  uid: number;
  proc: ProcTable;
  selfPid?: number;
}): OrphanCheck {
  const { owner, proc } = params;
  if (owner.kind === "missing") {
    return { orphan: false, reason: "no owner record" };
  }
  if (owner.kind === "invalid") {
    return { orphan: false, reason: owner.reason };
  }
  const record = owner.record;
  const refuse = (reason: string): OrphanCheck => ({ orphan: false, reason, record });
  if (path.resolve(record.socketPath) !== path.resolve(params.socketPath)) {
    return refuse(`owner record is for socket ${record.socketPath}`);
  }
  if ((record.account ?? "") !== (params.account ?? "")) {
    return refuse(
      `owner record is for account ${record.account ?? "(none)"}, not ${params.account ?? "(none)"}`,
    );
  }
  const stat = proc.readStat(record.pid);
  if (!stat || !isProcAlive(proc, record.pid)) {
    return refuse(`recorded pid ${record.pid} is not running`);
  }
  if (stat.startTime !== record.startTime) {
    return refuse(`pid ${record.pid} start time differs from the owner record (pid reused)`);
  }
  const cmdline = proc.readCmdline(record.pid);
  if (!cmdline || !cmdlineIsSignalCli(cmdline, record.cliPath)) {
    return refuse(`pid ${record.pid} is not signal-cli`);
  }
  if (params.account && !cmdlineHasAccount(cmdline, params.account)) {
    return refuse(`pid ${record.pid} is not running account ${params.account}`);
  }
  if (!cmdline.includes(params.socketPath)) {
    return refuse(`pid ${record.pid} is not serving ${params.socketPath}`);
  }
  const procUid = proc.readUid(record.pid);
  if (procUid !== params.uid) {
    return refuse(`pid ${record.pid} runs as uid ${String(procUid)}, not ${params.uid}`);
  }
  // Still the child of a different live gateway: not an orphan, someone else's live daemon.
  const selfPid = params.selfPid ?? process.pid;
  if (record.gatewayPid !== selfPid && stat.ppid === record.gatewayPid) {
    return refuse(`pid ${record.pid} is still owned by live gateway pid ${record.gatewayPid}`);
  }
  return { orphan: true, record };
}
