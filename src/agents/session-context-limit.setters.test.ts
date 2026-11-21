import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleContextLimitCommand } from "../auto-reply/reply/commands-context-limit.js";
import type { HandleCommandsParams } from "../auto-reply/reply/commands-types.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadSessionStore } from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { applySessionsPatchToStore } from "../gateway/sessions-patch.js";
import { createSessionStatusTool } from "./tools/session-status-tool.js";

/**
 * docs/design/session-context-limit.md §2 and §4: `/context limit`, `sessions.patch` and the
 * `session_status` tool give the same result, refuse the same values, and only operators may set
 * or clear by command or tool. Real session store on disk; no gateway, no network.
 */

vi.mock("../infra/provider-usage.js", () => ({
  resolveUsageProviderId: () => undefined,
  loadProviderUsageSummary: async () => ({ updatedAt: Date.now(), providers: [] }),
  formatUsageWindowSummary: () => null,
}));

const KEY = "agent:main:whatsapp:group:limit-g1@g.us";
let tempDir: string;
let storePath: string;
let cfg: OpenClawConfig;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ctx-limit-setters-"));
  storePath = path.join(tempDir, "sessions.json");
  cfg = {
    session: { store: storePath, mainKey: "main", scope: "per-sender" },
    agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } },
    tools: { agentToAgent: { enabled: false } },
  } as OpenClawConfig;
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function seed(entry: Partial<SessionEntry> = {}) {
  await fs.writeFile(
    storePath,
    JSON.stringify({
      [KEY]: { sessionId: "s1", updatedAt: 1, chatType: "group", contextTokens: 200_000, ...entry },
    }),
  );
}

function read(): SessionEntry | undefined {
  return loadSessionStore(storePath, { skipCache: true })[KEY];
}

async function viaCommand(value: string, senderIsOwner = true) {
  const entry = { ...read()! };
  const store = loadSessionStore(storePath, { skipCache: true });
  const params = {
    cfg,
    command: { senderIsOwner, senderId: "sender" },
    sessionEntry: entry,
    sessionStore: store,
    sessionKey: KEY,
    storePath,
    provider: "anthropic",
    model: "claude-opus-4-5",
  } as unknown as HandleCommandsParams;
  return (await handleContextLimitCommand(params, [value])).text ?? "";
}

async function viaPatch(value: number | null) {
  const store = loadSessionStore(storePath, { skipCache: true });
  const result = await applySessionsPatchToStore({
    cfg,
    store,
    storeKey: KEY,
    patch: { key: KEY, contextLimit: value },
  });
  if (result.ok) {
    await fs.writeFile(storePath, JSON.stringify(store));
  }
  return result;
}

async function viaTool(contextLimit: string, senderIsOwner = true) {
  const tool = createSessionStatusTool({ agentSessionKey: KEY, config: cfg, senderIsOwner });
  return await tool.execute("call-1", { contextLimit });
}

function comparable(entry: SessionEntry | undefined) {
  return { contextLimit: entry?.contextLimit, contextTokens: entry?.contextTokens };
}

describe("command, patch and tool give the same result (ARCH §2)", () => {
  it("set 64k / 64000 and clear with default / null", async () => {
    await seed();
    await viaCommand("64k");
    const byCommand = comparable(read());

    await seed();
    expect((await viaPatch(64_000)).ok).toBe(true);
    const byPatch = comparable(read());

    await seed();
    await viaTool("64k");
    const byTool = comparable(read());

    expect(byCommand).toEqual({ contextLimit: 64_000, contextTokens: undefined });
    expect(byPatch).toEqual(byCommand);
    expect(byTool).toEqual(byCommand);

    await seed({ contextLimit: 64_000 });
    await viaCommand("default");
    const clearedByCommand = read();
    await seed({ contextLimit: 64_000 });
    await viaPatch(null);
    const clearedByPatch = read();
    await seed({ contextLimit: 64_000 });
    await viaTool("default");
    const clearedByTool = read();
    for (const entry of [clearedByCommand, clearedByPatch, clearedByTool]) {
      expect(entry && "contextLimit" in entry).toBe(false);
      expect(entry?.sessionId).toBe("s1");
    }
  });

  it("below the hard minimum: all three refuse with the minimum named, nothing stored", async () => {
    await seed({ contextLimit: 64_000 });
    expect(await viaCommand("15999")).toContain("at least 16000");
    const patched = await viaPatch(15_999);
    expect(patched.ok).toBe(false);
    expect(patched.ok ? "" : patched.error.message).toContain("at least 16000");
    await expect(viaTool("15999")).rejects.toThrow("at least 16000");
    expect(read()?.contextLimit).toBe(64_000);
  });

  it("fractional tokens: all three refuse", async () => {
    await seed();
    expect(await viaCommand("64000.5")).toContain("whole number");
    expect((await viaPatch(64_000.5)).ok).toBe(false);
    await expect(viaTool("64000.5")).rejects.toThrow("whole number");
    expect(read()?.contextLimit).toBeUndefined();
  });

  it("sessions.patch without contextLimit leaves an existing limit alone", async () => {
    await seed({ contextLimit: 64_000 });
    const store = loadSessionStore(storePath, { skipCache: true });
    const result = await applySessionsPatchToStore({
      cfg,
      store,
      storeKey: KEY,
      patch: { key: KEY, label: "alerts" },
    });
    expect(result.ok && result.entry.contextLimit).toBe(64_000);
  });
});

describe("operator-only (ARCH §2.1, §2.3)", () => {
  it("a non-operator command is refused and changes nothing", async () => {
    await seed({ contextLimit: 64_000 });
    expect(await viaCommand("32k", false)).toContain("Only an operator");
    expect(await viaCommand("default", false)).toContain("Only an operator");
    expect(read()?.contextLimit).toBe(64_000);
  });

  it("the tool refuses set and clear unless the turn's sender is an operator", async () => {
    await seed({ contextLimit: 64_000 });
    await expect(viaTool("32k", false)).rejects.toThrow(/Only an operator/);
    await expect(viaTool("default", false)).rejects.toThrow(/Only an operator/);
    expect(read()?.contextLimit).toBe(64_000);
    const tool = createSessionStatusTool({ agentSessionKey: KEY, config: cfg });
    await expect(tool.execute("call-2", { contextLimit: "32k" })).rejects.toThrow(
      /Only an operator/,
    );
    expect(read()?.contextLimit).toBe(64_000);
  });

  it("the tool without contextLimit still works for anyone (status card unchanged)", async () => {
    await seed();
    const tool = createSessionStatusTool({
      agentSessionKey: KEY,
      config: cfg,
      senderIsOwner: false,
    });
    const result = await tool.execute("call-3", {});
    const details = result.details as { ok: boolean; changedContextLimit?: boolean };
    expect(details.ok).toBe(true);
    expect("changedContextLimit" in details).toBe(false);
    expect(read()?.contextLimit).toBeUndefined();
  });

  it("an operator's tool call sets it for another session by sessionKey and reports it", async () => {
    await seed();
    const tool = createSessionStatusTool({
      agentSessionKey: "agent:main:main",
      config: cfg,
      senderIsOwner: true,
    });
    const result = await tool.execute("call-4", { sessionKey: KEY, contextLimit: "0.25m" });
    expect(result.details).toMatchObject({
      ok: true,
      changedContextLimit: true,
      contextLimit: 250_000,
    });
    expect(read()?.contextLimit).toBe(250_000);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Context:");
  });
});
