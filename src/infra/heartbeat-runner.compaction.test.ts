import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { loadSessionStore, resolveMainSessionKey } from "../config/sessions.js";
import { markGatewayDraining, resetAllLanes } from "../process/command-queue.js";
import { resolveHeartbeatCompactionStatusForAgent, runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import { withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";

// Avoid pulling optional runtime deps during isolated runs.
vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

const { calls, piMocks, logMock } = vi.hoisted(() => {
  const calls: string[] = [];
  const logMock = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
  };
  return {
    calls,
    logMock,
    piMocks: {
      compactEmbeddedPiSession: vi.fn(),
      isEmbeddedPiRunActive: vi.fn((_sessionId: string): boolean => false),
      runEmbeddedPiAgent: vi.fn(),
    },
  };
});

vi.mock("../agents/pi-embedded.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/pi-embedded.js")>();
  return {
    ...actual,
    compactEmbeddedPiSession: piMocks.compactEmbeddedPiSession,
    isEmbeddedPiRunActive: piMocks.isEmbeddedPiRunActive,
    runEmbeddedPiAgent: piMocks.runEmbeddedPiAgent,
  };
});

vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      if (subsystem !== "gateway/heartbeat") {
        return actual.createSubsystemLogger(subsystem);
      }
      const logger = {
        ...logMock,
        subsystem,
        isEnabled: () => true,
        child: () => logger,
      };
      return logger;
    },
  };
});

installHeartbeatRunnerTestRuntime();

const SESSION_ID = "hb-session";

type Scenario = {
  totalTokens?: number;
  contextWindow?: number;
  heartbeat?: Record<string, unknown>;
  entry?: Record<string, unknown>;
  cfg?: (cfg: OpenClawConfig) => OpenClawConfig;
};

function compactionsByHeartbeat() {
  return piMocks.compactEmbeddedPiSession.mock.calls.map((call) => call[0]);
}

function compactionLogLines() {
  return logMock.info.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.startsWith("heartbeat: compacted session"));
}

async function withScenario(
  scenario: Scenario,
  run: (ctx: {
    cfg: OpenClawConfig;
    storePath: string;
    sessionKey: string;
    replySpy: ReturnType<typeof vi.spyOn>;
    sendWhatsApp: ReturnType<typeof vi.fn>;
    heartbeatOnce: () => ReturnType<typeof runHeartbeatOnce>;
  }) => Promise<void>,
) {
  await withTempHeartbeatSandbox(
    async ({ tmpDir, storePath, replySpy }) => {
      let cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            model: "openai/gpt-test",
            heartbeat: { every: "5m", target: "whatsapp", ...scenario.heartbeat },
          },
        },
        models: {
          providers: {
            openai: {
              baseUrl: "https://example.invalid/v1",
              models: [
                {
                  id: "gpt-test",
                  name: "gpt-test",
                  contextWindow: scenario.contextWindow ?? 200_000,
                  maxTokens: 8192,
                  input: ["text"],
                  reasoning: false,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
                {
                  id: "gpt-small",
                  name: "gpt-small",
                  contextWindow: 128_000,
                  maxTokens: 8192,
                  input: ["text"],
                  reasoning: false,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      } as OpenClawConfig;
      if (scenario.cfg) {
        cfg = scenario.cfg(cfg);
      }
      const sessionKey = resolveMainSessionKey(cfg);
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId: SESSION_ID,
            updatedAt: 1,
            lastChannel: "whatsapp",
            lastProvider: "whatsapp",
            lastTo: "+1555",
            totalTokens: scenario.totalTokens,
            totalTokensFresh: scenario.totalTokens !== undefined ? true : undefined,
            compactionCount: 2,
            ...scenario.entry,
          },
        }),
      );
      await fs.writeFile(path.join(tmpDir, `${SESSION_ID}.jsonl`), "");
      replySpy.mockImplementation(async () => {
        calls.push("turn");
        return { text: "HEARTBEAT_OK" };
      });
      const sendWhatsApp = vi.fn();
      const heartbeatOnce = () =>
        runHeartbeatOnce({
          cfg,
          deps: { getQueueSize: () => 0, nowMs: () => 0, sendWhatsApp },
        });
      await run({ cfg, storePath, sessionKey, replySpy, sendWhatsApp, heartbeatOnce });
    },
    { prefix: "openclaw-hb-compact-" },
  );
}

beforeEach(() => {
  calls.length = 0;
  for (const fn of Object.values(logMock)) {
    fn.mockClear();
  }
  piMocks.isEmbeddedPiRunActive.mockReset().mockReturnValue(false);
  piMocks.runEmbeddedPiAgent.mockReset().mockImplementation(async () => {
    calls.push("memory-flush");
    return { payloads: [], meta: {} };
  });
  piMocks.compactEmbeddedPiSession.mockReset().mockImplementation(async () => {
    calls.push("compact");
    return {
      ok: true,
      compacted: true,
      result: { summary: "s", firstKeptEntryId: "e", tokensBefore: 150_000, tokensAfter: 20_000 },
    };
  });
});

afterEach(() => {
  resetAllLanes();
  vi.restoreAllMocks();
});

describe("runHeartbeatOnce – heartbeat session compaction (ARCH §2, §4)", () => {
  it("over threshold: one compaction on the session's own model, then the turn on the compacted session", async () => {
    await withScenario(
      { totalTokens: 150_000 },
      async ({ storePath, sessionKey, replySpy, heartbeatOnce, sendWhatsApp }) => {
        replySpy.mockImplementation(async () => {
          calls.push("turn");
          // The turn sees the compacted session: same session, post-compaction size.
          const entry = loadSessionStore(storePath, { skipCache: true })[sessionKey];
          expect(entry?.sessionId).toBe(SESSION_ID);
          expect(entry?.totalTokens).toBe(20_000);
          return { text: "HEARTBEAT_OK" };
        });

        const result = await heartbeatOnce();

        expect(result.status).toBe("ran");
        expect(piMocks.compactEmbeddedPiSession).toHaveBeenCalledTimes(1);
        expect(compactionsByHeartbeat()[0]).toEqual(
          expect.objectContaining({
            sessionId: SESSION_ID,
            sessionKey,
            provider: "openai",
            model: "gpt-test",
            trigger: "heartbeat",
          }),
        );
        expect(calls).toEqual(["memory-flush", "compact", "turn"]);
        const entry = loadSessionStore(storePath, { skipCache: true })[sessionKey];
        expect(entry?.compactionCount).toBe(3);
        expect(typeof entry?.heartbeatCompactedAt).toBe("number");
        expect(entry?.updatedAt).toBe(1);
        // Quiet: one log line (before → after), nothing sent to any chat.
        expect(compactionLogLines()).toEqual([expect.stringContaining("150000 → 20000")]);
        expect(sendWhatsApp).not.toHaveBeenCalled();
      },
    );
  });

  it("uses the session's model override, not agents.defaults.compaction.model", async () => {
    await withScenario(
      {
        totalTokens: 70_000,
        entry: { providerOverride: "openai", modelOverride: "gpt-small" },
        cfg: (cfg) => ({
          ...cfg,
          agents: {
            ...cfg.agents,
            defaults: { ...cfg.agents?.defaults, compaction: { model: "openai/gpt-cheap" } },
          },
        }),
      },
      async ({ heartbeatOnce }) => {
        await heartbeatOnce();
        // gpt-small has a 128k window → 64k threshold; 70k is over it.
        expect(piMocks.compactEmbeddedPiSession).toHaveBeenCalledTimes(1);
        expect(compactionsByHeartbeat()[0]).toEqual(
          expect.objectContaining({ provider: "openai", model: "gpt-small" }),
        );
        expect(piMocks.runEmbeddedPiAgent).toHaveBeenCalledWith(
          expect.objectContaining({ provider: "openai", model: "gpt-small" }),
        );
      },
    );
  });

  it("uses heartbeat.model when set, like the turn itself", async () => {
    await withScenario(
      { totalTokens: 70_000, heartbeat: { model: "openai/gpt-small" } },
      async ({ heartbeatOnce }) => {
        await heartbeatOnce();
        expect(compactionsByHeartbeat()[0]).toEqual(
          expect.objectContaining({ provider: "openai", model: "gpt-small" }),
        );
      },
    );
  });

  it("passes heartbeat.compactInstructions as custom instructions", async () => {
    await withScenario(
      { totalTokens: 150_000, heartbeat: { compactInstructions: "keep open todos" } },
      async ({ heartbeatOnce }) => {
        await heartbeatOnce();
        expect(compactionsByHeartbeat()[0]).toEqual(
          expect.objectContaining({ customInstructions: "keep open todos" }),
        );
      },
    );
  });

  it("memory flush runs as part of it, on the same model, and is recorded", async () => {
    await withScenario(
      { totalTokens: 150_000 },
      async ({ storePath, sessionKey, heartbeatOnce }) => {
        await heartbeatOnce();
        expect(piMocks.runEmbeddedPiAgent).toHaveBeenCalledTimes(1);
        expect(piMocks.runEmbeddedPiAgent).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId: SESSION_ID,
            sessionKey,
            trigger: "memory",
            memoryFlushWritePath: expect.stringMatching(/^memory\/\d{4}-\d{2}-\d{2}\.md$/),
            provider: "openai",
            model: "gpt-test",
            disableMessageTool: true,
          }),
        );
        const entry = loadSessionStore(storePath, { skipCache: true })[sessionKey];
        expect(entry?.memoryFlushCompactionCount).toBe(2);
        expect(typeof entry?.memoryFlushAt).toBe("number");
      },
    );
  });

  it("a memory flush failure does not block the compaction or the turn", async () => {
    piMocks.runEmbeddedPiAgent.mockRejectedValueOnce(new Error("flush boom"));
    await withScenario({ totalTokens: 150_000 }, async ({ heartbeatOnce, replySpy }) => {
      await heartbeatOnce();
      expect(piMocks.compactEmbeddedPiSession).toHaveBeenCalledTimes(1);
      expect(replySpy).toHaveBeenCalledTimes(1);
    });
  });

  it.each([
    ["under threshold", { totalTokens: 99_000 }],
    ["compactAt off", { totalTokens: 190_000, heartbeat: { compactAt: "off" } }],
  ] as const)("%s → no compaction, turn still runs", async (_label, scenario) => {
    await withScenario(scenario, async ({ heartbeatOnce, replySpy }) => {
      await heartbeatOnce();
      expect(piMocks.compactEmbeddedPiSession).not.toHaveBeenCalled();
      expect(piMocks.runEmbeddedPiAgent).not.toHaveBeenCalled();
      expect(replySpy).toHaveBeenCalledTimes(1);
    });
  });

  it("an explicit compactAt is honoured (140k on a 1M model)", async () => {
    await withScenario(
      { totalTokens: 120_000, contextWindow: 1_000_000, heartbeat: { compactAt: 140_000 } },
      async ({ heartbeatOnce }) => {
        await heartbeatOnce();
        expect(piMocks.compactEmbeddedPiSession).not.toHaveBeenCalled();
      },
    );
    await withScenario(
      { totalTokens: 141_000, contextWindow: 1_000_000, heartbeat: { compactAt: 140_000 } },
      async ({ heartbeatOnce }) => {
        await heartbeatOnce();
        expect(piMocks.compactEmbeddedPiSession).toHaveBeenCalledTimes(1);
      },
    );
  });

  it("active run on the session → no compaction, never interrupts", async () => {
    piMocks.isEmbeddedPiRunActive.mockImplementation((id: string): boolean => id === SESSION_ID);
    await withScenario({ totalTokens: 150_000 }, async ({ heartbeatOnce }) => {
      await heartbeatOnce();
      expect(piMocks.compactEmbeddedPiSession).not.toHaveBeenCalled();
      expect(piMocks.runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("gateway draining → no compaction", async () => {
    await withScenario({ totalTokens: 150_000 }, async ({ heartbeatOnce }) => {
      markGatewayDraining();
      await heartbeatOnce();
      expect(piMocks.compactEmbeddedPiSession).not.toHaveBeenCalled();
      expect(piMocks.runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("compaction failure → turn still runs, error logged, retried next time", async () => {
    piMocks.compactEmbeddedPiSession
      .mockImplementationOnce(async () => {
        calls.push("compact");
        return { ok: false, compacted: false, reason: "provider exploded" };
      })
      .mockImplementationOnce(async () => {
        calls.push("compact");
        throw new Error("lane gone");
      });
    await withScenario({ totalTokens: 150_000 }, async ({ heartbeatOnce, replySpy }) => {
      expect((await heartbeatOnce()).status).toBe("ran");
      expect((await heartbeatOnce()).status).toBe("ran");
      await heartbeatOnce();

      expect(piMocks.compactEmbeddedPiSession).toHaveBeenCalledTimes(3);
      expect(replySpy).toHaveBeenCalledTimes(3);
      expect(calls.filter((c) => c !== "memory-flush")).toEqual([
        "compact",
        "turn",
        "compact",
        "turn",
        "compact",
        "turn",
      ]);
      const warnings = logMock.warn.mock.calls.map((call) => String(call[0]));
      expect(warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            "compaction failed (will retry next heartbeat): provider exploded",
          ),
          expect.stringContaining("compaction failed (will retry next heartbeat): lane gone"),
        ]),
      );
      expect(compactionLogLines()).toHaveLength(1);
    });
  });
});

describe("resolveHeartbeatCompactionStatusForAgent (ARCH §2.5)", () => {
  it("reports the heartbeat session's size, threshold and last compaction time", async () => {
    await withScenario(
      { totalTokens: 42_000, contextWindow: 128_000, entry: { heartbeatCompactedAt: 1234 } },
      async ({ cfg, sessionKey }) => {
        expect(resolveHeartbeatCompactionStatusForAgent(cfg, "main")).toEqual({
          sessionKey,
          totalTokens: 42_000,
          threshold: 64_000,
          lastCompactedAt: 1234,
        });
      },
    );
  });

  it("reports a null threshold when compactAt is off", async () => {
    await withScenario(
      { totalTokens: 42_000, heartbeat: { compactAt: "off" } },
      async ({ cfg }) => {
        expect(resolveHeartbeatCompactionStatusForAgent(cfg, "main")?.threshold).toBeNull();
      },
    );
  });
});
