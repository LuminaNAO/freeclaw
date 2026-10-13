import type { Clock } from "../../core/clock.js";
import type {
  ApplyResult,
  BadgeProvider,
  ListResult,
  ProviderProfile,
  ProviderTarget,
  ResolveResult,
  TargetRef,
} from "../../core/provider.js";
import { classify, outcomeFromError, type RpcOutcome } from "./classify.js";

// ARCH §4.3: the Signal provider. It talks to the daemon only through freeclaw's own
// Signal client (HTTP and unix-socket transports alike), and selects the daemon by the
// configured freeclaw Signal *account* — never by position or a written-down port.

export type SignalRpc = (method: string, params: Record<string, unknown>) => Promise<RpcOutcome>;

// What freeclaw's account resolution tells us about the configured account.
export type SignalEndpoint = {
  baseUrl: string;
  // The account's own number, sent on every RPC.
  account: string | null;
  transportError?: string;
};

export type SignalProviderConfig = {
  agentId: string;
  // freeclaw Signal account id (channels.signal.accounts.<id>); default account if unset.
  accountId: string | null;
  // Session whose model the account's profile avatar shows; null = profile unmanaged.
  profileSessionKey: string | null;
  // Operator's own picture for the profile base (runtime input, never committed).
  profileBaseImage: string | null;
};

export type SessionKeyParser = (key: string) => { agentId: string; rest: string } | null;

export function isLoopbackUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "::1" || /^127\./.test(h);
  } catch {
    return false;
  }
}

export function isSocketEndpoint(url: string): boolean {
  return url.trim().toLowerCase().startsWith("unix:");
}

// Wraps a freeclaw-style client call (resolves the result, throws on any failure) into
// the outcome shape the classifier reads.
export function createClientRpc(
  call: (
    method: string,
    params: Record<string, unknown>,
    opts: { baseUrl: string; timeoutMs: number },
  ) => Promise<unknown>,
  opts: { baseUrl: string; timeoutMs: number },
): SignalRpc {
  return async (method, params) => {
    try {
      const result = await call(method, params, opts);
      return { transport: "ok", body: { result } };
    } catch (err) {
      return outcomeFromError(err);
    }
  };
}

type JsonGroup = {
  id?: unknown;
  isMember?: unknown;
  permissionEditDetails?: unknown;
  members?: Array<{ number?: unknown; isAdmin?: unknown }>;
};

export function createSignalProvider(opts: {
  config: SignalProviderConfig;
  endpoint: SignalEndpoint;
  rpc: SignalRpc;
  parseSessionKey: SessionKeyParser;
  clock: Clock;
}): BadgeProvider {
  const { config, endpoint, rpc, clock } = opts;
  const account = endpoint.account ?? "";
  const ids = new Map<string, Set<string>>(); // lower → real ids
  let lastForcedAt = Number.NEGATIVE_INFINITY;
  const profileRef: TargetRef = { kind: "profile", idLower: "profile" };

  function noteId(real: string) {
    const lower = real.toLowerCase();
    const set = ids.get(lower) ?? new Set<string>();
    set.add(real);
    ids.set(lower, set);
  }

  // false only when our own member entry is found and is not an admin. A member's
  // number may be hidden (phone-number privacy), so an entry we cannot identify is
  // "unknown": the send is attempted and a real denial comes back as -1 and parks.
  function canEditOf(g: JsonGroup): boolean | "unknown" {
    if (g.permissionEditDetails === "EVERY_MEMBER") {
      return true;
    }
    if (g.permissionEditDetails === "ONLY_ADMINS" && Array.isArray(g.members)) {
      const me = g.members.find((m) => m?.number === account);
      if (me && typeof me.isAdmin === "boolean") {
        return me.isAdmin;
      }
    }
    return "unknown";
  }

  async function fetchTargets(): Promise<ListResult> {
    const out = await rpc("listGroups", { account });
    if (out.transport !== "ok" || out.body?.error) {
      return { ok: false, result: classify(out, { kind: "group" }) };
    }
    const groups = Array.isArray(out.body.result) ? (out.body.result as JsonGroup[]) : [];
    const targets: ProviderTarget[] = [];
    for (const g of groups) {
      if (typeof g?.id !== "string" || !g.id) {
        continue;
      }
      noteId(g.id);
      targets.push({
        ref: { kind: "group", idLower: g.id.toLowerCase() },
        member: g.isMember !== false,
        canEdit: canEditOf(g),
      });
    }
    return { ok: true, targets };
  }

  return {
    id: "signal",
    asset: { width: 512, height: 512, format: "png" },
    pacing: { spacingMs: 2000 },

    configError() {
      if (endpoint.transportError) {
        return `signal account transport: ${endpoint.transportError}`;
      }
      if (!endpoint.baseUrl) {
        return "signal account has no daemon endpoint";
      }
      if (!account) {
        return "signal account has no number configured (channels.signal.account)";
      }
      // The daemon opens the avatar path on its own filesystem (ARCH §5.5): it must be
      // local. A unix socket is local by construction.
      if (!isSocketEndpoint(endpoint.baseUrl) && !isLoopbackUrl(endpoint.baseUrl)) {
        return "the cache dir must be reachable by the signal daemon: its endpoint must be local (loopback or unix socket)";
      }
      return null;
    },

    // Uses freeclaw's session-key parser (ARCH §4.4).
    targetForSessionKey(sessionKey) {
      if (config.profileSessionKey && sessionKey === config.profileSessionKey) {
        return profileRef;
      }
      const parsed = opts.parseSessionKey(sessionKey);
      if (!parsed || parsed.agentId !== config.agentId.toLowerCase()) {
        return null;
      }
      const [channel, kind, ...rest] = parsed.rest.split(":");
      const id = rest.join(":");
      if (channel !== "signal" || kind !== "group" || !id) {
        return null;
      }
      return { kind: "group", idLower: id.toLowerCase() };
    },

    sessionKeyFor(ref) {
      if (ref.kind === "profile") {
        return config.profileSessionKey;
      }
      return `agent:${config.agentId.toLowerCase()}:signal:group:${ref.idLower}`;
    },

    profile(): ProviderProfile | null {
      return config.profileSessionKey
        ? {
            ref: profileRef,
            sessionKey: config.profileSessionKey,
            baseImage: config.profileBaseImage,
          }
        : null;
    },

    // Always a fresh listing: one local daemon read per pass; a cached one would hide
    // removed groups.
    listTargets: fetchTargets,

    async resolve(ref, o = {}): Promise<ResolveResult> {
      if (ref.kind === "profile") {
        return { ok: true, realId: "profile" };
      }
      let set = ids.get(ref.idLower);
      if (!set && clock.now() - lastForcedAt >= (o.minRefreshMs ?? 60_000)) {
        lastForcedAt = clock.now();
        const r = await fetchTargets();
        if (!r.ok) {
          return { ok: false, result: r.result };
        }
        set = ids.get(ref.idLower);
      }
      if (!set) {
        return {
          ok: false,
          result: { kind: "permanent", reason: "not-found", message: "no group matches this id" },
        };
      }
      if (set.size > 1) {
        return {
          ok: false,
          result: {
            kind: "permanent",
            reason: "ambiguous-id",
            message: `${set.size} groups match this id case-insensitively`,
          },
        };
      }
      return { ok: true, realId: [...set][0] as string };
    },

    async apply(target, assetPath): Promise<ApplyResult> {
      const kind = target.ref.kind;
      // Group titles and names are never sent; the lowercased id is never sent.
      const out =
        kind === "profile"
          ? await rpc("updateProfile", { account, avatar: assetPath })
          : await rpc("updateGroup", { account, groupId: target.realId, avatar: assetPath });
      return classify(out, { kind, avatarPath: assetPath });
    },

    // ARCH §2c.8: reads a group's current avatar (signal-cli `getAvatar`, base64). Read
    // only; never sent anywhere. The profile is never adopted.
    async currentAvatar(target) {
      if (target.ref.kind !== "group") {
        return { kind: "none" };
      }
      const out = await rpc("getAvatar", { account, groupId: target.realId });
      if (out.transport !== "ok") {
        return { kind: "retry", message: `daemon ${out.transport}` };
      }
      const err = out.body?.error;
      if (err) {
        const msg = String(err.message ?? "");
        // signal-cli: FileNotFoundException → "Could not find avatar".
        if (/could not find avatar/i.test(msg)) {
          return { kind: "none" };
        }
        // JSON-RPC "method not found": a daemon without getAvatar.
        if (err.code === -32601 || String(err.code) === "-32601") {
          return { kind: "unsupported" };
        }
        return { kind: "retry", message: msg.slice(0, 120) };
      }
      const r = out.body?.result as { data?: unknown } | string | undefined;
      const b64 = typeof r === "string" ? r : r?.data;
      if (typeof b64 !== "string" || !b64) {
        return { kind: "none" };
      }
      return { kind: "image", bytes: Buffer.from(b64, "base64") };
    },

    knownIds() {
      const out: Record<string, string> = {};
      for (const [lower, set] of ids) {
        if (set.size === 1) {
          out[lower] = [...set][0] as string;
        }
      }
      return out;
    },

    seedIds(map) {
      for (const real of Object.values(map ?? {})) {
        if (typeof real === "string") {
          noteId(real);
        }
      }
    },
  };
}
