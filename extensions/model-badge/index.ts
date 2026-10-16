import type { OpenClawPluginApi } from "openclaw/plugin-sdk/model-badge";
import { createBadgeCommand } from "./src/commands.js";
import type { Engine } from "./src/core/engine.js";
import { buildRuntime, type Runtime } from "./src/runtime.js";
import { createSceneWriter } from "./src/scene-writer.js";
import { TOOL_NAMES, createBadgeTool } from "./src/tool.js";

// model-badge (ARCH §5.1). The writer runs as a plugin service; triggers are the closed
// set of §5.2 (see README "Triggers"): startup and periodic passes, the store/models
// watcher, and the session_start plugin event as an early nudge for new targets. ARCH
// §2c.11: group memory's group_memory_created event names a new (or renamed) group, and
// the agent writes its image scene.

export default function register(api: OpenClawPluginApi) {
  let runtime: Runtime | undefined;
  const engines = (): Engine[] => runtime?.engines ?? [];

  const purge = async () => {
    const r = runtime;
    runtime = undefined;
    await r?.purge();
  };
  const actionDeps = {
    engines,
    steering: () => runtime?.steering ?? null,
    operators: () => runtime?.config.operators ?? [],
    allowGroupMembers: () => runtime?.config.steering.allowGroupMembers ?? true,
    purge,
  };

  // ARCH §2c.1: one tool, `model_badge`, covering every /badge subcommand; the §2a.3
  // name `model_badge_style` is kept as an alias. The sender id comes from the gateway's
  // tool context (§2c.2), never from tool arguments.
  api.registerTool(
    (ctx) =>
      runtime
        ? TOOL_NAMES.map((name) =>
            createBadgeTool({
              ...actionDeps,
              name,
              senderId: ctx.requesterSenderId,
              sessionKey: ctx.sessionKey,
            }),
          )
        : null,
    { names: [...TOOL_NAMES] },
  );

  const handle = createBadgeCommand(actionDeps);
  api.registerCommand({
    name: "badge",
    description: "Model badge avatars: status, repaint, audit, regenerate, purge, style.",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx) => handle(ctx),
  });

  // T2 early nudge: a new session may be a new target. The watcher confirms it.
  api.on("session_start", (event) => {
    if (event.sessionKey) {
      for (const e of engines()) {
        e.nudge(event.sessionKey);
      }
    }
  });

  // ARCH §2c.11 trigger: group-memory ARCH §8's new-group event, created or renamed.
  // Only this agent's own groups; the name goes to the engine of that channel's provider.
  api.on("group_memory_created", async (event) => {
    const r = runtime;
    if (!r || event.agentId.toLowerCase() !== r.config.agentId.toLowerCase()) {
      return;
    }
    for (const e of engines()) {
      if (e.provider.id === event.channel) {
        await e.groupNamed(event.groupId, event.name);
      }
    }
  });

  api.registerService({
    id: "model-badge",
    start: async (ctx) => {
      runtime = await buildRuntime({
        rawConfig: api.pluginConfig ?? {},
        gatewayConfig: ctx.config,
        gatewayStateDir: ctx.stateDir,
        log: ctx.logger,
        sceneWriterFor: api.runtime?.subagent
          ? (agentId) =>
              createSceneWriter({ runtime: api.runtime, agentId, gatewayConfig: ctx.config })
          : undefined,
      });
      if (runtime.errors.length) {
        ctx.logger.error(`[model-badge] config: ${runtime.errors.join("; ")}`);
      }
      // Never blocks gateway start-up: the first pass is paced and runs in the background.
      void runtime
        .start()
        .catch((err) => ctx.logger.error(`[model-badge] start failed: ${String(err)}`));
    },
    // ARCH §3.4: turn off → the writer stops; nothing is repainted back.
    stop: async () => {
      const r = runtime;
      runtime = undefined;
      await r?.stop();
    },
  });
}
