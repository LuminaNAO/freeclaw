import { randomUUID } from "node:crypto";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/model-badge";
import {
  buildWriterMessage,
  WRITER_INSTRUCTION,
  WRITER_MAX_SNIPPETS,
  type SceneWriter,
} from "./core/scene.js";

// ARCH §2c.11 writer: one short agent run through the plugin runtime, in its own
// throwaway session that is deleted afterwards. Inputs: the group name and, unless
// `memory: false`, the agent's own memory search for that name (top few snippets, from
// memory files only: never session transcripts, which are chat). Nothing else.

export type WriterRuntime = Pick<PluginRuntime, "subagent"> & {
  tools?: Pick<PluginRuntime["tools"], "createMemorySearchTool">;
};

export const WRITER_SESSION_MARKER = ":model-badge:scene:";
const LANE = "subagent";

export function writerSessionKey(agentId: string, id = randomUUID()): string {
  return `agent:${agentId.toLowerCase()}${WRITER_SESSION_MARKER}${id}`;
}

function textOf(msg: unknown): string {
  const content = (msg as { content?: unknown })?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        (c as { type?: unknown })?.type === "text" &&
        typeof (c as { text?: unknown }).text === "string"
          ? (c as { text: string }).text
          : "",
      )
      .join("");
  }
  return "";
}

// The agent's reply: the text of the last assistant message.
export function lastAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown };
    if (m?.role === "assistant") {
      return textOf(m);
    }
  }
  return "";
}

// The agent's own memory for the name: snippets from its memory files only.
export async function memorySnippets(
  runtime: WriterRuntime,
  opts: { gatewayConfig: OpenClawConfig; sessionKey: string; name: string },
): Promise<string[]> {
  const tool = runtime.tools?.createMemorySearchTool({
    config: opts.gatewayConfig,
    agentSessionKey: opts.sessionKey,
  });
  if (!tool?.execute) {
    return [];
  }
  try {
    const res = await tool.execute("model-badge-scene", {
      query: opts.name,
      maxResults: WRITER_MAX_SNIPPETS * 2,
    });
    const results = (res as { details?: { results?: unknown } })?.details?.results;
    if (!Array.isArray(results)) {
      return [];
    }
    return results
      .filter((r) => (r as { source?: unknown })?.source === "memory")
      .map((r) => (r as { snippet?: unknown }).snippet)
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .slice(0, WRITER_MAX_SNIPPETS);
  } catch {
    return [];
  }
}

export function createSceneWriter(opts: {
  runtime: WriterRuntime;
  agentId: string;
  gatewayConfig: OpenClawConfig;
  newSessionKey?: () => string;
}): SceneWriter {
  const { runtime } = opts;
  return {
    async write(req) {
      const sessionKey = opts.newSessionKey?.() ?? writerSessionKey(opts.agentId);
      const snippets = req.memory
        ? await memorySnippets(runtime, {
            gatewayConfig: opts.gatewayConfig,
            sessionKey,
            name: req.name,
          })
        : [];
      try {
        if (req.model) {
          await runtime.subagent.patchSession({
            sessionKey,
            model: req.model,
            label: "model-badge scene",
          });
        }
        const { runId } = await runtime.subagent.run({
          sessionKey,
          message: buildWriterMessage({ name: req.name, snippets }),
          extraSystemPrompt: WRITER_INSTRUCTION,
          lane: LANE,
          deliver: false,
          idempotencyKey: `model-badge-scene-${sessionKey.slice(-36)}`,
        });
        const end = await runtime.subagent.waitForRun({ runId, timeoutMs: req.timeoutMs });
        if (end.status !== "ok") {
          await runtime.subagent.abortSession?.({ sessionKey }).catch(() => undefined);
          throw new Error(end.status === "timeout" ? "writer timed out" : "writer run failed");
        }
        const { messages } = await runtime.subagent.getSessionMessages({ sessionKey, limit: 20 });
        return lastAssistantText(messages);
      } finally {
        // Throwaway: the session and its transcript are deleted whatever happened.
        await runtime.subagent
          .deleteSession({ sessionKey, deleteTranscript: true })
          .catch(() => undefined);
      }
    },
  };
}
