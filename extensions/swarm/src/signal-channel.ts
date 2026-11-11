import { runGroupClose } from "./group-close.js";
import type { HolonChannel } from "./members.js";

// Signal group API for holon groups (ARCH §10a.3, §10c): the existing signal-cli JSON-RPC
// (`updateGroup` to create, rename and remove members, `send` to post, `listGroups` to read the
// members and verify, `quitGroup { delete: true }` to leave and delete), always through
// freeclaw's own Signal client resolved by account, never by a port in code. The rpc is
// injected, so tests drive it with a stub and never reach a daemon.

export type SignalRpcCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/**
 * signal-cli wants a bare uuid or a +E.164 number. Holon files may carry the channel prefixes freeclaw
 * uses elsewhere (`uuid:…`, `signal:…`); strip them so a member id works the same in both places.
 */
export function signalRecipient(who: string): string {
  return who
    .trim()
    .replace(/^signal:/i, "")
    .replace(/^uuid:/i, "");
}

type SignalGroupMember = { uuid?: unknown; number?: unknown };
type SignalGroupEntry = {
  id?: unknown;
  members?: unknown;
  pendingMembers?: unknown;
};

function entriesOf(raw: unknown): SignalGroupEntry[] {
  // The JSON-RPC listGroups result is a bare array of group entries.
  return Array.isArray(raw)
    ? raw.filter((e): e is SignalGroupEntry => Boolean(e) && typeof e === "object")
    : [];
}

function membersOf(value: unknown): SignalGroupMember[] {
  return Array.isArray(value)
    ? value.filter((m): m is SignalGroupMember => Boolean(m) && typeof m === "object")
    : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * ARCH §10c.2c: everyone in the group, joined or pending, except the agent identity (its uuid
 * or its number), as the ids `updateGroup removeMember` takes (uuid first).
 */
export function otherMembers(entry: SignalGroupEntry, self: string[]): string[] {
  const me = new Set(self.map((s) => signalRecipient(s).toLowerCase()).filter(Boolean));
  const out: string[] = [];
  for (const m of [...membersOf(entry.members), ...membersOf(entry.pendingMembers)]) {
    const uuid = text(m.uuid);
    const number = text(m.number);
    if (me.has(uuid.toLowerCase()) || me.has(number.toLowerCase())) {
      continue;
    }
    const id = uuid || number;
    if (id && !out.includes(id)) {
      out.push(id);
    }
  }
  return out;
}

export function createSignalHolonChannel(opts: {
  /** Resolves the account's endpoint and calls it; throws on any failure. */
  rpc: SignalRpcCall;
  /** The agent's own Signal account (from the gateway's Signal config, never from code). */
  account?: string;
  /** The agent's own uuid (gateway Signal config); never removed from its own group. */
  accountUuid?: string;
}): HolonChannel {
  const base = () => (opts.account ? { account: opts.account } : {});
  const self = [opts.account ?? "", opts.accountUuid ?? ""].filter(Boolean);
  const listGroups = async (detailed: boolean) =>
    entriesOf(await opts.rpc("listGroups", { ...base(), ...(detailed && { detailed: true }) }));
  return {
    kind: "signal",
    async createGroup({ name, members }) {
      const result = (await opts.rpc("updateGroup", {
        ...base(),
        name,
        members: members.map(signalRecipient),
      })) as { groupId?: unknown } | undefined;
      const groupId = typeof result?.groupId === "string" ? result.groupId : "";
      if (!groupId) {
        throw new Error("signal updateGroup returned no group id");
      }
      return { groupId };
    },
    async post(groupId, message) {
      await opts.rpc("send", { ...base(), groupId, message });
    },
    async closeGroup(groupId, closeOpts) {
      return runGroupClose(
        {
          post: (message) => opts.rpc("send", { ...base(), groupId, message }),
          rename: (name) => opts.rpc("updateGroup", { ...base(), groupId, name }),
          others: async () => {
            const entry = (await listGroups(true)).find((g) => g.id === groupId);
            if (!entry) {
              throw new Error("signal listGroups does not list the group");
            }
            if (self.length === 0) {
              throw new Error("the agent's own Signal account is not configured");
            }
            return otherMembers(entry, self);
          },
          remove: (ids) => opts.rpc("updateGroup", { ...base(), groupId, removeMember: ids }),
          quitAndDelete: () => opts.rpc("quitGroup", { ...base(), groupId, delete: true }),
          listed: async () => (await listGroups(false)).some((g) => g.id === groupId),
        },
        closeOpts,
      );
    },
  };
}
