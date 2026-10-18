import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resetSystemdScopeProbeForTests,
  buildBrowserLaunchCommand,
  isSystemdUserScopeAvailable,
  measureLinuxProcessTreeRssBytes,
  resolveBrowserMemoryCapMode,
  sumPsTreeRssBytes,
} from "./memory-cap.js";

describe("browser memory cap launch command (ARCH §2.1-§2.2)", () => {
  afterEach(() => {
    resetSystemdScopeProbeForTests(undefined);
  });

  it("wraps the browser in a systemd-run user scope with MemoryMax when available", () => {
    const launch = buildBrowserLaunchCommand({
      executablePath: "/usr/bin/chromium",
      args: ["--remote-debugging-port=18800", "about:blank"],
      memoryLimitMb: 4096,
      platform: "linux",
      systemdAvailable: () => true,
    });
    expect(launch.command).toBe("systemd-run");
    expect(launch.args).toEqual([
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      "-p",
      "MemoryMax=4096M",
      "-p",
      "MemorySwapMax=0",
      "--",
      "/usr/bin/chromium",
      "--remote-debugging-port=18800",
      "about:blank",
    ]);
    expect(launch.memoryCap).toEqual({ mode: "kernel", limitMb: 4096 });
  });

  it("spawns the browser directly with a soft cap when systemd-run is unavailable", () => {
    const launch = buildBrowserLaunchCommand({
      executablePath: "/usr/bin/chromium",
      args: ["about:blank"],
      memoryLimitMb: 2048,
      platform: "linux",
      systemdAvailable: () => false,
    });
    expect(launch.command).toBe("/usr/bin/chromium");
    expect(launch.args).toEqual(["about:blank"]);
    expect(launch.memoryCap).toEqual({ mode: "soft", limitMb: 2048 });
  });

  it("memoryLimitMb 0 means no wrapper and cap off", () => {
    let probed = false;
    const launch = buildBrowserLaunchCommand({
      executablePath: "/usr/bin/chromium",
      args: ["about:blank"],
      memoryLimitMb: 0,
      platform: "linux",
      systemdAvailable: () => {
        probed = true;
        return true;
      },
    });
    expect(launch.command).toBe("/usr/bin/chromium");
    expect(launch.memoryCap).toEqual({ mode: "off", limitMb: 0 });
    expect(probed).toBe(false);
  });

  it("never uses systemd-run off Linux", () => {
    expect(isSystemdUserScopeAvailable("darwin")).toBe(false);
    expect(isSystemdUserScopeAvailable("win32")).toBe(false);
    const launch = buildBrowserLaunchCommand({
      executablePath: "/Applications/Chrome",
      args: [],
      memoryLimitMb: 4096,
      platform: "darwin",
    });
    expect(launch.command).toBe("/Applications/Chrome");
    expect(launch.memoryCap.mode).toBe("soft");
  });

  it("resolves the cap mode for status", () => {
    expect(resolveBrowserMemoryCapMode(0, "linux", () => true)).toBe("off");
    expect(resolveBrowserMemoryCapMode(4096, "linux", () => true)).toBe("kernel");
    expect(resolveBrowserMemoryCapMode(4096, "linux", () => false)).toBe("soft");
  });
});

describe("browser tree RSS measurement", () => {
  it("sums RSS over the whole process tree from ps output", () => {
    const ps = [
      "  1     0  1000",
      "100     1  2048",
      "101   100  1024",
      "102   101   512",
      "200     1  9999",
    ].join("\n");
    expect(sumPsTreeRssBytes(100, ps)).toBe((2048 + 1024 + 512) * 1024);
    expect(sumPsTreeRssBytes(999, ps)).toBeNull();
  });

  it("sums VmRSS over the tree from a /proc layout", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fc-proc-"));
    try {
      const write = (pid: number, ppid: number, comm: string, rssKb: number) => {
        fs.mkdirSync(path.join(root, String(pid)));
        fs.writeFileSync(path.join(root, String(pid), "stat"), `${pid} (${comm}) S ${ppid} 0 0`);
        fs.writeFileSync(
          path.join(root, String(pid), "status"),
          `Name:\t${comm}\nVmRSS:\t   ${rssKb} kB\n`,
        );
      };
      write(10, 1, "chrome", 100);
      write(11, 10, "chrome (renderer)", 200);
      write(12, 11, "chrome) x", 300);
      write(20, 1, "other", 5000);
      expect(measureLinuxProcessTreeRssBytes(10, root)).toBe(600 * 1024);
      expect(measureLinuxProcessTreeRssBytes(99, root)).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
