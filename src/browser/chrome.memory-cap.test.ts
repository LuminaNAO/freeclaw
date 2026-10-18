import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedBrowserConfig, ResolvedBrowserProfile } from "./config.js";

const spawnMock = vi.hoisted(() => vi.fn());
const systemdState = vi.hoisted(() => ({ available: true }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) };
});

vi.mock("../infra/ports.js", () => ({
  ensurePortAvailable: vi.fn(async () => {}),
}));

vi.mock("./memory-cap.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./memory-cap.js")>();
  return {
    ...actual,
    buildBrowserLaunchCommand: (params: Parameters<typeof actual.buildBrowserLaunchCommand>[0]) =>
      actual.buildBrowserLaunchCommand({
        ...params,
        platform: "linux",
        systemdAvailable: () => systemdState.available,
      }),
  };
});

const { launchOpenClawChrome, resolveOpenClawUserDataDir } = await import("./chrome.js");

function fakeProc(pid: number) {
  const proc = new EventEmitter() as EventEmitter & Record<string, unknown>;
  proc.pid = pid;
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.exitCode = null;
  proc.killed = false;
  proc.kill = vi.fn(() => true);
  return proc;
}

function makeResolved(memoryLimitMb: number): ResolvedBrowserConfig {
  return {
    enabled: true,
    evaluateEnabled: false,
    controlPort: 18791,
    cdpPortRangeStart: 18800,
    cdpPortRangeEnd: 18899,
    cdpProtocol: "http",
    cdpHost: "127.0.0.1",
    cdpIsLoopback: true,
    remoteCdpTimeoutMs: 1500,
    remoteCdpHandshakeTimeoutMs: 3000,
    color: "#FF4500",
    executablePath: process.execPath,
    headless: true,
    noSandbox: false,
    attachOnly: false,
    defaultProfile: "capped",
    profiles: { capped: { cdpPort: 18877, color: "#FF4500" } },
    extraArgs: [],
    memoryLimitMb,
    maxTabs: 8,
  };
}

const profile: ResolvedBrowserProfile = {
  name: "capped-test",
  cdpPort: 18877,
  cdpUrl: "http://127.0.0.1:18877",
  cdpHost: "127.0.0.1",
  cdpIsLoopback: true,
  color: "#FF4500",
  driver: "openclaw",
  attachOnly: false,
};

const originalFetch = globalThis.fetch;

describe("launchOpenClawChrome memory cap (ARCH §2.1-§2.2)", () => {
  beforeEach(() => {
    // Pre-create the profile so launch skips the bootstrap run.
    const userDataDir = resolveOpenClawUserDataDir(profile.name);
    fs.mkdirSync(path.join(userDataDir, "Default"), { recursive: true });
    fs.writeFileSync(path.join(userDataDir, "Local State"), "{}");
    fs.writeFileSync(path.join(userDataDir, "Default", "Preferences"), "{}");
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => fakeProc(4242));
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:18877/x" }), {
          status: 200,
        }),
    ) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    systemdState.available = true;
  });

  it("wraps the browser in systemd-run --scope -p MemoryMax=... when available", async () => {
    systemdState.available = true;
    const running = await launchOpenClawChrome(makeResolved(4096), profile);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(command).toBe("systemd-run");
    expect(args.slice(0, args.indexOf("--") + 2)).toEqual([
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      "-p",
      "MemoryMax=4096M",
      "-p",
      "MemorySwapMax=0",
      "--",
      process.execPath,
    ]);
    expect(args).toContain("--remote-debugging-port=18877");
    expect(running.memoryCap).toEqual({ mode: "kernel", limitMb: 4096 });
    expect(running.pid).toBe(4242);
  });

  it("spawns the browser directly when systemd-run is unavailable (soft cap)", async () => {
    systemdState.available = false;
    const running = await launchOpenClawChrome(makeResolved(4096), profile);
    const [command, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(command).toBe(process.execPath);
    expect(args).not.toContain("--scope");
    expect(running.memoryCap).toEqual({ mode: "soft", limitMb: 4096 });
  });

  it("memoryLimitMb 0 spawns the browser directly with no wrapper", async () => {
    systemdState.available = true;
    const running = await launchOpenClawChrome(makeResolved(0), profile);
    const [command, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(command).toBe(process.execPath);
    expect(args.some((a) => a.startsWith("MemoryMax"))).toBe(false);
    expect(running.memoryCap).toEqual({ mode: "off", limitMb: 0 });
  });
});
