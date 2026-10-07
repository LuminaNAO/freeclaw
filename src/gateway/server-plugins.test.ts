import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { PluginRegistry } from "../plugins/registry.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { PluginDiagnostic } from "../plugins/types.js";
import type { GatewayRequestContext, GatewayRequestOptions } from "./server-methods/types.js";

const loadOpenClawPlugins = vi.hoisted(() => vi.fn());
type HandleGatewayRequestOptions = GatewayRequestOptions & {
  extraHandlers?: Record<string, unknown>;
};
const handleGatewayRequest = vi.hoisted(() =>
  vi.fn(async (_opts: HandleGatewayRequestOptions) => {}),
);

vi.mock("../plugins/loader.js", () => ({
  loadOpenClawPlugins,
}));

vi.mock("./server-methods.js", () => ({
  handleGatewayRequest,
}));

const abortEmbeddedPiRun = vi.hoisted(() => vi.fn((_sessionId: string) => false));
const clearSessionQueues = vi.hoisted(() =>
  vi.fn((_keys: Array<string | undefined>) => ({ followupCleared: 0, laneCleared: 0, keys: [] })),
);
const loadSessionEntry = vi.hoisted(() =>
  vi.fn((_key: string): { entry?: { sessionId?: string } } => ({})),
);

vi.mock("../agents/pi-embedded.js", () => ({ abortEmbeddedPiRun }));
vi.mock("../auto-reply/reply/queue.js", () => ({ clearSessionQueues }));
vi.mock("./session-utils.js", () => ({ loadSessionEntry }));

const createRegistry = (diagnostics: PluginDiagnostic[]): PluginRegistry => ({
  plugins: [],
  tools: [],
  hooks: [],
  typedHooks: [],
  channels: [],
  commands: [],
  providers: [],
  gatewayHandlers: {},
  httpRoutes: [],
  cliRegistrars: [],
  services: [],
  diagnostics,
});

type ServerPluginsModule = typeof import("./server-plugins.js");

function createTestContext(label: string): GatewayRequestContext {
  return { label } as unknown as GatewayRequestContext;
}

function getLastDispatchedContext(): GatewayRequestContext | undefined {
  const call = handleGatewayRequest.mock.calls.at(-1)?.[0];
  return call?.context;
}

async function importServerPluginsModule(): Promise<ServerPluginsModule> {
  return import("./server-plugins.js");
}

function createSubagentRuntime(serverPlugins: ServerPluginsModule): PluginRuntime["subagent"] {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  loadOpenClawPlugins.mockReturnValue(createRegistry([]));
  serverPlugins.loadGatewayPlugins({
    cfg: {},
    workspaceDir: "/tmp",
    log,
    coreGatewayHandlers: {},
    baseMethods: [],
  });
  const call = loadOpenClawPlugins.mock.calls.at(-1)?.[0] as
    | { runtimeOptions?: { subagent?: PluginRuntime["subagent"] } }
    | undefined;
  if (!call?.runtimeOptions?.subagent) {
    throw new Error("Expected loadGatewayPlugins to provide subagent runtime");
  }
  return call.runtimeOptions.subagent;
}

beforeEach(() => {
  loadOpenClawPlugins.mockReset();
  handleGatewayRequest.mockReset();
  abortEmbeddedPiRun.mockClear();
  clearSessionQueues.mockClear();
  loadSessionEntry.mockClear();
  handleGatewayRequest.mockImplementation(async (opts: HandleGatewayRequestOptions) => {
    switch (opts.req.method) {
      case "agent":
        opts.respond(true, { runId: "run-1" });
        return;
      case "agent.wait":
        opts.respond(true, { status: "ok" });
        return;
      case "sessions.get":
        opts.respond(true, { messages: [] });
        return;
      case "sessions.delete":
        opts.respond(true, {});
        return;
      case "sessions.patch":
        opts.respond(true, {
          ok: true,
          resolved: { modelProvider: "provider-a", model: "model-a" },
        });
        return;
      default:
        opts.respond(true, {});
    }
  });
});

afterEach(() => {
  vi.resetModules();
});

describe("loadGatewayPlugins", () => {
  test("logs plugin errors with details", async () => {
    const { loadGatewayPlugins } = await importServerPluginsModule();
    const diagnostics: PluginDiagnostic[] = [
      {
        level: "error",
        pluginId: "telegram",
        source: "/tmp/telegram/index.ts",
        message: "failed to load plugin: boom",
      },
    ];
    loadOpenClawPlugins.mockReturnValue(createRegistry(diagnostics));

    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    loadGatewayPlugins({
      cfg: {},
      workspaceDir: "/tmp",
      log,
      coreGatewayHandlers: {},
      baseMethods: [],
    });

    expect(log.error).toHaveBeenCalledWith(
      "[plugins] failed to load plugin: boom (plugin=telegram, source=/tmp/telegram/index.ts)",
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  test("provides subagent runtime with sessions.get method aliases", async () => {
    const { loadGatewayPlugins } = await importServerPluginsModule();
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));

    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    loadGatewayPlugins({
      cfg: {},
      workspaceDir: "/tmp",
      log,
      coreGatewayHandlers: {},
      baseMethods: [],
    });

    const call = loadOpenClawPlugins.mock.calls.at(-1)?.[0];
    const subagent = call?.runtimeOptions?.subagent;
    expect(typeof subagent?.getSessionMessages).toBe("function");
    expect(typeof subagent?.getSession).toBe("function");
  });

  test("shares fallback context across module reloads for existing runtimes", async () => {
    const first = await importServerPluginsModule();
    const runtime = createSubagentRuntime(first);

    const staleContext = createTestContext("stale");
    first.setFallbackGatewayContext(staleContext);
    await runtime.run({ sessionKey: "s-1", message: "hello" });
    expect(getLastDispatchedContext()).toBe(staleContext);

    vi.resetModules();
    const reloaded = await importServerPluginsModule();
    const freshContext = createTestContext("fresh");
    reloaded.setFallbackGatewayContext(freshContext);

    await runtime.run({ sessionKey: "s-1", message: "hello again" });
    expect(getLastDispatchedContext()).toBe(freshContext);
  });

  test("uses updated fallback context after context replacement", async () => {
    const serverPlugins = await importServerPluginsModule();
    const runtime = createSubagentRuntime(serverPlugins);
    const firstContext = createTestContext("before-restart");
    const secondContext = createTestContext("after-restart");

    serverPlugins.setFallbackGatewayContext(firstContext);
    await runtime.run({ sessionKey: "s-2", message: "before restart" });
    expect(getLastDispatchedContext()).toBe(firstContext);

    serverPlugins.setFallbackGatewayContext(secondContext);
    await runtime.run({ sessionKey: "s-2", message: "after restart" });
    expect(getLastDispatchedContext()).toBe(secondContext);
  });

  test("reflects fallback context object mutation at dispatch time", async () => {
    const serverPlugins = await importServerPluginsModule();
    const runtime = createSubagentRuntime(serverPlugins);
    const context = { marker: "before-mutation" } as GatewayRequestContext & {
      marker: string;
    };

    serverPlugins.setFallbackGatewayContext(context);
    context.marker = "after-mutation";

    await runtime.run({ sessionKey: "s-3", message: "mutated context" });
    const dispatched = getLastDispatchedContext() as
      | (GatewayRequestContext & { marker: string })
      | undefined;
    expect(dispatched?.marker).toBe("after-mutation");
  });
});

describe("subagent runtime session control", () => {
  test("patchSession dispatches sessions.patch and returns the resolved model", async () => {
    const serverPlugins = await importServerPluginsModule();
    const runtime = createSubagentRuntime(serverPlugins);
    serverPlugins.setFallbackGatewayContext(createTestContext("patch"));

    const result = await runtime.patchSession({
      sessionKey: "agent:main:worker",
      model: "provider-a/model-a",
      thinkingLevel: "high",
      label: "worker",
    });

    expect(result).toEqual({ provider: "provider-a", model: "model-a" });
    const req = handleGatewayRequest.mock.calls.at(-1)?.[0].req;
    expect(req?.method).toBe("sessions.patch");
    expect(req?.params).toEqual({
      key: "agent:main:worker",
      model: "provider-a/model-a",
      thinkingLevel: "high",
      label: "worker",
    });
  });

  test("patchSession omits fields that were not given", async () => {
    const serverPlugins = await importServerPluginsModule();
    const runtime = createSubagentRuntime(serverPlugins);
    serverPlugins.setFallbackGatewayContext(createTestContext("patch-min"));

    await runtime.patchSession({ sessionKey: "agent:main:worker" });

    expect(handleGatewayRequest.mock.calls.at(-1)?.[0].req.params).toEqual({
      key: "agent:main:worker",
    });
  });

  test("patchSession surfaces a gateway rejection (e.g. model not allowed)", async () => {
    const serverPlugins = await importServerPluginsModule();
    const runtime = createSubagentRuntime(serverPlugins);
    serverPlugins.setFallbackGatewayContext(createTestContext("patch-reject"));
    handleGatewayRequest.mockImplementationOnce(async (opts: HandleGatewayRequestOptions) => {
      opts.respond(false, undefined, { code: "INVALID_REQUEST", message: "model not allowed" });
    });

    await expect(
      runtime.patchSession({ sessionKey: "agent:main:worker", model: "provider-x/model-x" }),
    ).rejects.toThrow("model not allowed");
  });

  test("abortSession aborts the session's embedded run and clears its queues", async () => {
    const serverPlugins = await importServerPluginsModule();
    const runtime = createSubagentRuntime(serverPlugins);
    loadSessionEntry.mockReturnValueOnce({ entry: { sessionId: "session-1" } });
    abortEmbeddedPiRun.mockReturnValueOnce(true);

    await expect(runtime.abortSession({ sessionKey: "agent:main:worker" })).resolves.toEqual({
      aborted: true,
    });
    expect(abortEmbeddedPiRun).toHaveBeenCalledWith("session-1");
    expect(clearSessionQueues).toHaveBeenCalledWith(["agent:main:worker", "session-1"]);
  });

  test("abortSession reports nothing aborted for an idle or unknown session", async () => {
    const serverPlugins = await importServerPluginsModule();
    const runtime = createSubagentRuntime(serverPlugins);
    loadSessionEntry.mockReturnValueOnce({});

    await expect(runtime.abortSession({ sessionKey: "agent:main:idle" })).resolves.toEqual({
      aborted: false,
    });
    expect(abortEmbeddedPiRun).not.toHaveBeenCalled();
  });
});
