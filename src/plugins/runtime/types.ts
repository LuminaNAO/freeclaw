import type { PluginRuntimeChannel } from "./types-channel.js";
import type { PluginRuntimeCore, RuntimeLogger } from "./types-core.js";

export type { RuntimeLogger };

// ── Subagent runtime types ──────────────────────────────────────────

export type SubagentRunParams = {
  sessionKey: string;
  message: string;
  extraSystemPrompt?: string;
  lane?: string;
  deliver?: boolean;
  idempotencyKey?: string;
};

export type SubagentRunResult = {
  runId: string;
};

export type SubagentWaitParams = {
  runId: string;
  timeoutMs?: number;
};

export type SubagentWaitResult = {
  status: "ok" | "error" | "timeout";
  error?: string;
};

export type SubagentGetSessionMessagesParams = {
  sessionKey: string;
  limit?: number;
};

export type SubagentGetSessionMessagesResult = {
  messages: unknown[];
};

/** @deprecated Use SubagentGetSessionMessagesParams. */
export type SubagentGetSessionParams = SubagentGetSessionMessagesParams;

/** @deprecated Use SubagentGetSessionMessagesResult. */
export type SubagentGetSessionResult = SubagentGetSessionMessagesResult;

export type SubagentDeleteSessionParams = {
  sessionKey: string;
  deleteTranscript?: boolean;
};

export type SubagentPatchSessionParams = {
  sessionKey: string;
  /** `provider/model`; validated against the gateway model allowlist. */
  model?: string;
  thinkingLevel?: string;
  label?: string;
};

export type SubagentPatchSessionResult = {
  provider: string;
  model: string;
};

export type SubagentAbortSessionParams = {
  sessionKey: string;
};

export type SubagentAbortSessionResult = {
  aborted: boolean;
};

export type PluginRuntime = PluginRuntimeCore & {
  subagent: {
    run: (params: SubagentRunParams) => Promise<SubagentRunResult>;
    waitForRun: (params: SubagentWaitParams) => Promise<SubagentWaitResult>;
    getSessionMessages: (
      params: SubagentGetSessionMessagesParams,
    ) => Promise<SubagentGetSessionMessagesResult>;
    /** @deprecated Use getSessionMessages. */
    getSession: (params: SubagentGetSessionParams) => Promise<SubagentGetSessionResult>;
    deleteSession: (params: SubagentDeleteSessionParams) => Promise<void>;
    /** Apply model / thinking / label overrides to a session entry (creates it if absent). */
    patchSession: (params: SubagentPatchSessionParams) => Promise<SubagentPatchSessionResult>;
    /** Abort the session's active run and drop its queued follow-ups. */
    abortSession: (params: SubagentAbortSessionParams) => Promise<SubagentAbortSessionResult>;
  };
  channel: PluginRuntimeChannel;
};
