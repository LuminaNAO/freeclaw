import { describe, expect, it, vi } from "vitest";
import {
  createMockSignalDaemonHandle,
  getSignalToolResultTestMocks,
  installSignalToolResultTestHooks,
  setSignalToolResultTestConfig,
} from "./monitor.tool-result.test-harness.js";

installSignalToolResultTestHooks();

// Import after the harness registers `vi.mock(...)` for Signal internals.
const { monitorSignalProvider } = await import("./monitor.js");

const { streamMock, spawnSignalDaemonMock, signalRpcRequestMock, socketDirMocks } =
  getSignalToolResultTestMocks();

type MonitorSignalProviderOptions = Parameters<typeof monitorSignalProvider>[0];

function createMonitorRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: ((code: number): never => {
      throw new Error(`exit ${code}`);
    }) as (code: number) => never,
  };
}

// httpPort within the preferred 56xxx range so monitor neither picks a fresh
// port nor persists a migration via writeConfigFile during tests.
function setAutoStartSignalConfig(overrides: Record<string, unknown> = {}) {
  setSignalToolResultTestConfig({
    channels: {
      signal: {
        autoStart: true,
        account: "+15550001111",
        httpPort: 56123,
        dmPolicy: "open",
        allowFrom: ["*"],
        ...overrides,
      },
    },
  });
}

async function runMonitorUntilSseAttach(runtime: ReturnType<typeof createMonitorRuntime>) {
  const abortController = new AbortController();
  // First SSE attach aborts the monitor, ending the run loop cleanly.
  streamMock.mockImplementation(async () => {
    abortController.abort();
  });
  spawnSignalDaemonMock.mockReturnValue(createMockSignalDaemonHandle());
  await monitorSignalProvider({
    abortSignal: abortController.signal,
    runtime,
  } as MonitorSignalProviderOptions);
}

describe.each([
  ["socket (default)", {}],
  ["http (explicit)", { transport: "http" }],
] as Array<[string, Record<string, unknown>]>)(
  "signal monitor receive-mode hardening: %s",
  (_name, transport) => {
    it('spawns the daemon with receiveMode "manual" even when config requests "on-start"', async () => {
      setAutoStartSignalConfig({ ...transport, receiveMode: "on-start" });
      const runtime = createMonitorRuntime();

      await runMonitorUntilSseAttach(runtime);

      expect(spawnSignalDaemonMock).toHaveBeenCalledTimes(1);
      expect(spawnSignalDaemonMock.mock.calls[0]?.[0]).toMatchObject({ receiveMode: "manual" });
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining('ignoring receiveMode "on-start"'),
      );
    });

    it('spawns with receiveMode "manual" by default without a receive-mode warning', async () => {
      setAutoStartSignalConfig(transport);
      const runtime = createMonitorRuntime();

      await runMonitorUntilSseAttach(runtime);

      expect(spawnSignalDaemonMock).toHaveBeenCalledTimes(1);
      expect(spawnSignalDaemonMock.mock.calls[0]?.[0]).toMatchObject({ receiveMode: "manual" });
      expect(runtime.error).not.toHaveBeenCalledWith(expect.stringContaining("receiveMode"));
    });

    it("never issues a receive RPC after SSE attach (queued messages flush via the SSE subscription)", async () => {
      setAutoStartSignalConfig(transport);
      const runtime = createMonitorRuntime();

      await runMonitorUntilSseAttach(runtime);

      const receiveCalls = signalRpcRequestMock.mock.calls.filter((call) => call[0] === "receive");
      expect(receiveCalls).toHaveLength(0);
    });
  },
);

describe("signal monitor transport selection", () => {
  it("socket default: spawns --socket listener, never persists an HTTP port, enforces socket mode", async () => {
    setAutoStartSignalConfig();
    const runtime = createMonitorRuntime();

    await runMonitorUntilSseAttach(runtime);

    const opts = spawnSignalDaemonMock.mock.calls[0]?.[0] as {
      listener: { kind: string; path: string };
    };
    expect(opts.listener.kind).toBe("socket");
    expect(opts.listener.path).toMatch(/default\.sock$/);
    expect(socketDirMocks.ensureSignalSocketDir).toHaveBeenCalledTimes(1);
    expect(socketDirMocks.clearStaleSignalSocket).toHaveBeenCalledTimes(1);
    expect(socketDirMocks.enforceSignalSocketMode).toHaveBeenCalledWith({
      socketPath: opts.listener.path,
      gid: undefined,
    });
    expect(streamMock.mock.calls[0]?.[0]).toMatchObject({ baseUrl: `unix:${opts.listener.path}` });
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("ignoring httpHost/httpPort"));
    expect(runtime.error).not.toHaveBeenCalledWith(expect.stringContaining("no authentication"));
  });

  it("explicit http: spawns --http listener and warns about missing authentication", async () => {
    setAutoStartSignalConfig({ transport: "http" });
    const runtime = createMonitorRuntime();

    await runMonitorUntilSseAttach(runtime);

    const opts = spawnSignalDaemonMock.mock.calls[0]?.[0] as { listener: Record<string, unknown> };
    expect(opts.listener).toEqual({ kind: "http", host: "127.0.0.1", port: 56123 });
    expect(socketDirMocks.ensureSignalSocketDir).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("no authentication"));
  });

  it("external socket daemon (autoStart:false + socketPath): no spawn, directory verified", async () => {
    setAutoStartSignalConfig({ autoStart: false, socketPath: "/run/user/1001/signal-cli/socket" });
    const runtime = createMonitorRuntime();

    await runMonitorUntilSseAttach(runtime);

    expect(spawnSignalDaemonMock).not.toHaveBeenCalled();
    expect(socketDirMocks.assertExternalSocketDirSafe).toHaveBeenCalledWith(
      "/run/user/1001/signal-cli/socket",
    );
    expect(streamMock.mock.calls[0]?.[0]).toMatchObject({
      baseUrl: "unix:/run/user/1001/signal-cli/socket",
    });
  });

  it.each([
    ["baseUrl", { baseUrl: "http://127.0.0.1:9" }],
    ["httpPort", { httpPort: 56999 }],
  ])(
    "explicit %s monitor option means HTTP, never a silently ignored socket",
    async (_k, extra) => {
      setAutoStartSignalConfig();
      const runtime = createMonitorRuntime();
      const abortController = new AbortController();
      streamMock.mockImplementation(async () => abortController.abort());
      await monitorSignalProvider({
        abortSignal: abortController.signal,
        runtime,
        ...extra,
      } as MonitorSignalProviderOptions);
      expect(socketDirMocks.ensureSignalSocketDir).not.toHaveBeenCalled();
      expect(String(streamMock.mock.calls[0]?.[0]?.baseUrl)).toMatch(/^http:\/\//);
    },
  );

  it("explicit HTTP monitor options conflict with transport=socket", async () => {
    setAutoStartSignalConfig({ transport: "socket" });
    const runtime = createMonitorRuntime();
    await expect(
      monitorSignalProvider({ runtime, httpPort: 56999 } as MonitorSignalProviderOptions),
    ).rejects.toThrow(/conflict with channels.signal.transport="socket"/);
    expect(spawnSignalDaemonMock).not.toHaveBeenCalled();
  });

  it("conflicting transport config fails closed before spawning anything", async () => {
    setAutoStartSignalConfig({ socketPath: "/x/d.sock", httpUrl: "http://127.0.0.1:8080" });
    const runtime = createMonitorRuntime();

    await expect(runMonitorUntilSseAttach(runtime)).rejects.toThrow(
      /configure exactly one transport/,
    );
    expect(spawnSignalDaemonMock).not.toHaveBeenCalled();
    expect(streamMock).not.toHaveBeenCalled();
  });
});

describe("trust gate endpoint classification", () => {
  it("treats the unix socket transport as local, never as a remote endpoint", async () => {
    const { classifySignalEndpoint } = await import("./monitor.js");
    expect(classifySignalEndpoint("unix:/run/user/1001/openclaw-signal/default.sock")).toBe(
      "unix-socket",
    );
    expect(classifySignalEndpoint("http://127.0.0.1:56123")).toBe("loopback");
    expect(classifySignalEndpoint("http://[::1]:8080")).toBe("loopback");
    expect(classifySignalEndpoint("http://10.0.0.5:8080")).toBe("remote");
    expect(classifySignalEndpoint("unix:relative.sock")).toBe("remote");
  });

  it("socket default with the gate enforcing logs endpoint=unix-socket and no remote warning", async () => {
    vi.stubEnv("OPENCLAW_SIGNAL_TRUST_GATE", "enforce");
    setAutoStartSignalConfig();
    const runtime = createMonitorRuntime();
    await runMonitorUntilSseAttach(runtime);
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("endpoint=unix-socket"));
    expect(runtime.error).not.toHaveBeenCalledWith(expect.stringContaining("not loopback"));
  });
});
