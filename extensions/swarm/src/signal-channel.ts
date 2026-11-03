import type { HolonChannel } from "./members.js";

// Signal group API for holon groups (ARCH §10a.3): the existing signal-cli JSON-RPC
// (`updateGroup` to create and rename, `send` to post, `quitGroup` to leave), always through
// freeclaw's own Signal client resolved by account, never by a port in code. The rpc is
// injected, so tests drive it with a stub and never reach a daemon.

export type SignalRpcCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/**
 * signal-cli wants a bare uuid or a +E.164 number. Holon files may carry the channel prefixes freeclaw
 * uses elsewhere (`uuid:…`, `signal:…`); strip them so a member id works the same in both places.
 */
export function signalRecipient(who: string): string {
  return who.trim().replace(/^signal:/i, "").replace(/^uuid:/i, "");
}

export function createSignalHolonChannel(opts: {
  /** Resolves the account's endpoint and calls it; throws on any failure. */
  rpc: SignalRpcCall;
  /** The agent's own Signal account (from the gateway's Signal config, never from code). */
  account?: string;
}): HolonChannel {
  const base = () => (opts.account ? { account: opts.account } : {});
  return {
    kind: "signal",
    async createGroup({ name, members }) {
      const result = (await opts.rpc("updateGroup", {
        ...base(),
        name,
        members: members.map(signalRecipient),
      })) as
        | { groupId?: unknown }
        | undefined;
      const groupId = typeof result?.groupId === "string" ? result.groupId : "";
      if (!groupId) {
        throw new Error("signal updateGroup returned no group id");
      }
      return { groupId };
    },
    async post(groupId, text) {
      await opts.rpc("send", { ...base(), groupId, message: text });
    },
    async closeGroup(groupId, { name }) {
      await opts.rpc("updateGroup", { ...base(), groupId, name });
      await opts.rpc("quitGroup", { ...base(), groupId });
    },
  };
}
