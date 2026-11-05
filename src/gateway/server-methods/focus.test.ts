// Gateway method `focus` (focus-mode ARCH §4, §7.4): operator authority only.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearAllFocus,
  readFocusState,
  registerFocusReplayer,
  setSessionFocus,
} from "../../infra/focus-mode.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { handleGatewayRequest } from "../server-methods.js";
import { focusHandlers } from "./focus.js";
import type { GatewayRequestContext } from "./types.js";

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  loadConfig: () => ({}),
}));

afterEach(() => {
  clearAllFocus();
  registerFocusReplayer(undefined);
});

const context = {
  logGateway: { info: vi.fn(), warn: vi.fn() },
} as unknown as GatewayRequestContext;

async function call(params: Record<string, unknown>, scopes?: string[]) {
  const respond = vi.fn();
  await handleGatewayRequest({
    req: { type: "req", id: "1", method: "focus", params },
    respond,
    client: scopes
      ? ({
          connect: { role: "operator", scopes, client: { id: "cli" } },
        } as never)
      : null,
    isWebchatConnect: () => false,
    context,
  });
  return respond;
}

describe("gateway focus method (focus-mode ARCH §4, §7.4)", () => {
  it("is an operator-admin method", () => {
    expect(authorizeOperatorScopesForMethod("focus", ["operator.write"]).allowed).toBe(false);
    expect(authorizeOperatorScopesForMethod("focus", ["operator.read"]).allowed).toBe(false);
    expect(authorizeOperatorScopesForMethod("focus", ["operator.admin"]).allowed).toBe(true);
    expect(focusHandlers.focus).toBeTypeOf("function");
  });

  it("a client without operator.admin is refused and nothing changes", async () => {
    const respond = await call({ action: "set", target: "agent:main:main" }, ["operator.write"]);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "missing scope: operator.admin" }),
    );
    expect(readFocusState()).toBeUndefined();
  });

  it("status, set with a tier, off <key> and off (all) return the focus report", async () => {
    const admin = ["operator.admin"];
    const set = await call({ action: "set", target: "main", tier: "hyper" }, admin);
    expect(set).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        action: "set",
        sessionKey: "agent:main:main",
        tier: "hyper",
        previousTier: "none",
        replaying: 0,
        status: expect.objectContaining({
          active: "hyper",
          sessions: [
            expect.objectContaining({
              sessionKey: "agent:main:main",
              by: "cli",
            }),
          ],
        }),
      }),
      undefined,
    );
    await call({ action: "set", target: "agent:main:signal:group:g" }, admin);
    const status = await call({ action: "status" }, admin);
    expect(status.mock.calls[0]?.[1]).toMatchObject({
      action: "status",
      status: {
        active: "hyper",
        sessions: [{ tier: "hyper" }, { tier: "normal" }],
      },
    });
    const offOne = await call({ action: "off", target: "main" }, admin);
    expect(offOne.mock.calls[0]?.[1]).toMatchObject({
      action: "off",
      sessionKey: "agent:main:main",
      tier: "none",
      previousTier: "hyper",
      status: { active: "normal" },
    });
    const replayer = vi.fn(() => ({ sessions: 2, done: Promise.resolve() }));
    registerFocusReplayer(replayer);
    const off = await call({ action: "off" }, admin);
    expect(off.mock.calls[0]?.[1]).toMatchObject({
      action: "off",
      sessionKey: null,
      ended: { "agent:main:signal:group:g": { tier: "normal" } },
      replaying: 2,
      status: { active: "none", sessions: [] },
    });
    expect(replayer).toHaveBeenCalledTimes(1);
    expect(readFocusState()).toBeUndefined();
  });

  it("off clears the state before the replay starts (§5.1)", async () => {
    setSessionFocus({ sessionKey: "agent:main:main", by: "op" });
    let seenDuringReplay: unknown = "unset";
    registerFocusReplayer(() => {
      seenDuringReplay = readFocusState();
      return { sessions: 0, done: Promise.resolve() };
    });
    await call({ action: "off", all: true }, ["operator.admin"]);
    expect(seenDuringReplay).toBeUndefined();
  });

  it("rejects a bad action, a missing target, a bad tier, target+all and a cron run target", async () => {
    const admin = ["operator.admin"];
    for (const params of [
      { action: "nope" },
      { action: "set" },
      { action: "set", target: "main", tier: "ultra" },
      { action: "set", target: "main", tier: "none" },
      { action: "off", target: "main", all: true },
      { action: "set", target: "agent:main:cron:j:run:r" },
    ]) {
      const respond = await call(params, admin);
      expect(respond.mock.calls[0]?.[0]).toBe(false);
    }
    expect(readFocusState()).toBeUndefined();
  });
});
