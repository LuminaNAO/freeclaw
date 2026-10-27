import fs from "node:fs";
import path from "node:path";

/**
 * Minimal Linux process table view used by the signal daemon lifecycle (ARCH §3.3).
 * Everything that reads /proc or sends a signal goes through this interface so tests can
 * substitute a fake table and never touch real processes.
 */
export type ProcStat = {
  /** One-letter state from /proc/<pid>/stat field 3 (R, S, D, Z, ...). */
  state: string;
  ppid: number;
  /** /proc/<pid>/stat field 22 (clock ticks since boot), kept as a string. */
  startTime: string;
};

export type ProcTable = {
  readStat: (pid: number) => ProcStat | null;
  readCmdline: (pid: number) => string[] | null;
  /** Real uid from /proc/<pid>/status, or null when unreadable. */
  readUid: (pid: number) => number | null;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  /**
   * Pids holding a listening unix socket bound to `socketPath` (/proc/net/unix inode ->
   * /proc/<pid>/fd). Processes of other uids are usually not visible; an empty list means
   * "no visible holder", null means the lookup is not supported here.
   */
  findSocketHolders: (socketPath: string) => number[] | null;
};

/** Parse /proc/<pid>/stat; the comm field may contain spaces and parentheses. */
export function parseProcStat(raw: string): ProcStat | null {
  const close = raw.lastIndexOf(")");
  if (close < 0) {
    return null;
  }
  // Fields after the comm start at field 3 (state).
  const rest = raw
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const state = rest[0];
  const ppid = Number(rest[1]);
  const startTime = rest[19];
  if (!state || !Number.isInteger(ppid) || !startTime || !/^\d+$/.test(startTime)) {
    return null;
  }
  return { state, ppid, startTime };
}

/** Inodes of unix sockets bound to `socketPath` in a /proc/net/unix dump. */
export function parseProcNetUnixInodes(raw: string, socketPath: string): string[] {
  const inodes: string[] = [];
  for (const line of raw.split("\n").slice(1)) {
    // Num RefCount Protocol Flags Type St Inode [Path]; the path may contain spaces.
    const match = /^\s*\S+:\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\d+)\s(.*)$/.exec(line);
    if (match && match[2] === socketPath) {
      inodes.push(match[1]);
    }
  }
  return inodes;
}

function readFileOrNull(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

export function createLinuxProcTable(procRoot = "/proc"): ProcTable {
  return {
    readStat: (pid) => {
      const raw = readFileOrNull(path.join(procRoot, String(pid), "stat"));
      return raw ? parseProcStat(raw) : null;
    },
    readCmdline: (pid) => {
      const raw = readFileOrNull(path.join(procRoot, String(pid), "cmdline"));
      if (raw === null) {
        return null;
      }
      const parts = raw.split("\0");
      if (parts.at(-1) === "") {
        parts.pop();
      }
      return parts;
    },
    readUid: (pid) => {
      const raw = readFileOrNull(path.join(procRoot, String(pid), "status"));
      const match = raw ? /^Uid:\s+(\d+)/m.exec(raw) : null;
      return match ? Number(match[1]) : null;
    },
    kill: (pid, signal) => {
      process.kill(pid, signal);
    },
    findSocketHolders: (socketPath) => {
      const unix = readFileOrNull(path.join(procRoot, "net", "unix"));
      if (unix === null) {
        return null;
      }
      const wanted = new Set(parseProcNetUnixInodes(unix, socketPath).map((i) => `socket:[${i}]`));
      if (wanted.size === 0) {
        return [];
      }
      const holders: number[] = [];
      let entries: string[];
      try {
        entries = fs.readdirSync(procRoot);
      } catch {
        return null;
      }
      for (const entry of entries) {
        if (!/^\d+$/.test(entry)) {
          continue;
        }
        const fdDir = path.join(procRoot, entry, "fd");
        let fds: string[];
        try {
          fds = fs.readdirSync(fdDir);
        } catch {
          continue; // other uid or gone
        }
        for (const fd of fds) {
          let target: string;
          try {
            target = fs.readlinkSync(path.join(fdDir, fd));
          } catch {
            continue;
          }
          if (wanted.has(target)) {
            holders.push(Number(entry));
            break;
          }
        }
      }
      return holders;
    },
  };
}

/** Alive means: /proc entry present, not a zombie, and (optionally) the same start time. */
export function isProcAlive(proc: ProcTable, pid: number, startTime?: string): boolean {
  const stat = proc.readStat(pid);
  if (!stat || stat.state === "Z" || stat.state === "X") {
    return false;
  }
  return startTime === undefined || stat.startTime === startTime;
}
