// Gateway method `focus` (focus-mode ARCH §4): operator authority only.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearFocusState,
  readFocusState,
  registerFocusReplayer,
  setFocusState,
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
  clearFocusState();
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

describe("gateway focus method (focus-mode ARCH §4)", () => {
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

  it("set, status and off", async () => {
    const admin = ["operator.admin"];
    const set = await call({ action: "set", target: "main" }, admin);
    expect(set).toHaveBeenCalledWith(
      true,
      { focus: expect.objectContaining({ target: "agent:main:main", by: "cli" }) },
      undefined,
    );
    const status = await call({ action: "status" }, admin);
    expect(status).toHaveBeenCalledWith(
      true,
      { focus: expect.objectContaining({ target: "agent:main:main" }), waiting: [] },
      undefined,
    );
    const replayer = vi.fn(() => ({ sessions: 2, done: Promise.resolve() }));
    registerFocusReplayer(replayer);
    const off = await call({ action: "off" }, admin);
    expect(off).toHaveBeenCalledWith(
      true,
      { ended: expect.objectContaining({ target: "agent:main:main" }), replaying: 2 },
      undefined,
    );
    expect(replayer).toHaveBeenCalledTimes(1);
    expect(readFocusState()).toBeUndefined();
  });

  it("off clears the state before the replay starts (§5.1)", async () => {
    setFocusState({ target: "agent:main:main", by: "op" });
    let seenDuringReplay: unknown = "unset";
    registerFocusReplayer(() => {
      seenDuringReplay = readFocusState();
      return { sessions: 0, done: Promise.resolve() };
    });
    await call({ action: "off" }, ["operator.admin"]);
    expect(seenDuringReplay).toBeUndefined();
  });

  it("rejects a bad action, a missing target and a cron run target", async () => {
    const admin = ["operator.admin"];
    for (const params of [
      { action: "nope" },
      { action: "set" },
      { action: "set", target: "agent:main:cron:j:run:r" },
    ]) {
      const respond = await call(params, admin);
      expect(respond.mock.calls[0]?.[0]).toBe(false);
    }
    expect(readFocusState()).toBeUndefined();
  });
});
