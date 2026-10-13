// ARCH §2b.8: image generation when available, vector otherwise.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  buildPrompt,
  createCommandGenerator,
  createOpenAiImagesGenerator,
  type BaseArtGenerator,
  type SpawnLike,
} from "./core/baseart.js";
import { normalizeConfig } from "./core/config.js";
import { baseParamsForSeed, imageSeedFor, seedFor } from "./core/motif.js";
import { fakePng } from "./test-helpers/fakes.js";
import { createWorld, IDS } from "./test-helpers/world.js";

// A fake image backend: returns a PNG (any size; the format guard normalises it) and
// records every call. `fail` decides per target seed.
function fakeImageGen(opts: { up?: boolean; fail?: (seed: string) => boolean } = {}) {
  const calls: Array<{ seed: string; prompt: string }> = [];
  const gen: BaseArtGenerator & { calls: typeof calls } = {
    id: "fake-image:v1",
    calls,
    available: async () => opts.up ?? true,
    async generate(target, style) {
      calls.push({ seed: target.seed, prompt: buildPrompt(target, style) });
      if (opts.fail?.(target.seed)) {
        throw new Error("backend error");
      }
      return fakePng(1024, 768, `image ${buildPrompt(target, style)} ${target.seed}`);
    },
  };
  return gen;
}

const IMAGE_CFG = {
  kind: "command",
  command: "/opt/fake/gen",
  maxPerDay: 10,
  maxPerRun: 10,
  maxAttempts: 3,
};

async function imageWorld(
  gen: BaseArtGenerator | null,
  cfg: Record<string, unknown> | null = IMAGE_CFG,
  targets = [IDS.a, IDS.b],
) {
  const w = await createWorld({
    targets,
    plugin: cfg ? { imageGen: cfg } : {},
    timing: { imageGenBackoffMs: 600_000 },
  });
  const e = await w.startEngine({ imageGenerator: gen });
  await w.settle();
  return { w, e };
}

// The image seed of a target at generation 0 (ARCH §2c.3).
const seedOf = (id: string, generation = 0) => imageSeedFor("signal", id.toLowerCase(), generation);
const baseOf = (w: Awaited<ReturnType<typeof createWorld>>, id: string) =>
  w.status().cache && (w.engines[0]!.targetSummary(w.tk(id))!.desired as { base: string }).base;

describe("image generation (ARCH §2b)", () => {
  it("unconfigured → vector bases; health imageGen unconfigured", async () => {
    const { w, e } = await imageWorld(null, null);
    expect(e.status().health.imageGen).toBe("unconfigured");
    expect(baseOf(w, IDS.a)).toBe("vector");
    expect(w.sends()).toHaveLength(2);
    await e.stop();
  });

  it("probe fails → vector for targets with no avatar + health retrying; nothing generated", async () => {
    const gen = fakeImageGen({ up: false });
    const { w, e } = await imageWorld(gen);
    expect(e.status().health.imageGen).toBe("retrying");
    expect(gen.calls).toHaveLength(0);
    expect(baseOf(w, IDS.a)).toBe("vector");
    await e.stop();
  });

  it("generator succeeds → the image base is used and our mark is composited on top", async () => {
    const gen = fakeImageGen();
    const { w, e } = await imageWorld(gen);
    expect(e.status().health.imageGen).toBe("ok");
    expect(gen.calls).toHaveLength(2);
    expect(baseOf(w, IDS.a)).toBe("raster");
    const sent = w.fs.files.get(w.sends()[0]!.avatar)!.data.toString();
    expect(sent).toContain("<image");
    expect(sent).toContain('data-mark="F"');
    // Stored, normalised base lives in the state dir.
    expect(w.fs.exists(`${w.paths.stateDir}/bases/${seedOf(IDS.a)}.png`)).toBe(true);
    await e.stop();
  });

  it("a failure for one target → that target vector, the others image; retried with backoff", async () => {
    let failing = true;
    const gen = fakeImageGen({ fail: (seed) => failing && seed === seedOf(IDS.b) });
    const { w, e } = await imageWorld(gen);
    expect(baseOf(w, IDS.a)).toBe("raster");
    expect(baseOf(w, IDS.b)).toBe("vector");
    expect(w.sends()).toHaveLength(2);
    const bCalls = () => gen.calls.filter((c) => c.seed === seedOf(IDS.b)).length;
    expect(bCalls()).toBe(1);
    // Within the backoff, a periodic pass does not retry.
    await e.runPass("periodic");
    expect(bCalls()).toBe(1);
    failing = false;
    await w.clock.advance(600_000);
    await e.runPass("periodic");
    await w.settle();
    expect(bCalls()).toBe(2);
    expect(baseOf(w, IDS.b)).toBe("raster");
    // The upgrade to the image base repaints B once.
    expect(w.targetSends(IDS.b)).toHaveLength(2);
    await e.stop();
  });

  it("gives up after maxAttempts for unchanged inputs", async () => {
    const gen = fakeImageGen({ fail: () => true });
    const { w, e } = await imageWorld(gen, { ...IMAGE_CFG, maxAttempts: 2 }, [IDS.a]);
    for (let i = 0; i < 5; i++) {
      await w.clock.advance(10 * 60_000);
      await e.runPass("periodic");
    }
    expect(gen.calls).toHaveLength(2);
    await e.stop();
  });

  it("cache hit → no second generation, across passes and restarts", async () => {
    const gen = fakeImageGen();
    const { w, e } = await imageWorld(gen);
    await e.runPass("periodic");
    await e.stop();
    const sends = w.sends().length;
    const e2 = await w.startEngine({ imageGenerator: gen, instanceId: "restart" });
    await w.settle();
    expect(gen.calls).toHaveLength(2);
    expect(w.sends()).toHaveLength(sends);
    await e2.stop();
  });

  it("style change → only that target is regenerated (and repainted)", async () => {
    const gen = fakeImageGen();
    const { w, e } = await imageWorld(gen);
    const sends = w.sends().length;
    w.setPlugin({ targets: { [IDS.b.toLowerCase()]: { palette: "ember" } } });
    await w.settle();
    expect(gen.calls).toHaveLength(3);
    expect(gen.calls.at(-1)!.seed).toBe(seedOf(IDS.b));
    expect(gen.calls.at(-1)!.prompt).toContain("ember");
    expect(
      w
        .sends()
        .slice(sends)
        .map((s) => s.target),
    ).toEqual([IDS.b]);
    await e.stop();
  });

  it("/badge regenerate makes a new base for that target only", async () => {
    const gen = fakeImageGen();
    const { w, e } = await imageWorld(gen);
    const r = await e.regenerate(w.tk(IDS.a));
    expect(r.ok).toBe(true);
    expect(gen.calls.map((c) => c.seed)).toEqual([seedOf(IDS.a), seedOf(IDS.b), seedOf(IDS.a, 1)]);
    await e.stop();
  });

  it("daily cap and per-run cap are respected; excess targets get vector now and upgrade later", async () => {
    const ids = Array.from(
      { length: 6 },
      (_, i) => `FakeCap${i}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=`,
    );
    const gen = fakeImageGen();
    const { w, e } = await imageWorld(gen, { ...IMAGE_CFG, maxPerRun: 2, maxPerDay: 3 }, ids);
    expect(gen.calls).toHaveLength(2);
    expect(ids.filter((id) => baseOf(w, id) === "raster")).toHaveLength(2);
    expect(w.sends()).toHaveLength(6);
    await e.runPass("periodic");
    expect(gen.calls).toHaveLength(3);
    await e.runPass("periodic");
    expect(gen.calls).toHaveLength(3);
    expect(e.status().imageGen).toMatchObject({ usedToday: 3, maxPerDay: 3 });
    // Next UTC day the meter resets and the rest are upgraded, still at most 2 per pass.
    await w.clock.advance(24 * 3_600_000);
    expect(gen.calls).toHaveLength(6);
    expect(ids.filter((id) => baseOf(w, id) === "raster")).toHaveLength(6);
    expect(e.status().imageGen.usedToday).toBeLessThanOrEqual(3);
    await e.stop();
  });

  it("format guard: bytes that are not an image → failure → vector", async () => {
    const gen: BaseArtGenerator = {
      id: "junk",
      available: async () => true,
      generate: async () => Buffer.from("<html>nope</html>"),
    };
    const { w, e } = await imageWorld(gen, IMAGE_CFG, [IDS.a]);
    expect(baseOf(w, IDS.a)).toBe("vector");
    expect(e.status().imageGen.failures[0].error).toMatch(/not a PNG or JPEG/);
    await e.stop();
  });

  it("the prompt never includes target ids, names or chat content", () => {
    const seed = seedFor("signal", "group-secret-id");
    const p = buildPrompt(
      { seed, params: baseParamsForSeed(seed) },
      { prompt: "watercolour ocean" },
    );
    expect(p).toContain("watercolour ocean");
    expect(p).toMatch(/no text/);
    expect(p).not.toContain("group-secret-id");
    expect(p).not.toContain(seed);
  });
});

describe("image backends (ARCH §2b.1)", () => {
  const target = {
    seed: seedFor("signal", "t"),
    params: baseParamsForSeed(seedFor("signal", "t")),
  };

  it("command backend: prompt on stdin, never in argv or env; PNG from stdout", async () => {
    const seen: { cmd?: string; args?: string[]; env?: Record<string, string>; stdin: string } = {
      stdin: "",
    };
    const fakeSpawn = ((cmd: string, args: string[], o: { env: Record<string, string> }) => {
      seen.cmd = cmd;
      seen.args = args;
      seen.env = o.env;
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        kill: () => void;
      };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.kill = () => {};
      child.stdin.on("data", (d) => (seen.stdin += d.toString()));
      child.stdin.on("finish", () => {
        child.stdout.end(fakePng(64, 64));
        setImmediate(() => child.emit("close", 0));
      });
      return child;
    }) as unknown as SpawnLike;
    const cfg = normalizeConfig(
      { imageGen: { kind: "command", command: "/opt/fake/gen", args: ["--png"] } },
      { gatewayStateDir: "/s" },
    );
    const gen = createCommandGenerator({
      config: cfg.config.imageGen as never,
      spawn: fakeSpawn,
      isExecutable: async () => true,
    });
    const out = await gen.generate(target, { prompt: "watercolour ocean" });
    expect(out.subarray(1, 4).toString()).toBe("PNG");
    expect(seen.cmd).toBe("/opt/fake/gen");
    expect(seen.args).toEqual(["--png"]);
    expect(seen.stdin).toContain("watercolour ocean");
    expect(JSON.stringify(seen.args)).not.toContain("watercolour");
    expect(JSON.stringify(seen.env)).not.toContain("watercolour");
    expect(await gen.available()).toBe(true);
  });

  it("command backend: a hung command times out", async () => {
    const fakeSpawn = (() => {
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        kill: () => void;
      };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.kill = () => {};
      return child;
    }) as unknown as SpawnLike;
    const gen = createCommandGenerator({
      config: {
        kind: "command",
        command: "/opt/fake/gen",
        args: [],
        timeoutMs: 30,
        maxAttempts: 1,
        maxPerDay: 1,
        maxPerRun: 1,
      },
      spawn: fakeSpawn,
    });
    await expect(gen.generate(target, {})).rejects.toThrow(/timed out/);
  });

  it("openai-images backend: key only in the Authorization header, prompt in the body, b64 out", async () => {
    const reqs: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = async (url: string, init: RequestInit) => {
      reqs.push({ url, init });
      if (url.endsWith("/models")) {
        return new Response("{}", { status: 200 });
      }
      return new Response(
        JSON.stringify({ data: [{ b64_json: fakePng(32, 32).toString("base64") }] }),
        { status: 200 },
      );
    };
    const cfg = normalizeConfig(
      {
        imageGen: {
          kind: "openai-images",
          baseUrl: "http://127.0.0.1:9/v1",
          model: "image-model",
          apiKey: { source: "env", provider: "default", id: "IMAGE_KEY" },
          seed: true,
        },
      },
      { gatewayStateDir: "/s" },
    );
    expect(cfg.ok).toBe(true);
    const gen = createOpenAiImagesGenerator({
      config: cfg.config.imageGen as never,
      apiKey: async () => "test-key-value",
      fetch: fetchFn,
    });
    expect(await gen.available()).toBe(true);
    const png = await gen.generate(target, {});
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    const gen2 = reqs.find((r) => r.url === "http://127.0.0.1:9/v1/images/generations")!;
    expect((gen2.init.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-key-value",
    );
    const body = JSON.parse(String(gen2.init.body));
    expect(body).toMatchObject({ model: "image-model", n: 1, response_format: "b64_json" });
    expect(typeof body.seed).toBe("number");
    expect(String(gen2.init.body)).not.toContain("test-key-value");
  });

  it("config: a literal API key is rejected (SecretRef only); the command must be absolute", () => {
    const lit = normalizeConfig(
      {
        imageGen: {
          kind: "openai-images",
          baseUrl: "http://127.0.0.1:9",
          model: "m",
          apiKey: "literal",
        },
      },
      { gatewayStateDir: "/s" },
    );
    expect(lit.ok).toBe(false);
    const rel = normalizeConfig(
      { imageGen: { kind: "command", command: "gen" } },
      { gatewayStateDir: "/s" },
    );
    expect(rel.ok).toBe(false);
  });
});
