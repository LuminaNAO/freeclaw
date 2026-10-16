// ARCH §5: integration with freeclaw — plugin registration, /badge commands, the style
// tool, and an end-to-end run through buildRuntime with the real filesystem, the real
// rasteriser and freeclaw's Signal client against a local HTTP stub.
import fsp from "node:fs/promises";
import http from "node:http";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/model-badge";
import { describe, expect, it } from "vitest";
import { createTestPluginApi } from "../../test-utils/plugin-api.js";
import register from "../index.js";
import { createBadgeCommand } from "./commands.js";
import { detectRasteriser } from "./core/render.js";
import { createSteering } from "./core/steering.js";
import { createStyleStore } from "./core/style.js";
import { buildRuntime } from "./runtime.js";
import { createLog } from "./test-helpers/fakes.js";
import * as S from "./test-helpers/signal-fixtures.js";
import { createWorld, IDS } from "./test-helpers/world.js";
import { BADGE_TOOL, createBadgeTool, STYLE_TOOL } from "./tool.js";

const OP = "+10000000002";

describe("plugin registration (ARCH §5.1)", () => {
  it("registers the writer service, /badge, the model_badge tool (+ alias), the session_start nudge and the §2c.11 new-group hook", () => {
    const seen = {
      services: [] as string[],
      commands: [] as string[],
      tools: [] as string[],
      hooks: [] as string[],
    };
    register(
      createTestPluginApi({
        id: "model-badge",
        name: "Model Badge",
        source: "test",
        config: {},
        runtime: {} as never,
        registerService: (s) => void seen.services.push(s.id),
        registerCommand: (c) => void seen.commands.push(c.name),
        registerTool: (_t, o) => void seen.tools.push(...(o?.names ?? [String(o?.name)])),
        on: ((name: string) => void seen.hooks.push(name)) as never,
      }),
    );
    expect(seen).toEqual({
      services: ["model-badge"],
      commands: ["badge"],
      tools: [BADGE_TOOL, STYLE_TOOL],
      hooks: ["session_start", "group_memory_created"],
    });
  });

  it("the manifest schema accepts the documented config shape", async () => {
    const manifest = JSON.parse(
      await fsp.readFile(path.join(import.meta.dirname, "..", "openclaw.plugin.json"), "utf8"),
    );
    expect(manifest.id).toBe("model-badge");
    const props = Object.keys(manifest.configSchema.properties).toSorted();
    expect(props).toEqual(
      [
        "agentId",
        "badges",
        "imageGen",
        "limits",
        "operators",
        "paths",
        "providers",
        "signal",
        "steering",
        "targets",
        "timing",
      ].toSorted(),
    );
  });
});

describe("/badge commands (ARCH §5.3)", () => {
  async function setup() {
    const w = await createWorld();
    const e = await w.startEngine();
    await w.settle();
    const steering = createSteering({
      engines: () => [e],
      store: createStyleStore({ fs: w.fs, stateDir: w.paths.rootDir }),
      operators: () => [OP],
      allowGroupMembers: () => false,
      configRules: () => [],
      now: () => w.clock.now(),
    });
    let purged = false;
    const handle = createBadgeCommand({
      engines: () => [e],
      steering: () => steering,
      operators: () => [OP],
      purge: async () => {
        purged = true;
        await e.purge();
      },
      now: () => w.clock.now(),
    });
    return { w, e, handle, purged: () => purged };
  }
  const inGroup = (id: string) => ({
    channel: "signal",
    from: `signal:group:${id}`,
    to: `group:${id}`,
  });

  it("operator-gated on the authenticated sender id", async () => {
    const { handle, e } = await setup();
    for (const args of ["status", "repaint this", "audit", "purge confirm", "regenerate this"]) {
      expect((await handle({ channel: "signal", senderId: "+10000000099", args })).text).toMatch(
        /operators only/,
      );
    }
    expect((await handle({ channel: "signal", args: "audit" })).text).toMatch(/operators only/);
    await e.stop();
  });

  it("status (this chat and all), repaint, audit", async () => {
    const { w, e, handle } = await setup();
    const here = (await handle({ ...inGroup(IDS.a), senderId: OP, args: "status" })).text;
    expect(here).toMatch(/Desired: rule:F \(prov\/fable-model, vector base\)/);
    expect(here).toMatch(/✓/);
    const all = (await handle({ channel: "signal", senderId: OP, args: "status all" })).text;
    expect(all).toMatch(/signal: role writer; targets 2; parked 0/);
    expect(all).toMatch(/image generation unconfigured/);
    const n = w.sends().length;
    expect((await handle({ ...inGroup(IDS.a), senderId: OP, args: "repaint this" })).text).toBe(
      "Repaint queued.",
    );
    await w.settle();
    expect(w.sends()).toHaveLength(n + 1);
    expect((await handle({ channel: "signal", senderId: OP, args: "audit" })).text).toMatch(
      /2\/2 converged, 0 pending, 0 parked, 0 assets missing/,
    );
    expect(
      (await handle({ channel: "signal", senderId: OP, args: "regenerate this" })).text,
    ).toMatch(/^Usage: \/badge regenerate/);
    expect((await handle({ ...inGroup(IDS.a), senderId: OP, args: "regenerate this" })).text).toBe(
      "Not queued: image generation is unconfigured.",
    );
    await e.stop();
  });

  it("purge needs confirmation, then removes cache and state", async () => {
    const { w, handle, purged } = await setup();
    expect((await handle({ channel: "signal", senderId: OP, args: "purge" })).text).toMatch(
      /purge confirm/,
    );
    expect(purged()).toBe(false);
    expect((await handle({ channel: "signal", senderId: OP, args: "purge confirm" })).text).toMatch(
      /removed/,
    );
    expect(purged()).toBe(true);
    expect(w.fs.list(w.paths.stateDir)).toEqual([]);
  });

  it("style list | preview | add | remove | reset via /badge style", async () => {
    const { w, e, handle } = await setup();
    const rule = JSON.stringify({ match: { modelGlob: "*fable*" }, set: { hue: "green" } });
    expect(
      (await handle({ channel: "signal", senderId: OP, args: `style preview ${rule}` })).text,
    ).toMatch(/2 target\(s\) would change/);
    expect(w.fs.exists(`${w.paths.rootDir}/style.json`)).toBe(false);
    const added = (await handle({ channel: "signal", senderId: OP, args: `style add ${rule}` }))
      .text;
    expect(added).toMatch(/^Added r-/);
    expect((await handle({ channel: "signal", senderId: OP, args: "style list" })).text).toMatch(
      /fable/,
    );
    const id = /Added (\S+)\./.exec(added)![1]!;
    expect(
      (await handle({ channel: "signal", senderId: "+10000000099", args: `style remove ${id}` }))
        .text,
    ).toMatch(/operators only/);
    expect(
      (await handle({ channel: "signal", senderId: OP, args: `style remove ${id}` })).text,
    ).toBe(`Removed ${id}.`);
    expect(
      (await handle({ channel: "signal", senderId: OP, args: "style add {nope" })).text,
    ).toMatch(/Give the rule as JSON/);
    expect((await handle({ channel: "signal", senderId: OP, args: "style reset" })).text).toMatch(
      /removed/,
    );
    await e.stop();
  });

  it("the style tool: preview returns sample images as attachments; add needs a separate call", async () => {
    const { w, e } = await setup();
    const steering = createSteering({
      engines: () => [e],
      store: createStyleStore({ fs: w.fs, stateDir: w.paths.rootDir }),
      operators: () => [OP],
      allowGroupMembers: () => false,
      configRules: () => [],
      now: () => w.clock.now(),
    });
    const tool = createBadgeTool({
      name: STYLE_TOOL,
      engines: () => [e],
      steering: () => steering,
      operators: () => [OP],
      allowGroupMembers: () => false,
      purge: async () => {},
      senderId: OP,
      sessionKey: w.sk(IDS.a),
    });
    const res = (await tool.execute("call-1", {
      action: "preview",
      rules: [{ match: { modelGlob: "*fable*" }, set: { tone: "dark" } }],
    })) as {
      content: Array<{ type: string; mimeType?: string }>;
    };
    expect(res.content[0]!.type).toBe("text");
    expect(
      res.content.filter((c) => c.type === "image").every((c) => c.mimeType === "image/png"),
    ).toBe(true);
    expect(w.fs.exists(`${w.paths.rootDir}/style.json`)).toBe(false);
    const add = (await tool.execute("call-2", {
      action: "add",
      rules: [{ match: { modelGlob: "*fable*" }, set: { tone: "dark" } }],
    })) as {
      details: { ok: boolean };
    };
    expect(add.details.ok).toBe(true);
    expect(w.fs.exists(`${w.paths.rootDir}/style.json`)).toBe(true);
    await e.stop();
  });
});

// ---------------- end to end ----------------

const rasteriser = await detectRasteriser();

async function waitFor(pred: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

describe.skipIf(!rasteriser)(
  "end to end through buildRuntime (real fs, real rasteriser, freeclaw Signal client)",
  () => {
    it("generates, paints once with the real-case id, repaints on a rename-style store write, prunes a removed target", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "model-badge-e2e-"));
      const G1 = "FakeGroupAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaA=";
      const G2 = "FakeGroupBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbB=";
      const live = new Set([G1, G2]);
      const sends: Array<Record<string, unknown>> = [];
      const server = http.createServer(async (req, res) => {
        let body = "";
        for await (const c of req) {
          body += c;
        }
        const m = JSON.parse(body);
        let out: unknown;
        if (m.method === "listGroups") {
          out = S.listGroups([...live].map((id) => S.group(id)));
        } else if (m.method === "getAvatar") {
          // ARCH §2c.8: no group has its own avatar here.
          out = { jsonrpc: "2.0", error: { code: -1, message: "Could not find avatar" } };
        } else {
          sends.push(m.params);
          out = S.updateOk();
        }
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ ...(out as object), id: m.id }));
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const port = (server.address() as net.AddressInfo).port;
      const w = async (rel: string, data: string) => {
        await fsp.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
        await fsp.writeFile(path.join(root, rel), data);
      };
      const storePath = path.join(root, "agents", "main", "sessions", "sessions.json");
      const gatewayConfig = {
        agents: {
          defaults: { model: { primary: "prov/fable-model" } },
          list: [{ id: "main", agentDir: path.join(root, "agents", "main", "agent") }],
        },
        session: { store: storePath },
        channels: { signal: { account: S.ACCOUNT, httpUrl: `http://127.0.0.1:${port}` } },
        plugins: {
          entries: {
            "model-badge": {
              enabled: true,
              config: {
                badges: [{ pattern: "fable", letter: "F", color: "#FFD700" }],
                timing: {
                  watchMs: 100,
                  debounceMs: 100,
                  queueSpacingMs: 50,
                  leaseHeartbeatMs: 5000,
                  reconcileIntervalMs: 600_000,
                  pruneGraceMs: 0,
                },
              },
            },
          },
        },
      } as unknown as OpenClawConfig;
      await w(
        "agents/main/agent/models.json",
        JSON.stringify({
          providers: { prov: { models: [{ id: "fable-model" }, { id: "k-model" }] } },
        }),
      );
      await w(
        "agents/main/sessions/sessions.json",
        JSON.stringify({
          [`agent:main:signal:group:${G1.toLowerCase()}`]: { updatedAt: 1, model: "prov/stale" },
        }),
      );
      await w("openclaw.json", JSON.stringify(gatewayConfig));
      const log = createLog();
      const rt = await buildRuntime({
        rawConfig: (gatewayConfig.plugins as { entries: Record<string, { config: unknown }> })
          .entries["model-badge"]!.config,
        gatewayConfig,
        gatewayStateDir: root,
        log,
        configPath: path.join(root, "openclaw.json"),
      });
      try {
        expect(rt.errors).toEqual([]);
        await rt.start();
        expect(await waitFor(() => sends.length >= 2)).toBe(true);
        expect(sends.map((s) => s.groupId).toSorted()).toEqual([G1, G2].toSorted());
        for (const s of sends) {
          expect(Object.keys(s).toSorted()).toEqual(["account", "avatar", "groupId"]);
          expect(
            String(s.avatar).startsWith(
              path.join(root, "plugins", "model-badge", "signal", "assets") + path.sep,
            ),
          ).toBe(true);
          const png = await fsp.readFile(String(s.avatar));
          expect([...png.subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
          expect(png.readUInt32BE(16)).toBe(512);
        }
        // Two targets × (F, K, ?) generated.
        const assetsDir = path.join(root, "plugins", "model-badge", "signal", "assets");
        const pngs = async () => (await fsp.readdir(assetsDir)).filter((f) => f.endsWith(".png"));
        expect(await pngs()).toHaveLength(6);

        // A model swap, written the way the gateway writes: tmp file + rename.
        await fsp.writeFile(
          `${storePath}.tmp`,
          JSON.stringify({
            [`agent:main:signal:group:${G1.toLowerCase()}`]: {
              updatedAt: 2,
              providerOverride: "prov",
              modelOverride: "k-model",
            },
          }),
        );
        await fsp.rename(`${storePath}.tmp`, storePath);
        expect(await waitFor(() => sends.length >= 3)).toBe(true);
        expect(sends[2]!.groupId).toBe(G1);

        // Target removed → its record and assets go at the next pass.
        live.delete(G2);
        await rt.engines[0]!.runPass("periodic");
        expect(await pngs()).toHaveLength(3);
        const applied = JSON.parse(
          await fsp.readFile(
            path.join(root, "plugins", "model-badge", "signal", "applied.json"),
            "utf8",
          ),
        );
        expect(Object.keys(applied.targets)).toEqual([`group:${G1.toLowerCase()}`]);

        const settled = sends.length;
        await new Promise((r) => setTimeout(r, 400));
        expect(sends).toHaveLength(settled);
        expect(log.lines.some((l) => l.msg.includes(G1) || l.msg.includes(G2))).toBe(false);
      } finally {
        await rt.stop();
        await new Promise<void>((r) => server.close(() => r()));
        await fsp.rm(root, { recursive: true, force: true });
      }
    });
  },
);
