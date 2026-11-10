// docs/design/mail-push.md §9.13: a config reload restarts only the changed connector.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { MailConnectorConfig } from "../config/types.mail.js";
import { buildGatewayReloadPlan, diffConfigPaths } from "../gateway/config-reload.js";
import { createGatewayReloadHandlers } from "../gateway/server-reload-handlers.js";
import { MailConnectorManager } from "./manager.js";
import { FakeMailProvider, getFakeMailbox, resetFakeMailboxes } from "./providers/fake.js";
import {
  createMemoryStateIo,
  createRecordingLogger,
  createRecordingSink,
  fakeConnectorConfig,
  waitFor,
} from "./test-helpers.js";

const managers: MailConnectorManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stop()));
  resetFakeMailboxes();
});

function cfgWith(connectors: MailConnectorConfig[]): OpenClawConfig {
  return { mail: { connectors } } as OpenClawConfig;
}

async function startManager(connectors: MailConnectorConfig[]) {
  const starts: string[] = [];
  const sink = createRecordingSink();
  const manager = new MailConnectorManager({
    log: createRecordingLogger(),
    sink,
    io: createMemoryStateIo(),
    statePathFor: (id) => `/state/${id}.json`,
    providerFactory: ({ config }) => {
      const provider = new FakeMailProvider(getFakeMailbox(config.id));
      return {
        test: () => provider.test(),
        start: (ctx) => {
          starts.push(config.id);
          return provider.start(ctx);
        },
      };
    },
  });
  managers.push(manager);
  await manager.start(cfgWith(connectors));
  for (const connector of connectors) {
    await waitFor(() => manager.get(connector.id)?.status().state === "idle");
  }
  return { manager, starts, sink };
}

const work = fakeConnectorConfig({ id: "work" });
const home = fakeConnectorConfig({
  id: "home",
  attach: [{ agentId: "main", sessionKey: "agent:main:mail:home" }],
});

describe("mail connector reload (§9.13)", () => {
  it("restarts only the connector whose entry changed", async () => {
    const { manager, starts } = await startManager([work, home]);
    expect(starts.toSorted()).toEqual(["home", "work"]);
    const workBefore = manager.get("work");
    const homeBefore = manager.get("home");

    const changedHome: MailConnectorConfig = { ...home, body: { maxChars: 500 } };
    const result = await manager.applyConfig(cfgWith([work, changedHome]));

    expect(result).toEqual({ started: [], stopped: [], restarted: ["home"], unchanged: ["work"] });
    expect(manager.get("work")).toBe(workBefore);
    expect(manager.get("home")).not.toBe(homeBefore);
    expect(homeBefore?.running).toBe(false);
    expect(workBefore?.running).toBe(true);
    await waitFor(() => starts.length === 3);
    expect(starts.toSorted()).toEqual(["home", "home", "work"]);
  });

  it("starts added and stops removed connectors, leaves the rest running", async () => {
    const { manager, starts } = await startManager([work]);
    const workBefore = manager.get("work");
    const result = await manager.applyConfig(cfgWith([work, home]));
    expect(result).toEqual({ started: ["home"], stopped: [], restarted: [], unchanged: ["work"] });
    const removed = await manager.applyConfig(cfgWith([home]));
    expect(removed).toEqual({ started: [], stopped: ["work"], restarted: [], unchanged: ["home"] });
    expect(workBefore?.running).toBe(false);
    expect(manager.get("work")).toBeUndefined();
    expect(starts.filter((id) => id === "work")).toHaveLength(1);
  });

  it("the unchanged connector keeps delivering across a reload of another one", async () => {
    const { manager, sink } = await startManager([work, home]);
    await manager.applyConfig(cfgWith([work, { ...home, enabled: false }]));
    getFakeMailbox("work").add({ subject: "still flowing" });
    await waitFor(() => sink.events.length === 1);
    expect(sink.events[0].connectorId).toBe("work");
    expect(manager.status("home")[0].state).toBe("disabled");
  });

  it("mail.* changes hot-reload mail connectors without a gateway restart", () => {
    const prev = cfgWith([work, home]);
    const next = cfgWith([work, { ...home, batch: { windowSeconds: 5 } }]);
    const plan = buildGatewayReloadPlan(diffConfigPaths(prev, next));
    expect(plan.restartGateway).toBe(false);
    expect(plan.reloadMailConnectors).toBe(true);
    expect(plan.restartCron).toBe(false);
    expect(plan.restartGmailWatcher).toBe(false);
    const unrelated = buildGatewayReloadPlan(["cron.enabled"]);
    expect(unrelated.reloadMailConnectors).toBe(false);
  });

  it("the gateway hot-reload handler hands the new config to the running manager", async () => {
    const { manager } = await startManager([work, home]);
    const applyConfig = vi.spyOn(manager, "applyConfig");
    const next = cfgWith([work]);
    const { applyHotReload } = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: () => {},
      getState: () =>
        ({
          hooksConfig: null,
          hookClientIpConfig: {},
          heartbeatRunner: { updateConfig: () => {} },
          cronState: {},
          browserControl: null,
          channelHealthMonitor: null,
          mailState: { manager },
        }) as never,
      setState: () => {},
      startChannel: async () => {},
      stopChannel: async () => {},
      logHooks: { info: () => {}, warn: () => {}, error: () => {} },
      logMail: { info: () => {}, warn: () => {}, error: () => {} },
      logBrowser: { error: () => {} },
      logChannels: { info: () => {}, error: () => {} },
      logCron: { error: () => {} },
      logReload: { info: () => {}, warn: () => {} },
      createHealthMonitor: () => null as never,
    });
    await applyHotReload(buildGatewayReloadPlan(["mail.connectors"]), next);
    expect(applyConfig).toHaveBeenCalledWith(next);
    expect(manager.get("home")).toBeUndefined();
    expect(manager.get("work")?.running).toBe(true);
  });
});
