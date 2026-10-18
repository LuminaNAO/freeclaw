import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter as buildWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";

const runTui = vi.hoisted(() => vi.fn(async () => {}));
const probeGatewayReachable = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const setupOnboardingShellCompletion = vi.hoisted(() => vi.fn(async () => {}));
const buildGatewayInstallPlan = vi.hoisted(() =>
  vi.fn(async () => ({
    programArguments: [],
    workingDirectory: "/tmp",
    environment: {},
  })),
);
const gatewayServiceInstall = vi.hoisted(() => vi.fn(async () => {}));
const gatewayServiceRestart = vi.hoisted(() =>
  vi.fn<() => Promise<{ outcome: "completed" } | { outcome: "scheduled" }>>(async () => ({
    outcome: "completed",
  })),
);
const gatewayServiceUninstall = vi.hoisted(() => vi.fn(async () => {}));
const gatewayServiceIsLoaded = vi.hoisted(() => vi.fn(async () => false));
const resolveGatewayInstallToken = vi.hoisted(() =>
  vi.fn(async () => ({
    token: undefined,
    tokenRefConfigured: true,
    warnings: [],
  })),
);
const isSystemdUserServiceAvailable = vi.hoisted(() => vi.fn(async () => true));
const writeConfigFile = vi.hoisted(() => vi.fn(async (_cfg: unknown) => {}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  writeConfigFile,
}));

vi.mock("../commands/onboard-helpers.js", () => ({
  detectBrowserOpenSupport: vi.fn(async () => ({ ok: false })),
  formatControlUiSshHint: vi.fn(() => "ssh hint"),
  openUrl: vi.fn(async () => false),
  probeGatewayReachable,
  resolveControlUiLinks: vi.fn(() => ({
    httpUrl: "http://127.0.0.1:18789",
    wsUrl: "ws://127.0.0.1:18789",
  })),
  waitForGatewayReachable: vi.fn(async () => {}),
}));

vi.mock("../commands/daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan,
  gatewayInstallErrorHint: vi.fn(() => "hint"),
}));

vi.mock("../commands/gateway-install-token.js", () => ({
  resolveGatewayInstallToken,
}));

vi.mock("../commands/daemon-runtime.js", () => ({
  DEFAULT_GATEWAY_DAEMON_RUNTIME: "node",
  GATEWAY_DAEMON_RUNTIME_OPTIONS: [{ value: "node", label: "Node" }],
}));

vi.mock("../commands/health-format.js", () => ({
  formatHealthCheckFailure: vi.fn(() => "health failed"),
}));

vi.mock("../commands/health.js", () => ({
  healthCommand: vi.fn(async () => {}),
}));

vi.mock("../daemon/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../daemon/service.js")>();
  return {
    ...actual,
    resolveGatewayService: vi.fn(() => ({
      isLoaded: gatewayServiceIsLoaded,
      restart: gatewayServiceRestart,
      uninstall: gatewayServiceUninstall,
      install: gatewayServiceInstall,
    })),
  };
});

vi.mock("../daemon/systemd.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../daemon/systemd.js")>();
  return {
    ...actual,
    isSystemdUserServiceAvailable,
  };
});

const ensureControlUiAssetsBuilt = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("../infra/control-ui-assets.js", () => ({
  ensureControlUiAssetsBuilt,
}));

vi.mock("../terminal/restore.js", () => ({
  restoreTerminalState: vi.fn(),
}));

vi.mock("../tui/tui.js", () => ({
  runTui,
}));

vi.mock("./onboarding.completion.js", () => ({
  setupOnboardingShellCompletion,
}));

import { finalizeOnboardingWizard } from "./onboarding.finalize.js";

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function expectFirstOnboardingInstallPlanCallOmitsToken() {
  const [firstArg] =
    (buildGatewayInstallPlan.mock.calls.at(0) as [Record<string, unknown>] | undefined) ?? [];
  expect(firstArg).toBeDefined();
  expect(firstArg && "token" in firstArg).toBe(false);
}

describe("finalizeOnboardingWizard", () => {
  beforeEach(() => {
    runTui.mockClear();
    probeGatewayReachable.mockClear();
    setupOnboardingShellCompletion.mockClear();
    buildGatewayInstallPlan.mockClear();
    gatewayServiceInstall.mockClear();
    gatewayServiceIsLoaded.mockReset();
    gatewayServiceIsLoaded.mockResolvedValue(false);
    gatewayServiceRestart.mockReset();
    gatewayServiceRestart.mockResolvedValue({ outcome: "completed" });
    gatewayServiceUninstall.mockReset();
    resolveGatewayInstallToken.mockClear();
    isSystemdUserServiceAvailable.mockReset();
    isSystemdUserServiceAvailable.mockResolvedValue(true);
  });

  it("resolves gateway password SecretRef for probe and TUI", async () => {
    const previous = process.env.OPENCLAW_GATEWAY_PASSWORD;
    process.env.OPENCLAW_GATEWAY_PASSWORD = "resolved-gateway-password"; // pragma: allowlist secret
    const select = vi.fn(async (params: { message: string }) => {
      if (params.message === "How do you want to hatch your bot?") {
        return "tui";
      }
      return "later";
    });
    const prompter = buildWizardPrompter({
      select: select as never,
      confirm: vi.fn(async () => false),
    });
    const runtime = createRuntime();

    try {
      await finalizeOnboardingWizard({
        flow: "quickstart",
        opts: {
          acceptRisk: true,
          authChoice: "skip",
          installDaemon: false,
          skipHealth: true,
          skipUi: false,
        },
        baseConfig: {},
        nextConfig: {
          gateway: {
            auth: {
              mode: "password",
              password: {
                source: "env",
                provider: "default",
                id: "OPENCLAW_GATEWAY_PASSWORD",
              },
            },
          },
          tools: {
            web: {
              search: {
                apiKey: "",
              },
            },
          },
        },
        workspaceDir: "/tmp",
        settings: {
          port: 18789,
          bind: "loopback",
          authMode: "password",
          gatewayToken: undefined,
          tailscaleMode: "off",
          tailscaleResetOnExit: false,
        },
        prompter,
        runtime,
      });
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_GATEWAY_PASSWORD;
      } else {
        process.env.OPENCLAW_GATEWAY_PASSWORD = previous;
      }
    }

    expect(probeGatewayReachable).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "ws://127.0.0.1:18789",
        password: "resolved-gateway-password", // pragma: allowlist secret
      }),
    );
    expect(runTui).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "ws://127.0.0.1:18789",
        password: "resolved-gateway-password", // pragma: allowlist secret
      }),
    );
  });

  it("does not persist resolved SecretRef token in daemon install plan", async () => {
    const prompter = buildWizardPrompter({
      select: vi.fn(async () => "later") as never,
      confirm: vi.fn(async () => false),
    });
    const runtime = createRuntime();

    await finalizeOnboardingWizard({
      flow: "advanced",
      opts: {
        acceptRisk: true,
        authChoice: "skip",
        installDaemon: true,
        skipHealth: true,
        skipUi: true,
      },
      baseConfig: {},
      nextConfig: {
        gateway: {
          auth: {
            mode: "token",
            token: {
              source: "env",
              provider: "default",
              id: "OPENCLAW_GATEWAY_TOKEN",
            },
          },
        },
      },
      workspaceDir: "/tmp",
      settings: {
        port: 18789,
        bind: "loopback",
        authMode: "token",
        gatewayToken: "session-token",
        tailscaleMode: "off",
        tailscaleResetOnExit: false,
      },
      prompter,
      runtime,
    });

    expect(resolveGatewayInstallToken).toHaveBeenCalledTimes(1);
    expect(buildGatewayInstallPlan).toHaveBeenCalledTimes(1);
    expectFirstOnboardingInstallPlanCallOmitsToken();
    expect(gatewayServiceInstall).toHaveBeenCalledTimes(1);
  });

  describe("Control UI default off", () => {
    async function runFinalize(params: {
      controlUi?: { enabled?: boolean };
      hatch?: "tui" | "web" | "later";
    }) {
      const hatchOptions: Array<{ value: unknown; label: string }> = [];
      const select = vi.fn(
        async (p: { message: string; options: Array<{ value: unknown; label: string }> }) => {
          if (p.message === "How do you want to hatch your bot?") {
            hatchOptions.push(...p.options);
            return params.hatch ?? "later";
          }
          return "later";
        },
      );
      const note = vi.fn(async (_message: string, _title?: string) => {});
      const outro = vi.fn(async (_message?: string) => {});
      const prompter = buildWizardPrompter({
        select: select as never,
        note,
        outro,
        confirm: vi.fn(async () => false),
      });
      const nextConfig = params.controlUi
        ? { gateway: { auth: { mode: "token" as const }, controlUi: params.controlUi } }
        : { gateway: { auth: { mode: "token" as const } } };
      await finalizeOnboardingWizard({
        flow: "quickstart",
        opts: {
          acceptRisk: true,
          authChoice: "skip",
          installDaemon: false,
          skipHealth: true,
          skipUi: false,
        },
        baseConfig: {},
        nextConfig,
        workspaceDir: "/tmp",
        settings: {
          port: 18789,
          bind: "loopback",
          authMode: "token",
          gatewayToken: "session-token",
          tailscaleMode: "off",
          tailscaleResetOnExit: false,
        },
        prompter,
        runtime: createRuntime(),
      });
      const notes = note.mock.calls.map(([message, title]) => ({
        message,
        title: title ?? "",
      }));
      const allText = [
        ...notes.map((n) => `${n.title}\n${n.message}`),
        ...outro.mock.calls.map(([message]) => message ?? ""),
      ].join("\n");
      return { notes, outro, hatchOptions, allText };
    }

    it("unset: prints no dashboard URL, says Control UI is off, prints how to enable it", async () => {
      ensureControlUiAssetsBuilt.mockClear();
      const { notes, outro, hatchOptions, allText } = await runFinalize({});

      expect(allText).not.toContain("Web UI:");
      expect(allText).not.toContain("Dashboard link");
      expect(allText).not.toContain("http://127.0.0.1:18789");
      expect(allText).not.toMatch(/\bdashboard --no-open/);
      expect(allText).toContain("Control UI: off");
      expect(allText).toContain("config set gateway.controlUi.enabled true");
      expect(notes.some((n) => n.title === "Control UI")).toBe(false);
      expect(hatchOptions.map((o) => o.value)).toEqual(["tui", "later"]);
      expect(String(outro.mock.calls.at(-1)?.[0])).toContain(
        "config set gateway.controlUi.enabled true",
      );
      expect(ensureControlUiAssetsBuilt).not.toHaveBeenCalled();
    });

    it("unset: the gateway WebSocket URL is still shown", async () => {
      const { allText } = await runFinalize({});
      expect(allText).toContain("Gateway WS: ws://127.0.0.1:18789");
    });

    it("enabled: true: prints the dashboard URL and offers the Web UI as before", async () => {
      ensureControlUiAssetsBuilt.mockClear();
      const { notes, hatchOptions, allText } = await runFinalize({ controlUi: { enabled: true } });

      expect(allText).toContain("Web UI: http://127.0.0.1:18789");
      expect(allText).not.toContain("Control UI: off");
      expect(notes.some((n) => n.title === "Control UI")).toBe(true);
      expect(hatchOptions.map((o) => o.value)).toEqual(["tui", "web", "later"]);
      expect(ensureControlUiAssetsBuilt).toHaveBeenCalledTimes(1);
    });

    it("enabled: true and choosing the Web UI shows the dashboard link", async () => {
      const { allText } = await runFinalize({ controlUi: { enabled: true }, hatch: "web" });
      expect(allText).toContain("Dashboard link (with token): http://127.0.0.1:18789");
    });

    it("writes nothing for the UI into the config", async () => {
      const nextConfig: OpenClawConfig = { gateway: { auth: { mode: "token" } } };
      const before = structuredClone(nextConfig);
      await finalizeOnboardingWizard({
        flow: "quickstart",
        opts: {
          acceptRisk: true,
          authChoice: "skip",
          installDaemon: false,
          skipHealth: true,
          skipUi: false,
        },
        baseConfig: {},
        nextConfig,
        workspaceDir: "/tmp",
        settings: {
          port: 18789,
          bind: "loopback",
          authMode: "token",
          gatewayToken: "session-token",
          tailscaleMode: "off",
          tailscaleResetOnExit: false,
        },
        prompter: buildWizardPrompter({
          select: vi.fn(async () => "later") as never,
          confirm: vi.fn(async () => false),
        }),
        runtime: createRuntime(),
      });
      expect(nextConfig).toEqual(before);
      expect(nextConfig.gateway?.controlUi).toBeUndefined();
    });
  });

  it("stops after a scheduled restart instead of reinstalling the service", async () => {
    const progressUpdate = vi.fn();
    const progressStop = vi.fn();
    gatewayServiceIsLoaded.mockResolvedValue(true);
    gatewayServiceRestart.mockResolvedValueOnce({ outcome: "scheduled" });
    const prompter = buildWizardPrompter({
      select: vi.fn(async (params: { message: string }) => {
        if (params.message === "Gateway service already installed") {
          return "restart";
        }
        return "later";
      }) as never,
      confirm: vi.fn(async () => false),
      progress: vi.fn(() => ({ update: progressUpdate, stop: progressStop })),
    });

    await finalizeOnboardingWizard({
      flow: "advanced",
      opts: {
        acceptRisk: true,
        authChoice: "skip",
        installDaemon: true,
        skipHealth: true,
        skipUi: true,
      },
      baseConfig: {},
      nextConfig: {},
      workspaceDir: "/tmp",
      settings: {
        port: 18789,
        bind: "loopback",
        authMode: "token",
        gatewayToken: undefined,
        tailscaleMode: "off",
        tailscaleResetOnExit: false,
      },
      prompter,
      runtime: createRuntime(),
    });

    expect(gatewayServiceRestart).toHaveBeenCalledTimes(1);
    expect(gatewayServiceInstall).not.toHaveBeenCalled();
    expect(gatewayServiceUninstall).not.toHaveBeenCalled();
    expect(progressUpdate).toHaveBeenCalledWith("Restarting Gateway service…");
    expect(progressStop).toHaveBeenCalledWith("Gateway service restart scheduled.");
  });

  describe("model-badge on for new installs only (ARCH model-badge §2c.12)", () => {
    const signalConfig = {
      channels: { signal: { account: "+15550001111" } },
    } as OpenClawConfig;

    async function finalize(params: { freshInstall?: boolean; nextConfig: OpenClawConfig }) {
      writeConfigFile.mockClear();
      await finalizeOnboardingWizard({
        flow: "quickstart",
        opts: {
          acceptRisk: true,
          authChoice: "skip",
          installDaemon: false,
          skipHealth: true,
          skipUi: true,
        },
        baseConfig: params.freshInstall ? {} : params.nextConfig,
        nextConfig: params.nextConfig,
        freshInstall: params.freshInstall,
        workspaceDir: "/tmp",
        settings: {
          port: 18789,
          bind: "loopback",
          authMode: "token",
          gatewayToken: undefined,
          tailscaleMode: "off",
          tailscaleResetOnExit: false,
        },
        prompter: buildWizardPrompter({
          select: vi.fn(async () => "later") as never,
          confirm: vi.fn(async () => false),
        }),
        runtime: createRuntime(),
      });
    }

    it("fresh onboarding writes the entry with the configured supported channels", async () => {
      await finalize({ freshInstall: true, nextConfig: signalConfig });
      expect(writeConfigFile).toHaveBeenCalledTimes(1);
      const written = writeConfigFile.mock.calls[0]?.[0] as OpenClawConfig;
      expect(written.plugins?.entries?.["model-badge"]).toEqual({
        enabled: true,
        config: { providers: ["signal"] },
      });
      expect(written.channels).toEqual(signalConfig.channels);
    });

    it("re-running onboarding on an existing config without the entry does not add it", async () => {
      await finalize({ freshInstall: false, nextConfig: signalConfig });
      await finalize({ nextConfig: signalConfig });
      expect(writeConfigFile).not.toHaveBeenCalled();
    });

    it("fresh onboarding keeps an entry already in the new config", async () => {
      await finalize({
        freshInstall: true,
        nextConfig: {
          ...signalConfig,
          plugins: { entries: { "model-badge": { enabled: false } } },
        },
      });
      expect(writeConfigFile).not.toHaveBeenCalled();
    });
  });
});
