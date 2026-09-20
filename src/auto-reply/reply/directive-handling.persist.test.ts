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
    const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: "acme" });

    const result = await persistInlineDirectives({
      directives: directivesWithModel("acme/alpha"),
      effectiveModelDirective: "acme/alpha",
      cfg,
      sessionEntry,
      sessionStore,
      sessionKey,
      elevatedEnabled: false,
      elevatedAllowed: false,
      defaultProvider: "acme",
      defaultModel: "base",
      aliasIndex,
      allowedModelKeys: new Set<string>(),
      provider: "acme",
      model: "base",
      initialModelLabel: "acme/base",
      formatModelSwitchEvent: (label) => `Model switched to ${label}.`,
      agentCfg: undefined,
    });
    await flush();

    expect(result.provider).toBe("acme");
    expect(result.model).toBe("alpha");
    expect(seen).toHaveLength(1);
    const event = seen[0];
    expect(isSessionPatchEvent(event)).toBe(true);
    expect(event.sessionKey).toBe(sessionKey);
    expect(event.context.patch).toEqual({ key: sessionKey, model: "acme/alpha" });
    expect((event.context.sessionEntry as SessionEntry).modelOverride).toBe("alpha");
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
      providerOverride: "acme",
      modelOverride: "alpha",
    };
    const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: "acme" });

    await persistInlineDirectives({
      directives: directivesWithModel("acme/alpha"),
      effectiveModelDirective: "acme/alpha",
      cfg,
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      sessionKey,
      elevatedEnabled: false,
      elevatedAllowed: false,
      defaultProvider: "acme",
      defaultModel: "base",
      aliasIndex,
      allowedModelKeys: new Set<string>(),
      provider: "acme",
      model: "alpha",
      initialModelLabel: "acme/alpha",
      formatModelSwitchEvent: (label) => `Model switched to ${label}.`,
      agentCfg: undefined,
    });
    await flush();

    expect(seen).toHaveLength(0);
  });
});
