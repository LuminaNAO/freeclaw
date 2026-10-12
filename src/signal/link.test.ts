import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compareVersions,
  isSignalCliVersionBelowMinimum,
  listLocalSignalAccounts,
  MIN_SIGNAL_CLI_VERSION,
  parseLinkedNumber,
  parseLinkUriLine,
  parseSignalCliVersion,
  redactLinkUri,
  resolveSignalLinkTarget,
  runSignalLink,
  SIGNAL_LINK_CONFIG_DIR_ENV,
  SIGNAL_LINK_MAX_ATTEMPTS,
  type SignalLinkResolution,
} from "./link.js";

const FAKE_URI =
  "sgnl://linkdevice?uuid=fakeuuid-0000-0000-0000-000000000000&pub_key=BfAkEfAkEfAkEfAkEfAkEfAkEfAkEfAkEfAkEfAkEfA";

const roots: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "siglink-test-"));
  fs.chmodSync(dir, 0o700);
  roots.push(dir);
  return dir;
}
afterEach(() => {
  while (roots.length) {
    const dir = roots.pop() as string;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

function makeFakeCli(dir: string, scriptBody: string): string {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const cli = path.join(bin, "signal-cli");
  fs.writeFileSync(cli, `#!/usr/bin/env bash\nset -u\n${scriptBody}\n`, { mode: 0o755 });
  return cli;
}

/** Fake that behaves: version ok, link emits URI then succeeds, listDevices ok. */
const HAPPY_SCRIPT = `
case "$1" in
  --version) echo "signal-cli 99.99.99-test"; exit 0;;
esac
args="$*"
if [[ "$args" == *" link "* ]]; then
  echo "INFO  some noise before the URI"
  echo "${FAKE_URI}"
  echo "Associated with: +15550001234"
  exit 0
fi
if [[ "$args" == *"listDevices"* ]]; then
  echo "devices"; exit 0
fi
if [[ "$args" == *"receive"* ]]; then
  exit 0
fi
exit 0
`;

function baseResolution(overrides: Partial<SignalLinkResolution>): SignalLinkResolution {
  return {
    accountId: "default",
    cliPath: "signal-cli",
    configDir: "/nonexistent",
    deviceName: "openclaw",
    configAccountPath: "channels.signal.account",
    ...overrides,
  };
}

function captureOutput() {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    output: { log: (l: string) => lines.push(l), error: (l: string) => errors.push(l) },
    all: () => [...lines, ...errors].join("\n"),
  };
}

describe("parseLinkUriLine", () => {
  it("accepts a strict sgnl:// linkdevice line", () => {
    expect(parseLinkUriLine(`  ${FAKE_URI}  `)).toBe(FAKE_URI);
  });
  it("ignores noise and non-linkdevice URIs", () => {
    expect(parseLinkUriLine("INFO linking...")).toBeNull();
    expect(parseLinkUriLine("sgnl://other?x=1")).toBeNull();
    expect(parseLinkUriLine(`prefix ${FAKE_URI}`)).toBeNull();
  });
  it("rejects malformed URIs with whitespace", () => {
    expect(parseLinkUriLine(`${FAKE_URI} extra`)).toBeNull();
    expect(parseLinkUriLine(`sgnl://linkdevice?uuid=a b`)).toBeNull();
  });
});

describe("parseLinkedNumber", () => {
  it("extracts an E.164 number from success lines", () => {
    expect(parseLinkedNumber("Associated with: +15550001234")).toBe("+15550001234");
    expect(parseLinkedNumber("no number here")).toBeNull();
  });
});

describe("redactLinkUri", () => {
  it("removes sgnl:// URIs from text", () => {
    expect(redactLinkUri(`see ${FAKE_URI} now`)).not.toContain("sgnl://linkdevice");
  });
});

describe("resolveSignalLinkTarget", () => {
  it("resolves cliPath and default device name from config", () => {
    const res = resolveSignalLinkTarget({
      cfg: {
        channels: { signal: { cliPath: "/opt/bin/signal-cli" } },
        gateway: { instanceName: "my-gateway" },
      } as never,
      accountId: undefined,
    });
    expect(res.cliPath).toBe("/opt/bin/signal-cli");
    expect(res.deviceName).toBe("my-gateway");
    expect(res.configAccountPath).toBe("channels.signal.account");
    expect(res.configDir).toContain(path.join(".local", "share", "signal-cli"));
  });
  it("uses accounts.<id>.account path for named accounts and falls back to 'openclaw'", () => {
    const res = resolveSignalLinkTarget({
      cfg: {
        channels: { signal: { accounts: { work: { cliPath: "sigx" } } } },
      } as never,
      accountId: "work",
    });
    expect(res.cliPath).toBe("sigx");
    expect(res.deviceName).toBe("openclaw");
    expect(res.configAccountPath).toBe("channels.signal.accounts.work.account");
  });
});

describe("listLocalSignalAccounts", () => {
  it("finds account dirs and accounts.json entries", () => {
    const dir = tmpRoot();
    fs.mkdirSync(path.join(dir, "data", "+15550001111"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "data", "accounts.json"),
      JSON.stringify({ accounts: [{ number: "+15550002222" }] }),
    );
    expect(listLocalSignalAccounts(dir).toSorted()).toEqual(["+15550001111", "+15550002222"]);
  });
  it("returns empty for a missing dir", () => {
    expect(listLocalSignalAccounts(path.join(tmpRoot(), "nope"))).toEqual([]);
  });
});

describe("runSignalLink", () => {
  async function runHappy(opts?: {
    extra?: Partial<Parameters<typeof runSignalLink>[0]>;
    configDir?: string;
  }) {
    const root = opts?.configDir ?? tmpRoot();
    const cli = makeFakeCli(root, HAPPY_SCRIPT.replaceAll("${FAKE_URI}", FAKE_URI));
    const configDir = path.join(root, "sigcfg");
    const cap = captureOutput();
    const qr: string[] = [];
    const pngs: string[] = [];
    const result = await runSignalLink({
      resolution: baseResolution({ cliPath: cli, configDir }),
      output: cap.output,
      renderTerminalQr: (uri) => qr.push(uri),
      writePng: async (uri, p) => {
        pngs.push(uri);
        fs.writeFileSync(p, "PNG", { mode: 0o600 });
      },
      pngPath: opts?.extra?.pngPath ?? path.join(root, "qr.png"),
      confirm: async () => false,
      ...opts?.extra,
    });
    return { result, cap, qr, pngs, configDir };
  }

  it("links happy-path, renders QR to terminal and PNG, and never leaks the URI", async () => {
    const { result, cap, qr, pngs } = await runHappy();
    expect(result.ok).toBe(true);
    expect(result.number).toBe("+15550001234");
    expect(result.signalCliVersion).toContain("signal-cli 99.99.99-test");
    expect(qr).toEqual([FAKE_URI]);
    expect(pngs).toEqual([FAKE_URI]);
    expect(cap.all()).not.toContain("sgnl://");
    expect(cap.all()).toContain("Scan with Signal on the phone");
  });

  it("writes the PNG with mode 0600", async () => {
    const root = tmpRoot();
    const cli = makeFakeCli(root, HAPPY_SCRIPT.replaceAll("${FAKE_URI}", FAKE_URI));
    const configDir = path.join(root, "sigcfg");
    const pngPath = path.join(root, "qr.png");
    const cap = captureOutput();
    const result = await runSignalLink({
      resolution: baseResolution({ cliPath: cli, configDir }),
      pngPath,
      output: cap.output,
      renderTerminalQr: () => {},
      writePng: async (uri, p) => {
        fs.writeFileSync(p, `PNG:${uri.length}`, { mode: 0o600 });
      },
    });
    expect(result.ok).toBe(true);
    const stat = fs.statSync(pngPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("renews an expired QR up to 3 times and then fails", async () => {
    const root = tmpRoot();
    const script = `
case "$1" in
  --version) echo "signal-cli 99.99.99-test"; exit 0;;
esac
args="$*"
if [[ "$args" == *" link "* ]]; then
  echo "${FAKE_URI}"
  echo "ERROR: Link request expired"
  exit 1
fi
exit 0
`.replaceAll("${FAKE_URI}", FAKE_URI);
    const cli = makeFakeCli(root, script);
    const cap = captureOutput();
    let qrs = 0;
    const result = await runSignalLink({
      resolution: baseResolution({ cliPath: cli, configDir: path.join(root, "sigcfg") }),
      output: cap.output,
      renderTerminalQr: () => {
        qrs += 1;
      },
    });
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(SIGNAL_LINK_MAX_ATTEMPTS);
    expect(result.error).toContain("expired");
    expect(qrs).toBe(SIGNAL_LINK_MAX_ATTEMPTS);
    expect(cap.all()).toContain("QR expired, new QR shown");
    expect(cap.all()).not.toContain("sgnl://");
  });

  it("succeeds on a renewed QR after an expiry", async () => {
    const root = tmpRoot();
    const counterFile = path.join(root, "count");
    const script = `
case "$1" in
  --version) echo "signal-cli 99.99.99-test"; exit 0;;
esac
args="$*"
if [[ "$args" == *" link "* ]]; then
  n=$(cat "${counterFile}" 2>/dev/null || echo 0)
  n=$((n+1)); echo "$n" > "${counterFile}"
  echo "${FAKE_URI}"
  if [[ "$n" -lt 2 ]]; then
    echo "ERROR: Link request expired"
    exit 1
  fi
  echo "Associated with: +15550001234"
  exit 0
fi
if [[ "$args" == *"listDevices"* ]]; then echo ok; exit 0; fi
exit 0
`
      .replaceAll("${counterFile}", counterFile)
      .replaceAll("${FAKE_URI}", FAKE_URI);
    const cli = makeFakeCli(root, script);
    const cap = captureOutput();
    const result = await runSignalLink({
      resolution: baseResolution({ cliPath: cli, configDir: path.join(root, "sigcfg") }),
      output: cap.output,
      renderTerminalQr: () => {},
    });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(cap.all()).toContain("QR expired, new QR shown");
  });

  it("times out and kills the child", async () => {
    const root = tmpRoot();
    const script = `
case "$1" in
  --version) echo "signal-cli 99.99.99-test"; exit 0;;
esac
args="$*"
if [[ "$args" == *" link "* ]]; then
  echo "${FAKE_URI}"
  exec sleep 30
fi
exit 0
`.replaceAll("${FAKE_URI}", FAKE_URI);
    const cli = makeFakeCli(root, script);
    const cap = captureOutput();
    const started = Date.now();
    const result = await runSignalLink({
      resolution: baseResolution({ cliPath: cli, configDir: path.join(root, "sigcfg") }),
      output: cap.output,
      renderTerminalQr: () => {},
      timeoutMs: 500,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Timed out");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("refuses config write and stops on number mismatch", async () => {
    const root = tmpRoot();
    const cli = makeFakeCli(root, HAPPY_SCRIPT.replaceAll("${FAKE_URI}", FAKE_URI));
    const cap = captureOutput();
    let wrote = 0;
    const result = await runSignalLink({
      resolution: baseResolution({
        cliPath: cli,
        configDir: path.join(root, "sigcfg"),
        expectedNumber: "+15550009999",
      }),
      output: cap.output,
      renderTerminalQr: () => {},
      writeConfig: true,
      writeConfigFn: async () => {
        wrote += 1;
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("does not match");
    expect(wrote).toBe(0);
    expect(cap.all()).not.toContain("sgnl://");
  });

  it("stops when --number already has a local account and --relink is not given", async () => {
    const root = tmpRoot();
    const configDir = path.join(root, "sigcfg");
    fs.mkdirSync(path.join(configDir, "data", "+15550001234"), { recursive: true });
    const { result } = await runHappy({
      configDir: root,
      extra: {
        resolution: baseResolution({
          cliPath: makeFakeCli(root, HAPPY_SCRIPT.replaceAll("${FAKE_URI}", FAKE_URI)),
          configDir,
          expectedNumber: "+15550001234",
        }),
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("already has an account");
    expect(result.error).toContain("--relink");
  });

  it("--relink removes only that account's local data after confirmation", async () => {
    const root = tmpRoot();
    const configDir = path.join(root, "sigcfg");
    fs.mkdirSync(path.join(configDir, "data", "+15550001234"), { recursive: true });
    fs.mkdirSync(path.join(configDir, "data", "+15550007777"), { recursive: true });
    const cli = makeFakeCli(root, HAPPY_SCRIPT.replaceAll("${FAKE_URI}", FAKE_URI));
    const cap = captureOutput();
    const result = await runSignalLink({
      resolution: baseResolution({
        cliPath: cli,
        configDir,
        expectedNumber: "+15550001234",
      }),
      output: cap.output,
      renderTerminalQr: () => {},
      relink: true,
      confirmedRelink: true,
    });
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(configDir, "data", "+15550001234"))).toBe(false);
    expect(fs.existsSync(path.join(configDir, "data", "+15550007777"))).toBe(true);
  });

  it("--relink declines without confirmation and keeps data", async () => {
    const root = tmpRoot();
    const configDir = path.join(root, "sigcfg");
    fs.mkdirSync(path.join(configDir, "data", "+15550001234"), { recursive: true });
    const cli = makeFakeCli(root, HAPPY_SCRIPT.replaceAll("${FAKE_URI}", FAKE_URI));
    const cap = captureOutput();
    const result = await runSignalLink({
      resolution: baseResolution({
        cliPath: cli,
        configDir,
        expectedNumber: "+15550001234",
      }),
      output: cap.output,
      renderTerminalQr: () => {},
      relink: true,
      confirm: async () => false,
    });
    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(configDir, "data", "+15550001234"))).toBe(true);
  });

  it("stops when a process is holding the config dir", async () => {
    const root = tmpRoot();
    const configDir = path.join(root, "sigcfg");
    fs.mkdirSync(configDir, { recursive: true });
    // Open a file inside the config dir from a separate process.
    const { spawn } = await import("node:child_process");
    const opener = spawn(
      process.execPath,
      [
        "-e",
        `const fs=require("fs");fs.closeSync(fs.openSync(${JSON.stringify(path.join(configDir, "held.txt"))},"w"));fs.openSync(${JSON.stringify(path.join(configDir, "held.txt"))},"r");setTimeout(()=>{},30000)`,
      ],
      { stdio: "ignore" },
    );
    try {
      await new Promise((r) => setTimeout(r, 400));
      const cli = makeFakeCli(root, HAPPY_SCRIPT.replaceAll("${FAKE_URI}", FAKE_URI));
      const cap = captureOutput();
      const result = await runSignalLink({
        resolution: baseResolution({ cliPath: cli, configDir }),
        output: cap.output,
        renderTerminalQr: () => {},
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("holding");
      expect(result.error).toContain("Stop the gateway / daemon for this account first");
    } finally {
      opener.kill("SIGKILL");
    }
  });

  it("prints one JSON object with --json and never the URI", async () => {
    const { result, cap } = await runHappy({ extra: { json: true } });
    expect(result.ok).toBe(true);
    const jsonLine = cap.lines.find((l) => l.startsWith("{"));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!);
    expect(parsed).toMatchObject({
      ok: true,
      number: "+15550001234",
      device: "openclaw",
      configWritten: false,
    });
    expect(jsonLine).not.toContain("sgnl://");
  });

  it("writes the config through the injected writer when writeConfig is set", async () => {
    const writes: Array<{ configAccountPath: string; number: string }> = [];
    const { result, cap } = await runHappy({
      extra: {
        writeConfig: true,
        writeConfigFn: async (w) => {
          writes.push(w);
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(result.configWritten).toBe(true);
    expect(writes).toEqual([
      { configAccountPath: "channels.signal.account", number: "+15550001234" },
    ]);
    expect(cap.all()).toContain("restart the gateway, then send a test message");
  });

  it("honors the config-dir env override and warns about it", async () => {
    const root = tmpRoot();
    const overrideDir = path.join(root, "throwaway-signal-cli");
    vi.stubEnv(SIGNAL_LINK_CONFIG_DIR_ENV, overrideDir);
    const res = resolveSignalLinkTarget({ cfg: {} as never, env: process.env });
    expect(res.configDir).toBe(overrideDir);
    const cli = makeFakeCli(root, HAPPY_SCRIPT.replaceAll("${FAKE_URI}", FAKE_URI));
    const cap = captureOutput();
    const result = await runSignalLink({
      resolution: { ...res, cliPath: cli },
      output: cap.output,
      renderTerminalQr: () => {},
    });
    expect(result.ok).toBe(true);
    expect(cap.all()).toContain("WARNING");
    expect(cap.all()).toContain(overrideDir);
  });

  it("uses XDG_DATA_HOME when set", () => {
    vi.stubEnv("XDG_DATA_HOME", "/tmp/xdg-test");
    vi.stubEnv(SIGNAL_LINK_CONFIG_DIR_ENV, "");
    const res = resolveSignalLinkTarget({ cfg: {} as never, env: process.env });
    expect(res.configDir).toBe(path.join("/tmp/xdg-test", "signal-cli"));
  });

  it("writes the PNG and fires onQr within 1 s of the sgnl:// line (speed requirement)", async () => {
    const root = tmpRoot();
    const stampFile = path.join(root, "uri-ts");
    const script = `
case "$1" in
  --version) echo "signal-cli 99.99.99-test"; exit 0;;
esac
args="$*"
if [[ "$args" == *" link "* ]]; then
  date +%s%N > "${stampFile}"
  echo "${FAKE_URI}"
  sleep 2
  echo "Associated with: +15550001234"
  exit 0
fi
if [[ "$args" == *"listDevices"* ]]; then echo ok; exit 0; fi
exit 0
`
      .replaceAll("${stampFile}", stampFile)
      .replaceAll("${FAKE_URI}", FAKE_URI);
    const cli = makeFakeCli(root, script);
    const pngPath = path.join(root, "qr.png");
    let pngAt = 0;
    const onQrCalls: string[] = [];
    const cap = captureOutput();
    const result = await runSignalLink({
      resolution: baseResolution({ cliPath: cli, configDir: path.join(root, "sigcfg") }),
      pngPath,
      output: cap.output,
      renderTerminalQr: () => {},
      writePng: async () => {
        fs.writeFileSync(pngPath, "PNG", { mode: 0o600 });
        pngAt = Date.now();
      },
      onQr: (p) => {
        onQrCalls.push(p);
      },
    });
    expect(result.ok).toBe(true);
    const uriAt = Number(fs.readFileSync(stampFile, "utf8").trim()) / 1e6;
    expect(pngAt).toBeGreaterThan(0);
    expect(pngAt - uriAt).toBeLessThan(1000);
    expect(onQrCalls).toEqual([pngPath]);
    // onQr receives only the PNG path; never the URI.
    expect(onQrCalls.join(" ")).not.toContain("sgnl://");
    expect(cap.all()).not.toContain("sgnl://");
  });

  it("fires onQr again after each auto-renew, with only the PNG path", async () => {
    const root = tmpRoot();
    const counterFile = path.join(root, "count");
    const script = `
case "$1" in
  --version) echo "signal-cli 99.99.99-test"; exit 0;;
esac
args="$*"
if [[ "$args" == *" link "* ]]; then
  n=$(cat "${counterFile}" 2>/dev/null || echo 0)
  n=$((n+1)); echo "$n" > "${counterFile}"
  echo "${FAKE_URI}"
  if [[ "$n" -lt 3 ]]; then
    echo "ERROR: Link request expired"
    exit 1
  fi
  echo "Associated with: +15550001234"
  exit 0
fi
if [[ "$args" == *"listDevices"* ]]; then echo ok; exit 0; fi
exit 0
`
      .replaceAll("${counterFile}", counterFile)
      .replaceAll("${FAKE_URI}", FAKE_URI);
    const cli = makeFakeCli(root, script);
    const pngPath = path.join(root, "qr.png");
    const onQrCalls: string[] = [];
    const cap = captureOutput();
    const result = await runSignalLink({
      resolution: baseResolution({ cliPath: cli, configDir: path.join(root, "sigcfg") }),
      pngPath,
      output: cap.output,
      renderTerminalQr: () => {},
      writePng: async (_uri, p) => {
        fs.writeFileSync(p, "PNG", { mode: 0o600 });
      },
      onQr: (p) => {
        onQrCalls.push(p);
      },
    });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(3);
    expect(onQrCalls).toEqual([pngPath, pngPath, pngPath]);
    expect(cap.all()).not.toContain("sgnl://");
  });

  it("registerKill kills the running child (Ctrl-C / RPC cancel path)", async () => {
    const root = tmpRoot();
    const pidFile = path.join(root, "child.pid");
    const script = `
case "$1" in
  --version) echo "signal-cli 99.99.99-test"; exit 0;;
esac
args="$*"
if [[ "$args" == *" link "* ]]; then
  echo "${FAKE_URI}"
  echo $$ > "${pidFile}"
  exec sleep 60
fi
exit 0
`
      .replaceAll("${pidFile}", pidFile)
      .replaceAll("${FAKE_URI}", FAKE_URI);
    const cli = makeFakeCli(root, script);
    const cap = captureOutput();
    let kill: (() => void) | null = null;
    const runPromise = runSignalLink({
      resolution: baseResolution({ cliPath: cli, configDir: path.join(root, "sigcfg") }),
      output: cap.output,
      renderTerminalQr: () => {},
      registerKill: (k) => {
        kill = k;
      },
    });
    await vi.waitFor(() => {
      expect(fs.existsSync(pidFile)).toBe(true);
      expect(kill).not.toBeNull();
    });
    const childPid = Number(fs.readFileSync(pidFile, "utf8").trim());
    kill!();
    const result = await runPromise;
    expect(result.ok).toBe(false);
    await vi.waitFor(() => {
      expect(() => process.kill(childPid, 0)).toThrow();
    });
  });

  it("fails cleanly when signal-cli is missing", async () => {
    const root = tmpRoot();
    const cap = captureOutput();
    const result = await runSignalLink({
      resolution: baseResolution({
        cliPath: path.join(root, "no-such-binary"),
        configDir: path.join(root, "sigcfg"),
      }),
      output: cap.output,
      renderTerminalQr: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("signal-cli");
  });

  it("refuses signal-cli below the minimum version and names the fix (fresh-install ARCH §1.2)", async () => {
    const root = tmpRoot();
    const script = `
case "$1" in
  --version) echo "signal-cli 0.14.5"; exit 0;;
esac
exit 0
`;
    const cli = makeFakeCli(root, script);
    const cap = captureOutput();
    let qrRendered = false;
    const result = await runSignalLink({
      resolution: baseResolution({ cliPath: cli, configDir: path.join(root, "sigcfg") }),
      output: cap.output,
      renderTerminalQr: () => {
        qrRendered = true;
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("0.14.5");
    expect(result.error).toContain(MIN_SIGNAL_CLI_VERSION);
    expect(result.error).toContain("openclaw channels add signal");
    expect(result.error).toContain("channels.signal.cliPath");
    // Never even attempted a link.
    expect(qrRendered).toBe(false);
    expect(cap.all()).not.toContain("sgnl://");
  });

  it("accepts signal-cli at the minimum version", async () => {
    const root = tmpRoot();
    const script = `
case "$1" in
  --version) echo "signal-cli ${MIN_SIGNAL_CLI_VERSION}"; exit 0;;
esac
args="$*"
if [[ "$args" == *" link "* ]]; then
  echo "${FAKE_URI}"
  echo "Associated with: +15550001234"
  exit 0
fi
exit 0
`.replaceAll("${FAKE_URI}", FAKE_URI);
    const cli = makeFakeCli(root, script);
    const cap = captureOutput();
    const result = await runSignalLink({
      resolution: baseResolution({ cliPath: cli, configDir: path.join(root, "sigcfg") }),
      output: cap.output,
      renderTerminalQr: () => {},
    });
    expect(result.ok).toBe(true);
  });
});

describe("version helpers (fresh-install ARCH §1.2)", () => {
  it("parseSignalCliVersion extracts dotted versions", () => {
    expect(parseSignalCliVersion("signal-cli 0.14.9")).toBe("0.14.9");
    expect(parseSignalCliVersion("signal-cli 0.14.9-SNAPSHOT")).toBe("0.14.9-SNAPSHOT");
    expect(parseSignalCliVersion("garbage")).toBeNull();
  });
  it("compareVersions orders dotted versions", () => {
    expect(compareVersions("0.14.5", "0.14.9")).toBeLessThan(0);
    expect(compareVersions("0.14.9", "0.14.9")).toBe(0);
    expect(compareVersions("0.14.10", "0.14.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "0.14.9")).toBeGreaterThan(0);
  });
  it("isSignalCliVersionBelowMinimum flags known-bad and unparseable versions", () => {
    expect(isSignalCliVersionBelowMinimum("signal-cli 0.14.5")).toBe(true);
    expect(isSignalCliVersionBelowMinimum("signal-cli 0.14.9")).toBe(false);
    expect(isSignalCliVersionBelowMinimum("signal-cli 0.15.0")).toBe(false);
    expect(isSignalCliVersionBelowMinimum("unparseable")).toBe(true);
  });
});
