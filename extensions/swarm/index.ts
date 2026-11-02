import path from "node:path";
import { resolveStateDir, type OpenClawPluginApi } from "openclaw/plugin-sdk/swarm";
import { registerSwarmCli } from "./src/cli.js";
import type { ContractDefaults, UpstreamChannel } from "./src/contract.js";
import { SWARM_EMIT_TOOL, createSwarmEmitToolFactory } from "./src/emit.js";
import { SwarmEngine } from "./src/engine.js";
import { resolveGroupAdapter } from "./src/group.js";
import { createSwarmHooks } from "./src/hooks.js";
import { createSwarmHolonToolFactory, SWARM_HOLON_TOOL } from "./src/lead-tool.js";
import { createSwarmMethods } from "./src/methods.js";
import { readOffline } from "./src/offline.js";
import { resumeOpenTasks } from "./src/resume.js";
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
};

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
      });
      hooks.attach(engine);
      const summary = await resumeOpenTasks(engine);
      if (summary.tasks > 0) {
        api.logger.info(
          `[swarm] resumed ${summary.tasks} task(s): resent=${summary.resent} ` +
            `acked=${summary.ackedFromTranscript + summary.ackedAsAnswered} redelivered=${summary.redelivered} ` +
            `childReports=${summary.childReports}`,
        );
      }
    },
    stop: () => {
      engine = undefined;
    },
  });
}
