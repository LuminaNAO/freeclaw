import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildModelAliasIndex } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  clearInternalHooks,
  isSessionPatchEvent,
  registerInternalHook,
  type InternalHookEvent,
} from "../../hooks/internal-hooks.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
import { persistInlineDirectives } from "./directive-handling.persist.js";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function directivesWithModel(raw: string): InlineDirectives {
  return {
    hasModelDirective: true,
    rawModelDirective: raw,
  } as unknown as InlineDirectives;
}

describe("persistInlineDirectives session:patch emission", () => {
  beforeEach(() => {
    clearInternalHooks();
  });
  afterEach(() => {
    clearInternalHooks();
  });

  it("fires session:patch with a qualified model when /model changes the session", async () => {
    const seen: InternalHookEvent[] = [];
    registerInternalHook("session:patch", (event) => {
      seen.push(event);
    });

    const cfg = {} as OpenClawConfig;
    const sessionKey = "agent:main:signal:group:abc";
    const sessionEntry: SessionEntry = { sessionId: "s1", updatedAt: 1 };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: "cloudburst" });

    const result = await persistInlineDirectives({
      directives: directivesWithModel("cloudburst/opus"),
      effectiveModelDirective: "cloudburst/opus",
      cfg,
      sessionEntry,
      sessionStore,
      sessionKey,
      elevatedEnabled: false,
      elevatedAllowed: false,
      defaultProvider: "cloudburst",
      defaultModel: "sol",
      aliasIndex,
      allowedModelKeys: new Set<string>(),
      provider: "cloudburst",
      model: "sol",
      initialModelLabel: "cloudburst/sol",
      formatModelSwitchEvent: (label) => `Model switched to ${label}.`,
      agentCfg: undefined,
    });
    await flush();

    expect(result.provider).toBe("cloudburst");
    expect(result.model).toBe("opus");
    expect(seen).toHaveLength(1);
    const event = seen[0];
    expect(isSessionPatchEvent(event)).toBe(true);
    expect(event.sessionKey).toBe(sessionKey);
    expect(event.context.patch).toEqual({ key: sessionKey, model: "cloudburst/opus" });
    expect((event.context.sessionEntry as SessionEntry).modelOverride).toBe("opus");
  });

  it("stays silent when the directive does not change the model", async () => {
    const seen: InternalHookEvent[] = [];
    registerInternalHook("session:patch", (event) => {
      seen.push(event);
    });

    const cfg = {} as OpenClawConfig;
    const sessionKey = "agent:main:main";
    const sessionEntry: SessionEntry = {
      sessionId: "s1",
      updatedAt: 1,
      providerOverride: "cloudburst",
      modelOverride: "opus",
    };
    const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: "cloudburst" });

    await persistInlineDirectives({
      directives: directivesWithModel("cloudburst/opus"),
      effectiveModelDirective: "cloudburst/opus",
      cfg,
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      sessionKey,
      elevatedEnabled: false,
      elevatedAllowed: false,
      defaultProvider: "cloudburst",
      defaultModel: "sol",
      aliasIndex,
      allowedModelKeys: new Set<string>(),
      provider: "cloudburst",
      model: "opus",
      initialModelLabel: "cloudburst/opus",
      formatModelSwitchEvent: (label) => `Model switched to ${label}.`,
      agentCfg: undefined,
    });
    await flush();

    expect(seen).toHaveLength(0);
  });
});
