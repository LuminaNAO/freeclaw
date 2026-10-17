// `openclaw gateway focus [set <key>|off|status]` (focus-mode ARCH §4).
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearFocusState, setFocusState } from "../../infra/focus-mode.js";

const callGatewayCli = vi.hoisted(() => vi.fn());
vi.mock("./call.js", () => ({ callGatewayCli }));
vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  readBestEffortConfig: async () => ({}),
}));
const logs: string[] = [];
vi.mock("../../runtime.js", () => ({
  defaultRuntime: { log: (line: string) => logs.push(line), error: vi.fn(), exit: vi.fn() },
}));

const { runGatewayFocus } = await import("./focus.js");

afterEach(() => {
  logs.length = 0;
  callGatewayCli.mockReset();
  clearFocusState();
});

describe("gateway focus CLI", () => {
  it("set calls the gateway focus method with the target", async () => {
    callGatewayCli.mockResolvedValue({ focus: { target: "agent:main:main" } });
    await runGatewayFocus({ action: "set", target: "main", opts: {} });
    expect(callGatewayCli).toHaveBeenCalledWith("focus", expect.anything(), {
      action: "set",
      target: "main",
    });
    expect(logs).toEqual(["Focus mode on agent:main:main."]);
  });

  it("set needs a target", async () => {
    await expect(runGatewayFocus({ action: "set", opts: {} })).rejects.toThrow(/usage/);
    expect(callGatewayCli).not.toHaveBeenCalled();
  });

  it("off reports the replay", async () => {
    callGatewayCli.mockResolvedValue({ ended: { target: "x" }, replaying: 3 });
    await runGatewayFocus({ action: "off", opts: {} });
    expect(callGatewayCli).toHaveBeenCalledWith("focus", expect.anything(), { action: "off" });
    expect(logs).toEqual(["Focus mode off. Replaying waiting messages for 3 session(s)."]);
  });

  it("status prints target, since and waiting", async () => {
    callGatewayCli.mockResolvedValue({
      focus: { target: "agent:main:main", since: 0, by: "op" },
      waiting: [{ sessionKey: "agent:main:a", count: 2 }],
    });
    await runGatewayFocus({ action: "status", opts: {} });
    expect(logs).toEqual([
      "Focus mode: on agent:main:main",
      "since 1970-01-01T00:00:00.000Z by op",
      "Waiting:",
      "  agent:main:a  waiting=2",
    ]);
  });

  it("status reads the state from disk when the gateway is down; set/off do not", async () => {
    setFocusState({ target: "agent:main:main", by: "op", now: 0 });
    callGatewayCli.mockRejectedValue(new Error("connect ECONNREFUSED"));
    await runGatewayFocus({ action: "status", opts: {} });
    expect(logs[0]).toBe("Focus mode: on agent:main:main");
    await expect(runGatewayFocus({ action: "off", opts: {} })).rejects.toThrow(/ECONNREFUSED/);
  });
});
