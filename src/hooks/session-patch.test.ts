import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import {
  clearInternalHooks,
  isSessionPatchEvent,
  registerInternalHook,
  type InternalHookEvent,
} from "./internal-hooks.js";
import { emitSessionPatchHook } from "./session-patch.js";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("emitSessionPatchHook", () => {
  beforeEach(() => {
    clearInternalHooks();
  });
  afterEach(() => {
    clearInternalHooks();
  });

  it("does nothing when no session:patch listener is registered", async () => {
    const entry: SessionEntry = { sessionId: "s1", updatedAt: 1 };
    expect(() =>
      emitSessionPatchHook({
        sessionKey: "agent:main:main",
        sessionEntry: entry,
        patch: { key: "agent:main:main", model: "acme/alpha" },
        cfg: {} as OpenClawConfig,
      }),
    ).not.toThrow();
  });

  it("delivers a cloned session:patch event to listeners", async () => {
    const seen: InternalHookEvent[] = [];
    registerInternalHook("session:patch", (event) => {
      seen.push(event);
    });
    const entry: SessionEntry = {
      sessionId: "s1",
      updatedAt: 1,
      providerOverride: "acme",
      modelOverride: "alpha",
    };
    emitSessionPatchHook({
      sessionKey: "agent:main:signal:group:abc",
      sessionEntry: entry,
      patch: { key: "agent:main:signal:group:abc", model: "acme/alpha" },
      cfg: {} as OpenClawConfig,
    });
    await flush();

    expect(seen).toHaveLength(1);
    const event = seen[0];
    expect(isSessionPatchEvent(event)).toBe(true);
    expect(event.sessionKey).toBe("agent:main:signal:group:abc");
    expect(event.context.patch).toEqual({
      key: "agent:main:signal:group:abc",
      model: "acme/alpha",
    });
    expect(event.context.sessionEntry).toEqual(entry);
    // Handlers get a copy, never the live entry.
    expect(event.context.sessionEntry).not.toBe(entry);
  });

  it("never throws when a listener fails", async () => {
    const ok = vi.fn();
    registerInternalHook("session:patch", () => {
      throw new Error("boom");
    });
    registerInternalHook("session:patch", ok);
    emitSessionPatchHook({
      sessionKey: "agent:main:main",
      sessionEntry: { sessionId: "s1", updatedAt: 1 },
      patch: { key: "agent:main:main", model: "acme/alpha" },
      cfg: {} as OpenClawConfig,
    });
    await flush();
    expect(ok).toHaveBeenCalledTimes(1);
  });
});
