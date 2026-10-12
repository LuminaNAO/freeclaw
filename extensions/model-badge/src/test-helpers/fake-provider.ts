import type {
  ApplyResult,
  BadgeProvider,
  ProviderProfile,
  ProviderTarget,
  TargetRef,
} from "../core/provider.js";

// A fake second channel ("fakechat"), used to prove the core is provider-agnostic
// (ARCH §6.5): it has its own session-key shape, its own id rules, its own write call
// and answers with ApplyResults directly. It shares nothing with the Signal provider.

export type FakeRoom = { id: string; member: boolean; canEdit: boolean | "unknown" };

export type FakeChatServer = {
  rooms: Map<string, FakeRoom>;
  calls: Array<{
    op: "list" | "setPicture" | "setProfilePicture";
    room?: string;
    picture?: string;
    at: number;
  }>;
  script: Array<ApplyResult | ((picture: string) => ApplyResult) | null>;
  down: boolean;
};

export function createFakeChatServer(): FakeChatServer {
  return { rooms: new Map(), calls: [], script: [], down: false };
}

const KEY = /^agent:([^:]+):fakechat:room:(.+)$/i;

export function createFakeChatProvider(opts: {
  server: FakeChatServer;
  agentId: string;
  profileSessionKey: string | null;
  profileBaseImage?: string | null;
  now: () => number;
}): BadgeProvider {
  const { server } = opts;
  const profileRef: TargetRef = { kind: "profile", idLower: "profile" };
  const next = (picture: string): ApplyResult => {
    const s = server.script.shift();
    if (typeof s === "function") {
      return s(picture);
    }
    return s ?? { kind: "ok" };
  };
  return {
    id: "fakechat",
    asset: { width: 512, height: 512, format: "png" },
    pacing: { spacingMs: 2000 },
    configError: () => null,
    targetForSessionKey(key) {
      if (opts.profileSessionKey && key === opts.profileSessionKey) {
        return profileRef;
      }
      const m = KEY.exec(key);
      return m && m[1]!.toLowerCase() === opts.agentId
        ? { kind: "group", idLower: m[2]!.toLowerCase() }
        : null;
    },
    sessionKeyFor(ref) {
      return ref.kind === "profile"
        ? opts.profileSessionKey
        : `agent:${opts.agentId}:fakechat:room:${ref.idLower}`;
    },
    profile(): ProviderProfile | null {
      return opts.profileSessionKey
        ? {
            ref: profileRef,
            sessionKey: opts.profileSessionKey,
            baseImage: opts.profileBaseImage ?? null,
          }
        : null;
    },
    async listTargets() {
      server.calls.push({ op: "list", at: opts.now() });
      if (server.down) {
        return { ok: false, result: { kind: "pause", reason: "daemon-down" } };
      }
      const targets: ProviderTarget[] = [...server.rooms.values()].map((r) => ({
        ref: { kind: "group", idLower: r.id.toLowerCase() },
        member: r.member,
        canEdit: r.canEdit,
      }));
      return { ok: true, targets };
    },
    async resolve(ref) {
      if (ref.kind === "profile") {
        return { ok: true, realId: "profile" };
      }
      const room = [...server.rooms.values()].find((r) => r.id.toLowerCase() === ref.idLower);
      return room
        ? { ok: true, realId: room.id }
        : {
            ok: false,
            result: { kind: "permanent", reason: "not-found", message: "no such room" },
          };
    },
    async apply(target, picture) {
      server.calls.push({
        op: target.ref.kind === "profile" ? "setProfilePicture" : "setPicture",
        room: target.ref.kind === "profile" ? undefined : target.realId,
        picture,
        at: opts.now(),
      });
      if (server.down) {
        return { kind: "pause", reason: "daemon-down" };
      }
      return next(picture);
    },
  };
}
