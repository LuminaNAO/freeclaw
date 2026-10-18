import { afterEach, describe, expect, it, vi } from "vitest";
import "../server-context.chrome-test-harness.js";
import * as chromeModule from "../chrome.js";
import * as memoryCap from "../memory-cap.js";
import { createBrowserRouteContext } from "../server-context.js";
import { makeState, originalFetch } from "../server-context.remote-tab-ops.harness.js";
import { createBrowserRouteDispatcher } from "./dispatcher.js";

const MiB = 1024 * 1024;

function withTabs(count: number) {
  const tabs = Array.from({ length: count }, (_, i) => ({
    id: `T${i}`,
    title: "",
    url: `https://example.com/${i}`,
    webSocketDebuggerUrl: `ws://127.0.0.1/devtools/page/T${i}`,
    type: "page",
  }));
  globalThis.fetch = vi.fn(async (url: unknown) => {
    if (String(url).includes("/json/list")) {
      return { ok: true, json: async () => tabs } as unknown as Response;
    }
    throw new Error(`unexpected fetch: ${String(url)}`);
  }) as typeof fetch;
}

function seedLaunched(state: ReturnType<typeof makeState>, mode: "kernel" | "soft") {
  (state.profiles as Map<string, unknown>).set("openclaw", {
    profile: { name: "openclaw" },
    running: {
      pid: 4242,
      exe: { kind: "chromium", path: "/usr/bin/chromium" },
      userDataDir: "/tmp/x",
      proc: { on: vi.fn() },
      memoryCap: { mode, limitMb: 4096 },
    },
    lastTargetId: null,
  });
}

describe("browser status memory fields (ARCH §2.5-§2.6)", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("GET / reports RSS, cap, tab count and kernel enforcement for the launched browser", async () => {
    withTabs(3);
    vi.spyOn(memoryCap, "measureBrowserTreeRssBytes").mockResolvedValue(2048 * MiB);
    const state = makeState("openclaw");
    state.resolved.memoryLimitMb = 4096;
    seedLaunched(state, "kernel");
    const dispatcher = createBrowserRouteDispatcher(
      createBrowserRouteContext({ getState: () => state }),
    );
    const res = await dispatcher.dispatch({ method: "GET", path: "/", query: {} });
    expect(res.status).toBe(200);
    expect((res.body as { memory?: unknown }).memory).toEqual({
      scope: "managed",
      capMode: "kernel",
      capMb: 4096,
      kernelEnforced: true,
      rssMb: 2048,
      tabCount: 3,
    });
  });

  it("GET /memory lists managed and external profiles without touching external ones", async () => {
    withTabs(2);
    const measure = vi.spyOn(memoryCap, "measureBrowserTreeRssBytes").mockResolvedValue(512 * MiB);
    const reachable = vi.mocked(chromeModule.isChromeReachable);
    reachable.mockClear();
    const state = makeState("openclaw");
    state.resolved.memoryLimitMb = 4096;
    state.resolved.profiles.user = {
      driver: "existing-session",
      attachOnly: true,
      color: "#00AA00",
    };
    seedLaunched(state, "soft");
    const dispatcher = createBrowserRouteDispatcher(
      createBrowserRouteContext({ getState: () => state }),
    );
    const res = await dispatcher.dispatch({ method: "GET", path: "/memory", query: {} });
    expect(res.status).toBe(200);
    const body = res.body as {
      memoryLimitMb: number;
      profiles: Array<{
        name: string;
        scope: string;
        kernelEnforced: boolean;
        tabCount: number | null;
      }>;
    };
    expect(body.memoryLimitMb).toBe(4096);
    const byName = Object.fromEntries(body.profiles.map((p) => [p.name, p]));
    expect(byName.openclaw).toMatchObject({
      scope: "managed",
      capMode: "soft",
      kernelEnforced: false,
      rssMb: 512,
      tabCount: 2,
      running: true,
    });
    expect(byName.remote).toMatchObject({ scope: "external", rssMb: null });
    expect(byName.user).toMatchObject({ scope: "external", rssMb: null });
    expect(measure).toHaveBeenCalledTimes(1);
    expect(measure).toHaveBeenCalledWith(4242);
    // External profiles are never probed.
    expect(reachable).not.toHaveBeenCalledWith(
      expect.stringContaining("browserless"),
      expect.anything(),
    );
  });
});
