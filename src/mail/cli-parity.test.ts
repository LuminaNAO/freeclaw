// docs/design/mail-push.md §9.12 (CLI/gateway parity) and §9.11 (no secrets in status/events).
// The CLI's gateway call is answered by the real method handlers over a real manager (fake
// provider), as a live gateway would; no gateway, no network.
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const callGatewayFromCli = vi.hoisted(() => vi.fn());
vi.mock("../cli/gateway-rpc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/gateway-rpc.js")>()),
  callGatewayFromCli,
}));
const logs: string[] = [];
const exitCodes: number[] = [];
vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: {
    log: (line: string) => logs.push(line),
    error: (line: string) => logs.push(`ERR ${line}`),
    exit: (code: number) => exitCodes.push(code),
  },
}));

const { registerMailCli, runMailConnectorsCli } = await import("../cli/mail-cli.js");
const { mailHandlers } = await import("../gateway/server-methods/mail.js");
const { listGatewayMethods } = await import("../gateway/server-methods-list.js");
const { coreGatewayHandlers } = await import("../gateway/server-methods.js");
const { resolveLeastPrivilegeOperatorScopesForMethod } =
  await import("../gateway/method-scopes.js");
const { MailConnectorManager, setActiveMailConnectorManager } = await import("./manager.js");
const { MAIL_CONNECTOR_METHODS } = await import("./ops.js");
const { FakeMailProvider, getFakeMailbox, resetFakeMailboxes } =
  await import("./providers/fake.js");
const helpers = await import("./test-helpers.js");

type Respond = (ok: boolean, payload?: unknown, error?: unknown) => void;

async function viaMethod(method: string, params: Record<string, unknown>) {
  const respond = vi.fn<Respond>();
  await mailHandlers[method]({
    req: { type: "req", id: "1", method, params },
    params,
    respond,
    client: null,
    isWebchatConnect: () => false,
    context: {} as never,
  } as never);
  const [ok, payload, error] = respond.mock.calls[0] ?? [];
  return { ok, payload, error };
}

/** Normalizes the moving clock in status reports. */
function stable(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), (key, v) =>
    key === "now" || key === "stateSince" || key === "updatedAt" ? 0 : v,
  );
}

let manager: InstanceType<typeof MailConnectorManager>;
const PASSWORD = "parity-secret-pw-91c2";

beforeEach(async () => {
  logs.length = 0;
  exitCodes.length = 0;
  const sink = helpers.createRecordingSink();
  manager = new MailConnectorManager({
    log: helpers.createRecordingLogger(),
    sink,
    io: helpers.createMemoryStateIo(),
    statePathFor: (id) => `/state/${id}.json`,
    // An imap connector that never connects: its provider fails before any network use.
    providerFactory: (params) => {
      if (params.config.provider === "imap") {
        return {
          start: async () => {
            throw new Error(`connect refused for password ${params.password}`);
          },
          test: async () => ({ ok: false, detail: `auth failed using ${params.password}` }),
        };
      }
      return new FakeMailProvider(getFakeMailbox(params.config.id));
    },
    retryBaseMs: 60_000,
  });
  const cfg = {
    mail: {
      connectors: [
        helpers.fakeConnectorConfig(),
        {
          id: "remote",
          provider: "imap",
          imap: {
            host: "imap.example.com",
            user: "me@example.com",
            password: PASSWORD,
          },
          attach: [{ agentId: "main", sessionKey: "agent:main:mail:remote" }],
        },
      ],
    },
  } as unknown as OpenClawConfig;
  await manager.start(cfg);
  setActiveMailConnectorManager(manager);
  await helpers.waitFor(() => manager.get("work")?.status().state === "idle");
  await helpers.waitFor(() => manager.get("remote")?.status().state === "backoff");
  callGatewayFromCli.mockImplementation(
    async (method: string, _opts: unknown, params: Record<string, unknown>) => {
      const result = await viaMethod(method, params ?? {});
      if (!result.ok) {
        throw new Error(JSON.stringify(result.error));
      }
      return result.payload;
    },
  );
});

afterEach(async () => {
  setActiveMailConnectorManager(null);
  await manager.stop();
  resetFakeMailboxes();
  callGatewayFromCli.mockReset();
});

describe("mail connectors CLI/gateway parity (§9.12)", () => {
  const cases: Array<{ verb: "list" | "status" | "test" | "restart"; id?: string }> = [
    { verb: "list" },
    { verb: "status" },
    { verb: "status", id: "work" },
    { verb: "test", id: "work" },
    { verb: "restart", id: "work" },
  ];

  it.each(cases)("$verb $id: --json output equals the method result", async ({ verb, id }) => {
    const method = MAIL_CONNECTOR_METHODS[verb];
    const params = id ? { id } : {};
    if (verb === "restart") {
      await helpers.waitFor(() => manager.get("work")?.status().state === "idle");
    }
    const direct = await viaMethod(method, params);
    expect(direct.ok).toBe(true);
    if (verb === "restart") {
      await helpers.waitFor(() => manager.get("work")?.status().state === "idle");
    }
    logs.length = 0;
    await runMailConnectorsCli({ verb, id, opts: { json: true } });
    expect(callGatewayFromCli).toHaveBeenLastCalledWith(method, { json: true }, params);
    expect(logs).toHaveLength(1);
    expect(stable(JSON.parse(logs[0]))).toEqual(stable(direct.payload));
  });

  it("every CLI verb maps to a registered, scoped gateway method", () => {
    const program = new Command();
    registerMailCli(program);
    const connectors = program.commands
      .find((cmd) => cmd.name() === "mail")
      ?.commands.find((cmd) => cmd.name() === "connectors");
    const verbs = connectors?.commands.map((cmd) => cmd.name()).toSorted();
    expect(verbs).toEqual(Object.keys(MAIL_CONNECTOR_METHODS).toSorted());
    for (const cmd of connectors?.commands ?? []) {
      expect(cmd.options.some((option) => option.long === "--json")).toBe(true);
    }
    const methods = new Set(listGatewayMethods());
    for (const method of Object.values(MAIL_CONNECTOR_METHODS)) {
      expect(methods.has(method)).toBe(true);
      expect(typeof coreGatewayHandlers[method]).toBe("function");
    }
    expect(resolveLeastPrivilegeOperatorScopesForMethod("mail.connectors.list")).toEqual([
      "operator.read",
    ]);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("mail.connectors.status")).toEqual([
      "operator.read",
    ]);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("mail.connectors.test")).toEqual([
      "operator.admin",
    ]);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("mail.connectors.restart")).toEqual([
      "operator.admin",
    ]);
  });

  it("human output: one line per connector", async () => {
    await runMailConnectorsCli({ verb: "list", opts: {} });
    expect(logs).toEqual([
      "work: fake [INBOX] idle -> agent:main:mail:work (now)",
      "remote: imap me@example.com@imap.example.com [INBOX] backoff -> agent:main:mail:remote (now)",
    ]);
  });

  it("test with a failing connector exits 1; unknown ids and missing ids are rejected", async () => {
    await runMailConnectorsCli({ verb: "test", id: "remote", opts: { json: true } });
    expect(exitCodes).toEqual([1]);
    expect((await viaMethod("mail.connectors.test", {})).ok).toBe(false);
    const unknown = await viaMethod("mail.connectors.status", { id: "nope" });
    expect(unknown.ok).toBe(false);
    expect(JSON.stringify(unknown.error)).toContain('unknown mail connector \\"nope\\"');
  });

  it("answers UNAVAILABLE when no manager runs", async () => {
    setActiveMailConnectorManager(null);
    const result = await viaMethod("mail.connectors.list", {});
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.error)).toContain("UNAVAILABLE");
  });
});

describe("secrets never leak (§9.11)", () => {
  it("password stays out of status, list, test output, state files and events", async () => {
    getFakeMailbox("work").add({ subject: "hello" });
    const outputs: unknown[] = [];
    for (const method of ["mail.connectors.list", "mail.connectors.status"]) {
      outputs.push((await viaMethod(method, {})).payload);
    }
    outputs.push((await viaMethod("mail.connectors.test", { id: "remote" })).payload);
    outputs.push(manager.status("remote"));
    const text = JSON.stringify(outputs);
    expect(text).not.toContain(PASSWORD);
    expect(text).toContain("[redacted]");
  });
});
