import chokidar from "chokidar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listChannelPlugins } from "../channels/plugins/index.js";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  buildGatewayReloadPlan,
  type GatewayReloadPlan,
  diffConfigPaths,
  resolveGatewayReloadSettings,
  startGatewayConfigReloader,
} from "./config-reload.js";

describe("diffConfigPaths", () => {
  it("captures nested config changes", () => {
    const prev = { hooks: { gmail: { account: "a" } } };
    const next = { hooks: { gmail: { account: "b" } } };
    const paths = diffConfigPaths(prev, next);
    expect(paths).toContain("hooks.gmail.account");
  });

  it("captures array changes", () => {
    const prev = { messages: { groupChat: { mentionPatterns: ["a"] } } };
    const next = { messages: { groupChat: { mentionPatterns: ["b"] } } };
    const paths = diffConfigPaths(prev, next);
    expect(paths).toContain("messages.groupChat.mentionPatterns");
  });

  it("does not report unchanged arrays of objects as changed", () => {
    const prev = {
      memory: {
        qmd: {
          paths: [{ path: "~/docs", pattern: "**/*.md", name: "docs" }],
          scope: {
            rules: [{ when: { channel: "slack" }, include: ["docs"] }],
          },
        },
      },
    };
    const next = {
      memory: {
        qmd: {
          paths: [{ path: "~/docs", pattern: "**/*.md", name: "docs" }],
          scope: {
            rules: [{ when: { channel: "slack" }, include: ["docs"] }],
          },
        },
      },
    };
    expect(diffConfigPaths(prev, next)).toEqual([]);
  });

  it("reports changed arrays of objects", () => {
    const prev = {
      memory: {
        qmd: {
          paths: [{ path: "~/docs", pattern: "**/*.md", name: "docs" }],
        },
      },
    };
    const next = {
      memory: {
        qmd: {
          paths: [{ path: "~/docs", pattern: "**/*.txt", name: "docs" }],
        },
      },
    };
    expect(diffConfigPaths(prev, next)).toContain("memory.qmd.paths");
  });
});

describe("buildGatewayReloadPlan", () => {
  const emptyRegistry = createTestRegistry([]);
  const telegramPlugin: ChannelPlugin = {
    id: "telegram",
    meta: {
      id: "telegram",
      label: "Telegram",
      selectionLabel: "Telegram",
      docsPath: "/channels/telegram",
      blurb: "test",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => [],
      resolveAccount: () => ({}),
    },
    reload: { configPrefixes: ["channels.telegram"] },
  };
  const whatsappPlugin: ChannelPlugin = {
    id: "whatsapp",
    meta: {
      id: "whatsapp",
      label: "WhatsApp",
      selectionLabel: "WhatsApp",
      docsPath: "/channels/whatsapp",
      blurb: "test",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => [],
      resolveAccount: () => ({}),
    },
    reload: { configPrefixes: ["web"], noopPrefixes: ["channels.whatsapp"] },
  };
  const registry = createTestRegistry([
    { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
    { pluginId: "whatsapp", plugin: whatsappPlugin, source: "test" },
  ]);

  beforeEach(() => {
    setActivePluginRegistry(registry);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("marks gateway changes as restart required", () => {
    const plan = buildGatewayReloadPlan(["gateway.port"]);
    expect(plan.restartGateway).toBe(true);
    expect(plan.restartReasons).toContain("gateway.port");
  });

  it("restarts the Gmail watcher for hooks.gmail changes", () => {
    const plan = buildGatewayReloadPlan(["hooks.gmail.account"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.restartGmailWatcher).toBe(true);
    expect(plan.reloadHooks).toBe(true);
  });

  it("restarts providers when provider config prefixes change", () => {
    const changedPaths = ["web.enabled", "channels.telegram.botToken"];
    const plan = buildGatewayReloadPlan(changedPaths);
    expect(plan.restartGateway).toBe(false);
    const expected = new Set(
      listChannelPlugins()
        .filter((plugin) =>
          (plugin.reload?.configPrefixes ?? []).some((prefix) =>
            changedPaths.some((path) => path === prefix || path.startsWith(`${prefix}.`)),
          ),
        )
        .map((plugin) => plugin.id),
    );
    expect(expected.size).toBeGreaterThan(0);
    expect(plan.restartChannels).toEqual(expected);
  });

  it("restarts heartbeat when model-related config changes", () => {
    const plan = buildGatewayReloadPlan([
      "models.providers.openai.models",
      "agents.defaults.model",
    ]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.restartHeartbeat).toBe(true);
    expect(plan.hotReasons).toEqual(
      expect.arrayContaining(["models.providers.openai.models", "agents.defaults.model"]),
    );
  });

  it("restarts heartbeat when agents.defaults.models allowlist changes", () => {
    const plan = buildGatewayReloadPlan(["agents.defaults.models"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.restartHeartbeat).toBe(true);
    expect(plan.hotReasons).toContain("agents.defaults.models");
    expect(plan.noopPaths).toEqual([]);
  });

  it("hot-reloads health monitor when channelHealthCheckMinutes changes", () => {
    const plan = buildGatewayReloadPlan(["gateway.channelHealthCheckMinutes"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.restartHealthMonitor).toBe(true);
    expect(plan.hotReasons).toContain("gateway.channelHealthCheckMinutes");
  });

  it("treats gateway.remote as no-op", () => {
    const plan = buildGatewayReloadPlan(["gateway.remote.url"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.noopPaths).toContain("gateway.remote.url");
  });

  it("treats secrets config changes as no-op for gateway restart planning", () => {
    const plan = buildGatewayReloadPlan(["secrets.providers.default.path"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.noopPaths).toContain("secrets.providers.default.path");
  });

  it("treats diagnostics.stuckSessionWarnMs as no-op for gateway restart planning", () => {
    const plan = buildGatewayReloadPlan(["diagnostics.stuckSessionWarnMs"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.noopPaths).toContain("diagnostics.stuckSessionWarnMs");
  });

  it("defaults unknown paths to restart", () => {
    const plan = buildGatewayReloadPlan(["unknownField"]);
    expect(plan.restartGateway).toBe(true);
  });

  it.each([
    {
      path: "gateway.channelHealthCheckMinutes",
      expectRestartGateway: false,
      expectHotPath: "gateway.channelHealthCheckMinutes",
      expectRestartHealthMonitor: true,
    },
    {
      path: "hooks.gmail.account",
      expectRestartGateway: false,
      expectHotPath: "hooks.gmail.account",
      expectRestartGmailWatcher: true,
      expectReloadHooks: true,
    },
    {
      path: "gateway.remote.url",
      expectRestartGateway: false,
      expectNoopPath: "gateway.remote.url",
    },
    {
      path: "unknownField",
      expectRestartGateway: true,
      expectRestartReason: "unknownField",
    },
  ])("classifies reload path: $path", (testCase) => {
    const plan = buildGatewayReloadPlan([testCase.path]);
    expect(plan.restartGateway).toBe(testCase.expectRestartGateway);
    if (testCase.expectHotPath) {
      expect(plan.hotReasons).toContain(testCase.expectHotPath);
    }
    if (testCase.expectNoopPath) {
      expect(plan.noopPaths).toContain(testCase.expectNoopPath);
    }
    if (testCase.expectRestartReason) {
      expect(plan.restartReasons).toContain(testCase.expectRestartReason);
    }
    if (testCase.expectRestartHealthMonitor) {
      expect(plan.restartHealthMonitor).toBe(true);
    }
    if (testCase.expectRestartGmailWatcher) {
      expect(plan.restartGmailWatcher).toBe(true);
    }
    if (testCase.expectReloadHooks) {
      expect(plan.reloadHooks).toBe(true);
    }
  });
});

describe("resolveGatewayReloadSettings", () => {
  it("uses defaults when unset", () => {
    const settings = resolveGatewayReloadSettings({});
    expect(settings.mode).toBe("hybrid");
    expect(settings.debounceMs).toBe(300);
  });
});

type WatcherHandler = () => void;
type WatcherEvent = "add" | "change" | "unlink" | "error";

function createWatcherMock() {
  const handlers = new Map<WatcherEvent, WatcherHandler[]>();
  return {
    on(event: WatcherEvent, handler: WatcherHandler) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
      return this;
    },
    emit(event: WatcherEvent) {
      for (const handler of handlers.get(event) ?? []) {
        handler();
      }
    },
    close: vi.fn(async () => {}),
  };
}

function makeSnapshot(partial: Partial<ConfigFileSnapshot> = {}): ConfigFileSnapshot {
  return {
    path: "/tmp/openclaw.json",
    exists: true,
    raw: "{}",
    parsed: {},
    resolved: {},
    valid: true,
    config: {},
    issues: [],
    warnings: [],
    legacyIssues: [],
    ...partial,
  };
}

function createReloaderHarness(readSnapshot: () => Promise<ConfigFileSnapshot>) {
  const watcher = createWatcherMock();
  vi.spyOn(chokidar, "watch").mockReturnValue(watcher as unknown as never);
  const onHotReload = vi.fn(async () => {});
  const onRestart = vi.fn();
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const reloader = startGatewayConfigReloader({
    initialConfig: { gateway: { reload: { debounceMs: 0 } } },
    readSnapshot,
    onHotReload,
    onRestart,
    log,
    watchPath: "/tmp/openclaw.json",
  });
  return { watcher, onHotReload, onRestart, log, reloader };
}

describe("startGatewayConfigReloader", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries missing snapshots and reloads once config file reappears", async () => {
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(makeSnapshot({ exists: false, raw: null, hash: "missing-1" }))
      .mockResolvedValueOnce(
        makeSnapshot({
          config: {
            gateway: { reload: { debounceMs: 0 } },
            hooks: { enabled: true },
          },
          hash: "next-1",
        }),
      );
    const { watcher, onHotReload, onRestart, log, reloader } = createReloaderHarness(readSnapshot);

    watcher.emit("unlink");
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(150);

    expect(readSnapshot).toHaveBeenCalledTimes(2);
    expect(onHotReload).toHaveBeenCalledTimes(1);
    expect(onRestart).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith("config reload retry (1/2): config file not found");
    expect(log.warn).not.toHaveBeenCalledWith("config reload skipped (config file not found)");

    await reloader.stop();
  });

  it("caps missing-file retries and skips reload after retry budget is exhausted", async () => {
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValue(makeSnapshot({ exists: false, raw: null, hash: "missing" }));
    const { watcher, onHotReload, onRestart, log, reloader } = createReloaderHarness(readSnapshot);

    watcher.emit("unlink");
    await vi.runAllTimersAsync();

    expect(readSnapshot).toHaveBeenCalledTimes(3);
    expect(onHotReload).not.toHaveBeenCalled();
    expect(onRestart).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith("config reload skipped (config file not found)");

    await reloader.stop();
  });

  it("contains restart callback failures and retries on subsequent changes", async () => {
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(
        makeSnapshot({
          config: {
            gateway: { reload: { debounceMs: 0 }, port: 18790 },
          },
          hash: "restart-1",
        }),
      )
      .mockResolvedValueOnce(
        makeSnapshot({
          config: {
            gateway: { reload: { debounceMs: 0 }, port: 18791 },
          },
          hash: "restart-2",
        }),
      );
    const { watcher, onHotReload, onRestart, log, reloader } = createReloaderHarness(readSnapshot);
    onRestart.mockRejectedValueOnce(new Error("restart-check failed"));
    onRestart.mockResolvedValueOnce(undefined);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      watcher.emit("change");
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();

      expect(onHotReload).not.toHaveBeenCalled();
      expect(onRestart).toHaveBeenCalledTimes(1);
      expect(log.error).toHaveBeenCalledWith("config restart failed: Error: restart-check failed");
      expect(unhandled).toEqual([]);

      watcher.emit("change");
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();

      expect(onRestart).toHaveBeenCalledTimes(2);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await reloader.stop();
    }
  });
});

// docs/design/config-reload.md, "2026-11-12 Reload baseline must be comparable with the reload
// snapshot": the reloader baseline must be the same kind of config as every later snapshot.
describe("startGatewayConfigReloader baseline vs SecretRef snapshot", () => {
  const emptyRegistry = createTestRegistry([]);
  const signalPlugin: ChannelPlugin = {
    ...createChannelTestPluginBase({ id: "signal", label: "Signal" }),
    reload: { configPrefixes: ["channels.signal"] },
  };
  const msteamsPlugin: ChannelPlugin = {
    ...createChannelTestPluginBase({ id: "msteams", label: "Microsoft Teams" }),
    reload: { configPrefixes: ["channels.msteams"] },
  };
  const registry = createTestRegistry([
    { pluginId: "signal", plugin: signalPlugin, source: "test" },
    { pluginId: "msteams", plugin: msteamsPlugin, source: "test" },
  ]);

  const providerKeyRef = { source: "file", provider: "testkeys", id: "/providers/x" } as const;
  const teamsPasswordRef = { source: "file", provider: "testkeys", id: "/msteams/app" } as const;

  type SecretRefLike = { source: "file"; provider: string; id: string };

  function buildConfig(params: {
    providerApiKey: string | SecretRefLike;
    teamsAppPassword: string | SecretRefLike;
    heartbeatEvery?: string;
    signalAllowFrom?: string[];
  }): OpenClawConfig {
    return {
      gateway: { reload: { debounceMs: 0 } },
      agents: { defaults: { heartbeat: { every: params.heartbeatEvery ?? "30m" } } },
      models: {
        providers: {
          x: {
            baseUrl: "https://models.example.test/v1",
            apiKey: params.providerApiKey,
            models: [],
          },
        },
      },
      channels: {
        msteams: { appId: "test-app-id", appPassword: params.teamsAppPassword },
        signal: {
          account: "+15550000001",
          allowFrom: params.signalAllowFrom ?? ["+15550000002"],
        },
      },
    } as OpenClawConfig;
  }

  // As written to the file: SecretRef objects (what readSnapshot returns).
  function sourceConfig(overrides?: {
    heartbeatEvery?: string;
    providerKeyRefId?: string;
    signalAllowFrom?: string[];
  }): OpenClawConfig {
    return buildConfig({
      providerApiKey: { ...providerKeyRef, id: overrides?.providerKeyRefId ?? providerKeyRef.id },
      teamsAppPassword: { ...teamsPasswordRef },
      heartbeatEvery: overrides?.heartbeatEvery,
      signalAllowFrom: overrides?.signalAllowFrom,
    });
  }

  // After secrets activation: every SecretRef replaced by its secret string (what the gateway
  // ran with at startup).
  function resolvedConfig(): OpenClawConfig {
    return buildConfig({
      providerApiKey: "synthetic-provider-key",
      teamsAppPassword: "synthetic-teams-password",
    });
  }

  function startReloader(readSnapshot: () => Promise<ConfigFileSnapshot>) {
    const watcher = createWatcherMock();
    vi.spyOn(chokidar, "watch").mockReturnValue(watcher as unknown as never);
    const onHotReload = vi.fn(async (_plan: GatewayReloadPlan, _next: OpenClawConfig) => {});
    const onRestart = vi.fn();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    // The gateway sets baselineFromSnapshot: the reloader reads the file once at start and diffs
    // later snapshots against that, not against the resolved initialConfig.
    const reloader = startGatewayConfigReloader({
      initialConfig: resolvedConfig(),
      baselineFromSnapshot: true,
      readSnapshot,
      onHotReload,
      onRestart,
      log,
      watchPath: "/tmp/openclaw.json",
    });
    return { watcher, onHotReload, onRestart, log, reloader };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    setActivePluginRegistry(registry);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    setActivePluginRegistry(emptyRegistry);
  });

  it("test 1: resolved initialConfig vs SecretRef snapshot restarts no channel and reports no SecretRef path", async () => {
    // The file at reloader start, then the file after an unrelated edit (heartbeat interval).
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(makeSnapshot({ config: sourceConfig(), hash: "start" }))
      .mockResolvedValueOnce(
        makeSnapshot({ config: sourceConfig({ heartbeatEvery: "45m" }), hash: "edit-1" }),
      );
    const { watcher, onHotReload, onRestart, reloader } = startReloader(readSnapshot);
    try {
      watcher.emit("change");
      await vi.runOnlyPendingTimersAsync();

      expect(onRestart).not.toHaveBeenCalled();
      expect(onHotReload).toHaveBeenCalledTimes(1);
      const [plan] = onHotReload.mock.calls[0];
      expect([...plan.restartChannels]).toEqual([]);
      expect(plan.changedPaths).toEqual(["agents.defaults.heartbeat.every"]);
      expect(plan.changedPaths).not.toContain("models.providers.x.apiKey");
      expect(plan.changedPaths).not.toContain("channels.msteams.appPassword");
    } finally {
      await reloader.stop();
    }
  });

  it("test 3: planner guard: provider apiKey restarts heartbeat only; channel paths restart only their own channel", () => {
    const providerPlan = buildGatewayReloadPlan(["models.providers.x.apiKey"]);
    expect(providerPlan.restartGateway).toBe(false);
    expect([...providerPlan.restartChannels]).toEqual([]);
    expect(providerPlan.restartHeartbeat).toBe(true);

    const signalPlan = buildGatewayReloadPlan(["channels.signal.groups.g="]);
    expect(signalPlan.restartGateway).toBe(false);
    expect([...signalPlan.restartChannels]).toEqual(["signal"]);

    const teamsPlan = buildGatewayReloadPlan(["channels.msteams.appPassword"]);
    expect(teamsPlan.restartChannels.has("signal")).toBe(false);
  });

  it("test 4: a real change still reloads: signal allowFrom restarts signal only, a new apiKey ref id restarts no channel", async () => {
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(makeSnapshot({ config: sourceConfig(), hash: "start" }))
      .mockResolvedValueOnce(
        makeSnapshot({
          config: sourceConfig({ signalAllowFrom: ["+15550000002", "+15550000003"] }),
          hash: "edit-1",
        }),
      )
      .mockResolvedValueOnce(
        makeSnapshot({
          config: sourceConfig({
            signalAllowFrom: ["+15550000002", "+15550000003"],
            providerKeyRefId: "/providers/x-rotated",
          }),
          hash: "edit-2",
        }),
      );
    const { watcher, onHotReload, onRestart, reloader } = startReloader(readSnapshot);
    try {
      watcher.emit("change");
      await vi.runOnlyPendingTimersAsync();
      expect(onHotReload).toHaveBeenCalledTimes(1);
      const [signalPlan] = onHotReload.mock.calls[0];
      expect(signalPlan.changedPaths).toEqual(["channels.signal.allowFrom"]);
      expect([...signalPlan.restartChannels]).toEqual(["signal"]);
      expect(signalPlan.restartHeartbeat).toBe(false);

      watcher.emit("change");
      await vi.runOnlyPendingTimersAsync();
      expect(onHotReload).toHaveBeenCalledTimes(2);
      const [keyPlan] = onHotReload.mock.calls[1];
      expect(keyPlan.changedPaths).toEqual(["models.providers.x.apiKey.id"]);
      expect([...keyPlan.restartChannels]).toEqual([]);
      expect(keyPlan.restartHeartbeat).toBe(true);
      expect(onRestart).not.toHaveBeenCalled();
    } finally {
      await reloader.stop();
    }
  });

  it("startup writes in the file (generated gateway.auth.token, seeded controlUi.allowedOrigins) are part of the baseline", async () => {
    const withStartupWrites = (cfg: OpenClawConfig): OpenClawConfig => ({
      ...cfg,
      gateway: {
        ...cfg.gateway,
        bind: "lan",
        auth: { mode: "token", token: "synthetic-generated-token" },
        controlUi: {
          enabled: true,
          allowedOrigins: ["http://localhost:18789", "http://127.0.0.1:18789"],
        },
      },
    });
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValueOnce(
        makeSnapshot({ config: withStartupWrites(sourceConfig()), hash: "start" }),
      )
      .mockResolvedValueOnce(
        makeSnapshot({
          config: withStartupWrites(sourceConfig({ heartbeatEvery: "45m" })),
          hash: "edit-1",
        }),
      );
    // initialConfig (resolved, from before the startup writes) has neither value.
    const { watcher, onHotReload, onRestart, reloader } = startReloader(readSnapshot);
    try {
      watcher.emit("change");
      await vi.runOnlyPendingTimersAsync();
      expect(onRestart).not.toHaveBeenCalled();
      expect(onHotReload).toHaveBeenCalledTimes(1);
      const [plan] = onHotReload.mock.calls[0];
      expect(plan.changedPaths).toEqual(["agents.defaults.heartbeat.every"]);
      expect(plan.restartGateway).toBe(false);
      expect([...plan.restartChannels]).toEqual([]);
    } finally {
      await reloader.stop();
    }
  });

  it("falls back to initialConfig when the baseline snapshot cannot be read", async () => {
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockRejectedValueOnce(new Error("read failed"))
      .mockResolvedValueOnce(
        makeSnapshot({
          config: buildConfig({
            providerApiKey: "synthetic-provider-key",
            teamsAppPassword: "synthetic-teams-password",
            heartbeatEvery: "45m",
          }),
          hash: "edit-1",
        }),
      );
    const { watcher, onHotReload, log, reloader } = startReloader(readSnapshot);
    try {
      watcher.emit("change");
      await vi.runOnlyPendingTimersAsync();
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining("config reload baseline: reading config failed"),
      );
      expect(onHotReload).toHaveBeenCalledTimes(1);
      const [plan] = onHotReload.mock.calls[0];
      expect(plan.changedPaths).toEqual(["agents.defaults.heartbeat.every"]);
    } finally {
      await reloader.stop();
    }
  });

  it("does not read a baseline snapshot unless baselineFromSnapshot is set", async () => {
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockResolvedValue(makeSnapshot({ config: { gateway: { reload: { debounceMs: 0 } } } }));
    const { reloader } = createReloaderHarness(readSnapshot);
    await vi.runOnlyPendingTimersAsync();
    expect(readSnapshot).not.toHaveBeenCalled();
    await reloader.stop();
  });
});
