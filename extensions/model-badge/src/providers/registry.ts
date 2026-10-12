import type { Clock } from "../core/clock.js";
import type { ProviderBlock } from "../core/config.js";
import type { BadgeProvider } from "../core/provider.js";

// ARCH §4.2: the provider registry. The core never imports a provider; the runtime looks
// providers up here by the ids in config `providers`. Adding a channel means adding a
// factory, not touching the core.

export type ProviderFactoryContext = {
  block: ProviderBlock;
  agentId: string;
  gatewayConfig: unknown;
  clock: Clock;
  rpcTimeoutMs: number;
};

export type ProviderFactory = (ctx: ProviderFactoryContext) => BadgeProvider;

export function createProviderRegistry(initial: Record<string, ProviderFactory> = {}) {
  const factories = new Map<string, ProviderFactory>(Object.entries(initial));
  return {
    register(id: string, factory: ProviderFactory) {
      factories.set(id, factory);
    },
    get(id: string): ProviderFactory | null {
      return factories.get(id) ?? null;
    },
    ids: () => [...factories.keys()].toSorted(),
  };
}

export type ProviderRegistry = ReturnType<typeof createProviderRegistry>;
