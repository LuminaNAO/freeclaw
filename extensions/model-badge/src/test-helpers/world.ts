import { parseAgentSessionKey } from "openclaw/plugin-sdk/model-badge";
import type { BaseArtGenerator } from "../core/baseart.js";
import { normalizeConfig } from "../core/config.js";
import { createEngine, type Engine } from "../core/engine.js";
import type { Lease } from "../core/lease.js";
import type { ApplyResult, BadgeProvider } from "../core/provider.js";
import type { Renderer } from "../core/render.js";
import type { RpcOutcome } from "../providers/signal/classify.js";
import { createSignalProvider } from "../providers/signal/provider.js";
import { createFakeChatProvider, createFakeChatServer } from "./fake-provider.js";
import {
  createFakeClock,
  createFakeRenderer,
  createLog,
  createMemFs,
  markLetterOf,
  type FakeRenderer,
} from "./fakes.js";
import * as S from "./signal-fixtures.js";

// A synthetic world the core suite runs in, for either provider (ARCH §6.5). Outcomes
// are scripted in neutral words; each backend turns them into its own wire responses.

export const ROOT = "/virtual";

export type Outcome =
  | "ok"
  | "ok-empty"
  | "rate-limited"
  | { captcha: number }
  | "io"
  | "not-found"
  | "not-allowed"
  | "avatar-unreadable"
  | "profile-avatar-unreadable"
  | "profile-io"
  | "fallback-5"
  | { http429: number }
  | "odd";

export type Send = { target: string; kind: "group" | "profile"; avatar: string; at: number };

export type TargetOpts = {
  // ARCH §2c.8: the group's own avatar bytes when first seen (none by default).
  avatar?: Buffer;
  member?: boolean;
  admin?: boolean;
  edit?: "EVERY_MEMBER" | "ONLY_ADMINS";
};

interface Backend {
  name: "signal" | "fakechat";
  sessionKey(id: string): string;
  profileSessionKey: string;
  addTarget(id: string, o?: TargetOpts): void;
  dropTarget(id: string): void;
  has(id: string): boolean;
  setDown(v: boolean): void;
  push(...o: Array<Outcome | null>): void;
  always(fn: (send: Send) => Outcome | null): void;
  sends(): Send[];
  provider(profile: boolean): BadgeProvider;
  // The bytes the target shows now (§2c.8), as the channel would return them.
  avatar(id: string): Buffer | null;
  setAvatar(id: string, bytes: Buffer | null): void;
  avatarReads(): number;
  rpcLog(): Array<{ method: string; params: Record<string, unknown> }>;
}

function signalBackend(
  clock: { now(): number },
  readFile: (p: string) => Buffer | undefined,
): Backend {
  const groups = new Map<string, ReturnType<typeof S.group>>();
  const avatars = new Map<string, Buffer>();
  let avatarReads = 0;
  const calls: Array<{ method: string; params: Record<string, unknown>; at: number }> = [];
  const script: Array<Outcome | null> = [];
  let alwaysFn: ((s: Send) => Outcome | null) | null = null;
  let down = false;
  const toWire = (o: Outcome, avatar: string): RpcOutcome => {
    if (typeof o === "object" && "captcha" in o) {
      return S.ok(S.updateCaptcha(o.captcha));
    }
    if (typeof o === "object" && "http429" in o) {
      return { transport: "http", status: 429, retryAfterMs: o.http429 };
    }
    switch (o) {
      case "ok":
        return S.ok(S.updateOk());
      case "ok-empty":
        return S.ok({ jsonrpc: "2.0", id: 1, result: {} });
      case "rate-limited":
        return S.ok(S.updateRateLimited());
      case "io":
        return S.ok(S.errIo());
      case "not-found":
        return S.ok(S.errGroupNotFound());
      case "not-allowed":
        return S.ok(S.errNotAllowed());
      case "avatar-unreadable":
        return S.ok(S.errAvatarMissing(avatar));
      case "profile-avatar-unreadable":
        return S.ok(S.errProfileAvatarUnreadable(avatar));
      case "profile-io":
        return S.ok(S.errProfileIo());
      case "fallback-5":
        return S.ok(S.errRateLimitFallback());
      case "odd":
        return S.ok({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "Something odd" } });
    }
  };
  const sendOf = (c: { method: string; params: Record<string, unknown>; at: number }): Send => ({
    target: c.method === "updateProfile" ? "profile" : String(c.params.groupId),
    kind: c.method === "updateProfile" ? "profile" : "group",
    avatar: String(c.params.avatar),
    at: c.at,
  });
  const rpc = async (method: string, params: Record<string, unknown>): Promise<RpcOutcome> => {
    const call = { method, params: structuredClone(params), at: clock.now() };
    calls.push(call);
    if (down) {
      return { transport: "refused" };
    }
    if (method === "listGroups") {
      return S.ok(S.listGroups([...groups.values()]));
    }
    if (method === "getAvatar") {
      avatarReads++;
      const bytes = avatars.get(String(params.groupId));
      return bytes
        ? S.ok({ jsonrpc: "2.0", id: 1, result: { data: bytes.toString("base64") } })
        : S.ok({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "Could not find avatar" } });
    }
    const send = sendOf(call);
    const o = alwaysFn ? alwaysFn(send) : script.shift();
    const outcome = o ?? "ok";
    if (
      send.kind === "group" &&
      (outcome === "ok" || outcome === "ok-empty" || outcome === "rate-limited")
    ) {
      const b = readFile(send.avatar);
      if (b) {
        avatars.set(send.target, b);
      }
    }
    return toWire(outcome, send.avatar);
  };
  return {
    name: "signal",
    sessionKey: (id) => `agent:main:signal:group:${id.toLowerCase()}`,
    profileSessionKey: "agent:main:signal:direct:+10000000001",
    addTarget: (id, o) => {
      groups.set(id, S.group(id, o));
      if (o?.avatar) {
        avatars.set(id, o.avatar);
      }
    },
    dropTarget: (id) => void groups.delete(id),
    avatar: (id) => avatars.get(id) ?? null,
    setAvatar: (id, b) => void (b ? avatars.set(id, b) : avatars.delete(id)),
    avatarReads: () => avatarReads,
    has: (id) => groups.has(id),
    setDown: (v) => void (down = v),
    push: (...o) => void script.push(...o),
    always: (fn) => void (alwaysFn = fn),
    sends: () =>
      calls.filter((c) => c.method === "updateGroup" || c.method === "updateProfile").map(sendOf),
    rpcLog: () => calls.filter((c) => c.method !== "getAvatar"),
    provider: (profile) =>
      createSignalProvider({
        config: {
          agentId: "main",
          accountId: null,
          profileSessionKey: profile ? "agent:main:signal:direct:+10000000001" : null,
          profileBaseImage: null,
        },
        endpoint: { baseUrl: "http://127.0.0.1:1", account: S.ACCOUNT },
        rpc,
        parseSessionKey: parseAgentSessionKey,
        clock: clock as never,
      }),
  };
}

function fakeBackend(
  clock: { now(): number },
  readFile: (p: string) => Buffer | undefined,
): Backend {
  const server = createFakeChatServer();
  server.readPicture = readFile;
  let alwaysFn: ((s: Send) => Outcome | null) | null = null;
  const script: Array<Outcome | null> = [];
  const toResult = (o: Outcome, picture: string): ApplyResult => {
    if (typeof o === "object" && "captcha" in o) {
      return { kind: "captcha", committed: true, retryAfterMs: o.captcha * 1000 };
    }
    if (typeof o === "object" && "http429" in o) {
      return { kind: "rate-limit-uncommitted", retryAfterMs: o.http429 };
    }
    switch (o) {
      case "ok":
      case "ok-empty":
        return { kind: "ok" };
      case "rate-limited":
        return { kind: "ok-rate-limited" };
      case "io":
        return { kind: "pause", reason: "provider-io" };
      case "profile-io":
        return { kind: "pause", reason: "provider-io", neverPark: true };
      case "not-found":
        return { kind: "permanent", reason: "not-found", message: "room gone" };
      case "not-allowed":
        return {
          kind: "permanent",
          reason: "permission",
          message: "not allowed to change the room picture",
        };
      case "avatar-unreadable":
      case "profile-avatar-unreadable":
        return {
          kind: "config",
          source: "avatar",
          message: `the server cannot read ${picture}; the cache dir must be readable by the daemon`,
        };
      case "fallback-5":
        return { kind: "rate-limit-uncommitted" };
      case "odd":
        return { kind: "error", message: "Something odd" };
    }
  };
  const sendOf = (c: FakeChatServerCall): Send => ({
    target: c.op === "setProfilePicture" ? "profile" : String(c.room),
    kind: c.op === "setProfilePicture" ? "profile" : "group",
    avatar: String(c.picture),
    at: c.at,
  });
  type FakeChatServerCall = (typeof server.calls)[number];
  server.script = new Proxy([], {
    get(t, p) {
      if (p === "shift") {
        return () => {
          const last = server.calls.at(-1)!;
          const send = sendOf(last);
          const o = alwaysFn ? alwaysFn(send) : script.shift();
          return toResult(o ?? "ok", send.avatar);
        };
      }
      return Reflect.get(t, p);
    },
  });
  return {
    name: "fakechat",
    sessionKey: (id) => `agent:main:fakechat:room:${id.toLowerCase()}`,
    profileSessionKey: "agent:main:fakechat:direct:user-1",
    addTarget: (id, o = {}) =>
      void server.rooms.set(id, {
        id,
        member: o.member ?? true,
        canEdit: o.edit === "ONLY_ADMINS" ? (o.admin ?? false) : true,
        picture: o.avatar ?? null,
      }),
    dropTarget: (id) => void server.rooms.delete(id),
    avatar: (id) => server.rooms.get(id)?.picture ?? null,
    setAvatar: (id, b) => {
      const r = server.rooms.get(id);
      if (r) {
        r.picture = b;
      }
    },
    avatarReads: () => server.calls.filter((c) => c.op === "getPicture").length,
    has: (id) => server.rooms.has(id),
    setDown: (v) => void (server.down = v),
    push: (...o) => void script.push(...o),
    always: (fn) => void (alwaysFn = fn),
    sends: () => server.calls.filter((c) => c.op !== "list" && c.op !== "getPicture").map(sendOf),
    rpcLog: () =>
      server.calls
        .filter((c) => c.op !== "getPicture")
        .map((c) => ({ method: c.op, params: { room: c.room, picture: c.picture } })),
    provider: (profile) =>
      createFakeChatProvider({
        server,
        agentId: "main",
        profileSessionKey: profile ? "agent:main:fakechat:direct:user-1" : null,
        now: () => clock.now(),
      }),
  };
}

export const IDS = {
  a: "FakeTargetAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaA=",
  b: "FakeTargetBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbB=",
  c: "FakeTargetCcccccccccccccccccccccccccccccccccccC=",
};

export const BADGES = [
  { pattern: "fable", letter: "F", color: "#FFD700" },
  { pattern: "opus-[ab]$", letter: "O", color: "#9B59D0" },
  { pattern: "k-model", letter: "KL", color: "#5DADE2" },
];

export const MODELS = ["fable-model", "opus-a", "opus-b", "k-model", "plain-new"];

export type MakeEngineExtra = {
  instanceId?: string;
  lease?: Lease;
  renderer?: Renderer | null;
  failRender?: (svg: string) => boolean;
  imageGenerator?: BaseArtGenerator | null;
};

export type WorldOpts = {
  backend?: "signal" | "fakechat";
  targets?: string[];
  targetOpts?: Record<string, TargetOpts>;
  models?: Record<string, string[]>;
  defaultModel?: string;
  plugin?: Record<string, unknown>;
  timing?: Record<string, number>;
  limits?: Record<string, number>;
  profile?: boolean;
  store?: Record<string, unknown>;
};

export async function createWorld(opts: WorldOpts = {}) {
  const clock = createFakeClock();
  const fs = createMemFs(clock);
  const log = createLog();
  const readFile = (p: string) => fs.files.get(p)?.data;
  const backend =
    opts.backend === "fakechat" ? fakeBackend(clock, readFile) : signalBackend(clock, readFile);
  const paths = {
    rootDir: `${ROOT}/state/plugins/model-badge`,
    stateDir: `${ROOT}/state/plugins/model-badge/${backend.name}`,
    sessionsStore: `${ROOT}/state/agents/main/sessions/sessions.json`,
    modelsJson: `${ROOT}/state/agents/main/agent/models.json`,
    gatewayConfig: `${ROOT}/state/openclaw.json`,
  };
  let pluginConfig: Record<string, unknown> = {
    providers: [backend.name],
    badges: BADGES,
    operators: ["+10000000002"],
    timing: { ...opts.timing },
    limits: { ...opts.limits },
    ...opts.plugin,
  };
  let defaultModel = opts.defaultModel ?? "prov/fable-model";
  let extraGateway: Record<string, unknown> = {};
  const writeGateway = () =>
    fs.putJson(paths.gatewayConfig, {
      agents: { defaults: { model: { primary: defaultModel } } },
      plugins: { entries: { "model-badge": { enabled: true, config: pluginConfig } } },
      ...extraGateway,
    });

  const tk = (id: string) => `group:${id.toLowerCase()}`;
  const sk = (id: string) => backend.sessionKey(id);

  const w = {
    clock,
    fs,
    log,
    backend,
    paths,
    engines: [] as Engine[],
    renderers: [] as FakeRenderer[],
    tk,
    sk,
    setModels(map: Record<string, string[]>) {
      const providers: Record<string, unknown> = {};
      for (const [p, ids] of Object.entries(map)) {
        providers[p] = { baseUrl: "http://fake.invalid", models: ids.map((id) => ({ id })) };
      }
      fs.putJson(paths.modelsJson, { providers });
    },
    setDefault(model: string) {
      defaultModel = model;
      writeGateway();
    },
    setPlugin(patch: Record<string, unknown>) {
      pluginConfig = { ...pluginConfig, ...patch };
      writeGateway();
    },
    setGatewayExtra(extra: Record<string, unknown>) {
      extraGateway = extra;
      writeGateway();
    },
    pluginConfig: () => pluginConfig,
    store: () =>
      fs.exists(paths.sessionsStore)
        ? fs.getJson<Record<string, unknown>>(paths.sessionsStore)
        : {},
    setStore(obj: Record<string, unknown>) {
      fs.putJson(paths.sessionsStore, obj);
    },
    pin(id: string, model: string, key = sk(id)) {
      const s = w.store();
      const [provider, ...rest] = model.split("/");
      s[key] = {
        ...(s[key] as object),
        providerOverride: provider,
        modelOverride: rest.join("/"),
        updatedAt: clock.now(),
        model: "stale/entry-model",
      };
      w.setStore(s);
    },
    unpin(id: string, key = sk(id)) {
      const s = w.store();
      s[key] = { updatedAt: clock.now(), model: "stale/entry-model" };
      w.setStore(s);
    },
    addTarget(id: string, o?: TargetOpts, withSession = true) {
      backend.addTarget(id, o);
      if (withSession) {
        const s = w.store();
        s[sk(id)] = { updatedAt: clock.now() };
        w.setStore(s);
      }
    },
    applied: () =>
      fs.exists(`${paths.stateDir}/applied.json`)
        ? fs.getJson<{ targets: Record<string, { hash: string; model?: string; mark?: string }> }>(
            `${paths.stateDir}/applied.json`,
          ).targets
        : {},
    status: () => fs.getJson<Record<string, any>>(`${paths.stateDir}/status.json`),
    sends: () => backend.sends(),
    targetSends: (id: string) => backend.sends().filter((s) => s.target === id),
    letterOf: (s: Send | undefined) => (s ? markLetterOf(fs.files.get(s.avatar)?.data) : null),
    assets: () => fs.list(`${paths.stateDir}/assets/`).filter((f) => f.endsWith(".png")),
    makeEngine(extra: MakeEngineExtra = {}): Engine {
      const norm = normalizeConfig(pluginConfig, { gatewayStateDir: `${ROOT}/state` });
      const renderer =
        extra.renderer !== undefined
          ? extra.renderer
          : createFakeRenderer(fs, { failWhen: extra.failRender });
      if (renderer && "calls" in renderer) {
        w.renderers.push(renderer as FakeRenderer);
      }
      const engine = createEngine({
        config: norm.config,
        provider: backend.provider(Boolean(opts.profile)),
        paths: { ...paths },
        fs,
        clock,
        log,
        renderer,
        imageGenerator: extra.imageGenerator ?? null,
        random: () => 0,
        hostname: "test-host",
        instanceId: extra.instanceId ?? `inst-${w.engines.length + 1}`,
        lease: extra.lease,
        validationErrors: norm.ok ? [] : norm.errors,
      });
      w.engines.push(engine);
      return engine;
    },
    async startEngine(extra: MakeEngineExtra = {}): Promise<Engine> {
      const e = w.makeEngine(extra);
      await e.start();
      await clock.flush();
      return e;
    },
    renderCalls: (): number =>
      w.renderers.reduce((n: number, r: FakeRenderer) => n + r.calls.length, 0),
    async settle(ms = 60_000) {
      await clock.advance(ms);
    },
  };

  w.setModels(opts.models ?? { prov: MODELS });
  writeGateway();
  const targets = opts.targets ?? [IDS.a, IDS.b];
  for (const id of targets) {
    backend.addTarget(id, opts.targetOpts?.[id]);
  }
  w.setStore(
    opts.store ??
      Object.fromEntries(
        targets.map((id) => [sk(id), { updatedAt: 1, model: "stale/entry-model" }]),
      ),
  );
  return w;
}

export type World = Awaited<ReturnType<typeof createWorld>>;
