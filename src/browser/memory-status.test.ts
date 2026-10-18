import { describe, expect, it, vi } from "vitest";
import type { ResolvedBrowserProfile } from "./config.js";
import { formatBrowserMemoryReport, formatBrowserMemoryStatus } from "./memory-cap.js";
import { resolveBrowserMemoryStatus } from "./memory-status.js";
import type { BrowserServerState, ProfileRuntimeState } from "./server-context.types.js";

const MiB = 1024 * 1024;

function makeProfile(overrides: Partial<ResolvedBrowserProfile> = {}): ResolvedBrowserProfile {
  return {
    name: "openclaw",
    cdpPort: 18800,
    cdpUrl: "http://127.0.0.1:18800",
    cdpHost: "127.0.0.1",
    cdpIsLoopback: true,
    color: "#FF4500",
    driver: "openclaw",
    attachOnly: false,
    ...overrides,
  };
}

const state = { resolved: { memoryLimitMb: 4096 } } as BrowserServerState;

function runningState(mode: "kernel" | "soft" | "off"): ProfileRuntimeState {
  return {
    profile: makeProfile(),
    running: {
      pid: 77,
      memoryCap: { mode, limitMb: mode === "off" ? 0 : 4096 },
    } as unknown as ProfileRuntimeState["running"],
  };
}

describe("browser memory status (ARCH §2.5-§2.6)", () => {
  it("reports RSS, cap, tabs and kernel enforcement for a launched browser", async () => {
    const measure = vi.fn(async () => 1536 * MiB);
    const status = await resolveBrowserMemoryStatus({
      state,
      profile: makeProfile(),
      profileState: runningState("kernel"),
      tabCount: 3,
      measureRssBytes: measure,
    });
    expect(measure).toHaveBeenCalledWith(77);
    expect(status).toEqual({
      scope: "managed",
      capMode: "kernel",
      capMb: 4096,
      kernelEnforced: true,
      rssMb: 1536,
      tabCount: 3,
    });
    expect(formatBrowserMemoryStatus(status)).toBe(
      "rss 1536 MiB / 4096 MiB cap (kernel-enforced) · 3 tabs",
    );
  });

  it("says the cap is soft when it is not kernel-enforced", async () => {
    const status = await resolveBrowserMemoryStatus({
      state,
      profile: makeProfile(),
      profileState: runningState("soft"),
      tabCount: 1,
      measureRssBytes: async () => 100 * MiB,
    });
    expect(status.kernelEnforced).toBe(false);
    expect(formatBrowserMemoryStatus(status)).toBe(
      "rss 100 MiB / 4096 MiB cap (soft (watchdog only)) · 1 tab",
    );
  });

  it("reports no cap when memoryLimitMb is 0", async () => {
    const status = await resolveBrowserMemoryStatus({
      state,
      profile: makeProfile(),
      profileState: runningState("off"),
      tabCount: 2,
      measureRssBytes: async () => 10 * MiB,
    });
    expect(status.capMb).toBeNull();
    expect(formatBrowserMemoryStatus(status)).toBe("rss 10 MiB · no cap · 2 tabs");
  });

  it.each([
    ["existing-session (user profile)", makeProfile({ name: "user", driver: "existing-session" })],
    ["extension relay", makeProfile({ name: "chrome-relay", driver: "extension" })],
    [
      "remote CDP / separate browser service",
      makeProfile({ name: "remote", cdpUrl: "https://browserless.example", cdpIsLoopback: false }),
    ],
    ["attach-only", makeProfile({ name: "attached", attachOnly: true })],
  ])("reports %s as external, not capped, and never measures it", async (_label, profile) => {
    const measure = vi.fn(async () => 1 * MiB);
    const status = await resolveBrowserMemoryStatus({
      state,
      profile,
      profileState: { profile, running: null },
      tabCount: null,
      measureRssBytes: measure,
    });
    expect(status.scope).toBe("external");
    expect(measure).not.toHaveBeenCalled();
    expect(formatBrowserMemoryStatus(status)).toBe("external, not capped");
  });

  it("reports a browser freeclaw did not start on a managed port as external", async () => {
    const status = await resolveBrowserMemoryStatus({
      state,
      profile: makeProfile(),
      tabCount: null,
      externallyRunning: true,
    });
    expect(status.scope).toBe("external");
  });

  it("formats the openclaw status summary line", () => {
    expect(
      formatBrowserMemoryReport({
        memoryLimitMb: 4096,
        profiles: [
          {
            name: "openclaw",
            running: true,
            scope: "managed",
            capMode: "kernel",
            capMb: 4096,
            kernelEnforced: true,
            rssMb: 900,
            tabCount: 2,
          },
          {
            name: "user",
            running: true,
            scope: "external",
            capMode: "none",
            capMb: null,
            kernelEnforced: false,
            rssMb: null,
            tabCount: null,
          },
          {
            name: "chrome-relay",
            running: false,
            scope: "external",
            capMode: "none",
            capMb: null,
            kernelEnforced: false,
            rssMb: null,
            tabCount: null,
          },
        ],
      }),
    ).toBe(
      "openclaw: rss 900 MiB / 4096 MiB cap (kernel-enforced) · 2 tabs · user: external, not capped",
    );
    expect(
      formatBrowserMemoryReport({
        memoryLimitMb: 4096,
        profiles: [
          {
            name: "openclaw",
            running: false,
            scope: "managed",
            capMode: "soft",
            capMb: 4096,
            kernelEnforced: false,
            rssMb: null,
            tabCount: null,
          },
        ],
      }),
    ).toBe("not running · cap 4096 MiB (soft (watchdog only))");
  });
});
