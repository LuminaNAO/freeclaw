import path from "node:path";
import {
  resolveSignalAccount,
  resolveStateDir,
  signalRpcRequest,
  type OpenClawConfig,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/swarm";
import { openChildrenOf } from "./src/children.js";
import { registerSwarmCli } from "./src/cli.js";
import type { ContractDefaults, UpstreamChannel } from "./src/contract.js";
import { SWARM_EMIT_TOOL, createSwarmEmitToolFactory } from "./src/emit.js";
import { SwarmEngine } from "./src/engine.js";
import { FakeChannel } from "./src/fake-channel.js";
import { resolveGroupAdapter } from "./src/group.js";
import { startIdleSweep } from "./src/heal.js";
import { createSwarmHooks } from "./src/hooks.js";
import { createSwarmHolonToolFactory, SWARM_HOLON_TOOL } from "./src/lead-tool.js";
import {
  memberConfigOf,
  type LegacyMemberConfig,
  type MemberPluginConfig,
} from "./src/member-aliases.js";
import { MemberChannels, type HolonChannel } from "./src/members.js";
import { createSwarmMethods } from "./src/methods.js";
import { readOffline } from "./src/offline.js";
import { attachRelay, relayMemberReply } from "./src/relay.js";
import { resumeOpenTasks } from "./src/resume.js";
import { createSignalHolonChannel } from "./src/signal-channel.js";
import { createRuntimeChannelSender } from "./src/upstream.js";

type SwarmPluginConfig = {
  stateDir?: string;
  defaultModel?: string;
  defaultThinking?: string;
  lane?: string;
  upstream?: {
    sessionKey?: string;
    channel?: UpstreamChannel;
    events?: string[];
  };
  budget?: { wall?: string; step_silence?: string };
  group?: { kind?: string };
  /**
   * ARCH §3.3, §8, §10a.3, §10b: channels that carry holon groups for members, and the root
   * owner's ids per channel (in every holon group). Nothing here → members are unreachable and
   * their holons escalate `BLOCKED: no channel`.
   */
  members?: MemberPluginConfig;
} & LegacyMemberConfig;

/** Group APIs for the configured channel kinds. `fake` is the in-process loopback (§10a.4). */
export function holonChannelsFrom(
  cfg: SwarmPluginConfig["members"],
  gatewayConfig: unknown,
): Record<string, HolonChannel> {
  const out: Record<string, HolonChannel> = {};
  for (const [kind, spec] of Object.entries(cfg?.channels ?? {})) {
    const name = kind.trim().toLowerCase();
    if (name === "fake") {
      out[name] = new FakeChannel();
    } else if (name === "signal") {
      // Resolved by account at call time, never by port (ARCH §10a.3).
      const resolve = () =>
        resolveSignalAccount({
          cfg: gatewayConfig as OpenClawConfig,
          accountId: spec?.accountId ?? null,
        });
      out[name] = createSignalHolonChannel({
        account: (() => {
          try {
            return resolve().config.account?.trim() || undefined;
          } catch {
            return undefined;
          }
        })(),
        rpc: (method, params) => {
          const account = resolve();
          if (account.transportError) {
            throw new Error(account.transportError);
          }
          return signalRpcRequest(method, params, { baseUrl: account.baseUrl });
        },
      });
    }
  }
  return out;
}

export default function register(api: OpenClawPluginApi) {
  const cfg = (api.pluginConfig ?? {}) as SwarmPluginConfig;
  const defaults: ContractDefaults = {
    defaultModel: cfg.defaultModel,
    defaultThinking: cfg.defaultThinking,
    upstream: cfg.upstream,
    budget: cfg.budget,
  };
  let engine: SwarmEngine | undefined;
  const getEngine = () => engine;

  api.registerTool(createSwarmEmitToolFactory(getEngine), { name: SWARM_EMIT_TOOL });
  // ARCH §5.1, §10a: the lead's tool (child holons and the steps 3-5 ops); it dispatches
  // through the same op table as the swarm.* methods and the CLI.
  api.registerTool(createSwarmHolonToolFactory(getEngine), { name: SWARM_HOLON_TOOL });

  const hooks = createSwarmHooks(getEngine);
  api.on("llm_input", hooks.onLlmInput);
  const memberCfg = memberConfigOf(cfg);
  // ARCH §10a.3: member replies in holon groups reach the relay; the relay has only swarm_emit.
  if (Object.keys(memberCfg?.channels ?? {}).length > 0) {
    api.on("message_received", hooks.onMessageReceived);
    api.on("message_sending", hooks.onMessageSending);
    api.on("before_tool_call", hooks.onBeforeToolCall);
  }

  for (const [method, handler] of Object.entries(createSwarmMethods(getEngine))) {
    api.registerGatewayMethod(method, handler);
  }

  // ARCH §9: with the gateway down, list/show read the same state dir the service uses.
  const cliStateDir = () => (cfg.stateDir ? path.resolve(cfg.stateDir) : resolveStateDir());
  api.registerCli(
    ({ program }) =>
      registerSwarmCli({
        program,
        readLocal: (method, params) => readOffline(cliStateDir(), method, params),
      }),
    { commands: ["swarm"] },
  );

  api.registerService({
    id: "swarm",
    start: async (ctx) => {
      // Task state lives under <gateway stateDir>/swarm unless plugin config overrides it.
      const stateDir = cfg.stateDir ? path.resolve(cfg.stateDir) : ctx.stateDir;
      engine = new SwarmEngine({
        stateDir,
        runtime: api.runtime,
        lane: cfg.lane,
        defaults,
        logger: api.logger,
        channelSender: createRuntimeChannelSender(api.runtime.channel),
        group: resolveGroupAdapter(cfg.group?.kind),
        memberChannels: new MemberChannels({
          channels: holonChannelsFrom(memberCfg, api.config),
          owners: memberCfg?.owners,
        }),
      });
      hooks.attach(engine);
      attachRelay(engine);
      const current = engine;
      for (const channel of current.memberChannels.channels.values()) {
        if (channel instanceof FakeChannel) {
          channel.inbound = (msg) => relayMemberReply(current, msg);
        }
      }
      const summary = await resumeOpenTasks(engine);
      if (summary.tasks > 0) {
        api.logger.info(
          `[swarm] resumed ${summary.tasks} task(s): resent=${summary.resent} ` +
            `acked=${summary.ackedFromTranscript + summary.ackedAsAnswered} redelivered=${summary.redelivered} ` +
            `childReports=${summary.childReports} retriesRearmed=${summary.retriesRearmed}`,
        );
      }
      // ARCH §7.1.5: once a minute, an open holon with nothing in flight gets its outstanding
      // input again; the swarm never needs an outside checker.
      startIdleSweep(
        current,
        (id) => openChildrenOf(current.stateDir, id),
        (resumed) => api.logger.info(`[swarm] idle sweep resumed ${resumed.join(", ")}`),
      );
    },
    stop: () => {
      engine?.timers.stopAll();
      engine = undefined;
    },
  });
}
