import fsSync from "node:fs";

/**
 * Linux-only: resolve which pids own the TCP LISTEN socket(s) on a port, using /proc only
 * (no lsof/ss dependency). `unknown` means a listener exists (or /proc is unreadable) but
 * its owner could not be attributed to a pid we can see; callers must refuse, not guess.
 */
export type PortListenerOwners =
  | { status: "ok"; pids: number[] }
  | { status: "unknown"; reason: string };

const TCP_LISTEN_STATE = "0A";

export function parseProcNetTcpListenInodes(raw: string, port: number): string[] {
  const inodes: string[] = [];
  for (const line of raw.split(/\r?\n/).slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10 || fields[3] !== TCP_LISTEN_STATE) {
      continue;
    }
    const portHex = fields[1]?.split(":").pop() ?? "";
    if (Number.parseInt(portHex, 16) !== port) {
      continue;
    }
    inodes.push(fields[9] ?? "0");
  }
  return inodes;
}

function readListenInodes(port: number): string[] | null {
  let readAny = false;
  const inodes: string[] = [];
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try {
      inodes.push(...parseProcNetTcpListenInodes(fsSync.readFileSync(file, "utf8"), port));
      readAny = true;
    } catch {
      // tcp6 may be absent when IPv6 is disabled.
    }
  }
  return readAny ? [...new Set(inodes)] : null;
}

function listPids(): number[] {
  try {
    return fsSync
      .readdirSync("/proc")
      .filter((name) => /^\d+$/.test(name))
      .map((name) => Number.parseInt(name, 10));
  } catch {
    return [];
  }
}

function pidOwnsAnySocket(pid: number, wanted: Set<string>): boolean {
  let fds: string[];
  try {
    fds = fsSync.readdirSync(`/proc/${pid}/fd`);
  } catch {
    return false;
  }
  for (const fd of fds) {
    try {
      const match = /^socket:\[(\d+)\]$/.exec(fsSync.readlinkSync(`/proc/${pid}/fd/${fd}`));
      if (match && wanted.has(match[1] ?? "")) {
        return true;
      }
    } catch {
      // fd closed meanwhile.
    }
  }
  return false;
}

export function readPortListenerOwnersSync(port: number): PortListenerOwners {
  const inodes = readListenInodes(port);
  if (inodes === null) {
    return { status: "unknown", reason: "cannot read /proc/net/tcp" };
  }
  if (inodes.length === 0) {
    return { status: "ok", pids: [] };
  }
  const wanted = new Set(inodes.filter((inode) => inode !== "0"));
  if (wanted.size === 0) {
    return { status: "unknown", reason: `listener on port ${port} has no socket inode` };
  }
  const pids = listPids().filter((pid) => pidOwnsAnySocket(pid, wanted));
  if (pids.length === 0) {
    return {
      status: "unknown",
      reason: `port ${port} is listening but its owning process is not visible`,
    };
  }
  return { status: "ok", pids };
}
