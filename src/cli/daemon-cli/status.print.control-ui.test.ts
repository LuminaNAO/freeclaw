import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeLogs: string[] = [];
const runtimeErrors: string[] = [];

vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    log: (msg: string) => runtimeLogs.push(msg),
    error: (msg: string) => runtimeErrors.push(msg),
    exit: vi.fn(),
  },
}));

vi.mock("../../logging.js", () => ({
  getResolvedLoggerSettings: () => ({ file: "/tmp/openclaw-test.log" }),
}));

import type { GatewayControlUiConfig } from "../../config/types.gateway.js";
import { stripAnsi } from "../../terminal/ansi.js";
import type { DaemonStatus } from "./status.gather.js";
import { printDaemonStatus } from "./status.print.js";

function buildStatus(controlUi: GatewayControlUiConfig | undefined): DaemonStatus {
  return {
    service: {
      label: "systemd",
      loaded: true,
      loadedText: "enabled",
      notLoadedText: "disabled",
    },
    config: {
      cli: { path: "/tmp/openclaw.json", exists: true, valid: true },
      daemon: { path: "/tmp/openclaw.json", exists: true, valid: true, controlUi },
    },
    gateway: {
      bindMode: "loopback",
      bindHost: "127.0.0.1",
      port: 18789,
      portSource: "env/config",
      probeUrl: "ws://127.0.0.1:18789",
    },
    rpc: { ok: true, url: "ws://127.0.0.1:18789" },
    extraServices: [],
  };
}

describe("printDaemonStatus Control UI line", () => {
  beforeEach(() => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
  });

  it.each([
    { name: "unset", controlUi: undefined },
    { name: "block without enabled", controlUi: {} },
    { name: "explicitly disabled", controlUi: { enabled: false } },
  ])("prints Control UI: off when $name", ({ controlUi }) => {
    printDaemonStatus(buildStatus(controlUi), { json: false });
    const lines = runtimeLogs.map(stripAnsi);
    expect(lines).toContain("Control UI: off");
    expect(lines.some((l) => l.startsWith("Dashboard:"))).toBe(false);
    expect(runtimeErrors.map(stripAnsi).some((l) => l.includes("Control UI"))).toBe(false);
  });

  it("prints the dashboard URL when enabled", () => {
    printDaemonStatus(buildStatus({ enabled: true }), { json: false });
    const lines = runtimeLogs.map(stripAnsi);
    expect(lines).toContain("Dashboard: http://127.0.0.1:18789/");
    expect(lines.some((l) => l.startsWith("Control UI:"))).toBe(false);
  });
});
