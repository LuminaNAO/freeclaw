// `openclaw gateway focus [status|set <key> [--tier t]|off [<key>|--all]] [--json]`
// (focus-mode ARCH §7.4).
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatFocusReportLines, runFocusOp } from "../../infra/focus-mode-actions.js";
import { clearAllFocus, setSessionFocus } from "../../infra/focus-mode.js";

const callGatewayCli = vi.hoisted(() => vi.fn());
vi.mock("./call.js", () => ({ callGatewayCli }));
vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  readBestEffortConfig: async () => ({}),
}));
const logs: string[] = [];
vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    log: (line: string) => logs.push(line),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

const { buildGatewayFocusParams, runGatewayFocus } = await import("./focus.js");

afterEach(() => {
  logs.length = 0;
  callGatewayCli.mockReset();
  clearAllFocus();
});

/** A method response, built by the real ops function (the method returns it as is). */
function reportFor(request: Parameters<typeof runFocusOp>[0]["request"]) {
  return runFocusOp({ cfg: {}, request, by: "cli" }).report;
}

describe("gateway focus CLI (focus-mode ARCH §7.4)", () => {
  it("maps the arguments to the method params", () => {
    expect(buildGatewayFocusParams({ action: "status" })).toEqual({
      action: "status",
    });
    expect(buildGatewayFocusParams({ action: "set", target: "main" })).toEqual({
      action: "set",
      target: "main",
    });
    expect(buildGatewayFocusParams({ action: "set", target: "main", tier: "hyper" })).toEqual({
      action: "set",
      target: "main",
      tier: "hyper",
    });
    expect(buildGatewayFocusParams({ action: "off", target: "main" })).toEqual({
      action: "off",
      target: "main",
    });
    expect(buildGatewayFocusParams({ action: "off", all: true })).toEqual({
      action: "off",
      all: true,
    });
  });

  it("refuses malformed calls before calling the gateway", async () => {
    for (const bad of [
      { action: "set" as const },
      { action: "set" as const, target: "main", all: true },
      { action: "off" as const },
      { action: "off" as const, target: "main", all: true },
      { action: "off" as const, all: true, tier: "hyper" },
      { action: "status" as const, target: "main" },
    ]) {
      await expect(runGatewayFocus({ ...bad, opts: {} })).rejects.toThrow(/usage|--tier|--all/);
    }
    expect(callGatewayCli).not.toHaveBeenCalled();
  });

  it("set --tier calls the method and prints the report lines", async () => {
    const report = reportFor({ action: "set", target: "main", tier: "hyper" });
    callGatewayCli.mockResolvedValue(report);
    await runGatewayFocus({
      action: "set",
      target: "main",
      tier: "hyper",
      opts: {},
    });
    expect(callGatewayCli).toHaveBeenCalledWith("focus", expect.anything(), {
      action: "set",
      target: "main",
      tier: "hyper",
    });
    expect(logs).toEqual(["Focus: agent:main:main set to hyper.", "Active level: hyper."]);
  });

  it("off <key> and off --all", async () => {
    setSessionFocus({ sessionKey: "agent:main:main", by: "op" });
    callGatewayCli.mockResolvedValue(reportFor({ action: "off", target: "main" }));
    await runGatewayFocus({ action: "off", target: "main", opts: {} });
    expect(callGatewayCli).toHaveBeenLastCalledWith("focus", expect.anything(), {
      action: "off",
      target: "main",
    });
    expect(logs).toEqual(["Focus: agent:main:main back to none."]);
    logs.length = 0;
    callGatewayCli.mockResolvedValue({
      ...reportFor({ action: "off", all: true }),
      replaying: 3,
    });
    await runGatewayFocus({ action: "off", all: true, opts: {} });
    expect(callGatewayCli).toHaveBeenLastCalledWith("focus", expect.anything(), {
      action: "off",
      all: true,
    });
    expect(logs).toEqual([
      "Focus is already off.",
      "Replaying waiting messages for 3 session(s), one combined prompt each.",
    ]);
  });

  it("--json prints the method's report unchanged", async () => {
    setSessionFocus({
      sessionKey: "agent:main:main",
      tier: "hyper",
      by: "op",
      now: 0,
    });
    const report = reportFor({ action: "status" });
    callGatewayCli.mockResolvedValue(report);
    await runGatewayFocus({ action: "status", opts: { json: true } });
    expect(JSON.parse(logs[0])).toEqual(report);
  });

  it("status reads the state from disk when the gateway is down (same report); set/off do not", async () => {
    setSessionFocus({ sessionKey: "agent:main:main", by: "op", now: 0 });
    callGatewayCli.mockRejectedValue(new Error("connect ECONNREFUSED"));
    await runGatewayFocus({ action: "status", opts: {} });
    expect(logs).toEqual(formatFocusReportLines(reportFor({ action: "status" })));
    expect(logs[0]).toBe("Focus: active level normal");
    logs.length = 0;
    await runGatewayFocus({ action: "status", opts: { json: true } });
    expect(JSON.parse(logs[0])).toEqual(reportFor({ action: "status" }));
    await expect(runGatewayFocus({ action: "off", all: true, opts: {} })).rejects.toThrow(
      /ECONNREFUSED/,
    );
    await expect(runGatewayFocus({ action: "set", target: "main", opts: {} })).rejects.toThrow(
      /ECONNREFUSED/,
    );
  });
});
