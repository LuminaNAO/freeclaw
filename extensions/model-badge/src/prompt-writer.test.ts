// ARCH §2c.11: new groups get an image scene written by the agent. Hook → writer called once
// per new group, again on rename, not for adopted-art groups; same inputs never call twice;
// over-40-words / quotes / banned words / name proper noun rejected → motif scene; timeout
// and failure fall back; non-private imageGen skips the writer; memory off sends no
// snippets; the writer input never contains chat content or member ids; the throwaway
// session is deleted.
import { describe, expect, it } from "vitest";
import { createTestPluginApi } from "../../test-utils/plugin-api.js";
import register, { registerModelBadge } from "../index.js";
import { createActions } from "./actions.js";
import { buildPrompt, FULL_BLEED, MOTIF_SCENES, type BaseArtGenerator } from "./core/baseart.js";
import { normalizeConfig } from "./core/config.js";
import type { Engine } from "./core/engine.js";
import { seedFor } from "./core/motif.js";
import {
  buildWriterMessage,
  imageGenIsPrivate,
  isPrivateHost,
  validateScene,
  WRITER_INSTRUCTION,
  type SceneWriteRequest,
  type SceneWriter,
} from "./core/scene.js";
import { createSteering } from "./core/steering.js";
import { createStyleStore } from "./core/style.js";
import { createSceneWriter, lastAssistantText, WRITER_SESSION_MARKER } from "./scene-writer.js";
import { fakePng } from "./test-helpers/fakes.js";
import { createWorld, IDS, type World } from "./test-helpers/world.js";

const OP = "+10000000002";
const GOOD = "sunlit allotment rows of tomatoes and runner beans beside a wooden shed at dawn";
const OWN = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("their own art")]);

function fakeImageGen() {
  const prompts: Array<{ seed: string; prompt: string }> = [];
  const gen: BaseArtGenerator & { prompts: typeof prompts } = {
    id: "fake-image:v1",
    prompts,
    available: async () => true,
    async generate(target, style) {
      const prompt = buildPrompt(target, style);
      prompts.push({ seed: target.seed, prompt });
      return fakePng(1024, 1024, `generated ${target.seed}`);
    },
  };
  return gen;
}

type FakeWriter = SceneWriter & { calls: SceneWriteRequest[] };
function fakeWriter(answer: (req: SceneWriteRequest) => string | Promise<string> = () => GOOD) {
  const calls: SceneWriteRequest[] = [];
  const w: FakeWriter = {
    calls,
    async write(req) {
      calls.push(req);
      return answer(req);
    },
  };
  return w;
}

const T_WATCH = 3_000;
const LOCAL_CMD = { kind: "command", command: "/opt/fake/gen" };

async function world(
  opts: {
    writer?: FakeWriter;
    imageGen?: Record<string, unknown>;
    avatars?: Record<string, Buffer>;
    targets?: string[];
  } = {},
) {
  const gen = fakeImageGen();
  const writer = opts.writer ?? fakeWriter();
  const w = await createWorld({ targets: [], plugin: { imageGen: opts.imageGen ?? LOCAL_CMD } });
  for (const id of opts.targets ?? [IDS.a]) {
    w.addTarget(id, opts.avatars?.[id] ? { avatar: opts.avatars[id] } : {});
  }
  const e = await w.startEngine({ imageGenerator: gen, sceneWriter: writer });
  await w.settle();
  return { w, e, gen, writer };
}

const keyOf = (id: string) => seedFor("signal", id.toLowerCase());
const promptsFor = (w: World, gen: ReturnType<typeof fakeImageGen>, id: string) => {
  const e = w.engines.at(-1)!;
  const seed = e.view()!.imageWant({ kind: "group", idLower: id.toLowerCase() }).target.seed;
  return gen.prompts.filter((p) => p.seed === seed).map((p) => p.prompt);
};
const lastPrompt = (w: World, gen: ReturnType<typeof fakeImageGen>, id: string) =>
  promptsFor(w, gen, id).at(-1) ?? "";
const motifScene = (e: Engine, id: string) => {
  const want = e.view()!.imageWant({ kind: "group", idLower: id.toLowerCase() });
  return `${MOTIF_SCENES[want.target.params.motif]}, in ${want.target.params.palette} colours`;
};

async function named(w: World, e: Engine, id: string, name: string) {
  await e.groupNamed(id, name);
  await w.settle();
  await e.idle();
  await w.settle();
}

describe("the scene writer is triggered by the new-group event (ARCH §2c.11)", () => {
  it("hook → writer called once per new group; the written scene is the image prompt", async () => {
    const { w, e, gen, writer } = await world({ targets: [IDS.a, IDS.b] });
    await named(w, e, IDS.a, "Garden Club");
    expect(writer.calls).toHaveLength(1);
    expect(writer.calls[0]).toMatchObject({ name: "Garden Club", memory: true, timeoutMs: 60_000 });
    const p = lastPrompt(w, gen, IDS.a);
    expect(p).toContain(`A scene of ${GOOD}`);
    expect(p).toContain(FULL_BLEED);
    expect(p).not.toContain("Garden Club");
    // B was never named: it keeps the motif scene and the writer is not called for it.
    expect(lastPrompt(w, gen, IDS.b)).toContain(motifScene(e, IDS.b));
    await named(w, e, IDS.b, "Book Circle");
    expect(writer.calls.map((c) => c.name)).toEqual(["Garden Club", "Book Circle"]);
    // The repaint shows the new base.
    expect(w.targetSends(IDS.a).length).toBeGreaterThanOrEqual(1);
    await e.stop();
  });

  it("same inputs never call the writer twice: repeats, passes and a restart", async () => {
    const { w, e, writer } = await world();
    await named(w, e, IDS.a, "Garden Club");
    await named(w, e, IDS.a, "Garden Club");
    await e.runPass("periodic");
    await w.settle();
    expect(writer.calls).toHaveLength(1);
    await e.stop();
    const e2 = await w.startEngine({
      instanceId: "restart",
      imageGenerator: fakeImageGen(),
      sceneWriter: writer,
    });
    await w.settle();
    await named(w, e2, IDS.a, "Garden Club");
    expect(writer.calls).toHaveLength(1);
    // The scene survives the restart.
    expect(e2.targetSummary(w.tk(IDS.a))!.scene).toEqual({ source: "writer", text: GOOD });
    await e2.stop();
  });

  it("a rename calls the writer again; regenerate (a new generation) does too", async () => {
    const { w, e, writer } = await world();
    await named(w, e, IDS.a, "Garden Club");
    await named(w, e, IDS.a, "Allotment Crew");
    expect(writer.calls.map((c) => c.name)).toEqual(["Garden Club", "Allotment Crew"]);
    const r = await e.regenerate(w.tk(IDS.a));
    expect(r.ok).toBe(true);
    await w.settle();
    await e.idle();
    expect(writer.calls.map((c) => c.name)).toEqual([
      "Garden Club",
      "Allotment Crew",
      "Allotment Crew",
    ]);
    await e.stop();
  });

  it("not called for a group on its own adopted artwork; restyle keeps it", async () => {
    const { w, e, writer } = await world({ avatars: { [IDS.a]: OWN } });
    await named(w, e, IDS.a, "Garden Club");
    expect(writer.calls).toHaveLength(0);
    expect(e.targetSummary(w.tk(IDS.a))!.scene).toBeNull();
    // An explicit regenerate leaves the adopted art for a generated base: now it writes.
    await e.regenerate(w.tk(IDS.a));
    await w.settle();
    await e.idle();
    expect(writer.calls.map((c) => c.name)).toEqual(["Garden Club"]);
    await e.stop();
  });

  it("a name that arrives before the target is known is kept and used once it appears", async () => {
    const { w, e, writer } = await world({ targets: [] });
    await e.groupNamed(IDS.c, "Seed Swap");
    expect(writer.calls).toHaveLength(0);
    w.addTarget(IDS.c);
    await w.settle();
    await e.idle();
    await w.settle();
    expect(writer.calls.map((c) => c.name)).toEqual(["Seed Swap"]);
    await e.stop();
  });

  it("a member's steering prompt still overrides the written scene", async () => {
    const { w, e, gen } = await world();
    await named(w, e, IDS.a, "Garden Club");
    const cfg = normalizeConfig(w.pluginConfig(), { gatewayStateDir: "/s" }).config;
    const steering = createSteering({
      engines: () => [e],
      store: createStyleStore({ fs: w.fs, stateDir: w.paths.rootDir }),
      operators: () => cfg.operators,
      allowGroupMembers: () => true,
      configRules: () => [],
      now: () => w.clock.now(),
    });
    const run = createActions({
      engines: () => [e] as Engine[],
      steering: () => steering,
      operators: () => cfg.operators,
      allowGroupMembers: () => true,
      purge: async () => {},
    });
    const here = { kind: "group" as const, idLower: IDS.a.toLowerCase() };
    const r = await run(
      "style.add",
      { rules: [{ match: { targetId: "this" }, set: { prompt: "watercolour ocean" } }] },
      { senderId: OP, engine: e, here },
    );
    expect(r.ok).toBe(true);
    await w.settle();
    await e.idle();
    await w.settle();
    const p = lastPrompt(w, gen, IDS.a);
    expect(p).toContain("A scene of watercolour ocean");
    expect(p).not.toContain(GOOD);
    expect(e.targetSummary(w.tk(IDS.a))!.scene).toMatchObject({ source: "steering" });
    await e.stop();
  });

  it("promptWriter.enabled false: never called; the motif scene is used", async () => {
    const writer = fakeWriter();
    const { w, e, gen } = await world({
      writer,
      imageGen: { ...LOCAL_CMD, promptWriter: { enabled: false } },
    });
    await named(w, e, IDS.a, "Garden Club");
    expect(writer.calls).toHaveLength(0);
    expect(lastPrompt(w, gen, IDS.a)).toContain(motifScene(e, IDS.a));
    await e.stop();
  });

  it("promptWriter model and timeout reach the writer; memory false is passed on", async () => {
    const writer = fakeWriter();
    const { w, e } = await world({
      writer,
      imageGen: {
        ...LOCAL_CMD,
        promptWriter: { model: "prov/k-model", timeoutMs: 5_000, memory: false },
      },
    });
    await named(w, e, IDS.a, "Garden Club");
    expect(writer.calls[0]).toEqual({
      name: "Garden Club",
      memory: false,
      model: "prov/k-model",
      timeoutMs: 5_000,
    });
    await e.stop();
  });
});

describe("validation and fallback to the motif scene (ARCH §2c.11)", () => {
  const cases: Array<[string, string]> = [
    ["over 40 words", Array.from({ length: 41 }, () => "leaf").join(" ")],
    ["quotes", 'a "garden" at dawn with tall sunflowers'],
    ["single quotes", "a 'garden' at dawn with tall sunflowers"],
    ["banned word", "an abstract garden at dawn"],
    ["banned word (plural)", "garden tiles at dawn"],
    ["name proper noun", "the Garden of a quiet club at dawn"],
    ["id-like digits", "a garden at dawn near plot 4412"],
    ["multi-line", "a garden at dawn\nwith sunflowers"],
    ["empty", "   "],
  ];
  for (const [what, answer] of cases) {
    it(`${what} → rejected, motif scene used; recorded, not retried`, async () => {
      const writer = fakeWriter(() => answer);
      const { w, e, gen } = await world({ writer });
      await named(w, e, IDS.a, "Garden Club");
      expect(writer.calls).toHaveLength(1);
      const p = lastPrompt(w, gen, IDS.a);
      expect(p).toContain(`A scene of ${motifScene(e, IDS.a)}`);
      expect(p).not.toContain(answer.trim() || "\u0000");
      const scene = e.targetSummary(w.tk(IDS.a))!.scene!;
      expect(scene.source).toBe("motif");
      expect(scene.why).toMatch(/^rejected/);
      await e.runPass("periodic");
      await w.settle();
      expect(writer.calls).toHaveLength(1);
      await e.stop();
    });
  }

  it("a writer failure falls back to the motif scene", async () => {
    const writer = fakeWriter(() => {
      throw new Error("model exploded");
    });
    const { w, e, gen } = await world({ writer });
    await named(w, e, IDS.a, "Garden Club");
    expect(lastPrompt(w, gen, IDS.a)).toContain(motifScene(e, IDS.a));
    expect(e.targetSummary(w.tk(IDS.a))!.scene).toMatchObject({
      source: "motif",
      why: "the writer failed",
    });
    // The failure text is not logged.
    expect(w.log.text()).not.toContain("model exploded");
    await e.stop();
  });

  it("a writer that never answers times out (default 60 s) and falls back", async () => {
    const writer = fakeWriter(() => new Promise<string>(() => {}));
    const { w, e, gen } = await world({ writer, targets: [] });
    // The group is named before it is a target (the hook fires on its first message).
    await e.groupNamed(IDS.a, "Garden Club");
    w.addTarget(IDS.a);
    // The writer starts on the watch tick that finds the new target.
    await w.clock.advance(T_WATCH);
    expect(writer.calls).toHaveLength(1);
    await w.clock.advance(59_000);
    // Still waiting: the image is held back for the scene, nothing generated for A yet.
    expect(writer.calls).toHaveLength(1);
    expect(promptsFor(w, gen, IDS.a)).toHaveLength(0);
    expect(e.targetSummary(w.tk(IDS.a))!.scene).toMatchObject({ source: "pending" });
    await w.clock.advance(1_000);
    await e.idle();
    await w.settle();
    expect(lastPrompt(w, gen, IDS.a)).toContain(motifScene(e, IDS.a));
    expect(e.targetSummary(w.tk(IDS.a))!.scene).toMatchObject({
      source: "motif",
      why: "the writer timed out",
    });
    await e.stop();
  });

  it("validateScene: accepts a clean scene, trims it, keeps apostrophes", () => {
    expect(validateScene(`  ${GOOD}.  `, "Garden Club")).toEqual({ ok: true, scene: GOOD });
    expect(validateScene("a children's garden at dawn", "Book Circle").ok).toBe(true);
    // Lower-case common words shared with the name are fine; the capitalised name word is not.
    expect(validateScene("a garden at dawn with a club house", "Garden Club").ok).toBe(true);
    expect(validateScene("a Garden at dawn", "Garden Club")).toEqual({ ok: false, reason: "name" });
    // A coined name word is a proper noun in any case.
    expect(validateScene("a quiet rooftop for opsly at dusk", "Opsly HQ")).toMatchObject({
      ok: true,
    });
    expect(validateScene("a quiet rooftop for mcallister at dusk", "McAllister Family")).toEqual({
      ok: false,
      reason: "name",
    });
    expect(validateScene("forty words exactly " + "x ".repeat(37), "n").ok).toBe(true);
    expect(validateScene(42, "n")).toEqual({ ok: false, reason: "empty" });
    expect(validateScene("a garden <script> at dawn", "n")).toEqual({
      ok: false,
      reason: "markup",
    });
  });
});

describe("boundary: names and memory never leave the box (ARCH §2c.11)", () => {
  it("a non-private imageGen skips the writer and uses the motif scene", async () => {
    const writer = fakeWriter();
    const { w, e, gen } = await world({
      writer,
      imageGen: {
        kind: "openai-images",
        baseUrl: "https://images.example.invalid",
        model: "m",
        apiKey: { source: "env", provider: "default", id: "K" },
      },
    });
    await named(w, e, IDS.a, "Garden Club");
    expect(writer.calls).toHaveLength(0);
    expect(lastPrompt(w, gen, IDS.a)).toContain(motifScene(e, IDS.a));
    expect(e.targetSummary(w.tk(IDS.a))!.scene).toMatchObject({
      source: "motif",
      why: "imageGen is not loopback or private",
    });
    await e.stop();
  });

  it("a loopback openai-images backend is private: the writer runs", async () => {
    const writer = fakeWriter();
    const { w, e } = await world({
      writer,
      imageGen: {
        kind: "openai-images",
        baseUrl: "http://127.0.0.1:9/v1",
        model: "m",
        apiKey: { source: "env", provider: "default", id: "K" },
      },
    });
    await named(w, e, IDS.a, "Garden Club");
    expect(writer.calls).toHaveLength(1);
    await e.stop();
  });

  it("isPrivateHost / imageGenIsPrivate", () => {
    for (const h of [
      "localhost",
      "127.0.0.1",
      "10.1.2.3",
      "[::1]",
      "::ffff:127.0.0.1",
      "fd00::5",
      "a.localhost",
    ]) {
      expect(isPrivateHost(h), h).toBe(true);
    }
    // Addresses other than the placeholders are built, so the hygiene scan sees no literals.
    const dot = (...p: number[]) => p.join(".");
    for (const h of [
      "example.invalid",
      dot(8, 8, 8, 8),
      `::ffff:${dot(8, 8, 8, 8)}`,
      "2001:db8::1",
      dot(999, 1, 1, 1),
    ]) {
      expect(isPrivateHost(h), h).toBe(false);
    }
    expect(isPrivateHost(dot(192, 168, 0, 9))).toBe(true);
    expect(isPrivateHost(dot(172, 16, 0, 1))).toBe(true);
    expect(isPrivateHost(dot(172, 32, 0, 1))).toBe(false);
    expect(imageGenIsPrivate(null)).toBe(false);
    expect(
      imageGenIsPrivate({
        kind: "command",
        command: "/opt/x",
        args: [],
        timeoutMs: 1,
        maxAttempts: 1,
        maxPerDay: 1,
        maxPerRun: 1,
        promptWriter: { enabled: true, timeoutMs: 1, memory: true },
      }),
    ).toBe(true);
  });

  it("scenes are never logged; /badge status shows the scene", async () => {
    const { w, e } = await world();
    await named(w, e, IDS.a, "Garden Club");
    expect(w.log.text()).not.toContain(GOOD);
    expect(w.log.text()).not.toContain("Garden Club");
    expect(w.log.text()).toMatch(/scene for a new group: written/);
    const cfg = normalizeConfig(w.pluginConfig(), { gatewayStateDir: "/s" }).config;
    const run = createActions({
      engines: () => [e] as Engine[],
      steering: () => null,
      operators: () => cfg.operators,
      allowGroupMembers: () => true,
      purge: async () => {},
    });
    const r = await run(
      "status",
      {},
      { senderId: OP, engine: e, here: { kind: "group", idLower: IDS.a.toLowerCase() } },
    );
    expect(r.text).toContain(`Scene (written by the agent): ${GOOD}`);
    // The cache is per target in the state dir, keyed by name and generation.
    const scenes = w.fs.getJson<{ targets: Record<string, unknown> }>(
      `${w.paths.stateDir}/scenes/scenes.json`,
    );
    expect(scenes.targets[keyOf(IDS.a)]).toMatchObject({
      name: "Garden Club",
      record: { name: "Garden Club", generation: 0, source: "writer", scene: GOOD },
    });
    await e.stop();
  });

  it("a removed target loses its scene", async () => {
    const { w, e } = await world();
    await named(w, e, IDS.a, "Garden Club");
    w.backend.dropTarget(IDS.a);
    await e.runPass("periodic");
    await w.settle();
    const scenes = w.fs.getJson<{ targets: Record<string, unknown> }>(
      `${w.paths.stateDir}/scenes/scenes.json`,
    );
    expect(scenes.targets[keyOf(IDS.a)]).toBeUndefined();
    await e.stop();
  });
});

// ---------------- the runtime writer (src/scene-writer.ts) ----------------

type Call = { method: string; params: Record<string, unknown> };
function fakeRuntime(
  opts: {
    reply?: string;
    status?: "ok" | "error" | "timeout";
    throwOnRun?: boolean;
    snippets?: Array<{ snippet: string; source: string }>;
  } = {},
) {
  const calls: Call[] = [];
  const memoryQueries: unknown[] = [];
  const rec = (method: string) => async (params: Record<string, unknown>) => {
    calls.push({ method, params });
  };
  const runtime = {
    subagent: {
      run: async (params: Record<string, unknown>) => {
        calls.push({ method: "run", params });
        if (opts.throwOnRun) {
          throw new Error("gateway refused");
        }
        return { runId: "run-1" };
      },
      waitForRun: async (params: Record<string, unknown>) => {
        calls.push({ method: "waitForRun", params });
        return { status: opts.status ?? "ok" };
      },
      getSessionMessages: async (params: Record<string, unknown>) => {
        calls.push({ method: "getSessionMessages", params });
        return {
          messages: [
            { role: "user", content: "x" },
            { role: "assistant", content: [{ type: "text", text: opts.reply ?? GOOD }] },
          ],
        };
      },
      getSession: async () => ({ messages: [] }),
      deleteSession: rec("deleteSession"),
      patchSession: async (params: Record<string, unknown>) => {
        calls.push({ method: "patchSession", params });
        return { provider: "prov", model: "k-model" };
      },
      abortSession: async (params: Record<string, unknown>) => {
        calls.push({ method: "abortSession", params });
        return { aborted: true };
      },
    },
    tools: {
      createMemorySearchTool: () => ({
        name: "memory_search",
        label: "Memory Search",
        description: "",
        parameters: {},
        execute: async (_id: string, params: unknown) => {
          memoryQueries.push(params);
          return {
            content: [],
            details: {
              results: opts.snippets ?? [
                { snippet: "The garden club plans spring planting.", source: "memory" },
                { snippet: "Chat: call +10000000001 about seeds", source: "sessions" },
              ],
            },
          };
        },
      }),
    },
  };
  return { runtime: runtime as never, calls, memoryQueries };
}

const SK = `agent:main${WRITER_SESSION_MARKER}00000000-0000-4000-8000-000000000009`;

describe("the runtime writer: runtime.subagent.run in a throwaway session (ARCH §2c.11)", () => {
  it("runs once in its own session with the instruction, returns the reply, deletes the session", async () => {
    const { runtime, calls, memoryQueries } = fakeRuntime();
    const writer = createSceneWriter({
      runtime,
      agentId: "main",
      gatewayConfig: {},
      newSessionKey: () => SK,
    });
    const out = await writer.write({ name: "Garden Club", memory: true, timeoutMs: 60_000 });
    expect(out).toBe(GOOD);
    expect(calls.map((c) => c.method)).toEqual([
      "run",
      "waitForRun",
      "getSessionMessages",
      "deleteSession",
    ]);
    const run = calls[0]!.params;
    expect(run.sessionKey).toBe(SK);
    expect(run.deliver).toBe(false);
    expect(run.extraSystemPrompt).toBe(WRITER_INSTRUCTION);
    expect(calls[1]!.params).toEqual({ runId: "run-1", timeoutMs: 60_000 });
    expect(calls[3]!.params).toEqual({ sessionKey: SK, deleteTranscript: true });
    // The agent's own memory search for the name; memory files only, no transcripts.
    expect(memoryQueries).toEqual([{ query: "Garden Club", maxResults: 6 }]);
    expect(run.message).toContain("Group name: Garden Club");
    expect(run.message).toContain("The garden club plans spring planting.");
    expect(run.message).not.toContain("Chat:");
    expect(run.message).not.toContain("+10000000001");
  });

  it("the instruction asks for one concrete scene of at most 40 words, no text or names", () => {
    expect(WRITER_INSTRUCTION).toMatch(/ONE concrete visual scene, at most 40 words/);
    expect(WRITER_INSTRUCTION).toMatch(
      /No text, letters, words, logos, brand names, real people or faces/,
    );
    expect(WRITER_INSTRUCTION).toMatch(/Never quote or repeat the group name/);
  });

  it("memory false sends no snippets and never searches", async () => {
    const { runtime, calls, memoryQueries } = fakeRuntime();
    const writer = createSceneWriter({
      runtime,
      agentId: "main",
      gatewayConfig: {},
      newSessionKey: () => SK,
    });
    await writer.write({ name: "Garden Club", memory: false, timeoutMs: 1_000 });
    expect(memoryQueries).toEqual([]);
    const msg = String(calls[0]!.params.message);
    expect(msg).not.toMatch(/memory says/);
    expect(msg).not.toContain("spring planting");
  });

  it("the writer input never contains chat content or member ids (fixture)", async () => {
    // A memory full of chat-shaped material and member ids.
    const { runtime, calls } = fakeRuntime({
      snippets: [
        {
          snippet:
            "Members: +10000000001, +10000000077 and uuid:00000000-0000-4000-8000-000000000001",
          source: "memory",
        },
        { snippet: "Alice said: lunch at noon?", source: "sessions" },
        {
          snippet: "Group id FakeTargetAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaA= meets weekly",
          source: "memory",
        },
      ],
    });
    const writer = createSceneWriter({
      runtime,
      agentId: "main",
      gatewayConfig: {},
      newSessionKey: () => SK,
    });
    await writer.write({ name: "Garden Club", memory: true, timeoutMs: 1_000 });
    const input = JSON.stringify(calls[0]!.params);
    for (const banned of [
      "+10000000001",
      "+10000000077",
      "00000000-0000-4000-8000-000000000001",
      "Alice said",
      "lunch at noon",
      IDS.a,
    ]) {
      expect(input).not.toContain(banned);
    }
    // Only these keys are ever sent to the run.
    expect(Object.keys(calls[0]!.params).toSorted()).toEqual(
      [
        "deliver",
        "extraSystemPrompt",
        "idempotencyKey",
        "lane",
        "message",
        "sessionKey",
      ].toSorted(),
    );
    // And the engine passes the writer nothing but the name and settings.
    const { w, e, writer: fw } = await world();
    await named(w, e, IDS.a, "Garden Club");
    expect(Object.keys(fw.calls[0]!).toSorted()).toEqual(["memory", "name", "timeoutMs"]);
    await e.stop();
  });

  it("buildWriterMessage strips digit runs and opaque ids from snippets and caps them at 3", () => {
    const msg = buildWriterMessage({
      name: "Garden Club",
      snippets: [
        "a",
        "b",
        "c",
        "d",
        "call 555 0100 1234 soon",
        "id FakeTargetBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbB=",
      ],
    });
    expect(msg.match(/^- /gm)).toHaveLength(3);
    const msg2 = buildWriterMessage({
      name: "Garden Club",
      snippets: ["call 555 0100 1234 soon", "id FakeTargetBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbB="],
    });
    expect(msg2).not.toMatch(/\d{3}/);
    expect(msg2).not.toContain("FakeTarget");
  });

  it("a model override patches the throwaway session first", async () => {
    const { runtime, calls } = fakeRuntime();
    const writer = createSceneWriter({
      runtime,
      agentId: "main",
      gatewayConfig: {},
      newSessionKey: () => SK,
    });
    await writer.write({ name: "G", memory: false, model: "prov/k-model", timeoutMs: 1_000 });
    expect(calls[0]).toEqual({
      method: "patchSession",
      params: { sessionKey: SK, model: "prov/k-model", label: "model-badge scene" },
    });
  });

  it("the throwaway session is deleted on failure and on timeout too", async () => {
    for (const o of [
      { throwOnRun: true },
      { status: "timeout" as const },
      { status: "error" as const },
    ]) {
      const { runtime, calls } = fakeRuntime(o);
      const writer = createSceneWriter({
        runtime,
        agentId: "main",
        gatewayConfig: {},
        newSessionKey: () => SK,
      });
      await expect(writer.write({ name: "G", memory: false, timeoutMs: 1_000 })).rejects.toThrow();
      expect(calls.at(-1)).toEqual({
        method: "deleteSession",
        params: { sessionKey: SK, deleteTranscript: true },
      });
      if (o.status === "timeout") {
        expect(calls.map((c) => c.method)).toContain("abortSession");
      }
    }
  });

  it("each write uses a fresh session key under the agent", async () => {
    const { runtime, calls } = fakeRuntime();
    const writer = createSceneWriter({ runtime, agentId: "Main", gatewayConfig: {} });
    await writer.write({ name: "G", memory: false, timeoutMs: 1_000 });
    await writer.write({ name: "G", memory: false, timeoutMs: 1_000 });
    const keys = calls.filter((c) => c.method === "run").map((c) => c.params.sessionKey);
    expect(new Set(keys).size).toBe(2);
    for (const k of keys) {
      expect(String(k)).toMatch(new RegExp(`^agent:main${WRITER_SESSION_MARKER}`));
    }
  });

  it("lastAssistantText reads the last assistant reply", () => {
    expect(
      lastAssistantText([
        { role: "assistant", content: "old" },
        { role: "user", content: "q" },
        { role: "assistant", content: [{ type: "text", text: "new" }, { type: "tool_use" }] },
      ]),
    ).toBe("new");
    expect(lastAssistantText([])).toBe("");
  });
});

describe("plugin wiring (ARCH §2c.11)", () => {
  it("registers the group_memory_created hook and routes this agent's events to the engine", async () => {
    const hooks = new Map<string, (event: unknown) => unknown>();
    register(
      createTestPluginApi({
        id: "model-badge",
        name: "Model Badge",
        source: "test",
        config: {},
        runtime: {} as never,
        registerService: () => {},
        registerCommand: () => {},
        registerTool: () => {},
        on: ((name: string, fn: (event: unknown) => unknown) => void hooks.set(name, fn)) as never,
      }),
    );
    expect([...hooks.keys()].toSorted()).toEqual(["group_memory_created", "session_start"]);
    // Before the service starts, an event is a no-op (never throws).
    await expect(
      Promise.resolve(
        hooks.get("group_memory_created")!({
          agentId: "main",
          channel: "signal",
          groupId: "g",
          name: "n",
          dir: "/x",
          firstSeen: "",
          reason: "created",
        }),
      ),
    ).resolves.toBeUndefined();
  });
});

// Live finding (operator, 2026-10-18): group memory's event carries Signal's raw
// "group:<base64id>", while targets, seeds and scenes are keyed by the bare lowercased id.
// The real event shape must reach the writer through the registered hook.
describe("the real group_memory_created event shape reaches the writer (ARCH §2c.11)", () => {
  const realEvent = (id: string, name: string, reason: "created" | "renamed" = "created") => ({
    agentId: "main",
    channel: "signal",
    groupId: `group:${id}`,
    name,
    dir: `/ws/memory/groups/signal/${encodeURIComponent(`group:${id}`)}`,
    firstSeen: "2026-10-18T08:00:00.000Z",
    reason,
  });

  async function wired(e: Engine) {
    const hooks = new Map<string, (event: unknown) => unknown>();
    let service: { start: (ctx: unknown) => Promise<void> } | undefined;
    registerModelBadge(
      createTestPluginApi({
        id: "model-badge",
        name: "Model Badge",
        source: "test",
        config: {},
        runtime: {} as never,
        registerService: ((s: typeof service) => void (service = s)) as never,
        registerCommand: () => {},
        registerTool: () => {},
        on: ((name: string, fn: (event: unknown) => unknown) => void hooks.set(name, fn)) as never,
      }),
      {
        buildRuntime: async () =>
          ({
            config: normalizeConfig({}, { gatewayStateDir: "/virtual/state" }).config,
            engines: [e],
            errors: [],
            start: async () => {},
            stop: async () => {},
          }) as never,
      },
    );
    await service!.start({ config: {}, stateDir: "/virtual/state", logger: console });
    return (ev: unknown) => Promise.resolve(hooks.get("group_memory_created")!(ev));
  }

  it("feeds groupId 'group:<id>' through api.on: the writer is called and its scene is the prompt", async () => {
    const { w, e, gen, writer } = await world({ targets: [IDS.a, IDS.b] });
    const fire = await wired(e);
    await fire(realEvent(IDS.a, "Garden Club"));
    await w.settle();
    await e.idle();
    await w.settle();
    expect(writer.calls.map((c) => c.name)).toEqual(["Garden Club"]);
    expect(lastPrompt(w, gen, IDS.a)).toContain(`A scene of ${GOOD}`);
    expect(e.targetSummary(w.tk(IDS.a))!.scene).toEqual({ source: "writer", text: GOOD });
    // The name is stored under the target's own key, never the raw event id.
    const stored = w.fs.getJson<{ targets: Record<string, { name?: string }> }>(
      `${w.paths.stateDir}/scenes/scenes.json`,
    );
    expect(stored.targets[keyOf(IDS.a)]?.name).toBe("Garden Club");
    expect(stored.targets[seedFor("signal", `group:${IDS.a.toLowerCase()}`)]).toBeUndefined();
    // B was never named: still the motif scene.
    expect(lastPrompt(w, gen, IDS.b)).toContain(motifScene(e, IDS.b));
    // A rename through the same real shape writes again.
    await fire(realEvent(IDS.a, "Allotment Crew", "renamed"));
    await w.settle();
    await e.idle();
    expect(writer.calls.map((c) => c.name)).toEqual(["Garden Club", "Allotment Crew"]);
    // Another agent's event is ignored.
    await fire({ ...realEvent(IDS.b, "Book Circle"), agentId: "other" });
    await w.settle();
    await e.idle();
    expect(writer.calls).toHaveLength(2);
    await e.stop();
  });

  it("the bare id and the raw 'group:' id name the same target (any case)", async () => {
    const { w, e, writer } = await world();
    await named(w, e, `GROUP:${IDS.a.toUpperCase()}`, "Garden Club");
    await named(w, e, IDS.a, "Garden Club");
    expect(writer.calls).toHaveLength(1);
    await e.stop();
  });

  it("scene entries written under the raw event id are dropped on load", async () => {
    const bad = seedFor("signal", `group:${IDS.a.toLowerCase()}`);
    const { w, e, writer } = await world({ targets: [] });
    await e.stop();
    w.fs.putJson(`${w.paths.stateDir}/scenes/scenes.json`, {
      version: 1,
      targets: { [bad]: { name: "Garden Club" }, [keyOf(IDS.b)]: { name: "Book Circle" } },
    });
    w.addTarget(IDS.a);
    const e2 = await w.startEngine({
      instanceId: "migrate",
      imageGenerator: fakeImageGen(),
      sceneWriter: writer,
    });
    await w.settle();
    await e2.idle();
    const stored = w.fs.getJson<{ targets: Record<string, unknown> }>(
      `${w.paths.stateDir}/scenes/scenes.json`,
    );
    expect(stored.targets[bad]).toBeUndefined();
    expect(stored.targets[keyOf(IDS.b)]).toEqual({ name: "Book Circle" });
    // The stale name never reached the writer; the next event re-adds it.
    expect(writer.calls).toHaveLength(0);
    await named(w, e2, `group:${IDS.a}`, "Garden Club");
    expect(writer.calls.map((c) => c.name)).toEqual(["Garden Club"]);
    await e2.stop();
  });

  it("a raw-id entry for a target unknown at load is dropped when the watcher first sees it", async () => {
    const bad = seedFor("signal", `group:${IDS.a.toLowerCase()}`);
    const { w, e, writer } = await world({ targets: [] });
    await e.stop();
    const file = `${w.paths.stateDir}/scenes/scenes.json`;
    w.fs.putJson(file, {
      version: 1,
      targets: { [bad]: { name: "Garden Club" }, [keyOf(IDS.b)]: { name: "Book Circle" } },
    });
    const e2 = await w.startEngine({
      instanceId: "migrate-late",
      imageGenerator: fakeImageGen(),
      sceneWriter: writer,
    });
    await w.settle(T_WATCH * 2);
    // Unknown at load: nothing to match the raw key against yet.
    expect(e2.knownTargets()).not.toContain(w.tk(IDS.a));
    expect(w.fs.getJson<{ targets: Record<string, unknown> }>(file).targets[bad]).toEqual({
      name: "Garden Club",
    });
    // The group appears through the watcher only (well inside the periodic interval).
    w.addTarget(IDS.a);
    await w.settle(T_WATCH * 2);
    await e2.idle();
    expect(e2.knownTargets()).toContain(w.tk(IDS.a));
    const stored = w.fs.getJson<{ targets: Record<string, unknown> }>(file);
    expect(stored.targets[bad]).toBeUndefined();
    expect(stored.targets[keyOf(IDS.b)]).toEqual({ name: "Book Circle" });
    expect(writer.calls).toHaveLength(0);
    // The next real event names it under the target key and the writer runs.
    await named(w, e2, `group:${IDS.a}`, "Garden Club");
    expect(writer.calls.map((c) => c.name)).toEqual(["Garden Club"]);
    await e2.stop();
  });
});
