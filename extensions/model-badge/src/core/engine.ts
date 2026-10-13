// The channel-agnostic engine (ARCH §1, §3, §4). One engine drives one provider. It is
// the ONLY caller of provider.apply and the only writer of applied.json, status.json, the
// asset cache and the stored image bases. Ported from the certified standalone
// reconciler: desired-state reconcile, single writer with lease, debounce, paced queue,
// rate-limit/captcha/outage pauses, parking, status/health.
import os from "node:os";
import path from "node:path";
import { createImageBases, type BaseArtGenerator, type ImageBases } from "./baseart.js";
import { createAssetCache, type AssetCache, type AssetJob } from "./cache.js";
import type { Clock, Logger } from "./clock.js";
import { normalizeConfig, type ModelBadgeConfig } from "./config.js";
import { createView, type Desired, type HeldBase, type View } from "./desired.js";
import type { CoreFs } from "./fsio.js";
import { sha256 } from "./hash.js";
import { createLease, type Lease } from "./lease.js";
import type { BaseParams } from "./motif.js";
import { targetKey, type ApplyResult, type BadgeProvider, type TargetRef } from "./provider.js";
import type { Renderer } from "./render.js";
import { overrideSnapshot, type SessionEntryLike } from "./resolve.js";
import { createStyleStore, seededRules, type StyleRule } from "./style.js";

// Keeps ids and phone numbers out of logs and status messages.
export function redact(s: unknown): string {
  return String(s ?? "")
    .replace(/[A-Za-z0-9+/]{20,}={0,2}/g, "<id>")
    .replace(/\+\d{6,}/g, "<number>")
    .slice(0, 300);
}

export const PLUGIN_ID = "model-badge";

export type EnginePaths = {
  // Provider namespace: applied.json, status.json, writer.lease, assets/, bases/.
  stateDir: string;
  // Shared across providers: style.json.
  rootDir: string;
  sessionsStore: string;
  modelsJson: string;
  gatewayConfig: string;
};

export type EngineDeps = {
  config: ModelBadgeConfig;
  provider: BadgeProvider;
  paths: EnginePaths;
  fs: CoreFs;
  clock: Clock;
  log: Logger;
  // null: no rasteriser on the host → health renderer-missing, writer idle.
  renderer: Renderer | null;
  imageGenerator?: BaseArtGenerator | null;
  parseConfigText?: (text: string) => unknown;
  initialGatewayConfig?: unknown;
  instanceId?: string;
  lease?: Lease;
  random?: () => number;
  hostname?: string;
  validationErrors?: string[];
};

// `base` records what the target shows, so image-first selection (§2c.4) can keep it
// while its image base is not ready. A record without `base` predates it.
type AppliedBase =
  | { kind: "vector"; params: BaseParams }
  | { kind: "raster"; source: "image" | "file"; sha: string };
type AppliedRecord = {
  hash: string;
  appliedAt: number;
  model?: string;
  mark?: string;
  base?: AppliedBase;
};
type AppliedState = { version: 1; targets: Record<string, AppliedRecord> };
type TargetInfo = {
  ref: TargetRef;
  sessionKey: string | null;
  canEdit?: boolean | "unknown";
  listed?: boolean;
};
type OkDesired = Extract<Desired, { ok: true }>;

type Inputs = {
  store: Record<string, SessionEntryLike>;
  modelsJson: unknown;
  gatewayConfig: unknown;
  rules: StyleRule[];
  pluginConfig: ModelBadgeConfig;
  profileFile: { file: string; sha: string } | null;
};

export type Role = "starting" | "writer" | "standby" | "idle" | "stopped";

export function createEngine(deps: EngineDeps) {
  const { provider, fs, clock, log, paths: P } = deps;
  const parseConfigText = deps.parseConfigText ?? ((t: string) => JSON.parse(t) as unknown);
  const random = deps.random ?? Math.random;
  const hostname = deps.hostname ?? os.hostname();
  const T = deps.config.timing;
  const L = deps.config.limits;
  const size = { width: provider.asset.width, height: provider.asset.height };
  const instanceId =
    deps.instanceId ?? sha256(`${process.pid}:${clock.now()}:${random()}`).slice(0, 16);
  const tag = `[model-badge:${provider.id}]`;

  const cache: AssetCache | null = deps.renderer
    ? createAssetCache({
        fs,
        renderer: deps.renderer,
        cacheDir: path.join(P.stateDir, "assets"),
        size,
        clock,
        log,
        concurrency: T.renderConcurrency,
      })
    : null;
  const images: ImageBases = createImageBases({
    fs,
    dir: path.join(P.stateDir, "bases"),
    generator: deps.imageGenerator ?? null,
    renderer: deps.renderer,
    size,
    clock,
    log,
    limits: {
      maxPerDay: deps.config.imageGen?.maxPerDay ?? 0,
      maxPerRun: deps.config.imageGen?.maxPerRun ?? 0,
      maxAttempts: deps.config.imageGen?.maxAttempts ?? 1,
      backoffMs: T.imageGenBackoffMs,
      maxBackoffMs: T.imageGenMaxBackoffMs,
    },
  });
  const styleStore = createStyleStore({ fs, stateDir: P.rootDir });
  const lease =
    deps.lease ??
    createLease({
      fs,
      stateDir: P.stateDir,
      clock,
      ttlMs: T.leaseTtlMs,
      instanceId,
      host: hostname,
    });
  const appliedPath = path.join(P.stateDir, "applied.json");
  const statusPath = path.join(P.stateDir, "status.json");

  let running = false;
  let started = false;
  let role: Role = "starting";
  let holder: { pid: number; host: string; heartbeatAt: number } | null = null;
  let applied: AppliedState = { version: 1, targets: {} };
  const status = {
    parked: {} as Record<
      string,
      { hash: string; reason: string; message: string; since: number; attempts: number }
    >,
    inflight: {} as Record<string, { hash: string; since: number; base?: AppliedBase }>,
    waiting: {} as Record<string, { reason: string; since: number }>,
    notices: {
      unavailableModels: {} as Record<string, { firstSeen: number; targets: string[] }>,
      unmatchedModels: {} as Record<string, { letter: string; color: string; firstSeen: number }>,
    },
    health: {} as Record<string, unknown>,
    cache: { fingerprint: null, required: 0, present: 0, failed: {}, builtAt: null } as Record<
      string,
      unknown
    >,
    triggers: {} as Record<string, { count: number; lastSeenAt: number | null }>,
    ids: {} as Record<string, string>,
  };

  let inputs: Inputs | null = null;
  let view: View | null = null;
  let targets = new Map<string, TargetInfo>();
  const gone = new Set<string>();
  const removedBases = new Set<string>();
  const snapshots = new Map<string, string>();
  const stats = new Map<string, string>();
  let lastBuiltFingerprint: string | null = null;
  let inputsBroken: string[] = [];
  let configFromAvatar = false;
  const artAttempts = new Map<string, number>();
  const nudged = new Set<string>();

  const debounce = new Map<string, unknown>();
  const queue: string[] = [];
  const delayed = new Set<string>();
  let pumpTimer: unknown = null;
  let timers: unknown[] = [];
  let lastSendAt = Number.NEGATIVE_INFINITY;
  let pausedUntil = 0;
  let pauseReason: string | null = null;
  let consecutivePauses = 0;
  let captchaPauseMs = 0;
  // After a captcha pause the next send is a probe. Sends are strictly serial and a
  // captcha result re-pauses before the next send, so exactly one probe goes out.
  let captchaProbe = false;
  let currentSend: Promise<void> | null = null;
  let rebuildPromise: Promise<void> | null = null;
  let rebuildAgain = false;
  let writeChain: Promise<void> = Promise.resolve();
  const errorAttempts = new Map<string, { n: number; nextAt: number }>();
  const ioStreak = new Map<string, { n: number; othersOk: boolean }>();
  const logged = new Map<string, unknown>();

  function once(key: string, value: unknown, fn: () => void) {
    if (logged.get(key) === value) {
      return;
    }
    logged.set(key, value);
    fn();
  }

  function bump(source: string) {
    const t = (status.triggers[source] ??= { count: 0, lastSeenAt: null });
    t.count++;
    t.lastSeenAt = clock.now();
  }

  function setHealth(name: string, value: unknown) {
    if (value === null || value === undefined) {
      if (name in status.health) {
        delete status.health[name];
        once(`health:${name}`, "ok", () => log.info(`${tag} ${name} ok`));
      }
      return;
    }
    status.health[name] = value;
    once(`health:${name}`, JSON.stringify(value), () =>
      log.error(`${tag} ${name}: ${typeof value === "string" ? value : JSON.stringify(value)}`),
    );
  }

  // ---------------- persistence ----------------

  function snapshotStatus() {
    const now = clock.now();
    return {
      version: 1,
      provider: provider.id,
      ...status,
      imageGen: images.status(),
      ids: provider.knownIds?.() ?? status.ids,
      role,
      holder: holder
        ? { pid: holder.pid, host: holder.host, heartbeatAt: holder.heartbeatAt }
        : null,
      queue: {
        length: queue.length,
        pausedUntil: pausedUntil > now ? pausedUntil : null,
        pauseReason: pausedUntil > now ? pauseReason : null,
        consecutive: consecutivePauses,
      },
    };
  }

  let lastAppliedText: string | null = null;
  function persist(opts: { applied?: boolean } = {}): Promise<void> {
    writeChain = writeChain
      .then(async () => {
        if (role !== "writer") {
          return;
        }
        await fs.mkdirp(P.stateDir);
        if (opts.applied) {
          const text = JSON.stringify(applied, null, 1);
          if (text !== lastAppliedText) {
            await fs.writeAtomic(appliedPath, text);
            lastAppliedText = text;
          }
        }
        await fs.writeAtomic(statusPath, JSON.stringify(snapshotStatus(), null, 1));
      })
      .catch((err) => log.error(`${tag} state write failed: ${(err as Error)?.message ?? err}`));
    return writeChain;
  }

  // Replaces in-memory assignment state with what is on disk. Runs on every lease
  // acquisition: a standby's memory is stale because the previous writer kept going.
  async function loadPersisted() {
    applied = { version: 1, targets: {} };
    lastAppliedText = null;
    try {
      const a = JSON.parse(await fs.readText(appliedPath)) as Partial<AppliedState>;
      if (a && typeof a.targets === "object" && a.targets) {
        applied = { version: 1, targets: a.targets };
        lastAppliedText = JSON.stringify(applied, null, 1);
      }
    } catch {
      // Fresh start: the first reconcile paints once, paced.
    }
    status.parked = {};
    status.inflight = {};
    errorAttempts.clear();
    ioStreak.clear();
    try {
      const s = JSON.parse(await fs.readText(statusPath)) as Record<string, unknown>;
      for (const k of ["parked", "inflight", "notices", "ids"] as const) {
        if (s?.[k] && typeof s[k] === "object") {
          (status as Record<string, unknown>)[k] = s[k];
        }
      }
      provider.seedIds?.(status.ids);
    } catch {
      // No status yet.
    }
    // A target still marked in-flight may show an asset other than the recorded one
    // (crash after send, before the applied write): it is repainted once, and the
    // in-flight hash stays protected from pruning until then.
    // The record keeps what the target (probably) shows, so image-first selection keeps
    // that avatar instead of painting a vector over it (§2c.4).
    for (const [k, i] of Object.entries(status.inflight)) {
      const rec = applied.targets[k];
      if (rec?.hash !== i?.hash) {
        applied.targets[k] = { hash: "", appliedAt: 0, base: i?.base ?? rec?.base };
      }
    }
    await images.load();
  }

  // ---------------- inputs ----------------

  async function statKey(p: string): Promise<string> {
    try {
      const s = await fs.stat(p);
      return s ? `${s.mtimeMs}:${s.size}` : "missing";
    } catch {
      return "error";
    }
  }

  function pluginConfigFrom(gatewayConfig: unknown): ModelBadgeConfig | null {
    const entry = (
      gatewayConfig as { plugins?: { entries?: Record<string, { config?: unknown }> } } | undefined
    )?.plugins?.entries?.[PLUGIN_ID];
    if (!entry || entry.config === undefined) {
      return null;
    }
    const n = normalizeConfig(entry.config, { gatewayStateDir: P.rootDir });
    if (!n.ok) {
      throw new Error(n.errors.join("; "));
    }
    return n.config;
  }

  // Reads every input. A file that fails to read or parse keeps its last good value.
  async function loadInputs(): Promise<boolean> {
    const prev = inputs;
    const broken: string[] = [];
    const load = async <R>(
      name: string,
      fn: () => Promise<R>,
      opts: { blocking?: boolean } = {},
    ): Promise<R | undefined> => {
      try {
        const v = await fn();
        setHealth(name, null);
        return v;
      } catch (err) {
        setHealth(
          name,
          `unreadable (${redact((err as Error)?.message ?? err).slice(0, 120)}); keeping last good`,
        );
        if (opts.blocking) {
          broken.push(name);
        }
        return undefined;
      }
    };
    const json = async (p: string, missing: unknown) =>
      (await fs.stat(p)) ? (JSON.parse(await fs.readText(p)) as unknown) : missing;

    const store = await load("sessionsStore", () => json(P.sessionsStore, {}));
    const modelsJson = await load("modelsJson", () => json(P.modelsJson, {}));
    const gatewayConfig = await load("gatewayConfig", async () =>
      (await fs.stat(P.gatewayConfig))
        ? parseConfigText(await fs.readText(P.gatewayConfig))
        : (deps.initialGatewayConfig ?? {}),
    );
    const pluginConfig =
      gatewayConfig === undefined
        ? undefined
        : await load("pluginConfig", async () => pluginConfigFrom(gatewayConfig), {
            blocking: true,
          });
    const stored = await load("style", () => styleStore.load(), { blocking: true });
    const profile = provider.profile();
    let profileFile: Inputs["profileFile"] | undefined = null;
    if (profile?.baseImage) {
      const file = profile.baseImage;
      profileFile = await load(
        "profileBaseImage",
        async () => ({
          file,
          sha: sha256(await fs.readFile(file)),
        }),
        { blocking: true },
      );
    }

    const pc = pluginConfig ?? prev?.pluginConfig ?? deps.config;
    const next: Inputs = {
      store: (store && typeof store === "object" ? store : (prev?.store ?? {})) as Inputs["store"],
      modelsJson: modelsJson ?? prev?.modelsJson ?? {},
      gatewayConfig: gatewayConfig ?? prev?.gatewayConfig ?? deps.initialGatewayConfig ?? {},
      pluginConfig: pc,
      rules: [
        ...seededRules(pc.steering.rules),
        ...(stored ?? prev?.rules.filter((r) => !r.id.startsWith("config-")) ?? []),
      ],
      profileFile: profileFile === undefined ? (prev?.profileFile ?? null) : profileFile,
    };
    // An unreadable plugin config, style file or profile image could repaint every
    // target wrongly, so sends stop until it is fixed (fail-safe, standalone §5).
    inputsBroken = broken;
    inputs = next;
    view = makeView(next);
    setHealth(
      "defaultModel",
      view.defaultModel ? null : "no default model configured (agents.defaults.model)",
    );
    return true;
  }

  function makeView(i: Inputs): View {
    return createView(
      {
        store: i.store,
        modelsJson: i.modelsJson,
        gatewayConfig: i.gatewayConfig,
        badges: i.pluginConfig.badges,
        rules: i.rules,
        overrides: i.pluginConfig.targets,
        profileFile: i.profileFile,
        storedImage: (w) => images.current(w),
        imageMode: images.state !== "unconfigured",
        held: heldBase,
        generation: (key) => images.generation(key),
      },
      { providerId: provider.id, size },
    );
  }

  // What a target shows now, as a base the view can composite a new mark on (§2c.4).
  function heldBase(k: string): HeldBase | null {
    const rec = applied.targets[k];
    if (!rec) {
      return status.inflight[k] ? { kind: "unknown" } : null;
    }
    const b = rec.base;
    if (!b) {
      return { kind: "unknown" };
    }
    if (b.kind === "vector") {
      return { kind: "vector", params: b.params };
    }
    if (b.source === "file") {
      const pf = inputs?.profileFile;
      return pf && pf.sha === b.sha
        ? { kind: "raster", source: "file", sha: pf.sha, file: pf.file }
        : { kind: "unknown" };
    }
    const s = images.bySha(b.sha);
    return s ? { kind: "raster", source: "image", sha: s.sha, file: s.file } : { kind: "unknown" };
  }

  function appliedBaseOf(d: OkDesired): AppliedBase {
    return d.base.kind === "vector"
      ? { kind: "vector", params: d.base.params }
      : { kind: "raster", source: d.base.source, sha: d.base.sha };
  }

  function watchedPaths(): string[] {
    const list = [P.sessionsStore, P.modelsJson, P.gatewayConfig, styleStore.file];
    const pb = provider.profile()?.baseImage;
    if (pb) {
      list.push(pb);
    }
    return list;
  }

  async function recordStats() {
    for (const p of watchedPaths()) {
      stats.set(p, await statKey(p));
    }
  }

  // ---------------- targets ----------------

  function targetsFromStore(): Map<string, TargetInfo> {
    const out = new Map<string, TargetInfo>();
    for (const sessionKey of Object.keys(inputs?.store ?? {})) {
      const ref = provider.targetForSessionKey(sessionKey);
      if (!ref || ref.kind === "profile") {
        continue;
      }
      const k = targetKey(ref);
      if (gone.has(k)) {
        continue;
      }
      const prev = targets.get(k);
      out.set(k, { ref, sessionKey, canEdit: prev?.canEdit, listed: prev?.listed });
    }
    const prof = provider.profile();
    if (prof) {
      out.set(targetKey(prof.ref), { ref: prof.ref, sessionKey: prof.sessionKey });
    }
    // Provider-listed targets with no session yet use the default model.
    for (const [k, t] of targets) {
      if (!out.has(k) && t.listed) {
        out.set(k, t);
      }
    }
    return out;
  }

  // ARCH §3.3: a removed target loses its assignment record, parked state and (at the
  // next prune) its assets and stored base. No RPC.
  async function removeTarget(k: string, why: string) {
    const t = targets.get(k);
    const had = applied.targets[k] || status.parked[k];
    delete applied.targets[k];
    delete status.parked[k];
    delete status.waiting[k];
    delete status.inflight[k];
    targets.delete(k);
    gone.add(k);
    const qi = queue.indexOf(k);
    if (qi !== -1) {
      queue.splice(qi, 1);
    }
    if (t && view) {
      const want = view.imageWant(t.ref);
      removedBases.add(want.key);
      await images.remove(want.key);
    }
    if (had) {
      log.info(`${tag} target removed: ${why}`);
    }
  }

  async function refreshProviderTargets(): Promise<boolean> {
    const r = await provider.listTargets();
    if (!r.ok) {
      setHealth("daemon", "unreachable (target listing failed)");
      return false;
    }
    setHealth("daemon", null);
    const live = new Map(r.targets.map((t) => [targetKey(t.ref), t] as const));
    for (const [k, t] of live) {
      if (!t.member) {
        continue;
      }
      gone.delete(k);
      const cur = targets.get(k) ?? { ref: t.ref, sessionKey: provider.sessionKeyFor(t.ref) };
      cur.canEdit = t.canEdit;
      cur.listed = true;
      targets.set(k, cur);
    }
    for (const [k, t] of [...targets]) {
      if (t.ref.kind !== "group") {
        continue;
      }
      const l = live.get(k);
      if (!l || !l.member) {
        await removeTarget(k, "target is gone or the account is no longer a member");
      }
    }
    return true;
  }

  // ---------------- layer 1: generated assets ----------------

  function rebuild(reason: string): Promise<void> {
    if (rebuildPromise) {
      rebuildAgain = true;
      return rebuildPromise;
    }
    rebuildPromise = (async () => {
      do {
        rebuildAgain = false;
        await doRebuild(reason);
      } while (rebuildAgain && running);
    })().finally(() => {
      rebuildPromise = null;
    });
    return rebuildPromise;
  }

  // Image bases first (§2b.2), within the caps; then every live target × every mark of
  // every available model, plus "?" (§3.1). Generates what is missing, prunes what is
  // unused (§3.2, §3.3, §3.5) — never a full wipe.
  async function doRebuild(reason: string) {
    if (!view || !cache || !inputs) {
      return;
    }
    const t0 = clock.now();
    const refs = [...targets.values()].map((t) => t.ref);
    const wants = refs
      .filter((r) => !(r.kind === "profile" && inputs?.profileFile))
      .map((r) => view!.imageWant(r));
    const img = await images.ensure(wants);
    if (img.generated > 0) {
      view = makeView(inputs);
    }
    const fp = view.fingerprint(refs);

    const required = new Map<string, AssetJob>();
    for (const ref of refs) {
      for (const job of view.requiredFor(ref)) {
        required.set(job.hash, job);
      }
    }
    const toRender = new Map(
      [...required].filter(([h]) => (artAttempts.get(h) ?? 0) < L.maxArtAttempts),
    );
    const res = await cache.ensure(toRender);
    for (const f of res.failed) {
      artAttempts.set(f.hash, (artAttempts.get(f.hash) ?? 0) + 1);
    }

    const failed: Record<string, { attempts: number; gaveUp: boolean; error?: string }> = {};
    let present = 0;
    for (const h of required.keys()) {
      if (await cache.has(h)) {
        present++;
        artAttempts.delete(h);
      } else {
        const n = artAttempts.get(h) ?? 0;
        failed[h.slice(0, 12)] = {
          attempts: n,
          gaveUp: n >= L.maxArtAttempts,
          error: res.failed.find((f) => f.hash === h)?.error,
        };
      }
    }

    const pruned = await pruneUnused(required.keys());
    await pruneBases(refs);

    if (Object.keys(failed).length === 0) {
      lastBuiltFingerprint = fp;
    }
    status.cache = {
      fingerprint: fp,
      required: required.size,
      present,
      failed,
      rendered: res.rendered,
      pruned,
      images: img,
      builtAt: clock.now(),
      durationMs: clock.now() - t0,
      reason,
    };
    log.info(
      `${tag} assets (${reason}): ${required.size} required, ${res.rendered} rendered, ` +
        `${Object.keys(failed).length} failed, ${pruned} pruned`,
    );
    await persist();
  }

  // An asset goes once nothing needs it: not required, not applied, not in flight, and
  // older than the grace period — or at once if its target was removed (§3.2, §3.3).
  async function pruneUnused(required: Iterable<string>): Promise<number> {
    if (!cache || !view) {
      return 0;
    }
    const keep = new Set(required);
    for (const a of Object.values(applied.targets)) {
      keep.add(a.hash);
    }
    for (const i of Object.values(status.inflight)) {
      keep.add(i.hash);
    }
    const live = new Set([...targets.values()].map((t) => view!.imageWant(t.ref).key));
    const removed = new Set([...removedBases].filter((b) => !live.has(b)));
    const { pruned } = await cache.prune({ keep, graceMs: T.pruneGraceMs, removedBases: removed });
    removedBases.clear();
    return pruned;
  }

  // §2c.3: stored image bases go once no live target wants them and none shows them, so
  // a regenerated target's old picture is pruned after the new one is applied.
  async function pruneBases(refs: TargetRef[]) {
    if (!view) {
      return 0;
    }
    const seeds = new Set(refs.map((r) => view!.imageWant(r).target.seed));
    const shas = new Set<string>();
    for (const b of [
      ...Object.values(applied.targets).map((a) => a.base),
      ...Object.values(status.inflight).map((i) => i.base),
    ]) {
      if (b?.kind === "raster") {
        shas.add(b.sha);
      }
    }
    return images.prune({ seeds, shas });
  }

  // ---------------- layer 2: reconcile ----------------

  function noteNotices(d: OkDesired, k: string) {
    if (d.mark.kind === "unknown") {
      const n = (status.notices.unavailableModels[d.model] ??= {
        firstSeen: clock.now(),
        targets: [],
      });
      if (!n.targets.includes(k)) {
        n.targets.push(k);
      }
      once(`unavailable:${d.model}`, 1, () =>
        log.warn(`${tag} model ${d.model} is not available; showing "?"`),
      );
    } else if (d.mark.kind === "auto") {
      status.notices.unmatchedModels[d.model] ??= {
        letter: d.mark.mark.letter,
        color: d.mark.mark.color,
        firstSeen: clock.now(),
      };
    }
  }

  function park(k: string, hash: string, reason: string, message: string) {
    status.parked[k] = {
      hash,
      reason,
      message: redact(message),
      since: clock.now(),
      attempts: errorAttempts.get(k)?.n ?? 0,
    };
    errorAttempts.delete(k);
    ioStreak.delete(k);
    const i = queue.indexOf(k);
    if (i !== -1) {
      queue.splice(i, 1);
    }
    once(`park:${k}`, `${reason}:${hash}`, () =>
      log.warn(`${tag} target parked (${reason}): ${redact(message)}`),
    );
  }

  async function evaluate(
    k: string,
  ): Promise<{ action: "skip"; why: string } | { action: "send"; d: OkDesired; t: TargetInfo }> {
    const t = targets.get(k);
    if (!t || !view || !cache) {
      return { action: "skip", why: "unknown-target" };
    }
    if (inputsBroken.length) {
      return { action: "skip", why: "inputs-broken" };
    }
    const d = view.desired(t.ref, t.sessionKey);
    if (!d.ok) {
      if (d.class === "waiting-for-image") {
        status.waiting[k] = {
          reason: "waiting-for-image",
          since: status.waiting[k]?.since ?? clock.now(),
        };
        return { action: "skip", why: "waiting-for-image" };
      }
      return { action: "skip", why: "config" };
    }
    noteNotices(d, k);
    const parked = status.parked[k];
    if (parked) {
      if (parked.hash === d.hash) {
        return { action: "skip", why: "parked" };
      }
      delete status.parked[k];
      errorAttempts.delete(k);
    }
    if (applied.targets[k]?.hash === d.hash) {
      delete status.waiting[k];
      return { action: "skip", why: "converged" };
    }
    if (t.canEdit === false) {
      park(
        k,
        d.hash,
        "permission",
        "the account cannot edit this target's avatar (only admins can)",
      );
      return { action: "skip", why: "parked" };
    }
    // The apply path never renders (standalone O2): a missing asset waits for a rebuild.
    if (!(await cache.has(d.hash))) {
      status.waiting[k] = {
        reason: "waiting-for-asset",
        since: status.waiting[k]?.since ?? clock.now(),
      };
      return { action: "skip", why: "waiting-for-asset" };
    }
    delete status.waiting[k];
    return { action: "send", d, t };
  }

  async function reconcileAll(reason: string) {
    if (!view) {
      return;
    }
    bump(`pass:${reason}`);
    for (const k of targets.keys()) {
      if ((await evaluate(k)).action === "send") {
        enqueue(k);
      }
    }
    await persist({ applied: true });
    schedulePump();
  }

  // ---------------- queue ----------------

  function enqueue(k: string, opts: { head?: boolean } = {}) {
    if (queue.includes(k)) {
      return;
    }
    if (opts.head) {
      queue.unshift(k);
    } else {
      queue.push(k);
    }
  }

  function markDirty(k: string) {
    if (!running) {
      return;
    }
    const prev = debounce.get(k);
    if (prev) {
      clock.clearTimeout(prev);
    }
    debounce.set(
      k,
      clock.setTimeout(() => {
        debounce.delete(k);
        enqueue(k);
        schedulePump();
      }, T.debounceMs),
    );
  }

  function schedulePump() {
    if (!running || role !== "writer" || pumpTimer || currentSend || queue.length === 0) {
      return;
    }
    const now = clock.now();
    const wait = Math.max(0, pausedUntil - now, lastSendAt + T.queueSpacingMs - now);
    pumpTimer = clock.setTimeout(() => {
      pumpTimer = null;
      return pump().catch((err) => log.error(`${tag} queue: ${(err as Error)?.message ?? err}`));
    }, wait);
  }

  function pauseQueue(reason: string, ms: number) {
    pausedUntil = Math.max(pausedUntil, clock.now() + ms);
    pauseReason = reason;
    once("pause", `${reason}:${consecutivePauses}`, () =>
      log.warn(`${tag} queue paused (${reason}) for ${Math.round(ms / 1000)} s`),
    );
  }

  function backoffMs(hintMs?: number) {
    const computed = Math.min(
      T.rateLimitBaseMs * 2 ** Math.max(0, consecutivePauses - 1),
      T.rateLimitMaxBackoffMs,
    );
    return Math.max(hintMs ?? 0, Math.round(computed * (1 + 0.1 * random())));
  }

  async function pump() {
    if (!running || role !== "writer" || currentSend) {
      return;
    }
    const now = clock.now();
    if (now < pausedUntil || now < lastSendAt + T.queueSpacingMs) {
      schedulePump();
      return;
    }
    const k = queue.shift();
    if (k === undefined) {
      return;
    }
    const nextAt = errorAttempts.get(k)?.nextAt ?? 0;
    if (now < nextAt) {
      if (!delayed.has(k)) {
        delayed.add(k);
        timers.push(
          clock.setTimeout(() => {
            delayed.delete(k);
            enqueue(k);
            schedulePump();
          }, nextAt - now),
        );
      }
      schedulePump();
      return;
    }
    if (captchaProbe) {
      bump("captchaProbe");
    }
    currentSend = sendOne(k).catch((err) =>
      log.error(`${tag} send: ${(err as Error)?.message ?? err}`),
    );
    try {
      await currentSend;
    } finally {
      currentSend = null;
      await persist({ applied: true });
      schedulePump();
    }
  }

  async function sendOne(k: string) {
    if (!(await lease.stillMine())) {
      becomeStandby();
      return;
    }
    const e = await evaluate(k);
    if (e.action !== "send" || !cache) {
      return;
    }
    const { d, t } = e;
    const r = await provider.resolve(t.ref, { minRefreshMs: T.listTargetsMinRefreshMs });
    if (!r.ok) {
      await handleResult(k, d, r.result);
      return;
    }
    // In-flight is recorded atomically before the send: it protects the asset from
    // pruning across a crash between the send and the applied write (standalone RC2).
    status.inflight[k] = { hash: d.hash, since: clock.now(), base: appliedBaseOf(d) };
    await persist();

    lastSendAt = clock.now();
    bump("send");
    let result: ApplyResult;
    try {
      result = await provider.apply({ ref: t.ref, realId: r.realId }, cache.pngPath(d.hash));
    } catch (err) {
      result = { kind: "error", message: String((err as Error)?.message ?? err) };
    }
    const before = applied.targets[k]?.base;
    await handleResult(k, d, result);
    delete status.inflight[k];
    // §2c.3: once a new image base is applied, the one it replaced goes (if nothing else
    // shows it and no live target wants it).
    const after = applied.targets[k]?.base;
    if (before?.kind === "raster" && (after?.kind !== "raster" || after.sha !== before.sha)) {
      await pruneBases([...targets.values()].map((x) => x.ref));
    }
  }

  function recordApplied(k: string, d: OkDesired) {
    applied.targets[k] = {
      hash: d.hash,
      appliedAt: clock.now(),
      model: d.model,
      mark: d.mark.label,
      base: appliedBaseOf(d),
    };
    delete status.parked[k];
    errorAttempts.delete(k);
    ioStreak.delete(k);
    for (const s of ioStreak.values()) {
      s.othersOk = true;
    }
  }

  function clearConfigFromAvatar() {
    if (configFromAvatar) {
      configFromAvatar = false;
      setHealth("config", null);
    }
  }

  async function handleResult(k: string, d: OkDesired, r: ApplyResult) {
    switch (r.kind) {
      case "ok":
        recordApplied(k, d);
        consecutivePauses = 0;
        captchaPauseMs = 0;
        captchaProbe = false;
        setHealth("captcha", null);
        setHealth("daemon", null);
        setHealth("providerIo", null);
        clearConfigFromAvatar();
        return;

      case "ok-rate-limited":
        recordApplied(k, d);
        captchaProbe = false;
        setHealth("captcha", null);
        clearConfigFromAvatar();
        consecutivePauses++;
        pauseQueue("rate-limit", backoffMs(r.retryAfterMs));
        return;

      case "rate-limit-uncommitted":
        consecutivePauses++;
        enqueue(k, { head: true });
        pauseQueue("rate-limit", backoffMs(r.retryAfterMs));
        return;

      case "captcha": {
        if (r.committed) {
          recordApplied(k, d);
        } else {
          enqueue(k, { head: true });
        }
        // First pause: max(hint, captchaMinPauseMs). Each repeat doubles, capped at
        // captchaMaxPauseMs; a server hint is a floor for the current pause only.
        const doubled = captchaPauseMs
          ? Math.min(captchaPauseMs * 2, T.captchaMaxPauseMs)
          : T.captchaMinPauseMs;
        const ms = Math.max(r.retryAfterMs ?? 0, doubled);
        captchaPauseMs = ms;
        captchaProbe = true;
        const since =
          (status.health.captcha as { since?: number } | undefined)?.since ?? clock.now();
        status.health.captcha = {
          since,
          retryAfterSeconds: r.retryAfterMs ? Math.round(r.retryAfterMs / 1000) : null,
          pausedUntil: clock.now() + ms,
          action: "solve the provider's challenge for this account, then /badge repaint",
          probeAfterPause: true,
        };
        once("captcha", since, () =>
          log.error(
            `${tag} the provider requires a challenge (captcha) for this account; avatar updates paused`,
          ),
        );
        pauseQueue("captcha", ms);
        return;
      }

      case "pause": {
        consecutivePauses++;
        if (r.reason === "daemon-down") {
          setHealth("daemon", "unreachable");
        } else {
          setHealth("providerIo", "provider-side I/O failures; queue paused");
        }
        pauseQueue(r.reason, backoffMs(r.retryAfterMs));
        if (r.reason !== "provider-io") {
          enqueue(k, { head: true });
          return;
        }
        // Retry at the head once; after that let other targets go first, so a
        // target-specific failure cannot block the queue and is told apart from an outage.
        const s = ioStreak.get(k) ?? { n: 0, othersOk: false };
        s.n++;
        ioStreak.set(k, s);
        if (!r.neverPark && s.n >= L.ioErrorParkThreshold && s.othersOk) {
          park(
            k,
            d.hash,
            "error",
            `${s.n} consecutive provider-side failures on this target while others succeeded`,
          );
          return;
        }
        enqueue(k, { head: s.n === 1 });
        return;
      }

      case "permanent":
        if (r.reason === "not-found") {
          // Removed (§3.3); if the provider lists it again it comes back as a new target.
          await removeTarget(k, "not found on apply");
          void rebuild("target removed");
          return;
        }
        park(k, d.hash, r.reason, r.message);
        return;

      case "config":
        if (r.source === "avatar") {
          configFromAvatar = true;
        }
        setHealth("config", r.message);
        enqueue(k, { head: true });
        pauseQueue("config", T.reconcileIntervalMs);
        return;

      default: {
        const ea = errorAttempts.get(k) ?? { n: 0, nextAt: 0 };
        ea.n++;
        ea.nextAt =
          clock.now() + Math.round(T.errorBackoffBaseMs * 2 ** (ea.n - 1) * (1 + 0.1 * random()));
        errorAttempts.set(k, ea);
        if (ea.n >= L.maxAttempts) {
          park(k, d.hash, "error", r.message);
        } else {
          log.warn(`${tag} apply error (attempt ${ea.n}/${L.maxAttempts}): ${redact(r.message)}`);
          enqueue(k);
        }
      }
    }
  }

  // ---------------- triggers (ARCH §5.2, closed set) ----------------

  // Store/input watchers: one stat per watched path; read and diff only on change. This
  // is the fallback for the events freeclaw does not emit to plugins (model swaps,
  // models.json changes, input edits).
  async function watchTick() {
    if (!running || role !== "writer") {
      return;
    }
    bump("watch");
    let changed = nudged.size > 0;
    nudged.clear();
    for (const p of watchedPaths()) {
      const s = await statKey(p);
      if (stats.get(p) !== s) {
        changed = true;
        stats.set(p, s);
      }
    }
    if (!changed) {
      return;
    }

    const prevView = view;
    const wasBroken = inputsBroken.length > 0;
    await loadInputs();
    if (inputsBroken.length) {
      return;
    }
    const prevKeys = new Set(targets.keys());
    targets = targetsFromStore();
    await recordStats();

    const refs = [...targets.values()].map((t) => t.ref);
    const fp = view!.fingerprint(refs);
    const availChanged =
      prevView !== null &&
      [...prevView.available].toSorted().join("\n") !== [...view!.available].toSorted().join("\n");
    const defaultChanged = prevView !== null && prevView.defaultModel !== view!.defaultModel;

    if (fp !== lastBuiltFingerprint) {
      bump(availChanged ? "models-available-change" : "inputs-change");
      await rebuild(availChanged ? "available models changed" : "inputs changed");
      for (const k of targets.keys()) {
        markDirty(k);
      }
    } else if (defaultChanged || wasBroken) {
      bump("inputs-change");
      for (const k of targets.keys()) {
        markDirty(k);
      }
    }

    for (const [k, t] of targets) {
      if (!t.sessionKey) {
        continue;
      }
      const snap = overrideSnapshot(inputs!.store[t.sessionKey]);
      const prev = snapshots.get(t.sessionKey);
      snapshots.set(t.sessionKey, snap);
      if (!prevKeys.has(k)) {
        bump("target-create");
        markDirty(k);
      } else if (prev !== undefined && prev !== snap) {
        bump("session-model-change");
        markDirty(k);
      }
    }
  }

  async function fullPass(reason: string) {
    // §2c.4: a probe that failed is retried with backoff on each pass; when it comes up,
    // bases upgrade on this pass, without a restart.
    if (await images.probeIfDue()) {
      log.info(`${tag} image generator is up; upgrading bases`);
    }
    status.health.imageGen = images.state;
    const watchedStoreStat = stats.get(P.sessionsStore);
    const watchedSnaps = new Map(snapshots);
    await loadInputs();
    targets = targetsFromStore();
    await refreshProviderTargets();
    targets = targetsFromStore();

    // Watcher health: the store's stat is unchanged since the watcher last looked, yet an
    // override differs from what it recorded. Only a watcher fault explains that.
    if (
      reason === "periodic" &&
      watchedStoreStat !== undefined &&
      (await statKey(P.sessionsStore)) === watchedStoreStat
    ) {
      for (const [sk, snap] of watchedSnaps) {
        if (overrideSnapshot(inputs!.store[sk]) !== snap) {
          status.health.watcherMisses =
            ((status.health.watcherMisses as number | undefined) ?? 0) + 1;
          once("watcherMiss", 1, () =>
            log.warn(
              `${tag} sessions store changed without the watcher noticing; check the store path`,
            ),
          );
          break;
        }
      }
    }

    for (const t of targets.values()) {
      if (t.sessionKey) {
        snapshots.set(t.sessionKey, overrideSnapshot(inputs!.store[t.sessionKey]));
      }
    }
    await recordStats();
    const refs = [...targets.values()].map((t) => t.ref);
    const imagesPending = images.pending(refs.map((r) => view!.imageWant(r))) > 0;
    if (reason === "startup" || imagesPending || view!.fingerprint(refs) !== lastBuiltFingerprint) {
      await rebuild(reason);
    } else {
      // No input changed, but repaints since the last rebuild may have left assets that
      // nothing references any more: prune them on the periodic pass.
      const pruned = await pruneUnused(
        refs.flatMap((r) => view!.requiredFor(r).map((j) => j.hash)),
      );
      if (pruned > 0) {
        status.cache.pruned = pruned;
      }
      await pruneBases(refs);
    }
    await reconcileAll(reason);
  }

  // ---------------- writer role ----------------

  function becomeStandby() {
    if (role === "standby") {
      return;
    }
    role = "standby";
    queue.length = 0;
    once("role", "standby", () =>
      log.warn(
        `${tag} standby: another instance holds the writer lease (pid ${holder?.pid ?? "?"})`,
      ),
    );
  }

  async function tryLease(): Promise<"acquired" | "held" | "standby"> {
    try {
      const r = await lease.acquire();
      holder = r.holder;
      if (r.held) {
        delete status.health.duplicateGateway;
        if (role !== "writer") {
          await loadPersisted();
          role = "writer";
          logged.delete("role");
          log.info(`${tag} writer lease acquired`);
          return "acquired";
        }
        return "held";
      }
      if (holder?.host === hostname) {
        status.health.duplicateGateway = {
          holderPid: holder.pid,
          since:
            (status.health.duplicateGateway as { since?: number } | undefined)?.since ??
            clock.now(),
        };
      }
      becomeStandby();
      return "standby";
    } catch (err) {
      setHealth("lease", String((err as Error)?.message ?? err));
      becomeStandby();
      return "standby";
    }
  }

  function every(ms: number, fn: () => Promise<void>) {
    const loop = () => {
      if (!running) {
        return;
      }
      timers.push(
        clock.setTimeout(async () => {
          try {
            await fn();
          } catch (err) {
            log.error(`${tag} ${(err as Error)?.message ?? err}`);
          }
          loop();
        }, ms),
      );
    };
    loop();
  }

  async function writerOnly<R>(fn: () => Promise<R>): Promise<R | { ok: false; message: string }> {
    if (role !== "writer") {
      return {
        ok: false,
        message: role === "standby" ? "this instance is in standby" : `writer is ${role}`,
      };
    }
    return fn();
  }

  const api = {
    instanceId,
    provider,

    async start() {
      if (started) {
        return;
      }
      started = true;
      running = true;
      const providerError = provider.configError();
      const errors = [...(deps.validationErrors ?? []), ...(providerError ? [providerError] : [])];
      if (errors.length) {
        role = "idle";
        setHealth("config", errors.join("; "));
        return;
      }
      if (!deps.renderer) {
        role = "idle";
        setHealth("renderer", "renderer-missing: install rsvg-convert (librsvg) or ImageMagick");
        return;
      }
      const state = await images.probe();
      status.health.imageGen = state;
      if ((await tryLease()) !== "standby") {
        await fullPass("startup");
      }
      every(T.watchMs, watchTick);
      every(T.reconcileIntervalMs, async () => {
        const l = await tryLease();
        if (l !== "standby") {
          await fullPass(l === "acquired" ? "startup" : "periodic");
        }
      });
      every(T.leaseHeartbeatMs, async () => {
        if ((await tryLease()) === "acquired") {
          await fullPass("startup");
        }
      });
    },

    // ARCH §3.4: turn off. The writer stops; nothing is repainted back.
    async stop(opts: { releaseLease?: boolean } = {}) {
      running = false;
      for (const h of timers) {
        clock.clearTimeout(h);
      }
      timers = [];
      for (const h of debounce.values()) {
        clock.clearTimeout(h);
      }
      debounce.clear();
      if (pumpTimer) {
        clock.clearTimeout(pumpTimer);
      }
      pumpTimer = null;
      queue.length = 0;
      if (currentSend) {
        const pending = currentSend;
        await Promise.race([
          pending,
          new Promise<void>((resolve) => {
            const h = clock.setTimeout(resolve, T.rpcTimeoutMs);
            void pending.finally(() => clock.clearTimeout(h));
          }),
        ]);
      }
      await writeChain;
      if (opts.releaseLease !== false && role === "writer") {
        await lease.release().catch(() => {});
      }
      role = "stopped";
    },

    // A plugin event saw a session start; check the inputs on the next tick (T2).
    nudge(sessionKey: string) {
      if (provider.targetForSessionKey(sessionKey)) {
        nudged.add(sessionKey);
      }
    },

    // Stepping seams for tests.
    watchTick,
    rebuild: (reason = "manual") => rebuild(reason),
    runPass: async (kind = "periodic") => {
      const l = await tryLease();
      if (l !== "standby") {
        await fullPass(l === "acquired" ? "startup" : kind);
      }
    },
    markDirty,
    async idle() {
      await rebuildPromise;
      await currentSend;
      await writeChain;
    },
    status: () => structuredClone(snapshotStatus()),
    applied: () => structuredClone(applied),
    role: () => role,
    knownTargets: () => [...targets.keys()],
    targetKeyForSession(sessionKey: string) {
      const ref = provider.targetForSessionKey(sessionKey);
      return ref ? targetKey(ref) : null;
    },
    view: () => view,
    rules: () => inputs?.rules ?? [],
    // A view over the current inputs with a different rule list: steering preview
    // (§2a.3). Pure; nothing is written.
    viewWithRules: (rules: StyleRule[]) => (inputs ? makeView({ ...inputs, rules }) : null),
    refs: () => [...targets.values()].map((t) => t.ref),
    cachePath: (hash: string) => cache?.pngPath(hash) ?? null,
    renderer: () => deps.renderer,
    size: () => size,

    // ---------------- operator actions (/badge, the style tool) ----------------
    // These only change engine state; the engine stays the single writer.

    async repaint(k: string) {
      return writerOnly(async () => {
        if (!targets.has(k)) {
          return { ok: false as const, message: "unknown target" };
        }
        delete status.parked[k];
        // Forget the recorded hash so the target is sent again, but keep what it shows:
        // image first never trades a shown image for vector on a repaint (§2c.4).
        const rec = applied.targets[k];
        if (rec?.base) {
          applied.targets[k] = { hash: "", appliedAt: 0, base: rec.base };
        } else {
          delete applied.targets[k];
        }
        errorAttempts.delete(k);
        ioStreak.delete(k);
        if (pauseReason === "captcha") {
          pausedUntil = 0;
          pauseReason = null;
          captchaPauseMs = 0;
        }
        await persist({ applied: true });
        enqueue(k);
        schedulePump();
        return { ok: true as const };
      });
    },

    async reconcileNow() {
      return writerOnly(async () => {
        if (pauseReason === "captcha") {
          pausedUntil = 0;
          pauseReason = null;
          captchaPauseMs = 0;
        }
        await fullPass("operator");
        return { ok: true as const };
      });
    },

    // Picks up a style.json change now instead of on the next watch tick.
    async inputsChanged() {
      if (role === "writer") {
        nudged.add("*");
        await watchTick();
      }
    },

    // `regenerate` (§2b.4, §2c.3): bumps the target's generation counter, so its image
    // seed — and the picture — changes. The old base stays until the new one is applied.
    async regenerate(k: string) {
      return writerOnly(async () => {
        const t = targets.get(k);
        if (!t || !view) {
          return { ok: false as const, message: "unknown target" };
        }
        if (images.state === "unconfigured") {
          return { ok: false as const, message: "image generation is unconfigured" };
        }
        if (t.ref.kind === "profile" && inputs?.profileFile) {
          return { ok: false as const, message: "the profile uses profileBaseImage" };
        }
        const generation = await images.regenerate(view.imageWant(t.ref).key);
        await fullPass("regenerate");
        return { ok: true as const, generation, imageGen: images.state };
      });
    },

    // ARCH §3.4: `/badge purge` removes this provider's cache and state on request. The
    // engine is stopped first; nothing is repainted.
    async purge() {
      await api.stop();
      await fs.rmrf(P.stateDir);
      applied = { version: 1, targets: {} };
      status.parked = {};
      status.inflight = {};
      status.waiting = {};
      lastBuiltFingerprint = null;
      return { ok: true as const };
    },

    targetSummary(k: string) {
      const t = targets.get(k);
      if (!t || !view) {
        return null;
      }
      const d = view.desired(t.ref, t.sessionKey);
      return {
        desired: d.ok
          ? { mark: d.mark.label, model: d.model, base: d.base.kind, hash: d.hash.slice(0, 12) }
          : { error: d.message },
        applied: applied.targets[k]?.hash
          ? {
              mark: applied.targets[k].mark,
              model: applied.targets[k].model,
              hash: applied.targets[k].hash.slice(0, 12),
            }
          : null,
        converged: d.ok && applied.targets[k]?.hash === d.hash,
        parked: status.parked[k] ?? null,
        waiting: status.waiting[k] ?? null,
        queuePosition: queue.indexOf(k),
      };
    },

    // `/badge audit`: a read-only consistency check of both layers.
    async audit() {
      const rows = [...targets.keys()].map((k) => ({ key: k, ...api.targetSummary(k)! }));
      let missing = 0;
      if (view && cache) {
        for (const ref of [...targets.values()].map((t) => t.ref)) {
          for (const job of view.requiredFor(ref)) {
            if (!(await cache.has(job.hash))) {
              missing++;
            }
          }
        }
      }
      return {
        targets: rows.length,
        converged: rows.filter((r) => r.converged).length,
        mismatched: rows.filter((r) => !r.converged && !r.parked).map((r) => r.key),
        parked: rows.filter((r) => r.parked).map((r) => ({ key: r.key, reason: r.parked!.reason })),
        assetsMissing: missing,
        role,
      };
    },
  };
  return api;
}

export type Engine = ReturnType<typeof createEngine>;
