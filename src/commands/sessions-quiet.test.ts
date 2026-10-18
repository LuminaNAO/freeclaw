/**
 * docs/design/agent-peers-and-quiet-sessions.md §3.1-§3.3: `openclaw sessions set|show`, the
 * operator-only `sessions.setQuiet` gateway method, persistence and `openclaw status` visibility.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { logs, cfgRef } = vi.hoisted(() => ({
  logs: [] as string[],
  cfgRef: { current: {} as Record<string, unknown> },
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return { ...actual, loadConfig: () => cfgRef.current };
});

vi.mock("../runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime.js")>();
  return {
    ...actual,
    defaultRuntime: {
      log: (line: unknown) => logs.push(String(line)),
      error: (line: unknown) => logs.push(String(line)),
      exit: (code: number) => {
        throw new Error(`exit ${code}`);
      },
    },
  };
});

const { registerStatusHealthSessionsCommands } =
  await import("../cli/program/register.status-health-sessions.js");
const { sessionsQuietHandlers } = await import("../gateway/server-methods/sessions-quiet.js");
const { authorizeOperatorScopesForMethod, isAdminOnlyMethod } =
  await import("../gateway/method-scopes.js");
const { listGatewayMethods } = await import("../gateway/server-methods-list.js");
const { validateSessionsPatchParams } = await import("../gateway/protocol/index.js");
const { clearSessionStoreCacheForTest, loadSessionStore } =
  await import("../config/sessions/store.js");
const { recordSuppressedSessionError } = await import("../sessions/quiet-settings.js");
const { getStatusSummary } = await import("./status.summary.js");

const KEY = "agent:main:signal:group:quiet-g1";
let dir: string;
let storePath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-quiet-"));
  storePath = path.join(dir, "sessions.json");
  cfgRef.current = { session: { store: storePath } };
  fs.writeFileSync(
    storePath,
    JSON.stringify({
      [KEY]: { sessionId: "s-1", updatedAt: 1_700_000_000_000, chatType: "group" },
      "agent:main:main": { sessionId: "s-main", updatedAt: 1_700_000_000_000 },
    }),
  );
  clearSessionStoreCacheForTest();
  logs.length = 0;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function readEntry(key = KEY) {
  clearSessionStoreCacheForTest();
  return loadSessionStore(storePath, { skipCache: true })[key];
}

async function cli(...args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerStatusHealthSessionsCommands(program);
  await program.parseAsync(["node", "openclaw", "sessions", ...args]);
}

async function callMethod(method: string, params: Record<string, unknown>) {
  const respond = vi.fn();
  await sessionsQuietHandlers[method]({
    params,
    respond,
    // oxlint-disable-next-line typescript/no-explicit-any
    req: { method } as any,
    client: null,
    isWebchatConnect: () => false,
    // oxlint-disable-next-line typescript/no-explicit-any
    context: {} as any,
  });
  const [ok, payload, error] = respond.mock.calls[0] ?? [];
  return { ok, payload, error };
}

describe("openclaw sessions set / show (quiet sessions ARCH §3.1, §3.3)", () => {
  it("show reports both settings as default when unset", async () => {
    await cli("show", KEY);
    expect(logs).toContain("  errorReplies: on (default)");
    expect(logs).toContain("  slashCommands: on (default)");
  });

  it("set --no-error-replies --no-slash-commands stores both; show reports them", async () => {
    await cli("set", KEY, "--no-error-replies", "--no-slash-commands");
    const entry = readEntry();
    expect(entry?.errorReplies).toBe(false);
    expect(entry?.slashCommands).toBe(false);
    // Other sessions untouched.
    expect(readEntry("agent:main:main")?.errorReplies).toBeUndefined();

    logs.length = 0;
    await cli("show", KEY);
    expect(logs).toContain("  errorReplies: off");
    expect(logs).toContain("  slashCommands: off");

    logs.length = 0;
    await cli("show", KEY, "--json");
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      key: KEY,
      errorReplies: false,
      slashCommands: false,
    });
  });

  it("set only touches the flags given, and --error-replies clears back to unset", async () => {
    await cli("set", KEY, "--no-slash-commands");
    expect(readEntry()?.slashCommands).toBe(false);
    expect("errorReplies" in (readEntry() ?? {})).toBe(false);

    await cli("set", KEY, "--no-error-replies");
    await cli("set", KEY, "--error-replies", "--slash-commands");
    const entry = readEntry() ?? {};
    expect("errorReplies" in entry).toBe(false);
    expect("slashCommands" in entry).toBe(false);
  });

  it("set with no flags or an unknown session fails without writing", async () => {
    const before = fs.readFileSync(storePath, "utf8");
    await expect(cli("set", KEY)).rejects.toThrow();
    await expect(
      cli("set", "agent:main:signal:group:nope", "--no-error-replies"),
    ).rejects.toThrow();
    expect(fs.readFileSync(storePath, "utf8")).toBe(before);
  });
});

describe("sessions.setQuiet gateway method (ARCH §3.1)", () => {
  it("is registered and operator.admin only", () => {
    expect(listGatewayMethods()).toContain("sessions.setQuiet");
    expect(listGatewayMethods()).toContain("sessions.quiet.get");
    for (const method of ["sessions.setQuiet", "sessions.quiet.get"]) {
      expect(isAdminOnlyMethod(method)).toBe(true);
      expect(authorizeOperatorScopesForMethod(method, ["operator.write"]).allowed).toBe(false);
      expect(authorizeOperatorScopesForMethod(method, ["operator.admin"]).allowed).toBe(true);
    }
  });

  it("sessions.patch does not accept the quiet settings", () => {
    expect(validateSessionsPatchParams({ key: KEY, errorReplies: false })).toBe(false);
    expect(validateSessionsPatchParams({ key: KEY, slashCommands: false })).toBe(false);
  });

  it("sets and clears the same fields the CLI writes", async () => {
    let res = await callMethod("sessions.setQuiet", { sessionKey: KEY, errorReplies: false });
    expect(res.ok).toBe(true);
    expect(res.payload).toMatchObject({ errorReplies: false, slashCommands: true, changed: true });
    expect(readEntry()?.errorReplies).toBe(false);

    res = await callMethod("sessions.quiet.get", { sessionKey: KEY });
    expect(res.payload).toMatchObject({ errorReplies: false, slashCommands: true });

    res = await callMethod("sessions.setQuiet", { sessionKey: KEY, errorReplies: true });
    expect(res.ok).toBe(true);
    expect("errorReplies" in (readEntry() ?? {})).toBe(false);
  });

  it("rejects bad input", async () => {
    expect((await callMethod("sessions.setQuiet", { errorReplies: false })).ok).toBe(false);
    expect((await callMethod("sessions.setQuiet", { sessionKey: KEY })).ok).toBe(false);
    expect(
      (await callMethod("sessions.setQuiet", { sessionKey: KEY, errorReplies: "no" })).ok,
    ).toBe(false);
  });
});

describe("quiet settings persist and suppressed errors show in status (ARCH §3.1, §3.2)", () => {
  it("settings are on the stored session entry (survive restart)", async () => {
    await cli("set", KEY, "--no-error-replies");
    const raw = JSON.parse(fs.readFileSync(storePath, "utf8"));
    expect(raw[KEY].errorReplies).toBe(false);
  });

  it("status summary flags quiet sessions and carries the suppressed error", async () => {
    await cli("set", KEY, "--no-error-replies", "--no-slash-commands");
    await recordSuppressedSessionError({
      storePath,
      sessionKey: KEY,
      text: "⚠️ Agent failed before reply: boom",
      now: 1_700_000_000_500,
    });
    clearSessionStoreCacheForTest();
    const summary = await getStatusSummary({
      // oxlint-disable-next-line typescript/no-explicit-any
      config: cfgRef.current as any,
    });
    const row = summary.sessions.recent.find((sess) => sess.key === KEY);
    expect(row?.flags).toContain("error-replies:off");
    expect(row?.flags).toContain("slash-commands:off");
    expect(row?.suppressedError).toEqual({
      at: 1_700_000_000_500,
      text: "⚠️ Agent failed before reply: boom",
    });
    const plain = summary.sessions.recent.find((sess) => sess.key === "agent:main:main");
    expect(plain?.flags.some((flag) => flag.includes("-off") || flag.includes(":off"))).toBe(false);
    expect(plain?.suppressedError).toBeUndefined();
  });
});
