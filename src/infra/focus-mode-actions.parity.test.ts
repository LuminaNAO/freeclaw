// CLI, chat and gateway-method parity with --json (focus-mode ARCH §7.4, §7.6):
// one ops function behind all three; the same op gives the same state, the same
// report (method response = CLI --json) and the same text (chat reply = CLI output).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { formatFocusReportLines, type FocusReport, runFocusOp } from "./focus-mode-actions.js";
import { clearAllFocus, readFocusState, registerFocusReplayer } from "./focus-mode.js";

const callGatewayCli = vi.hoisted(() => vi.fn());
vi.mock("../cli/gateway-cli/call.js", () => ({ callGatewayCli }));
vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  loadConfig: () => ({ commands: { ownerAllowFrom: ["+2000"] } }),
  readBestEffortConfig: async () => ({
    commands: { ownerAllowFrom: ["+2000"] },
  }),
}));
const logs: string[] = [];
vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: (line: string) => logs.push(line),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

const { handleFocusCommand } = await import("../auto-reply/reply/commands-focus.js");
const { buildCommandTestParams } = await import("../auto-reply/reply/commands.test-harness.js");
const { focusHandlers } = await import("../gateway/server-methods/focus.js");
const { runGatewayFocus } = await import("../cli/gateway-cli/focus.js");

const cfg = { commands: { ownerAllowFrom: ["+2000"] } } as OpenClawConfig;
const NOW = 1_700_000_000_000;

type CliArgs = Omit<Parameters<typeof runGatewayFocus>[0], "opts">;

afterEach(() => {
  vi.useRealTimers();
  logs.length = 0;
  callGatewayCli.mockReset();
  clearAllFocus();
  registerFocusReplayer(undefined);
});

async function viaChat(body: string): Promise<string> {
  const params = buildCommandTestParams(body, cfg, {
    SenderId: "+2000",
    From: "+2000",
  });
  return (await handleFocusCommand(params, true))?.reply?.text ?? "";
}

async function viaMethod(params: Record<string, unknown>): Promise<FocusReport> {
  const respond = vi.fn();
  await focusHandlers.focus({
    req: { type: "req", id: "1", method: "focus", params },
    params,
    respond,
    client: { connect: { client: { id: "+2000" } } } as never,
    isWebchatConnect: () => false,
    context: { logGateway: { info: vi.fn(), warn: vi.fn() } } as never,
  });
  expect(respond.mock.calls[0]?.[0]).toBe(true);
  return respond.mock.calls[0]?.[1] as FocusReport;
}

/** The CLI, with its gateway call answered by the real method (as a live gateway would). */
async function viaCli(args: CliArgs): Promise<{ lines: string[]; report: FocusReport }> {
  let report: FocusReport | undefined;
  callGatewayCli.mockImplementation(async (_m: string, _o: unknown, params: never) => {
    report = await viaMethod(params);
    return report;
  });
  logs.length = 0;
  await runGatewayFocus({ ...args, opts: {} });
  const lines = [...logs];
  logs.length = 0;
  await runGatewayFocus({ ...args, opts: { json: true } });
  expect(JSON.parse(logs[0])).toEqual(report);
  return { lines, report: report as FocusReport };
}

/** Run one op on each surface from the same starting state; return what each produced. */
async function onEachSurface(
  setup: () => void,
  chat: string,
  method: Record<string, unknown>,
  cli: CliArgs,
) {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  clearAllFocus();
  setup();
  const chatText = await viaChat(chat);
  const chatState = readFocusState();
  clearAllFocus();
  setup();
  const methodReport = await viaMethod(method);
  const methodState = readFocusState();
  clearAllFocus();
  setup();
  const cliOut = await viaCli(cli);
  // The CLI ran the op twice (text, then --json); the second is a repeat of the first.
  const cliState = readFocusState();
  return { chatText, chatState, methodReport, methodState, cliOut, cliState };
}

function focus(sessionKey: string, tier: "normal" | "hyper") {
  runFocusOp({
    cfg,
    request: { action: "set", target: sessionKey, tier },
    by: "+2000",
  });
}

describe("focus parity: CLI, chat and gateway method (focus-mode ARCH §7.4)", () => {
  it("set with a tier", async () => {
    const r = await onEachSurface(
      () => focus("agent:main:signal:group:g", "normal"),
      "/focus main hyper",
      { action: "set", target: "main", tier: "hyper" },
      { action: "set", target: "main", tier: "hyper" },
    );
    expect(r.methodState).toEqual(r.chatState);
    expect(r.cliState).toEqual(r.chatState);
    expect(r.chatState?.sessions["agent:main:main"]).toEqual({
      tier: "hyper",
      since: NOW,
      by: "+2000",
    });
    expect(r.chatText).toBe(formatFocusReportLines(r.methodReport).join("\n"));
    // The CLI's repeat leaves the same state; its first output equals the chat reply.
    expect(r.cliOut.lines.join("\n")).toBe(r.chatText);
  });

  it("off <key>", async () => {
    const setup = () => {
      focus("agent:main:main", "hyper");
      focus("agent:main:signal:group:g", "normal");
    };
    const r = await onEachSurface(
      setup,
      "/focus off main",
      { action: "off", target: "main" },
      { action: "off", target: "main" },
    );
    expect(r.methodState).toEqual(r.chatState);
    expect(r.chatText).toBe(formatFocusReportLines(r.methodReport).join("\n"));
    expect(r.cliOut.lines.join("\n")).toBe(r.chatText);
    expect(r.methodReport).toMatchObject({
      previousTier: "hyper",
      status: { active: "normal" },
    });
  });

  it("off (all)", async () => {
    const r = await onEachSurface(
      () => focus("agent:main:main", "normal"),
      "/focus off",
      { action: "off" },
      { action: "off", all: true },
    );
    expect(r.chatState).toBeUndefined();
    expect(r.methodState).toBeUndefined();
    expect(r.cliState).toBeUndefined();
    expect(r.chatText).toBe(formatFocusReportLines(r.methodReport).join("\n"));
    expect(r.chatText).toBe("Focus off: cleared 1 session(s).");
  });

  it("status: the same report as JSON, the same lines as text", async () => {
    const setup = () => {
      focus("agent:main:main", "hyper");
      focus("agent:main:signal:group:g", "normal");
    };
    const r = await onEachSurface(setup, "/focus", { action: "status" }, { action: "status" });
    expect(r.cliOut.report).toEqual(r.methodReport);
    expect(r.chatText).toBe(formatFocusReportLines(r.methodReport).join("\n"));
    expect(r.cliOut.lines.join("\n")).toBe(r.chatText);
    expect(r.methodReport.status.active).toBe("hyper");
  });
});
