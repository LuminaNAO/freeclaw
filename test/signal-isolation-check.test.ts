import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseSignalCliArgv,
  parseSsUnix,
  runCheck,
  type CheckOptions,
} from "../scripts/signal-isolation-check.mjs";

const UID = process.getuid?.() ?? 1000;
const OTHER_UID = UID + 4242;

type FakeProc = {
  pid: number;
  uid?: number;
  argv: string[];
  sockets?: string[];
  fdsUnreadable?: boolean;
};

const roots: string[] = [];
const servers: net.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    await new Promise<void>((r) => s.close(() => r()));
  }
  for (const r of roots.splice(0)) {
    restoreModes(r);
    fs.rmSync(r, { recursive: true, force: true });
  }
});

/** Undo fixture chmod 0000 on fd dirs so cleanup can descend. */
function restoreModes(dir: string): void {
  fs.chmodSync(dir, 0o700);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      restoreModes(path.join(dir, entry.name));
    }
  }
}

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sigchk-"));
  fs.chmodSync(d, 0o700);
  roots.push(d);
  return d;
}

/** A real socket file in a real directory, for C2's lstat checks. */
async function realSocket(dirMode = 0o700, sockMode = 0o600): Promise<string> {
  const dir = path.join(tmp(), "sock");
  fs.mkdirSync(dir);
  fs.chmodSync(dir, dirMode);
  const p = path.join(dir, "a.sock");
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(p, r));
  servers.push(server);
  fs.chmodSync(p, sockMode);
  return p;
}

type Fixture = {
  procs: FakeProc[];
  unixListen?: Array<{ inode: string; path: string }>;
  tcpListen?: Array<{ inode: string; addr?: string }>;
};

/** Synthetic procfs: cmdline, status, fd symlinks to socket:[inode], net/unix, net/tcp. */
function buildProc(fx: Fixture): string {
  const root = path.join(tmp(), "proc");
  fs.mkdirSync(path.join(root, "net"), { recursive: true });
  for (const p of fx.procs) {
    const base = path.join(root, String(p.pid));
    fs.mkdirSync(path.join(base, "fd"), { recursive: true });
    fs.writeFileSync(path.join(base, "cmdline"), `${p.argv.join("\0")}\0`);
    const uid = p.uid ?? UID;
    fs.writeFileSync(path.join(base, "status"), `Name:\tx\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
    (p.sockets ?? []).forEach((inode, i) => {
      fs.symlinkSync(`socket:[${inode}]`, path.join(base, "fd", String(i + 3)));
    });
    if (p.fdsUnreadable) {
      fs.chmodSync(path.join(base, "fd"), 0o000);
    }
  }
  const unix = ["Num       RefCount Protocol Flags    Type St Inode Path"];
  for (const u of fx.unixListen ?? []) {
    unix.push(`0000000000000000: 00000002 00000000 00010000 0001 01 ${u.inode} ${u.path}`);
  }
  fs.writeFileSync(path.join(root, "net/unix"), `${unix.join("\n")}\n`);
  const tcp = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
  ];
  for (const t of fx.tcpListen ?? []) {
    tcp.push(
      `   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 ${t.inode} 1 0000000000000000 100 0 0 10 0`,
    );
  }
  fs.writeFileSync(path.join(root, "net/tcp"), `${tcp.join("\n")}\n`);
  fs.writeFileSync(path.join(root, "net/tcp6"), `${tcp[0]}\n`);
  return root;
}

const daemonArgv = (sock: string, extra: string[] = []) => [
  "java",
  "-classpath",
  "/opt/signal-cli/lib/x.jar",
  "org.asamk.signal.Main",
  "-a",
  "+15550001111",
  "daemon",
  "--socket",
  sock,
  "--no-receive-stdout",
  "--receive-mode",
  "manual",
  ...extra,
];

const ssLine = (localPath: string, localInode: string, peerInode: string) =>
  `u_str ESTAB 0      0      ${localPath} ${localInode}            * ${peerInode}`;

const fdsBlockable = UID !== 0;

function check(fx: Fixture, opts: CheckOptions = {}) {
  return runCheck({ procRoot: buildProc(fx), ssOutput: "", ...opts });
}

describe("argv parsing", () => {
  it("recognizes java Main and signal-cli wrappers, not lookalikes or other subcommands", () => {
    expect(parseSignalCliArgv(daemonArgv("/s"))).toMatchObject({
      account: "+15550001111",
      subcommand: "daemon",
      socket: ["/s"],
      receiveMode: "manual",
    });
    expect(
      parseSignalCliArgv([
        "/usr/bin/signal-cli",
        "--account=+1555",
        "daemon",
        "--http=127.0.0.1:1",
      ]),
    ).toMatchObject({
      account: "+1555",
      http: true,
    });
    expect(
      parseSignalCliArgv(["/bin/sh", "/usr/bin/signal-cli", "-u", "+1555", "daemon", "--tcp"]),
    ).toMatchObject({
      tcp: true,
    });
    expect(parseSignalCliArgv(["vim", "signal-cli.log"])).toBeUndefined();
    expect(parseSignalCliArgv(["signal-cli", "-a", "+1555", "link"])?.subcommand).toBe("link");
  });

  it("parses ss -x -H rows with local and peer inodes", () => {
    const { rows, parsed } = parseSsUnix(
      `${ssLine("/s.sock", "10", "11")}\n${ssLine("*", "11", "10")}\n`,
    );
    expect(parsed).toBe(2);
    expect(rows[0]).toMatchObject({ localPath: "/s.sock", localInode: "10", peerInode: "11" });
  });
});

describe("C1-C4 per daemon", () => {
  it("clean socket daemon passes", async () => {
    const sock = await realSocket();
    const r = check({
      procs: [{ pid: 10, argv: daemonArgv(sock), sockets: ["100"] }],
      unixListen: [{ inode: "100", path: sock }],
    });
    expect(r.daemons[0].checks).toEqual({ c1: "PASS", c2: "PASS", c3: "PASS", c4: "PASS" });
    expect(r.overall).toBe("PASS");
    expect(r.exitCode).toBe(0);
  });

  it("C1 fails on a TCP listener fd and on --http/--tcp in argv", async () => {
    const sock = await realSocket();
    const viaFd = check({
      procs: [{ pid: 10, argv: daemonArgv(sock), sockets: ["100", "200"] }],
      unixListen: [{ inode: "100", path: sock }],
      tcpListen: [{ inode: "200" }],
    });
    expect(viaFd.daemons[0].checks.c1).toBe("FAIL");
    expect(viaFd.daemons[0].reasons.join()).toMatch(/tcp-listener:127\.0\.0\.1:8080/);
    const viaArgv = check({
      procs: [{ pid: 10, argv: daemonArgv(sock, ["--http", "127.0.0.1:8080"]), sockets: ["100"] }],
      unixListen: [{ inode: "100", path: sock }],
    });
    expect(viaArgv.daemons[0].checks.c1).toBe("FAIL");
    expect(viaArgv.exitCode).toBe(1);
  });

  it.skipIf(!fdsBlockable)("C1 still fails on argv when fds are unreadable", () => {
    const r = check({
      procs: [{ pid: 10, argv: daemonArgv("/x", ["--tcp"]), fdsUnreadable: true }],
    });
    expect(r.daemons[0].checks.c1).toBe("FAIL");
  });

  it.each([
    [0o700, 0o666, /socket-mode-other/],
    [0o700, 0o660, /socket-mode-group/],
    [0o755, 0o600, /dir-mode-other/],
    [0o770, 0o600, /dir-group-write/],
  ])("C2 fails for dir %o socket %o", async (dirMode, sockMode, reason) => {
    const sock = await realSocket(dirMode, sockMode);
    const r = check({
      procs: [{ pid: 10, argv: daemonArgv(sock), sockets: ["100"] }],
      unixListen: [{ inode: "100", path: sock }],
    });
    expect(r.daemons[0].checks.c2).toBe("FAIL");
    expect(r.daemons[0].reasons.join()).toMatch(reason);
  });

  it("C2 group mode passes with --allow-group (and matching --group)", async () => {
    const sock = await realSocket(0o710, 0o660);
    const fx = {
      procs: [{ pid: 10, argv: daemonArgv(sock), sockets: ["100"] }],
      unixListen: [{ inode: "100", path: sock }],
    };
    expect(check(fx, { allowGroup: true }).daemons[0].checks.c2).toBe("PASS");
    const gid = fs.statSync(sock).gid;
    expect(check(fx, { allowGroup: true, group: gid + 1 }).daemons[0].checks.c2).toBe("FAIL");
  });

  it("C2 fails on owner mismatch (fixture uid differs from file owner)", async () => {
    const sock = await realSocket();
    const r = check({
      procs: [{ pid: 10, uid: OTHER_UID, argv: daemonArgv(sock), sockets: ["100"] }],
      unixListen: [{ inode: "100", path: sock }],
    });
    expect(r.daemons[0].reasons.join()).toMatch(/socket-owner/);
  });

  it("C2 fails for an abstract socket and for no filesystem socket", () => {
    const abstract = check({
      procs: [{ pid: 10, argv: daemonArgv("/x"), sockets: ["100"] }],
      unixListen: [{ inode: "100", path: "@sig" }],
    });
    expect(abstract.daemons[0].checks.c2).toBe("FAIL");
    const none = check({ procs: [{ pid: 10, argv: daemonArgv("/x"), sockets: [] }] });
    expect(none.daemons[0].reasons).toContain("no-filesystem-socket");
  });

  it("C2 judges a socket-activated daemon (no listener flag) on the socket it holds", async () => {
    const sock = await realSocket();
    const argv = ["signal-cli", "-a", "+15550001111", "daemon", "--receive-mode", "manual"];
    const r = check({
      procs: [{ pid: 10, argv, sockets: ["100"] }],
      unixListen: [{ inode: "100", path: sock }],
    });
    expect(r.daemons[0].checks.c2).toBe("PASS");
  });

  it("C3 fails a multi-account daemon, duplicates, and manifest mismatches", async () => {
    const sock = await realSocket();
    const noAcct = ["signal-cli", "daemon", "--socket", sock, "--receive-mode", "manual"];
    expect(
      check({
        procs: [{ pid: 10, argv: noAcct, sockets: ["100"] }],
        unixListen: [{ inode: "100", path: sock }],
      }).daemons[0].checks.c3,
    ).toBe("FAIL");

    const dup = check({
      procs: [
        { pid: 10, argv: daemonArgv(sock), sockets: ["100"] },
        { pid: 11, argv: daemonArgv(sock), sockets: ["100"] },
      ],
      unixListen: [{ inode: "100", path: sock }],
    });
    expect(dup.daemons.every((d) => d.checks.c3 === "FAIL")).toBe(true);

    const fx = {
      procs: [{ pid: 10, argv: daemonArgv(sock), sockets: ["100"] }],
      unixListen: [{ inode: "100", path: sock }],
    };
    expect(
      check(fx, {
        manifest: { agents: [{ uid: OTHER_UID, account: "+15550001111" }] },
      }).daemons[0].reasons.join(),
    ).toMatch(/wrong-uid/);
    const missing = check(fx, {
      manifest: { agents: [{ account: "+15550001111" }, { account: "+15550003333" }] },
    });
    expect(missing.missing).toEqual([
      { account: "+15550003333", state: "FAIL", reason: "daemon-missing" },
    ]);
    expect(missing.exitCode).toBe(1);
    expect(
      check(fx, {
        allowDown: true,
        manifest: { agents: [{ account: "+15550001111" }, { account: "+15550003333" }] },
      }).exitCode,
    ).toBe(0);
    expect(check(fx, { manifest: { agents: [] } }).daemons[0].reasons.join()).toMatch(
      /unexpected-daemon/,
    );
  });

  it("C4 warns (exit 0) without manual receive mode, and never masks a FAIL", async () => {
    const sock = await realSocket();
    const argv = daemonArgv(sock).filter((a) => a !== "--receive-mode" && a !== "manual");
    const r = check({
      procs: [{ pid: 10, argv, sockets: ["100"] }],
      unixListen: [{ inode: "100", path: sock }],
    });
    expect(r.daemons[0].checks.c4).toBe("WARN");
    expect(r.exitCode).toBe(0);
    const both = check({
      procs: [{ pid: 10, argv: [...argv, "--tcp"], sockets: ["100"] }],
      unixListen: [{ inode: "100", path: sock }],
    });
    expect(both.exitCode).toBe(1);
  });
});

describe("outcomes and waivers", () => {
  it("nothing to check is UNKNOWN (exit 3), never PASS", () => {
    const r = check({ procs: [{ pid: 1, argv: ["init"] }] });
    expect(r.overall).toBe("UNKNOWN");
    expect(r.exitCode).toBe(3);
  });

  it.skipIf(!fdsBlockable)("unreadable daemon fds make the verdict UNKNOWN", () => {
    const r = check({
      procs: [{ pid: 10, uid: OTHER_UID, argv: daemonArgv("/x"), fdsUnreadable: true }],
    });
    expect(r.daemons[0].checks.c1).toBe("UNKNOWN");
    expect(r.exitCode).toBe(3);
  });

  it("--allow-http waives an HTTP daemon: WAIVED with a distinct exit code, not PASS", () => {
    const argv = [
      "signal-cli",
      "-a",
      "+15550001111",
      "daemon",
      "--http",
      "127.0.0.1:8080",
      "--receive-mode",
      "manual",
    ];
    const fx = { procs: [{ pid: 10, argv, sockets: ["200"] }], tcpListen: [{ inode: "200" }] };
    expect(check(fx).exitCode).toBe(1);
    const waived = check(fx, { allowHttp: ["+15550001111"] });
    expect(waived.daemons[0].checks.c1).toBe("WAIVED");
    expect(waived.overall).toBe("PASS_WITH_WAIVERS");
    expect(waived.exitCode).toBe(4);
    expect(check(fx, { allowHttp: ["+15550009999"] }).notes).toContain(
      "allow-http-unused:+15550009999",
    );
  });
});

describe("C5 host-wide relay sweep", () => {
  async function relayFixture(relay: Partial<FakeProc> & { argv: string[] }) {
    const sock = await realSocket();
    // Daemon holds listener 100 and accepted conn 101; client end is 102 (peer of 101).
    const fx: Fixture = {
      procs: [
        { pid: 10, argv: daemonArgv(sock), sockets: ["100", "101"] },
        { pid: 20, sockets: ["102", "300"], ...relay },
      ],
      unixListen: [{ inode: "100", path: sock }],
      tcpListen: [{ inode: "300" }],
    };
    const ss = `${ssLine(sock, "101", "102")}\n${ssLine("*", "102", "101")}\n`;
    return { sock, fx, ss };
  }

  it("flags a relay with NO signal-cli in its argv (socat, different uid), with pid/uid/argv", async () => {
    const argv = ["socat", "TCP-LISTEN:8080,fork", "UNIX-CONNECT:/x"];
    const { fx, ss } = await relayFixture({ argv, uid: OTHER_UID });
    const r = check(fx, { ssOutput: ss });
    expect(r.c5.state).toBe("FAIL");
    expect(r.c5.relays).toEqual([
      expect.objectContaining({ pid: 20, uid: OTHER_UID, argv, listen: ["127.0.0.1:8080"] }),
    ]);
    expect(r.exitCode).toBe(1);
  });

  it("flags a node shim-shaped relay", async () => {
    const { fx, ss } = await relayFixture({ argv: ["node", "scripts/shim.mjs"] });
    expect(check(fx, { ssOutput: ss }).c5.relays).toHaveLength(1);
  });

  it("a socket client without a TCP listener is not a relay", async () => {
    const { fx, ss } = await relayFixture({ argv: ["node", "client.mjs"], sockets: ["102"] });
    expect(check(fx, { ssOutput: ss }).c5.state).toBe("PASS");
  });

  it("a TCP listener not connected to any signal socket is not a relay", async () => {
    const { fx } = await relayFixture({ argv: ["nginx"] });
    expect(check(fx, { ssOutput: "" }).c5.state).toBe("PASS");
  });

  it("a same-uid gateway client with its own port is WARN (surfaced), not FAIL", async () => {
    const { fx, ss } = await relayFixture({ argv: ["openclaw-gateway"] });
    const r = check(fx, { ssOutput: ss });
    expect(r.c5.state).toBe("WARN");
    expect(r.c5.gatewayClients).toHaveLength(1);
    expect(r.exitCode).toBe(0);
  });

  it("a gateway-named process under another uid is still a relay", async () => {
    const { fx, ss } = await relayFixture({ argv: ["openclaw-gateway"], uid: OTHER_UID });
    expect(check(fx, { ssOutput: ss }).c5.state).toBe("FAIL");
  });

  it("flags a forking relay split across processes (parent LISTEN, child unix client)", async () => {
    const sock = await realSocket();
    const argv = ["socat", "TCP-LISTEN:8080,fork", "UNIX-CONNECT:/x"];
    const fx: Fixture = {
      procs: [
        { pid: 10, argv: daemonArgv(sock), sockets: ["100", "101"] },
        { pid: 20, argv, sockets: ["300"] },
        { pid: 21, argv, sockets: ["102"] },
      ],
      unixListen: [{ inode: "100", path: sock }],
      tcpListen: [{ inode: "300" }],
    };
    const r = check(fx, { ssOutput: `${ssLine(sock, "101", "102")}\n` });
    expect(r.c5.state).toBe("FAIL");
    expect(r.c5.relays[0]).toMatchObject({ pid: 21, kind: "tcp-relay", groupPids: [20, 21] });
    expect(r.exitCode).toBe(1);
  });

  it("flags a relay whose TCP side is an accepted ESTABLISHED socket (listener owned elsewhere)", async () => {
    const sock = await realSocket();
    const procRoot = buildProc({
      procs: [
        { pid: 10, argv: daemonArgv(sock), sockets: ["100", "101"] },
        { pid: 1, argv: ["systemd"], sockets: ["300"] },
        { pid: 30, argv: ["node", "shim.mjs"], sockets: ["102", "301"] },
      ],
      unixListen: [{ inode: "100", path: sock }],
      tcpListen: [{ inode: "300" }],
    });
    fs.appendFileSync(
      path.join(procRoot, "net/tcp"),
      "   1: 0100007F:1F90 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 301 1 0000000000000000 100 0 0 10 0\n",
    );
    const r = runCheck({ procRoot, ssOutput: `${ssLine(sock, "101", "102")}\n` });
    expect(r.c5.state).toBe("FAIL");
    expect(r.c5.relays[0]).toMatchObject({ pid: 30, kind: "tcp-connected-client" });
  });

  it("does not group unrelated processes that only share a uid", async () => {
    const sock = await realSocket();
    const fx: Fixture = {
      procs: [
        { pid: 10, argv: daemonArgv(sock), sockets: ["100", "101"] },
        { pid: 20, argv: ["node", "client.mjs"], sockets: ["102"] },
        { pid: 21, argv: ["nginx"], sockets: ["300"] },
      ],
      unixListen: [{ inode: "100", path: sock }],
      tcpListen: [{ inode: "300" }],
    };
    expect(check(fx, { ssOutput: `${ssLine(sock, "101", "102")}\n` }).c5.state).toBe("PASS");
  });

  it("evaluates a default-path socket even with no visible daemon", async () => {
    const sock = await realSocket();
    const fx: Fixture = {
      procs: [{ pid: 20, argv: ["socat", "TCP-LISTEN:1"], sockets: ["102", "300"] }],
      tcpListen: [{ inode: "300" }],
    };
    const r = check(fx, { extraSocketPaths: [sock], ssOutput: `${ssLine(sock, "101", "102")}\n` });
    expect(r.c5.state).toBe("FAIL");
    expect(r.exitCode).toBe(1);
  });

  it("missing or unparseable ss output is UNKNOWN, never PASS", async () => {
    const { fx } = await relayFixture({ argv: ["socat"] });
    expect(check(fx, { ssOutput: undefined, noSs: true }).c5.state).toBe("UNKNOWN");
    expect(check(fx, { ssOutput: "garbage that is not ss output\n" }).c5.state).toBe("UNKNOWN");
  });

  it.skipIf(!fdsBlockable)("a relay whose fds are unreadable makes C5 UNKNOWN", async () => {
    const { fx, ss } = await relayFixture({ argv: ["socat"], uid: OTHER_UID, fdsUnreadable: true });
    const r = check(fx, { ssOutput: ss });
    expect(r.c5.state).toBe("UNKNOWN");
    expect(r.exitCode).toBe(3);
  });
});

describe("read-only guarantee", () => {
  it("does not modify the proc tree or the socket", async () => {
    const sock = await realSocket();
    const procRoot = buildProc({
      procs: [{ pid: 10, argv: daemonArgv(sock), sockets: ["100"] }],
      unixListen: [{ inode: "100", path: sock }],
    });
    const before = fs.lstatSync(sock);
    const snap = fs.readFileSync(path.join(procRoot, "net/unix"), "utf8");
    runCheck({ procRoot, ssOutput: "" });
    const after = fs.lstatSync(sock);
    expect(after.mode).toBe(before.mode);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(fs.readFileSync(path.join(procRoot, "net/unix"), "utf8")).toBe(snap);
  });
});
