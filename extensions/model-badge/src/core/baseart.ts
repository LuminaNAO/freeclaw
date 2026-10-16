import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import type { Clock, Logger } from "./clock.js";
import type { ImageGenConfig } from "./config.js";
import type { CoreFs } from "./fsio.js";
import { canonicalJSON, sha256 } from "./hash.js";
import { isMotif, renderBaseSvg, type BaseParams, type MotifName } from "./motif.js";
import { rasterBaseSvg, sniffImage, verifyPng, type Renderer, type RenderSize } from "./render.js";

// ARCH §2b: two base-art backends behind one interface. `vector` is the built-in
// parametric generator (always available); `image` is a configured image-generation
// system. Only the base is ever generated; marks are composited by our renderer.

export type BaseStyle = { motif?: string; palette?: string; prompt?: string };
// `seed` is the image seed (§2c.3: it covers the target's generation counter); `portrait`
// marks the account's own profile picture (§2c.5).
export type BaseTarget = { seed: string; params: BaseParams; portrait?: boolean };

export interface BaseArtGenerator {
  readonly id: string;
  available(): Promise<boolean>;
  generate(target: BaseTarget, style: BaseStyle): Promise<Buffer>;
}

export const vectorGenerator: BaseArtGenerator = {
  id: "vector",
  available: async () => true,
  generate: async (target) => Buffer.from(renderBaseSvg(target.params)),
};

// ---------------- prompt (§2b.5, §2c.10) ----------------

// ARCH §2c.10: a generated base is a concrete scene that fills the whole frame. The image
// model draws what the prompt names, so the prompt never names a shape to put in the
// frame: the banned words below never appear in it, except "panel" inside the required
// full-bleed clause, which forbids one.
export const FULL_BLEED =
  "full-bleed artwork filling the entire frame edge to edge, no border, no frame, no inner panel";

export const BANNED_PROMPT_WORDS = [
  "square",
  "avatar",
  "background",
  "tile",
  "card",
  "panel",
  "abstract",
] as const;

// Bump whenever the prompt templates change: it is part of a generated base's inputs, so
// every generated base is made again once; adopted bases are never generated, so they
// are untouched.
export const BASE_PROMPT_TAG = "scene-v1";

// Motifs map to scenes, not shapes.
export const MOTIF_SCENES: Readonly<Record<MotifName, string>> = {
  waves: "calm ocean waves under a soft evening sky",
  rings: "ripples spreading across a still lake at dusk",
  facets: "sunlit crystal cliffs above a quiet valley",
  dots: "a field of fireflies over tall grass at night",
};

const NO_MARKS = "no text, no letters, no numbers, no people, no faces, no logos";

const HOUSE_TEMPLATE = `A scene of {scene}. A ${FULL_BLEED}. Soft light, rich detail, ${NO_MARKS}.`;

// ARCH §2c.5: the profile picture is shown cropped to a circle, so its prompt keeps the
// scene centred with nothing important near the corners, and is still full-bleed.
const PROFILE_TEMPLATE =
  "A scene of {scene}. A portrait-safe composition centred in the frame that still reads when " +
  `cropped to a circle, nothing important near the corners. A ${FULL_BLEED}. ` +
  `Soft light, rich detail, ${NO_MARKS}.`;

const BANNED_RE = new RegExp(`\\b(?:${BANNED_PROMPT_WORDS.join("|")})s?\\b`, "gi");

// A member's steering words are kept, minus the banned words, and wrapped in the same
// full-bleed template (§2c.10).
function steeringWords(prompt: string): string {
  return (
    prompt
      .replace(/[\r\n]+/g, " ")
      .replace(BANNED_RE, " ")
      .replace(/\s+([,.;:!?])/g, "$1")
      .replace(/\s{2,}/g, " ")
      .replace(/^[\s,.;:!?-]+|[\s,;:-]+$/g, "")
      // A removed word can leave a dangling "on a" behind.
      .replace(/(?:\s+\b(?:a|an|the|on|in|of|with|as|for|and)\b)+$/i, "")
      .trim()
  );
}

// Built only from style words and the generated base's own parameters. Group names,
// member names and chat content are never inputs, so they can never leak into a prompt.
export function buildPrompt(target: BaseTarget, style: BaseStyle): string {
  const steered = style.prompt ? steeringWords(style.prompt) : "";
  let scene: string;
  if (steered) {
    scene = steered;
  } else {
    const motif = isMotif(style.motif) ? style.motif : target.params.motif;
    const palette = style.palette ?? target.params.palette;
    scene = `${MOTIF_SCENES[motif]}, in ${palette} colours`;
  }
  const template = target.portrait ? PROFILE_TEMPLATE : HOUSE_TEMPLATE;
  return template.replace("{scene}", scene);
}

export function seedNumber(seed: string): number {
  return Number.parseInt(seed.slice(0, 8), 16) & 0x7fffffff;
}

// ---------------- backends ----------------

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function imagesRoot(baseUrl: string): string {
  return /\/v1$/.test(baseUrl) ? baseUrl : `${baseUrl}/v1`;
}

// OpenAI-compatible /v1/images/generations. The key comes from a resolver (SecretRef);
// it is sent only in the Authorization header, never logged or put in argv.
export function createOpenAiImagesGenerator(opts: {
  config: Extract<ImageGenConfig, { kind: "openai-images" }>;
  apiKey: () => Promise<string>;
  fetch?: FetchLike;
}): BaseArtGenerator {
  const { config } = opts;
  const doFetch: FetchLike = opts.fetch ?? ((u, i) => fetch(u, i));
  const root = imagesRoot(config.baseUrl);
  const call = async (url: string, init: RequestInit) => {
    const key = await opts.apiKey();
    return doFetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  };
  return {
    id: `openai-images:${config.model}`,
    async available() {
      try {
        const res = await call(`${root}/models`, { method: "GET" });
        return res.ok;
      } catch {
        return false;
      }
    },
    async generate(target, style) {
      const body: Record<string, unknown> = {
        model: config.model,
        prompt: buildPrompt(target, style),
        size: config.size,
        n: 1,
        response_format: "b64_json",
      };
      if (config.seed) {
        body.seed = seedNumber(target.seed);
      }
      const res = await call(`${root}/images/generations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(`image generation failed (HTTP ${res.status})`);
      }
      const json = (await res.json()) as { data?: Array<{ b64_json?: unknown }> };
      const b64 = json?.data?.[0]?.b64_json;
      if (typeof b64 !== "string" || !b64) {
        throw new Error("image generation returned no b64_json image");
      }
      return Buffer.from(b64, "base64");
    },
  };
}

export type SpawnLike = typeof spawn;

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Local command: absolute path + fixed args; the prompt goes on stdin (never argv or
// env), PNG bytes come back on stdout, bounded by a timeout.
export function createCommandGenerator(opts: {
  config: Extract<ImageGenConfig, { kind: "command" }>;
  spawn?: SpawnLike;
  maxBytes?: number;
  isExecutable?: (file: string) => Promise<boolean>;
}): BaseArtGenerator {
  const { config } = opts;
  const doSpawn = opts.spawn ?? spawn;
  const maxBytes = opts.maxBytes ?? 32 << 20;
  const run = (input: string) =>
    new Promise<Buffer>((resolve, reject) => {
      const child = doSpawn(config.command, config.args, {
        stdio: ["pipe", "pipe", "ignore"],
        env: { PATH: process.env.PATH ?? "" },
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      const finish = (err: Error | null) => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        if (err) {
          child.kill("SIGKILL");
          reject(err);
        } else {
          resolve(Buffer.concat(chunks));
        }
      };
      const timer = setTimeout(
        () => finish(new Error("image command timed out")),
        Math.max(1, config.timeoutMs),
      );
      child.stdout?.on("data", (d: Buffer) => {
        size += d.length;
        if (size > maxBytes) {
          finish(new Error("image command output too large"));
          return;
        }
        chunks.push(d);
      });
      child.on("error", (err) =>
        finish(new Error(`image command failed to start: ${err.message}`)),
      );
      child.on("close", (code) =>
        finish(code === 0 ? null : new Error(`image command exited with code ${code}`)),
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    });
  return {
    id: `command:${path.basename(config.command)}`,
    // The probe checks the command is an executable file; it never runs a generation.
    async available() {
      return (opts.isExecutable ?? isExecutable)(config.command);
    },
    async generate(target, style) {
      return run(`${buildPrompt(target, style)}\n`);
    },
  };
}

// ---------------- stored image bases (§2b.2, §2b.4, §2b.6, §2b.7, §2c.3, §2c.4) ----------------

// ok: the backend answers. retrying: configured but the probe has not succeeded yet; it
// is retried with backoff and never pins the extension to vector (§2c.4). unconfigured:
// no imageGen → vector is the base generator.
export type ImageGenState = "ok" | "retrying" | "unconfigured";

// `key` is the target's stable base key; `target.seed` is the image seed for the target's
// current generation (§2c.3), so each generation is stored under its own file.
export type ImageWant = {
  key: string;
  generation: number;
  target: BaseTarget;
  style: BaseStyle;
};

export type StoredBase = { sha: string; file: string; inputsKey: string };

type Meter = { day: string; used: number };
type Entry = StoredBase & { key: string; seed: string };

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function createImageBases(opts: {
  fs: CoreFs;
  dir: string;
  generator: BaseArtGenerator | null;
  renderer: Renderer | null;
  size: RenderSize;
  clock: Clock;
  log: Logger;
  limits: {
    maxPerDay: number;
    maxPerRun: number;
    maxAttempts: number;
    backoffMs: number;
    maxBackoffMs?: number;
  };
}) {
  const { fs, dir, generator, clock, log, limits } = opts;
  const maxBackoffMs = limits.maxBackoffMs ?? Number.POSITIVE_INFINITY;
  let state: ImageGenState = generator ? "retrying" : "unconfigured";
  let probeAttempts = 0;
  let nextProbeAt = 0;
  // Every stored base on disk, by image seed. More than one per target may exist while a
  // target still shows an older generation; the old one is pruned once the new one is
  // applied (§2c.3).
  const stored = new Map<string, Entry>();
  const failures = new Map<
    string,
    { inputsKey: string; attempts: number; nextAt: number; error: string }
  >();
  const generations = new Map<string, number>();
  let meter: Meter = { day: utcDay(clock.now()), used: 0 };
  const meterPath = path.join(dir, "meter.json");
  const generationsPath = path.join(dir, "generations.json");
  const fileFor = (seed: string) => path.join(dir, `${seed}.png`);
  const manifestFor = (seed: string) => path.join(dir, `${seed}.json`);
  const backoff = (n: number) => Math.min(limits.backoffMs * 2 ** Math.max(0, n - 1), maxBackoffMs);

  function inputsKeyOf(w: ImageWant): string {
    return sha256(
      canonicalJSON({
        prompt: buildPrompt(w.target, w.style),
        tag: BASE_PROMPT_TAG,
        seed: w.target.seed,
        generator: generator?.id ?? null,
      }),
    );
  }

  function rollMeter() {
    const today = utcDay(clock.now());
    if (meter.day !== today) {
      meter = { day: today, used: 0 };
    }
  }

  // Format guard: signature, decode, square-crop and resize to the asset size. The
  // stored base is the normalised PNG.
  async function normalise(bytes: Buffer, seed: string): Promise<Buffer> {
    const mime = sniffImage(bytes);
    if (!mime) {
      throw new Error("generated bytes are not a PNG or JPEG");
    }
    if (!opts.renderer) {
      throw new Error("no rasteriser to verify the generated image");
    }
    const tmp = path.join(dir, `${seed}.${clock.now()}`);
    await fs.writeFile(`${tmp}.svg.tmp`, rasterBaseSvg({ mime, bytes }, opts.size.width));
    try {
      await opts.renderer.svgToPng(`${tmp}.svg.tmp`, `${tmp}.png.tmp`, opts.size);
      const out = await fs.readFile(`${tmp}.png.tmp`);
      verifyPng(out, opts.size);
      return out;
    } finally {
      await fs.unlink(`${tmp}.svg.tmp`);
      await fs.unlink(`${tmp}.png.tmp`);
    }
  }

  async function dropEntry(e: Entry) {
    stored.delete(e.seed);
    await fs.unlink(fileFor(e.seed));
    await fs.unlink(manifestFor(e.seed));
  }

  function current(w: ImageWant): StoredBase | null {
    if (!generator) {
      return null;
    }
    const e = stored.get(w.target.seed);
    return e && e.key === w.key && e.inputsKey === inputsKeyOf(w)
      ? { sha: e.sha, file: e.file, inputsKey: e.inputsKey }
      : null;
  }

  function blocked(w: ImageWant, now: number): boolean {
    const f = failures.get(w.key);
    return Boolean(
      f && f.inputsKey === inputsKeyOf(w) && (f.attempts >= limits.maxAttempts || now < f.nextAt),
    );
  }

  return {
    get state() {
      return state;
    },

    // Startup probe. A failure leaves the state `retrying` and schedules the next probe.
    async probe(): Promise<ImageGenState> {
      if (!generator) {
        state = "unconfigured";
        return state;
      }
      let ok = false;
      try {
        ok = await generator.available();
      } catch {
        ok = false;
      }
      if (ok) {
        state = "ok";
        probeAttempts = 0;
        nextProbeAt = 0;
      } else {
        state = "retrying";
        probeAttempts++;
        nextProbeAt = clock.now() + backoff(probeAttempts);
        log.warn(
          `[model-badge] image generator probe failed (attempt ${probeAttempts}); retrying in ${Math.round(backoff(probeAttempts) / 1000)} s`,
        );
      }
      return state;
    },

    // §2c.4: periodic passes (and the watcher) re-probe once the backoff has elapsed.
    // Returns true when this call brought the backend up.
    async probeIfDue(): Promise<boolean> {
      if (state !== "retrying" || clock.now() < nextProbeAt) {
        return false;
      }
      return (await this.probe()) === "ok";
    },

    async load(): Promise<void> {
      stored.clear();
      generations.clear();
      try {
        meter = JSON.parse(await fs.readText(meterPath)) as Meter;
      } catch {
        meter = { day: utcDay(clock.now()), used: 0 };
      }
      try {
        const g = JSON.parse(await fs.readText(generationsPath)) as Record<string, unknown>;
        for (const [k, v] of Object.entries(g ?? {})) {
          if (Number.isInteger(v) && (v as number) > 0) {
            generations.set(k, v as number);
          }
        }
      } catch {
        // No counters yet: every target is at generation 0.
      }
      let names: string[] = [];
      try {
        names = await fs.readdir(dir);
      } catch {
        return;
      }
      for (const n of names) {
        const m = /^([0-9a-f]{64})\.json$/.exec(n);
        if (!m) {
          continue;
        }
        const seed = m[1] as string;
        try {
          const man = JSON.parse(await fs.readText(path.join(dir, n))) as {
            key?: string;
            sha?: string;
            inputsKey?: string;
          };
          const file = fileFor(seed);
          const bytes = await fs.readFile(file);
          if (man.key && man.sha === sha256(bytes) && man.inputsKey) {
            stored.set(seed, { key: man.key, seed, sha: man.sha, file, inputsKey: man.inputsKey });
          }
        } catch {
          // A broken stored base is ignored; the target keeps what it shows until a new one exists.
        }
      }
    },

    // §2c.3: the target's generation counter (0 until the first regenerate).
    generation(key: string): number {
      return generations.get(key) ?? 0;
    },

    // The stored base for a target's current inputs and generation, if it exists.
    current,

    // A stored base by its bytes' hash (a base a target still shows), if still on disk.
    bySha(sha: string): StoredBase | null {
      for (const e of stored.values()) {
        if (e.sha === sha) {
          return { sha: e.sha, file: e.file, inputsKey: e.inputsKey };
        }
      }
      return null;
    },

    pending(wants: ImageWant[]): number {
      if (state !== "ok") {
        return 0;
      }
      const now = clock.now();
      return wants.filter((w) => !current(w) && !blocked(w, now)).length;
    },

    // Generate what is missing, within the per-run and daily caps. A target whose image
    // is not ready keeps what it shows (§2c.4); failures back off, capped.
    async ensure(wants: ImageWant[]) {
      const summary = { generated: 0, failed: 0, deferred: 0 };
      if (state !== "ok" || !generator) {
        return summary;
      }
      rollMeter();
      let thisRun = 0;
      const now = clock.now();
      for (const w of wants) {
        if (current(w) || blocked(w, now)) {
          continue;
        }
        const inputsKey = inputsKeyOf(w);
        const f = failures.get(w.key);
        if (thisRun >= limits.maxPerRun || meter.used >= limits.maxPerDay) {
          summary.deferred++;
          continue;
        }
        thisRun++;
        meter.used++;
        await fs.mkdirp(dir);
        await fs.writeAtomic(meterPath, JSON.stringify(meter));
        try {
          const raw = await generator.generate(w.target, w.style);
          const png = await normalise(raw, w.target.seed);
          const sha = sha256(png);
          const seed = w.target.seed;
          const file = fileFor(seed);
          await fs.writeAtomic(file, png);
          await fs.writeAtomic(
            manifestFor(seed),
            JSON.stringify({
              key: w.key,
              sha,
              inputsKey,
              generation: w.generation,
              generator: generator.id,
              prompt: BASE_PROMPT_TAG,
              generatedAt: clock.now(),
            }),
          );
          stored.set(seed, { key: w.key, seed, sha, file, inputsKey });
          failures.delete(w.key);
          summary.generated++;
        } catch (err) {
          const prev = f && f.inputsKey === inputsKey ? f.attempts : 0;
          const attempts = prev + 1;
          failures.set(w.key, {
            inputsKey,
            attempts,
            nextAt: clock.now() + backoff(attempts),
            error: String((err as Error)?.message ?? err).slice(0, 200),
          });
          summary.failed++;
          log.warn(
            `[model-badge] image base generation failed (attempt ${attempts}/${limits.maxAttempts}); the target keeps what it shows for now`,
          );
        }
      }
      return summary;
    },

    // §2c.3: `regenerate` bumps the target's generation, which changes its image seed, so
    // the next pass makes a new picture. The old one stays until the new one is applied.
    async regenerate(key: string): Promise<number> {
      const n = (generations.get(key) ?? 0) + 1;
      generations.set(key, n);
      failures.delete(key);
      await fs.mkdirp(dir);
      await fs.writeAtomic(generationsPath, JSON.stringify(Object.fromEntries(generations)));
      return n;
    },

    // Drops stored bases nothing needs: not the current one for a live target and not a
    // base some target still shows (§2c.3: old generation pruned after the new is applied).
    async prune(keep: { seeds: Set<string>; shas: Set<string> }): Promise<number> {
      let n = 0;
      for (const e of [...stored.values()]) {
        if (!keep.seeds.has(e.seed) && !keep.shas.has(e.sha)) {
          await dropEntry(e);
          n++;
        }
      }
      return n;
    },

    // A removed target loses every stored base and its counter (§3.3).
    async remove(key: string) {
      failures.delete(key);
      for (const e of [...stored.values()]) {
        if (e.key === key) {
          await dropEntry(e);
        }
      }
      if (generations.delete(key)) {
        await fs.writeAtomic(generationsPath, JSON.stringify(Object.fromEntries(generations)));
      }
    },

    status() {
      rollMeter();
      return {
        state,
        generator: generator?.id ?? null,
        usedToday: meter.used,
        maxPerDay: limits.maxPerDay,
        maxPerRun: limits.maxPerRun,
        stored: stored.size,
        nextProbeAt: state === "retrying" ? nextProbeAt : null,
        failures: [...failures.values()].map((f) => ({ attempts: f.attempts, error: f.error })),
      };
    },
  };
}

export type ImageBases = ReturnType<typeof createImageBases>;
