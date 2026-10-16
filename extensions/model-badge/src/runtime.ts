import path from "node:path";
import {
  parseConfigJson5,
  resolveAgentDir,
  resolveConfigPath,
  resolveSecretRefString,
  resolveStorePath,
  type OpenClawConfig,
  type SecretRef,
} from "openclaw/plugin-sdk/model-badge";
import {
  createCommandGenerator,
  createOpenAiImagesGenerator,
  type BaseArtGenerator,
} from "./core/baseart.js";
import { realClock, type Clock, type Logger } from "./core/clock.js";
import { normalizeConfig, type ImageGenConfig, type ModelBadgeConfig } from "./core/config.js";
import { createEngine, type Engine } from "./core/engine.js";
import { createNodeFs, type CoreFs } from "./core/fsio.js";
import { createRenderer, detectRasteriser, type Renderer } from "./core/render.js";
import type { SceneWriter } from "./core/scene.js";
import { createSteering, type Steering } from "./core/steering.js";
import { createStyleStore, seededRules } from "./core/style.js";
import { createProviderRegistry, type ProviderRegistry } from "./providers/registry.js";
import { signalProviderFactory } from "./providers/signal/index.js";

// Wires the core to freeclaw: paths from freeclaw's own resolvers, providers from the
// registry, the rasteriser found on the host, the configured image backend.

export function defaultRegistry(): ProviderRegistry {
  return createProviderRegistry({ signal: signalProviderFactory });
}

export function imageGeneratorFor(
  cfg: ImageGenConfig | null,
  gatewayConfig: OpenClawConfig,
): BaseArtGenerator | null {
  if (!cfg) {
    return null;
  }
  if (cfg.kind === "openai-images") {
    return createOpenAiImagesGenerator({
      config: cfg,
      // The key is resolved through freeclaw's SecretRef resolver at call time; it is
      // never stored, logged or passed on a command line.
      apiKey: () =>
        resolveSecretRefString(cfg.apiKey as SecretRef, {
          config: gatewayConfig,
          env: process.env,
        }),
    });
  }
  return createCommandGenerator({ config: cfg });
}

export type Runtime = {
  config: ModelBadgeConfig;
  engines: Engine[];
  steering: Steering;
  rootDir: string;
  errors: string[];
  start(): Promise<void>;
  stop(): Promise<void>;
  purge(): Promise<void>;
};

export async function buildRuntime(opts: {
  rawConfig: unknown;
  gatewayConfig: OpenClawConfig;
  gatewayStateDir: string;
  log: Logger;
  clock?: Clock;
  fs?: CoreFs;
  registry?: ProviderRegistry;
  renderer?: Renderer | null;
  configPath?: string;
  // ARCH §2c.11: the agent-run scene writer (built from the plugin runtime in index.ts).
  sceneWriter?: SceneWriter | null;
  sceneWriterFor?: (agentId: string) => SceneWriter;
}): Promise<Runtime> {
  const clock = opts.clock ?? realClock;
  const fs = opts.fs ?? createNodeFs();
  const registry = opts.registry ?? defaultRegistry();
  const norm = normalizeConfig(opts.rawConfig, { gatewayStateDir: opts.gatewayStateDir });
  const config = norm.config;
  const errors = norm.ok ? [] : [...norm.errors];
  const rootDir = config.stateDir;
  const renderer =
    opts.renderer !== undefined
      ? opts.renderer
      : await detectRasteriser().then((bin) =>
          bin ? createRenderer(bin, config.timing.renderTimeoutMs) : null,
        );
  const gatewayConfigPath = opts.configPath ?? resolveConfigPath();
  const agentId = config.agentId;
  const sessionsStore = resolveStorePath(opts.gatewayConfig.session?.store, { agentId });
  const modelsJson = path.join(resolveAgentDir(opts.gatewayConfig, agentId), "models.json");
  const imageGenerator = imageGeneratorFor(config.imageGen, opts.gatewayConfig);
  const sceneWriter = opts.sceneWriter ?? opts.sceneWriterFor?.(agentId) ?? null;

  const engines: Engine[] = [];
  for (const id of config.providers) {
    const factory = registry.get(id);
    if (!factory) {
      errors.push(`unknown provider "${id}" (available: ${registry.ids().join(", ")})`);
      continue;
    }
    const provider = factory({
      block: config.providerBlocks[id] ?? {},
      agentId,
      gatewayConfig: opts.gatewayConfig,
      clock,
      rpcTimeoutMs: config.timing.rpcTimeoutMs,
    });
    engines.push(
      createEngine({
        config,
        provider,
        // Each provider has its own applied/status namespace (ARCH §4.2).
        paths: {
          stateDir: path.join(rootDir, id),
          rootDir,
          sessionsStore,
          modelsJson,
          gatewayConfig: gatewayConfigPath,
        },
        fs,
        clock,
        log: opts.log,
        renderer,
        imageGenerator,
        sceneWriter,
        parseConfigText: (text) => {
          const r = parseConfigJson5(text);
          if (!r.ok) {
            throw new Error("config file is not valid JSON5");
          }
          return r.parsed;
        },
        initialGatewayConfig: opts.gatewayConfig,
        validationErrors: errors,
      }),
    );
  }

  const steering = createSteering({
    engines: () => engines,
    store: createStyleStore({ fs, stateDir: rootDir }),
    operators: () => config.operators,
    allowGroupMembers: () => config.steering.allowGroupMembers,
    configRules: () => seededRules(config.steering.rules),
    now: () => clock.now(),
  });

  return {
    config,
    engines,
    steering,
    rootDir,
    errors,
    async start() {
      for (const e of engines) {
        await e.start();
      }
    },
    async stop() {
      for (const e of engines) {
        await e.stop();
      }
    },
    // ARCH §3.4: removes every provider's cache and state, and the style rules.
    async purge() {
      for (const e of engines) {
        await e.purge();
      }
      await fs.rmrf(rootDir);
    },
  };
}
