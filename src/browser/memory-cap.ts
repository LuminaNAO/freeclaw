import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * How the memory cap of a launched browser is enforced (ARCH §2.2):
 * - "kernel": the browser runs inside a systemd user scope with MemoryMax, so the kernel
 *   enforces the cap for the whole process tree.
 * - "soft": no kernel cap is available; only the watchdog (§2.4) enforces it.
 * - "off": `browser.memoryLimitMb` is 0; no cap and no watchdog.
 */
export type BrowserMemoryCapMode = "kernel" | "soft" | "off";

export type BrowserMemoryCap = {
  mode: BrowserMemoryCapMode;
  /** Cap in MiB; 0 when mode is "off". */
  limitMb: number;
};

export type BrowserLaunchCommand = {
  command: string;
  args: string[];
  memoryCap: BrowserMemoryCap;
};

type SystemdProbe = (platform: NodeJS.Platform) => boolean;

let cachedSystemdScopeSupport: boolean | undefined;

function findOnPath(binary: string, envPath = process.env.PATH ?? ""): string | null {
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, binary);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

/**
 * True when this host can run `systemd-run --user --scope`: Linux, `systemd-run` on PATH, and a
 * reachable systemd user manager. The result is cached for the life of the process.
 */
export function isSystemdUserScopeAvailable(platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "linux") {
    return false;
  }
  if (cachedSystemdScopeSupport !== undefined) {
    return cachedSystemdScopeSupport;
  }
  let available = false;
  try {
    if (findOnPath("systemd-run")) {
      const probe = spawnSync("systemctl", ["--user", "show", "--property=Version", "--value"], {
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      available = probe.status === 0 && (probe.stdout ?? "").trim().length > 0;
    }
  } catch {
    available = false;
  }
  cachedSystemdScopeSupport = available;
  return available;
}

export function resetSystemdScopeProbeForTests(value?: boolean): void {
  cachedSystemdScopeSupport = value;
}

/**
 * Build the command used to launch a managed browser (ARCH §2.1-§2.2).
 *
 * With a cap and a systemd user manager the browser is wrapped in
 * `systemd-run --user --scope -p MemoryMax=<n>M -p MemorySwapMax=0 --`, so the kernel enforces the
 * limit for every browser process. `systemd-run --scope` execs the browser in place, so the
 * spawned pid is still the browser's. Otherwise the browser is spawned directly.
 */
export function buildBrowserLaunchCommand(params: {
  executablePath: string;
  args: string[];
  memoryLimitMb: number;
  platform?: NodeJS.Platform;
  systemdAvailable?: SystemdProbe;
}): BrowserLaunchCommand {
  const platform = params.platform ?? process.platform;
  const limitMb =
    Number.isFinite(params.memoryLimitMb) && params.memoryLimitMb > 0
      ? Math.floor(params.memoryLimitMb)
      : 0;
  if (limitMb === 0) {
    return {
      command: params.executablePath,
      args: [...params.args],
      memoryCap: { mode: "off", limitMb: 0 },
    };
  }
  const probe = params.systemdAvailable ?? isSystemdUserScopeAvailable;
  if (probe(platform)) {
    return {
      command: "systemd-run",
      args: [
        "--user",
        "--scope",
        "--quiet",
        "--collect",
        "-p",
        `MemoryMax=${limitMb}M`,
        "-p",
        "MemorySwapMax=0",
        "--",
        params.executablePath,
        ...params.args,
      ],
      memoryCap: { mode: "kernel", limitMb },
    };
  }
  return {
    command: params.executablePath,
    args: [...params.args],
    memoryCap: { mode: "soft", limitMb },
  };
}

/** The cap mode a launch would get right now, for status when no browser is running. */
export function resolveBrowserMemoryCapMode(
  memoryLimitMb: number,
  platform: NodeJS.Platform = process.platform,
  systemdAvailable: SystemdProbe = isSystemdUserScopeAvailable,
): BrowserMemoryCapMode {
  if (!(memoryLimitMb > 0)) {
    return "off";
  }
  return systemdAvailable(platform) ? "kernel" : "soft";
}

type ProcEntry = { pid: number; ppid: number };

function readLinuxProcEntries(procRoot: string): ProcEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(procRoot);
  } catch {
    return [];
  }
  const entries: ProcEntry[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) {
      continue;
    }
    try {
      const stat = fs.readFileSync(path.join(procRoot, name, "stat"), "utf8");
      // comm (field 2) may contain spaces/parens; fields after the last ")" are fixed.
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ppid = Number.parseInt(rest[1] ?? "", 10);
      if (Number.isFinite(ppid)) {
        entries.push({ pid: Number.parseInt(name, 10), ppid });
      }
    } catch {
      // process exited while scanning
    }
  }
  return entries;
}

function collectTree(rootPid: number, entries: ProcEntry[]): number[] {
  const children = new Map<number, number[]>();
  for (const entry of entries) {
    const list = children.get(entry.ppid);
    if (list) {
      list.push(entry.pid);
    } else {
      children.set(entry.ppid, [entry.pid]);
    }
  }
  const out: number[] = [];
  const seen = new Set<number>();
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    if (seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    out.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return out;
}

function readLinuxVmRssBytes(procRoot: string, pid: number): number | null {
  try {
    const status = fs.readFileSync(path.join(procRoot, String(pid), "status"), "utf8");
    const match = /^VmRSS:\s+(\d+)\s*kB/m.exec(status);
    return match ? Number.parseInt(match[1], 10) * 1024 : 0;
  } catch {
    return null;
  }
}

/**
 * Sum the resident set size of a process and all its descendants, in bytes (Linux, via /proc).
 * Returns null when the root process does not exist.
 */
export function measureLinuxProcessTreeRssBytes(
  rootPid: number,
  procRoot = "/proc",
): number | null {
  const rootRss = readLinuxVmRssBytes(procRoot, rootPid);
  if (rootRss === null) {
    return null;
  }
  const pids = collectTree(rootPid, readLinuxProcEntries(procRoot));
  let total = 0;
  for (const pid of pids) {
    total += pid === rootPid ? rootRss : (readLinuxVmRssBytes(procRoot, pid) ?? 0);
  }
  return total;
}

/** Parse `ps -A -o pid=,ppid=,rss=` output (rss in KiB) and sum the tree under rootPid. */
export function sumPsTreeRssBytes(rootPid: number, psOutput: string): number | null {
  const rows: Array<ProcEntry & { rssKb: number }> = [];
  for (const line of psOutput.split("\n")) {
    const [pid, ppid, rss] = line
      .trim()
      .split(/\s+/)
      .map((v) => Number.parseInt(v, 10));
    if (Number.isFinite(pid) && Number.isFinite(ppid) && Number.isFinite(rss)) {
      rows.push({ pid, ppid, rssKb: rss });
    }
  }
  if (!rows.some((row) => row.pid === rootPid)) {
    return null;
  }
  const rssByPid = new Map(rows.map((row) => [row.pid, row.rssKb]));
  return collectTree(rootPid, rows).reduce((sum, pid) => sum + (rssByPid.get(pid) ?? 0) * 1024, 0);
}

/**
 * RSS of a browser's whole process tree in bytes, or null when it cannot be measured
 * (process gone, or a platform without /proc or ps).
 */
export async function measureBrowserTreeRssBytes(
  rootPid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<number | null> {
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    return null;
  }
  if (platform === "linux") {
    return measureLinuxProcessTreeRssBytes(rootPid);
  }
  if (platform === "win32") {
    return null;
  }
  return await new Promise<number | null>((resolve) => {
    execFile(
      "ps",
      ["-A", "-o", "pid=,ppid=,rss="],
      { timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        resolve(sumPsTreeRssBytes(rootPid, stdout));
      },
    );
  });
}

export function bytesToMb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

/** Memory cap / usage of one browser profile, for `openclaw status` and `browser status` (ARCH §2.5). */
export type BrowserMemoryStatus = {
  /** "external": a browser freeclaw did not launch; never capped or touched (ARCH §2.6). */
  scope: "managed" | "external";
  capMode: BrowserMemoryCapMode | "none";
  capMb: number | null;
  kernelEnforced: boolean;
  rssMb: number | null;
  tabCount: number | null;
};

export function formatBrowserMemoryStatus(status: BrowserMemoryStatus): string {
  if (status.scope === "external") {
    return "external, not capped";
  }
  const tabs =
    status.tabCount === null
      ? "tabs ?"
      : `${status.tabCount} tab${status.tabCount === 1 ? "" : "s"}`;
  const rss = status.rssMb === null ? "rss ?" : `rss ${status.rssMb} MiB`;
  if (status.capMode === "off" || status.capMode === "none" || status.capMb === null) {
    return `${rss} · no cap · ${tabs}`;
  }
  const enforcement = status.kernelEnforced ? "kernel-enforced" : "soft (watchdog only)";
  return `${rss} / ${status.capMb} MiB cap (${enforcement}) · ${tabs}`;
}

/**
 * One-line summary of every profile's memory status for `openclaw status` (ARCH §2.5).
 * Running managed browsers show RSS / cap / tabs / enforcement; running external browsers show
 * "external, not capped"; when nothing runs, the cap that the next launch would get is shown.
 */
export function formatBrowserMemoryReport(report: {
  memoryLimitMb: number;
  profiles: Array<BrowserMemoryStatus & { name: string; running: boolean }>;
}): string {
  const running = report.profiles.filter((p) => p.running);
  if (running.length === 0) {
    const managed = report.profiles.find((p) => p.scope === "managed");
    if (!managed || managed.capMode === "off" || managed.capMode === "none") {
      return "not running · no cap";
    }
    const enforcement = managed.kernelEnforced ? "kernel-enforced" : "soft (watchdog only)";
    return `not running · cap ${managed.capMb ?? report.memoryLimitMb} MiB (${enforcement})`;
  }
  return running.map((p) => `${p.name}: ${formatBrowserMemoryStatus(p)}`).join(" · ");
}
