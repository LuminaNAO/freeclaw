import type { Server } from "node:http";
import { startBrowserMemoryWatchdog } from "./memory-watchdog.js";
import { isPwAiLoaded } from "./pw-ai-state.js";
import { type BrowserServerState, createBrowserRouteContext } from "./server-context.js";
import { ensureExtensionRelayForProfiles, stopKnownBrowserProfiles } from "./server-lifecycle.js";

export async function createBrowserRuntimeState(params: {
  resolved: BrowserServerState["resolved"];
  port: number;
  server?: Server | null;
  onWarn: (message: string) => void;
}): Promise<BrowserServerState> {
  const state: BrowserServerState = {
    server: params.server ?? null,
    port: params.port,
    resolved: params.resolved,
    profiles: new Map(),
  };

  await ensureExtensionRelayForProfiles({
    resolved: params.resolved,
    onWarn: params.onWarn,
  });

  // ARCH §2.4: watch the memory of browsers freeclaw launches (off when memoryLimitMb is 0).
  const ctx = createBrowserRouteContext({ getState: () => state, refreshConfigFromDisk: true });
  state.memoryWatchdog = startBrowserMemoryWatchdog({
    getState: () => state,
    deps: { forProfile: (name) => ctx.forProfile(name) },
  });

  return state;
}

export async function stopBrowserRuntime(params: {
  current: BrowserServerState | null;
  getState: () => BrowserServerState | null;
  clearState: () => void;
  closeServer?: boolean;
  onWarn: (message: string) => void;
}): Promise<void> {
  if (!params.current) {
    return;
  }

  params.current.memoryWatchdog?.stop();
  params.current.memoryWatchdog = null;

  await stopKnownBrowserProfiles({
    getState: params.getState,
    onWarn: params.onWarn,
  });

  if (params.closeServer && params.current.server) {
    await new Promise<void>((resolve) => {
      params.current?.server?.close(() => resolve());
    });
  }

  params.clearState();

  if (!isPwAiLoaded()) {
    return;
  }
  try {
    const mod = await import("./pw-ai.js");
    await mod.closePlaywrightBrowserConnection();
  } catch {
    // ignore
  }
}
