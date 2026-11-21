import fs from "node:fs/promises";
import path from "node:path";
import "./test-helpers/fast-coding-tools.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  cleanupEmbeddedPiRunnerTestWorkspace,
  createEmbeddedPiRunnerTestWorkspace,
  type EmbeddedPiRunnerTestWorkspace,
  immediateEnqueue,
} from "./test-helpers/pi-embedded-runner-e2e-fixtures.js";

/**
 * docs/design/session-context-limit.md §1.2, §3.1, §4: with the real runner and Pi's own
 * auto-compaction, a chat already above a newly set limit compacts first on its next turn
 * (through the existing threshold path, with a summary). Without a limit the same chat does not.
 */

function usage(input: number, output: number) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

vi.mock("@mariozechner/pi-coding-agent", async () => {
  return await vi.importActual<typeof import("@mariozechner/pi-coding-agent")>(
    "@mariozechner/pi-coding-agent",
  );
});

/** Every model call (turn and compaction summary) stays in-process: a local fake API provider. */
const FAKE_API = "ctx-limit-fake-api";

async function registerFakeApi() {
  const ai = await import("@mariozechner/pi-ai");
  const reply = (model: { api: string; provider: string; id: string }) => ({
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "summary-or-reply" }],
    stopReason: "stop" as const,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: usage(1, 1),
    timestamp: Date.now(),
  });
  const stream = (model: { api: string; provider: string; id: string }) => {
    const out = ai.createAssistantMessageEventStream();
    queueMicrotask(() => {
      out.push({ type: "done", reason: "stop", message: reply(model) });
      out.end();
    });
    return out;
  };
  ai.registerApiProvider(
    { api: FAKE_API, stream, streamSimple: stream } as unknown as Parameters<
      typeof ai.registerApiProvider
    >[0],
    "ctx-limit-test",
  );
}

let runEmbeddedPiAgent: typeof import("./pi-embedded-runner/run.js").runEmbeddedPiAgent;
let SessionManager: typeof import("@mariozechner/pi-coding-agent").SessionManager;
let workspace: EmbeddedPiRunnerTestWorkspace | undefined;
let counter = 0;

beforeAll(async () => {
  vi.useRealTimers();
  ({ runEmbeddedPiAgent } = await import("./pi-embedded-runner/run.js"));
  ({ SessionManager } = await import("@mariozechner/pi-coding-agent"));
  await registerFakeApi();
  workspace = await createEmbeddedPiRunnerTestWorkspace("openclaw-ctx-limit-");
}, 180_000);

afterAll(async () => {
  const ai = await import("@mariozechner/pi-ai");
  ai.unregisterApiProviders("ctx-limit-test");
  await cleanupEmbeddedPiRunnerTestWorkspace(workspace);
  workspace = undefined;
});

function makeConfig(storePath: string): OpenClawConfig {
  return {
    session: { store: storePath },
    models: {
      providers: {
        openai: {
          api: FAKE_API,
          apiKey: "sk-test",
          baseUrl: "http://127.0.0.1:9",
          models: [
            {
              id: "mock-big",
              name: "Mock big",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 1_000_000,
              maxTokens: 2048,
            },
          ],
        },
      },
    },
  } as unknown as OpenClawConfig;
}

/** A transcript whose last reply reported a 100k-token context: far below 1M, far above 32k. */
function seedLargeChat(sessionFile: string) {
  const sm = SessionManager.open(sessionFile);
  for (let i = 0; i < 3; i += 1) {
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: `question ${i}` }],
      timestamp: Date.now() - 10_000 + i,
    });
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: `answer ${i}` }],
      stopReason: "stop",
      api: FAKE_API,
      provider: "openai",
      model: "mock-big",
      usage: usage(100_000, 50),
      timestamp: Date.now() - 9_000 + i,
    });
  }
}

async function runTurn(contextLimit: number | undefined, opts: { asSubagent?: boolean } = {}) {
  const root = workspace!;
  counter += 1;
  const chatKey = `agent:test:whatsapp:group:limit-${counter}@g.us`;
  const childKey = `agent:test:subagent:child-${counter}`;
  const sessionKey = opts.asSubagent ? childKey : chatKey;
  const sessionFile = path.join(root.workspaceDir, `limit-${counter}.jsonl`);
  const storePath = path.join(root.tempRoot, `sessions-${counter}.json`);
  await fs.writeFile(
    storePath,
    JSON.stringify({
      [chatKey]: {
        sessionId: `s-${counter}`,
        updatedAt: Date.now(),
        ...(contextLimit !== undefined ? { contextLimit } : {}),
      },
      ...(opts.asSubagent
        ? { [childKey]: { sessionId: `c-${counter}`, updatedAt: Date.now(), spawnedBy: chatKey } }
        : {}),
    }),
  );
  seedLargeChat(sessionFile);
  const events: string[] = [];
  const result = await runEmbeddedPiAgent({
    sessionId: `s-${counter}`,
    sessionKey,
    sessionFile,
    workspaceDir: root.workspaceDir,
    config: makeConfig(storePath),
    prompt: "next question",
    provider: "openai",
    model: "mock-big",
    timeoutMs: 10_000,
    agentDir: root.agentDir,
    runId: `ctx-limit-run-${counter}`,
    enqueue: immediateEnqueue,
    onAgentEvent: (evt) => {
      if (evt.stream === "compaction" && typeof evt.data.phase === "string") {
        events.push(evt.data.phase);
      }
    },
  });
  const raw = await fs.readFile(sessionFile, "utf-8");
  const entries = raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type?: string; summary?: string });
  return { result, entries, events };
}

describe("session context limit: next turn compacts first (ARCH §3.1)", () => {
  it("no limit: a 100k chat on a 1M model does not compact (today's behaviour)", async () => {
    const { entries, events, result } = await runTurn(undefined);
    expect(entries.filter((e) => e.type === "compaction")).toHaveLength(0);
    expect(events).not.toContain("start");
    expect(result.meta.agentMeta?.compactionCount ?? 0).toBe(0);
  });

  it("limit above the model window: no effect", async () => {
    const { entries } = await runTurn(2_000_000);
    expect(entries.filter((e) => e.type === "compaction")).toHaveLength(0);
  });

  it("limit below the chat's size: the next turn compacts with a summary, then answers", async () => {
    const { entries, events, result } = await runTurn(32_000);
    const compactions = entries.filter((e) => e.type === "compaction");
    expect(compactions).toHaveLength(1);
    expect(compactions[0]?.summary).toContain("summary-or-reply");
    expect(events).toContain("start");
    expect(events).toContain("end");
    expect(result.meta.agentMeta?.compactionCount).toBe(1);
    expect(result.payloads?.some((p) => p.text === "summary-or-reply")).toBe(true);
  });

  it("a sub-agent of a limited chat is not limited (ARCH §1.4)", async () => {
    const { entries, events } = await runTurn(32_000, { asSubagent: true });
    expect(entries.filter((e) => e.type === "compaction")).toHaveLength(0);
    expect(events).not.toContain("start");
  });
});
