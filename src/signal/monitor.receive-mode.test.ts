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

const { streamMock, spawnSignalDaemonMock, signalRpcRequestMock } = getSignalToolResultTestMocks();

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

describe("signal monitor receive-mode hardening", () => {
  it('spawns the daemon with receiveMode "manual" even when config requests "on-start"', async () => {
    setAutoStartSignalConfig({ receiveMode: "on-start" });
    const runtime = createMonitorRuntime();

    await runMonitorUntilSseAttach(runtime);

    expect(spawnSignalDaemonMock).toHaveBeenCalledTimes(1);
    expect(spawnSignalDaemonMock.mock.calls[0]?.[0]).toMatchObject({ receiveMode: "manual" });
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining('ignoring receiveMode "on-start"'),
    );
  });

  it('spawns with receiveMode "manual" by default without warning', async () => {
    setAutoStartSignalConfig();
    const runtime = createMonitorRuntime();

    await runMonitorUntilSseAttach(runtime);

    expect(spawnSignalDaemonMock).toHaveBeenCalledTimes(1);
    expect(spawnSignalDaemonMock.mock.calls[0]?.[0]).toMatchObject({ receiveMode: "manual" });
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("never issues a receive RPC after SSE attach (queued messages flush via the SSE subscription)", async () => {
    setAutoStartSignalConfig();
    const runtime = createMonitorRuntime();

    await runMonitorUntilSseAttach(runtime);

    const receiveCalls = signalRpcRequestMock.mock.calls.filter((call) => call[0] === "receive");
    expect(receiveCalls).toHaveLength(0);
  });
});
