import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionStore } from "../../config/sessions.js";
import { updateSessionStoreAfterAgentRun } from "./session-store.js";

function acpMeta() {
  return {
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: "runtime-1",
    mode: "persistent" as const,
    state: "idle" as const,
    lastActivityAt: Date.now(),
  };
}

describe("updateSessionStoreAfterAgentRun", () => {
  it("preserves ACP metadata when caller has a stale session snapshot", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-store-"));
    const storePath = path.join(dir, "sessions.json");
    const sessionKey = `agent:codex:acp:${randomUUID()}`;
    const sessionId = randomUUID();

    const existing: SessionEntry = {
      sessionId,
      updatedAt: Date.now(),
      acp: acpMeta(),
    };
    await fs.writeFile(storePath, JSON.stringify({ [sessionKey]: existing }, null, 2), "utf8");

    const staleInMemory: Record<string, SessionEntry> = {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
      },
    };

    await updateSessionStoreAfterAgentRun({
      cfg: {} as never,
      sessionId,
      sessionKey,
      storePath,
      sessionStore: staleInMemory,
      defaultProvider: "openai",
      defaultModel: "gpt-5.3-codex",
      result: {
        payloads: [],
        meta: {
          aborted: false,
          agentMeta: {
            provider: "openai",
            model: "gpt-5.3-codex",
          },
        },
      } as never,
    });

    const persisted = loadSessionStore(storePath, { skipCache: true })[sessionKey];
    expect(persisted?.acp).toBeDefined();
    expect(staleInMemory[sessionKey]?.acp).toBeDefined();
  });

  it("persists latest systemPromptReport for downstream warning dedupe", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-store-"));
    const storePath = path.join(dir, "sessions.json");
    const sessionKey = `agent:codex:report:${randomUUID()}`;
    const sessionId = randomUUID();

    const sessionStore: Record<string, SessionEntry> = {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
      },
    };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf8");

    const report = {
      source: "run" as const,
      generatedAt: Date.now(),
      bootstrapTruncation: {
        warningMode: "once" as const,
        warningSignaturesSeen: ["sig-a", "sig-b"],
      },
      systemPrompt: {
        chars: 1,
        projectContextChars: 1,
        nonProjectContextChars: 0,
      },
      injectedWorkspaceFiles: [],
      skills: { promptChars: 0, entries: [] },
      tools: { listChars: 0, schemaChars: 0, entries: [] },
    };

    await updateSessionStoreAfterAgentRun({
      cfg: {} as never,
      sessionId,
      sessionKey,
      storePath,
      sessionStore,
      defaultProvider: "openai",
      defaultModel: "gpt-5.3-codex",
      result: {
        payloads: [],
        meta: {
          agentMeta: {
            provider: "openai",
            model: "gpt-5.3-codex",
          },
          systemPromptReport: report,
        },
      } as never,
    });

    const persisted = loadSessionStore(storePath, { skipCache: true })[sessionKey];
    expect(persisted?.systemPromptReport?.bootstrapTruncation?.warningSignaturesSeen).toEqual([
      "sig-a",
      "sig-b",
    ]);
    expect(sessionStore[sessionKey]?.systemPromptReport?.bootstrapTruncation?.warningMode).toBe(
      "once",
    );
  });
  it("leaves user-owned fields written during the run untouched (ARCH §2.2, §2.3)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-store-"));
    const storePath = path.join(dir, "sessions.json");
    const sessionKey = `agent:main:override:${randomUUID()}`;
    const sessionId = randomUUID();

    const turnStart: SessionEntry = { sessionId, updatedAt: Date.now(), thinkingLevel: "low" };
    const onDisk: SessionEntry = {
      ...turnStart,
      providerOverride: "openai",
      modelOverride: "gpt-5.2",
      thinkingLevel: "high",
      verboseLevel: "on",
      sendPolicy: "deny",
      label: "renamed",
    };
    await fs.writeFile(storePath, JSON.stringify({ [sessionKey]: onDisk }, null, 2), "utf8");
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: turnStart };

    await updateSessionStoreAfterAgentRun({
      cfg: {} as never,
      sessionId,
      sessionKey,
      storePath,
      sessionStore,
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
      result: {
        payloads: [],
        meta: {
          agentMeta: {
            provider: "anthropic",
            model: "claude-opus-4-5",
            usage: { input: 10, output: 5 },
          },
        },
      } as never,
    });

    const persisted = loadSessionStore(storePath, { skipCache: true })[sessionKey];
    expect(persisted).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-5.2",
      thinkingLevel: "high",
      verboseLevel: "on",
      sendPolicy: "deny",
      label: "renamed",
      inputTokens: 10,
      outputTokens: 5,
    });
    expect(persisted).not.toHaveProperty("model");
    expect(persisted).not.toHaveProperty("modelProvider");
    expect(sessionStore[sessionKey]?.modelOverride).toBe("gpt-5.2");
  });
});
