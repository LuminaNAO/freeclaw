import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import type { Clock, Logger } from "./clock.js";
import type { ImageGenConfig } from "./config.js";
import type { CoreFs } from "./fsio.js";
import { canonicalJSON, sha256 } from "./hash.js";
import { renderBaseSvg, type BaseParams } from "./motif.js";
import { rasterBaseSvg, sniffImage, verifyPng, type Renderer, type RenderSize } from "./render.js";

// ARCH §2b: two base-art backends behind one interface. `vector` is the built-in
// parametric generator (always available); `image` is a configured image-generation
// system. Only the base is ever generated; marks are composited by our renderer.

export type BaseStyle = { motif?: string; palette?: string; prompt?: string };
export type BaseTarget = { seed: string; params: BaseParams };

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

// ---------------- prompt (§2b.5) ----------------

const HOUSE_TEMPLATE =
  "Abstract square avatar background. {style}. Soft shapes, balanced composition, " +
  "no text, no letters, no numbers, no people, no faces, no logos.";

// Built only from style words and the generated base's own parameters. Group names,
// member names and chat content are never inputs, so they can never leak into a prompt.
export function buildPrompt(target: BaseTarget, style: BaseStyle): string {
  const words = style.prompt
    ? style.prompt
    : `${style.palette ?? target.params.palette} colour palette, ${style.motif ?? target.params.motif} motif`;
  return HOUSE_TEMPLATE.replace("{style}", words.replace(/[\r\n]+/g, " ").trim());
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

// ---------------- stored image bases (§2b.2, §2b.4, §2b.6, §2b.7) ----------------

export type ImageGenState = "ok" | "unavailable" | "unconfigured";

export type ImageWant = {
  key: string;
  target: BaseTarget;
  style: BaseStyle;
};

export type StoredBase = { sha: string; file: string; inputsKey: string };

type Meter = { day: string; used: number };

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
  limits: { maxPerDay: number; maxPerRun: number; maxAttempts: number; backoffMs: number };
}) {
  const { fs, dir, generator, clock, log, limits } = opts;
  let state: ImageGenState = generator ? "unavailable" : "unconfigured";
  const index = new Map<string, StoredBase>();
  const failures = new Map<
    string,
    { inputsKey: string; attempts: number; nextAt: number; error: string }
  >();
  const forced = new Set<string>();
  let meter: Meter = { day: utcDay(clock.now()), used: 0 };
  const meterPath = path.join(dir, "meter.json");
  const fileFor = (seed: string) => path.join(dir, `${seed}.png`);
  const manifestFor = (seed: string) => path.join(dir, `${seed}.json`);

  function inputsKeyOf(w: ImageWant): string {
    return sha256(
      canonicalJSON({
        prompt: buildPrompt(w.target, w.style),
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

  return {
    get state() {
      return state;
    },

    async probe(): Promise<ImageGenState> {
      if (!generator) {
        state = "unconfigured";
      } else {
        let ok = false;
        try {
          ok = await generator.available();
        } catch {
          ok = false;
        }
        state = ok ? "ok" : "unavailable";
      }
      return state;
    },

    async load(): Promise<void> {
      index.clear();
      try {
        meter = JSON.parse(await fs.readText(meterPath)) as Meter;
      } catch {
        meter = { day: utcDay(clock.now()), used: 0 };
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
        try {
          const man = JSON.parse(await fs.readText(path.join(dir, n))) as {
            key?: string;
            sha?: string;
            inputsKey?: string;
          };
          const file = fileFor(m[1] as string);
          const bytes = await fs.readFile(file);
          if (man.key && man.sha === sha256(bytes) && man.inputsKey) {
            index.set(man.key, { sha: man.sha, file, inputsKey: man.inputsKey });
          }
        } catch {
          // A broken stored base is ignored; the target uses vector until regenerated.
        }
      }
    },

    // The stored base for a target, if it matches the target's current inputs.
    current(w: ImageWant): StoredBase | null {
      if (state !== "ok") {
        return null;
      }
      const s = index.get(w.key);
      return s && s.inputsKey === inputsKeyOf(w) && !forced.has(w.key) ? s : null;
    },

    pending(wants: ImageWant[]): number {
      if (state !== "ok") {
        return 0;
      }
      const now = clock.now();
      return wants.filter((w) => {
        if (this.current(w)) {
          return false;
        }
        const f = failures.get(w.key);
        return (
          !f ||
          f.inputsKey !== inputsKeyOf(w) ||
          (f.attempts < limits.maxAttempts && now >= f.nextAt)
        );
      }).length;
    },

    // Generate what is missing, within the per-run and daily caps. Failures leave the
    // target on vector and back off; excess targets wait for a later pass.
    async ensure(wants: ImageWant[]) {
      const summary = { generated: 0, failed: 0, deferred: 0 };
      if (state !== "ok" || !generator) {
        return summary;
      }
      rollMeter();
      let thisRun = 0;
      const now = clock.now();
      for (const w of wants) {
        if (this.current(w)) {
          continue;
        }
        const inputsKey = inputsKeyOf(w);
        const f = failures.get(w.key);
        if (
          f &&
          f.inputsKey === inputsKey &&
          (f.attempts >= limits.maxAttempts || now < f.nextAt)
        ) {
          continue;
        }
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
          const file = fileFor(w.target.seed);
          await fs.writeAtomic(file, png);
          await fs.writeAtomic(
            manifestFor(w.target.seed),
            JSON.stringify({
              key: w.key,
              sha,
              inputsKey,
              generator: generator.id,
              generatedAt: clock.now(),
            }),
          );
          index.set(w.key, { sha, file, inputsKey });
          failures.delete(w.key);
          forced.delete(w.key);
          summary.generated++;
        } catch (err) {
          const prev = f && f.inputsKey === inputsKey ? f.attempts : 0;
          const attempts = prev + 1;
          failures.set(w.key, {
            inputsKey,
            attempts,
            nextAt: clock.now() + limits.backoffMs * 2 ** (attempts - 1),
            error: String((err as Error)?.message ?? err).slice(0, 200),
          });
          summary.failed++;
          log.warn(
            `[model-badge] image base generation failed (attempt ${attempts}/${limits.maxAttempts}); using vector for now`,
          );
        }
      }
      return summary;
    },

    // `/badge regenerate <target>`: forget the stored base so the next pass makes a new one.
    regenerate(key: string) {
      forced.add(key);
      failures.delete(key);
    },

    async remove(key: string, seed: string) {
      index.delete(key);
      failures.delete(key);
      forced.delete(key);
      await fs.unlink(fileFor(seed));
      await fs.unlink(manifestFor(seed));
    },

    status() {
      rollMeter();
      return {
        state,
        generator: generator?.id ?? null,
        usedToday: meter.used,
        maxPerDay: limits.maxPerDay,
        stored: index.size,
        failures: [...failures.values()].map((f) => ({ attempts: f.attempts, error: f.error })),
      };
    },
  };
}

export type ImageBases = ReturnType<typeof createImageBases>;
