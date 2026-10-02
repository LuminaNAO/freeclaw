#!/usr/bin/env node
// Read-only conformance check for per-agent signal-cli isolation (see ARCH.signal-isolation.md §8 and
// docs/channels/signal-isolation.md). Linux only: reads procfs and `ss -x` output.
// Exit codes: 0 PASS, 1 FAIL, 2 usage/platform error, 3 UNKNOWN, 4 PASS with waivers.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OPTS_WITH_VALUE = new Set([
  "-a",
  "--account",
  "-u",
  "--username",
  "-c",
  "--config",
  "-d",
  "--data-dir",
  "--log-file",
  "-o",
  "--output",
  "--service-environment",
  "--trust-new-identities",
  "--bus-name",
]);

const RANK = { PASS: 0, WARN: 1, WAIVED: 2, UNKNOWN: 3, FAIL: 4 };

function worst(...states) {
  return states.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "PASS");
}

function readText(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
}

/** Locate the signal-cli entry token; returns the index after it, or -1. */
function signalCliArgvStart(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "org.asamk.signal.Main") {
      return i + 1;
    }
    // argv0, or argv1 for a shell wrapper (`/bin/sh /usr/bin/signal-cli ...`).
    if (i <= 1 && path.basename(argv[i]) === "signal-cli") {
      return i + 1;
    }
  }
  return -1;
}

function readFlag(argv, i, name) {
  const tok = argv[i];
  if (tok === name) {
    const next = argv[i + 1];
    return {
      value: next !== undefined && !next.startsWith("-") ? next : undefined,
      consumed: next !== undefined && !next.startsWith("-") ? 2 : 1,
      present: true,
    };
  }
  if (tok.startsWith(`${name}=`)) {
    return { value: tok.slice(name.length + 1), consumed: 1, present: true };
  }
  return undefined;
}

export function parseSignalCliArgv(argv) {
  const start = signalCliArgvStart(argv);
  if (start < 0) {
    return undefined;
  }
  const out = {
    account: undefined,
    subcommand: undefined,
    socket: [],
    tcp: false,
    http: false,
    receiveMode: undefined,
  };
  for (let i = start; i < argv.length; ) {
    const tok = argv[i];
    if (out.subcommand === undefined) {
      const acct =
        readFlag(argv, i, "-a") ??
        readFlag(argv, i, "--account") ??
        readFlag(argv, i, "-u") ??
        readFlag(argv, i, "--username");
      if (acct) {
        out.account = acct.value;
        i += acct.consumed;
        continue;
      }
      if (tok.startsWith("-")) {
        const name = tok.split("=")[0];
        i += OPTS_WITH_VALUE.has(name) && !tok.includes("=") ? 2 : 1;
        continue;
      }
      out.subcommand = tok;
      i += 1;
      continue;
    }
    const sock = readFlag(argv, i, "--socket");
    if (sock) {
      out.socket.push(sock.value ?? "(default)");
      i += sock.consumed;
      continue;
    }
    for (const name of ["--tcp", "--http"]) {
      const f = readFlag(argv, i, name);
      if (f) {
        out[name.slice(2)] = true;
      }
    }
    const rm = readFlag(argv, i, "--receive-mode");
    if (rm) {
      out.receiveMode = rm.value;
      i += rm.consumed;
      continue;
    }
    // Some wrappers place -a after the subcommand; signal-cli itself does not, but record it.
    const acct = readFlag(argv, i, "-a") ?? readFlag(argv, i, "--account");
    if (acct && out.account === undefined) {
      out.account = acct.value;
      i += acct.consumed;
      continue;
    }
    i += 1;
  }
  return out;
}

function normalizeAccount(value) {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.startsWith("+") ? `+${trimmed.slice(1).replace(/[\s().-]/g, "")}` : trimmed;
}

function decodeTcpAddr(hex) {
  const [ip, port] = hex.split(":");
  const p = Number.parseInt(port, 16);
  if (ip.length === 8) {
    const bytes = ip
      .match(/../g)
      .map((b) => Number.parseInt(b, 16))
      .toReversed();
    return `${bytes.join(".")}:${p}`;
  }
  return `[${ip}]:${p}`;
}

const TCP_STATES = {
  "01": "ESTABLISHED",
  "02": "SYN_SENT",
  "03": "SYN_RECV",
  "04": "FIN_WAIT1",
  "05": "FIN_WAIT2",
  "06": "TIME_WAIT",
  "07": "CLOSE",
  "08": "CLOSE_WAIT",
  "09": "LAST_ACK",
  "0A": "LISTEN",
  "0B": "CLOSING",
};

/** Every TCP socket with an inode, any state: inode -> { addr, state }. */
function readTcpSockets(procRoot) {
  const sockets = new Map();
  for (const file of ["net/tcp", "net/tcp6"]) {
    const text = readText(path.join(procRoot, file));
    if (!text) {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10 || cols[9] === "0") {
        continue;
      }
      sockets.set(cols[9], { addr: decodeTcpAddr(cols[1]), state: TCP_STATES[cols[3]] ?? cols[3] });
    }
  }
  return sockets;
}

function readTcpListeners(procRoot) {
  const listeners = new Map();
  for (const file of ["net/tcp", "net/tcp6"]) {
    const text = readText(path.join(procRoot, file));
    if (!text) {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10 || cols[3] !== "0A") {
        continue;
      }
      listeners.set(cols[9], decodeTcpAddr(cols[1]));
    }
  }
  return listeners;
}

function readUnixListeners(procRoot) {
  const listeners = new Map();
  const text = readText(path.join(procRoot, "net/unix"));
  if (!text) {
    return listeners;
  }
  for (const line of text.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 7) {
      continue;
    }
    // Flags 00010000 = __SO_ACCEPTCON (listening).
    if (cols[3] !== "00010000") {
      continue;
    }
    listeners.set(cols[6], cols[7]);
  }
  return listeners;
}

function readProcesses(procRoot) {
  const procs = [];
  let entries = [];
  try {
    entries = fs.readdirSync(procRoot);
  } catch {
    return procs;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) {
      continue;
    }
    const base = path.join(procRoot, name);
    const cmdline = readText(path.join(base, "cmdline"));
    const status = readText(path.join(base, "status"));
    if (cmdline === undefined || status === undefined) {
      continue; // vanished between readdir and read
    }
    const argv = cmdline.split("\0").filter((s) => s.length > 0);
    const uidLine = status.split("\n").find((l) => l.startsWith("Uid:"));
    const uid = uidLine ? Number(uidLine.split(/\s+/)[2] ?? uidLine.split(/\s+/)[1]) : undefined;
    let fdInodes;
    let fdsReadable = true;
    try {
      fdInodes = new Set();
      for (const fd of fs.readdirSync(path.join(base, "fd"))) {
        let target;
        try {
          target = fs.readlinkSync(path.join(base, "fd", fd));
        } catch {
          continue;
        }
        const m = /^socket:\[(\d+)\]$/.exec(target);
        if (m) {
          fdInodes.add(m[1]);
        }
      }
    } catch (err) {
      if (err?.code === "ENOENT") {
        continue;
      }
      fdsReadable = false;
      fdInodes = new Set();
    }
    procs.push({ pid: Number(name), uid, argv, fdInodes, fdsReadable });
  }
  return procs;
}

/** Parse `ss -x -H` output into connections: { localPath, localInode, peerInode }. */
export function parseSsUnix(text) {
  const rows = [];
  let parsed = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    const cols = line.split(/\s+/);
    if (cols.length < 8 || !/^u_(str|seq|dgr)$/.test(cols[0])) {
      continue;
    }
    const localInode = cols[5];
    const peerInode = cols[7];
    if (!/^\d+$/.test(localInode) || !/^\d+$/.test(peerInode)) {
      continue;
    }
    parsed += 1;
    rows.push({ state: cols[1], localPath: cols[4], localInode, peerInode });
  }
  return { rows, parsed };
}

function lstatSafe(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return undefined;
  }
}

function checkSocketPath(socketPath, daemonUid, opts) {
  const reasons = [];
  const st = lstatSafe(socketPath);
  if (!st) {
    return { state: "FAIL", reasons: [`socket-missing:${socketPath}`] };
  }
  if (!st.isSocket()) {
    reasons.push(`not-a-socket:${socketPath}`);
  }
  if (st.uid !== daemonUid) {
    reasons.push(`socket-owner:${st.uid}!=${daemonUid}`);
  }
  if ((st.mode & 0o007) !== 0) {
    reasons.push(`socket-mode-other:${(st.mode & 0o777).toString(8)}`);
  }
  if ((st.mode & 0o070) !== 0) {
    if (!opts.allowGroup) {
      reasons.push(`socket-mode-group:${(st.mode & 0o777).toString(8)}`);
    } else if (opts.group !== undefined && st.gid !== opts.group) {
      reasons.push(`socket-group:${st.gid}!=${opts.group}`);
    }
  }
  const dir = path.dirname(socketPath);
  const dst = lstatSafe(dir);
  if (!dst || dst.isSymbolicLink() || !dst.isDirectory()) {
    reasons.push(`dir-not-real:${dir}`);
  } else {
    if (dst.uid !== daemonUid) {
      reasons.push(`dir-owner:${dst.uid}!=${daemonUid}`);
    }
    if ((dst.mode & 0o007) !== 0) {
      reasons.push(`dir-mode-other:${(dst.mode & 0o777).toString(8)}`);
    }
    if ((dst.mode & 0o020) !== 0) {
      reasons.push(`dir-group-write:${(dst.mode & 0o777).toString(8)}`);
    }
  }
  return { state: reasons.length > 0 ? "FAIL" : "PASS", reasons };
}

function isGatewayArgv(argv) {
  const head = argv.slice(0, 4).map((a) => path.basename(a));
  if (head[0] === "openclaw-gateway") {
    return true;
  }
  return head.some((a) => a === "openclaw" || a === "openclaw.mjs") && argv.includes("gateway");
}

function defaultSocketPaths(procRoot) {
  const out = [];
  // Only meaningful against the real host; synthetic proc roots pass explicit paths.
  if (procRoot !== "/proc") {
    return out;
  }
  try {
    for (const uid of fs.readdirSync("/run/user")) {
      const p = `/run/user/${uid}/signal-cli/socket`;
      if (lstatSafe(p)) {
        out.push(p);
      }
    }
  } catch {
    // no /run/user or unreadable
  }
  if (lstatSafe("/tmp/signal-cli/socket")) {
    out.push("/tmp/signal-cli/socket");
  }
  return out;
}

export function runCheck(options = {}) {
  const procRoot = options.procRoot ?? "/proc";
  const notes = [];
  const procs = readProcesses(procRoot);
  const tcp = readTcpListeners(procRoot);
  const tcpAll = readTcpSockets(procRoot);
  const unixListen = readUnixListeners(procRoot);
  const allowHttp = new Set(
    (options.allowHttp ?? []).map(normalizeAccount).filter((a) => typeof a === "string"),
  );
  const usedAllowHttp = new Set();

  const daemons = [];
  for (const p of procs) {
    const parsed = parseSignalCliArgv(p.argv);
    if (!parsed || parsed.subcommand !== "daemon") {
      continue;
    }
    const account = normalizeAccount(parsed.account);
    const d = {
      pid: p.pid,
      uid: p.uid,
      account,
      argv: p.argv,
      socketPaths: [],
      checks: {},
      reasons: [],
    };

    // C1: no TCP, by fds and by argv independently.
    const tcpFds = [...p.fdInodes].filter((i) => tcp.has(i)).map((i) => tcp.get(i));
    let c1 = "PASS";
    if (parsed.tcp || parsed.http) {
      c1 = "FAIL";
      d.reasons.push(`tcp-listener-argv:${parsed.http ? "--http" : "--tcp"}`);
    }
    if (tcpFds.length > 0) {
      c1 = "FAIL";
      d.reasons.push(`tcp-listener:${tcpFds.join(",")}`);
    }
    if (c1 === "PASS" && !p.fdsReadable) {
      c1 = "UNKNOWN";
      d.reasons.push("fds-unreadable");
    }
    if (c1 === "FAIL" && account && allowHttp.has(account)) {
      c1 = "WAIVED";
      usedAllowHttp.add(account);
    }
    d.checks.c1 = c1;

    // C2: socket ownership/mode, judged on the daemon's actual listening unix sockets (so a
    // socket-activated daemon with no listener flag is judged on what it holds).
    let c2;
    if (!p.fdsReadable) {
      c2 = "UNKNOWN";
    } else {
      const listening = [...p.fdInodes].filter((i) => unixListen.has(i));
      const paths = listening.map((i) => unixListen.get(i));
      const fsPaths = paths.filter((x) => x && x.startsWith("/"));
      for (const x of paths) {
        if (!x || x.startsWith("@")) {
          d.reasons.push(`abstract-or-unnamed-socket:${x ?? "(none)"}`);
        }
      }
      if (fsPaths.length === 0) {
        c2 = d.checks.c1 === "WAIVED" ? "WAIVED" : "FAIL";
        if (c2 === "FAIL") {
          d.reasons.push("no-filesystem-socket");
        }
      } else {
        c2 = paths.length !== fsPaths.length ? "FAIL" : "PASS";
        for (const sp of fsPaths) {
          d.socketPaths.push(sp);
          const r = checkSocketPath(sp, p.uid, options);
          c2 = worst(c2, r.state);
          d.reasons.push(...r.reasons);
        }
      }
    }
    for (const s of parsed.socket) {
      if (s !== "(default)" && !d.socketPaths.includes(s)) {
        d.socketPaths.push(s);
      }
    }
    d.checks.c2 = c2;

    // C4 (warning only).
    d.checks.c4 = parsed.receiveMode === "manual" ? "PASS" : "WARN";
    if (d.checks.c4 === "WARN") {
      d.reasons.push(`receive-mode-not-manual:${parsed.receiveMode ?? "on-start"}`);
    }
    daemons.push(d);
  }

  // C3: one daemon per account (+ manifest).
  const byAccount = new Map();
  for (const d of daemons) {
    d.checks.c3 = "PASS";
    if (!d.account) {
      d.checks.c3 = "FAIL";
      d.reasons.push("no-account(multi-account daemon)");
      continue;
    }
    byAccount.set(d.account, [...(byAccount.get(d.account) ?? []), d]);
  }
  for (const [acct, list] of byAccount) {
    if (list.length > 1) {
      for (const d of list) {
        d.checks.c3 = "FAIL";
        d.reasons.push(`duplicate-account:${acct}`);
      }
    }
  }
  const missing = [];
  if (options.manifest) {
    const wanted = new Map();
    for (const entry of options.manifest.agents ?? []) {
      wanted.set(normalizeAccount(entry.account), entry);
    }
    for (const [acct, entry] of wanted) {
      const list = byAccount.get(acct) ?? [];
      if (list.length === 0) {
        missing.push({
          account: acct,
          state: options.allowDown ? "WARN" : "FAIL",
          reason: "daemon-missing",
        });
      }
      for (const d of list) {
        if (entry.uid !== undefined && d.uid !== entry.uid) {
          d.checks.c3 = "FAIL";
          d.reasons.push(`wrong-uid:${d.uid}!=${entry.uid}`);
        }
      }
    }
    for (const d of daemons) {
      if (d.account && !wanted.has(d.account)) {
        d.checks.c3 = "FAIL";
        d.reasons.push("unexpected-daemon(not in manifest)");
      }
    }
  }

  // C5: host-wide relay sweep, independent of argv.
  const socketSet = new Set();
  for (const d of daemons) {
    for (const sp of d.socketPaths) {
      socketSet.add(sp);
    }
  }
  for (const entry of options.manifest?.agents ?? []) {
    if (entry.socketPath) {
      socketSet.add(entry.socketPath);
    }
  }
  for (const sp of options.extraSocketPaths ?? defaultSocketPaths(procRoot)) {
    socketSet.add(sp);
  }
  const relays = [];
  const gatewayClients = [];
  let c5 = "PASS";
  const c5Reasons = [];
  if (socketSet.size > 0) {
    let ssText = options.ssOutput;
    if (ssText === undefined && !options.noSs) {
      try {
        ssText = execFileSync("ss", ["-x", "-H"], { encoding: "utf8", timeout: 10_000 });
      } catch {
        ssText = undefined;
      }
    }
    const ss = ssText === undefined ? undefined : parseSsUnix(ssText);
    if (!ss || (ss.parsed === 0 && ssText.trim().length > 0)) {
      c5 = "UNKNOWN";
      c5Reasons.push(ss ? "ss-output-unparseable" : "ss-unavailable");
    } else {
      // Server-side accepted sockets carry the listening path; their peer is the client.
      const clientInodes = new Map();
      for (const row of ss.rows) {
        if (socketSet.has(row.localPath) && row.peerInode !== "0") {
          clientInodes.set(row.peerInode, row.localPath);
        }
      }
      const daemonUidBySocket = new Map();
      for (const d of daemons) {
        for (const sp of d.socketPaths) {
          daemonUidBySocket.set(sp, d.uid);
        }
      }
      // A relay may split its two ends across processes: a forking server keeps the TCP
      // listener in the parent while each forked child holds the unix connection (socat
      // fork), or a socket-activation manager owns the listener and hands the relay an
      // accepted (ESTABLISHED) socket. So TCP evidence counts in any state, and processes
      // that share uid and an identical argv (the signature of fork without exec) are judged
      // together. Daemons and same-uid gateways are never merged into a relay's group.
      const daemonPids = new Set(daemons.map((d) => d.pid));
      const groupKey = (p) => `${p.uid}\0${p.argv.join("\0")}`;
      const groups = new Map();
      for (const p of procs) {
        if (daemonPids.has(p.pid) || isGatewayArgv(p.argv) || p.argv.length === 0) {
          continue;
        }
        groups.set(groupKey(p), [...(groups.get(groupKey(p)) ?? []), p]);
      }
      const tcpOf = (p) =>
        [...p.fdInodes].filter((i) => tcpAll.has(i)).map((i) => ({ pid: p.pid, ...tcpAll.get(i) }));

      for (const p of procs) {
        if (!p.fdsReadable) {
          c5 = worst(c5, "UNKNOWN");
          if (!c5Reasons.includes("fds-unreadable(run as root for a full sweep)")) {
            c5Reasons.push("fds-unreadable(run as root for a full sweep)");
          }
          continue;
        }
        if (daemonPids.has(p.pid)) {
          continue;
        }
        const connected = [...p.fdInodes].filter((i) => clientInodes.has(i));
        if (connected.length === 0) {
          continue;
        }
        const socketPath = clientInodes.get(connected[0]);
        const gateway = isGatewayArgv(p.argv) && p.uid === daemonUidBySocket.get(socketPath);
        const members = gateway ? [p] : (groups.get(groupKey(p)) ?? [p]);
        const tcpEvidence = members.flatMap(tcpOf);
        if (tcpEvidence.length === 0) {
          continue;
        }
        const listen = tcpEvidence.filter((t) => t.state === "LISTEN").map((t) => t.addr);
        const record = {
          pid: p.pid,
          uid: p.uid,
          argv: p.argv,
          socketPath,
          listen,
          tcp: tcpEvidence,
          groupPids: members.map((m) => m.pid),
          kind: listen.length > 0 ? "tcp-relay" : "tcp-connected-client",
        };
        // A gateway is a legitimate socket client with its own TCP traffic. Same-uid
        // processes are inside the daemon's trust domain anyway (ARCH.signal-isolation.md §3), so spoofing the
        // argv gains nothing; it is still surfaced, never silently passed.
        if (gateway) {
          gatewayClients.push(record);
          c5 = worst(c5, "WARN");
        } else {
          relays.push(record);
          c5 = "FAIL";
        }
      }
    }
    if (c5 !== "UNKNOWN") {
      c5Reasons.push(
        "point-in-time: an idle relay with no live connection to the daemon is not visible",
      );
    }
  }

  for (const acct of allowHttp) {
    if (!usedAllowHttp.has(acct)) {
      notes.push(`allow-http-unused:${String(acct)}`);
    }
  }

  let overall = "PASS";
  for (const d of daemons) {
    overall = worst(overall, d.checks.c1, d.checks.c2, d.checks.c3, d.checks.c4);
  }
  for (const m of missing) {
    overall = worst(overall, m.state);
  }
  overall = worst(overall, c5);
  if (daemons.length === 0 && !options.manifest && relays.length === 0) {
    overall = worst(overall, "UNKNOWN");
    notes.push("nothing-to-check(no signal-cli daemons found and no manifest)");
  }
  const anyWaived = daemons.some((d) => d.checks.c1 === "WAIVED" || d.checks.c2 === "WAIVED");
  let exitCode;
  if (overall === "FAIL") {
    exitCode = 1;
  } else if (overall === "UNKNOWN") {
    exitCode = 3;
  } else if (anyWaived) {
    exitCode = 4;
    overall = "PASS_WITH_WAIVERS";
  } else {
    exitCode = 0;
  }
  return {
    overall,
    exitCode,
    daemons,
    missing,
    c5: { state: c5, reasons: c5Reasons, relays, gatewayClients, socketPaths: [...socketSet] },
    notes,
  };
}

function formatHuman(report) {
  const lines = [];
  for (const d of report.daemons) {
    lines.push(
      `daemon pid=${d.pid} uid=${d.uid} account=${d.account ?? "-"} c1=${d.checks.c1} c2=${d.checks.c2} c3=${d.checks.c3} c4=${d.checks.c4}${d.reasons.length ? ` reasons=${d.reasons.join(";")}` : ""}`,
    );
  }
  for (const m of report.missing) {
    lines.push(`account ${m.account}: ${m.state} ${m.reason}`);
  }
  lines.push(
    `c5=${report.c5.state}${report.c5.reasons.length ? ` reasons=${report.c5.reasons.join(";")}` : ""}`,
  );
  for (const r of report.c5.relays) {
    lines.push(
      `  FAIL ${r.kind} pid=${r.pid} uid=${r.uid} group=${r.groupPids.join(",")} socket=${r.socketPath} tcp=${r.tcp.map((t) => `${t.pid}:${t.state}:${t.addr}`).join(",")} argv=${r.argv.join(" ")}`,
    );
  }
  for (const g of report.c5.gatewayClients) {
    lines.push(
      `  WARN gateway-client pid=${g.pid} uid=${g.uid} socket=${g.socketPath} listen=${g.listen.join(",")}`,
    );
  }
  for (const n of report.notes) {
    lines.push(`note: ${n}`);
  }
  lines.push(`OVERALL ${report.overall} (exit ${report.exitCode})`);
  return lines.join("\n");
}

function parseArgs(argv) {
  const opts = { allowHttp: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const val = () => {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new Error(`${a} requires a value`);
      }
      i += 1;
      return v;
    };
    switch (a) {
      case "--proc":
        opts.procRoot = val();
        break;
      case "--manifest":
        opts.manifest = JSON.parse(fs.readFileSync(val(), "utf8"));
        break;
      case "--ss-output":
        opts.ssOutput = fs.readFileSync(val(), "utf8");
        break;
      case "--no-ss":
        opts.noSs = true;
        break;
      case "--socket-path":
        opts.extraSocketPaths = [...(opts.extraSocketPaths ?? []), val()];
        break;
      case "--allow-group":
        opts.allowGroup = true;
        break;
      case "--group": {
        const g = val();
        if (!/^\d+$/.test(g)) {
          throw new Error("--group takes a numeric gid");
        }
        opts.group = Number(g);
        break;
      }
      case "--allow-down":
        opts.allowDown = true;
        break;
      case "--allow-http":
        opts.allowHttp.push(val());
        break;
      case "--json":
        opts.json = true;
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      default:
        throw new Error(`unknown option ${a}`);
    }
  }
  return opts;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`signal-isolation-check: ${err.message}\n`);
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write(
      "usage: signal-isolation-check [--json] [--manifest f] [--allow-group [--group gid]] [--allow-down] [--allow-http acct]... [--proc root] [--ss-output f | --no-ss] [--socket-path p]...\n",
    );
    process.exit(0);
  }
  if (process.platform !== "linux" && !opts.procRoot) {
    process.stderr.write("signal-isolation-check: Linux only (requires procfs)\n");
    process.exit(2);
  }
  const report = runCheck(opts);
  process.stdout.write(`${opts.json ? JSON.stringify(report, null, 2) : formatHuman(report)}\n`);
  process.exit(report.exitCode);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
