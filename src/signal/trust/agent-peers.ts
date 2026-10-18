import { logWarn } from "../../logger.js";
import type { RuntimeEnv } from "../../runtime.js";
import { createSignalTrustStoreReader, listSignalAgentUuids } from "./store.js";

/**
 * Agent peers ARCH §2.2/§2.3: answers "is this sender an identity the operator marked as an
 * agent?". Reads the same trust store as the ingress gate, but independently of whether the gate
 * is enforcing: marks are an operator setting, not a trust decision. A missing or unusable store
 * means nothing is marked, so the check is a no-op.
 */
export type SignalAgentPeers = {
  isMarkedAgent: (uuid: string | undefined) => Promise<boolean>;
};

export function createSignalAgentPeers(params: {
  accountId: string;
  runtime?: RuntimeEnv;
  env?: NodeJS.ProcessEnv;
  storePath?: string;
}): SignalAgentPeers {
  const reader = createSignalTrustStoreReader({
    accountId: params.accountId,
    env: params.env,
    filePath: params.storePath,
  });
  let cachedGeneration = -1;
  let marked: ReadonlySet<string> = new Set();
  let reportedInvalidGeneration = -1;
  return {
    async isMarkedAgent(uuid) {
      if (!uuid) {
        return false;
      }
      const snapshot = await reader.read();
      if (snapshot.generation !== cachedGeneration) {
        cachedGeneration = snapshot.generation;
        marked = snapshot.ok ? new Set(listSignalAgentUuids(snapshot.trusted)) : new Set();
        if (
          !snapshot.ok &&
          snapshot.error !== "store file is missing" &&
          reportedInvalidGeneration !== snapshot.generation
        ) {
          reportedInvalidGeneration = snapshot.generation;
          // Logged once per store state change, never per event.
          logWarn(
            `signal agent peers: trust store unusable (${snapshot.error}); no identity is treated as an agent`,
            params.runtime,
          );
        }
      }
      return marked.size > 0 && marked.has(uuid.toLowerCase());
    },
  };
}
