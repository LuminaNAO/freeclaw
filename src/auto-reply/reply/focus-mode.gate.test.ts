// Focus mode gate at inbound dispatch (focus-mode ARCH §3, §6, §7.2, §7.6).
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  clearAllFocus,
  clearSessionFocus,
  FOCUS_BUSY_NOTICE,
  type FocusTier,
  readFocusState,
  sessionFocusTier,
  setSessionFocus,
  takeHeldFocusFiles,
} from "../../infra/focus-mode.js";
import { deleteStackFiles, listStack } from "../../infra/session-stack.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { dispatchReplyFromConfig } from "./dispatch-from-config.js";
import { resetInboundDedupe } from "./inbound-dedupe.js";
import type { ReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

vi.mock("./abort.js", () => ({
  tryFastAbortFromMessage: async () => ({ handled: false, aborted: false }),
  formatAbortReplyText: () => "aborted",
}));

function createDispatcher() {
  const finals: ReplyPayload[] = [];
  const dispatcher: ReplyDispatcher = {
    sendToolResult: vi.fn(() => true),
    sendBlockReply: vi.fn(() => true),
    sendFinalReply: vi.fn((payload: ReplyPayload) => {
      finals.push(payload);
      return true;
    }),
    waitForIdle: vi.fn(async () => {}),
    getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
    markComplete: vi.fn(),
  };
  return { dispatcher, finals };
}

const cfg = {} as OpenClawConfig;
const TARGET = "agent:main:main";
const OTHER = "agent:main:whatsapp:direct:+1000";

function filesFor(sessionKey: string): string[] {
  return listStack()
    .filter((s) => s.sessionKey === sessionKey)
    .flatMap((s) => s.entries.map((e) => e.file));
}

function focusOn(sessionKey: string, tier: FocusTier = "normal") {
  setSessionFocus({ sessionKey, tier, by: "op" });
}

afterEach(() => {
  resetInboundDedupe();
  clearAllFocus();
  takeHeldFocusFiles();
  deleteStackFiles(listStack().flatMap((s) => s.entries.map((e) => e.file)));
});

async function send(params: {
  sessionKey: string;
  body: string;
  sid: string;
  owner?: boolean;
  /** Authorized for commands but not an owner. */
  authorizedOnly?: boolean;
  resolver?: (ctx: unknown, opts?: GetReplyOptions) => Promise<ReplyPayload | undefined>;
}) {
  const ctx = buildTestCtx({
    SessionKey: params.sessionKey,
    Body: params.body,
    CommandBody: params.body,
    RawBody: params.body,
    MessageSid: params.sid,
    SenderId: params.owner ? "+2000" : "+1000",
    From: params.owner ? "whatsapp:+2000" : "whatsapp:+1000",
    To: "whatsapp:+2000",
    CommandAuthorized: params.owner === true || params.authorizedOnly === true,
  });
  const { dispatcher, finals } = createDispatcher();
  const replyResolver = vi.fn(params.resolver ?? (async () => ({ text: "ran" })));
  const result = await dispatchReplyFromConfig({
    ctx,
    cfg:
      params.owner || params.authorizedOnly
        ? ({ commands: { ownerAllowFrom: ["+2000"] } } as OpenClawConfig)
        : cfg,
    dispatcher,
    replyResolver: replyResolver as never,
  });
  return { result, finals, replyResolver };
}

describe("focus mode gate (focus-mode ARCH §3)", () => {
  it("§6: target session runs while focused", async () => {
    focusOn(TARGET);
    const { replyResolver, finals } = await send({ sessionKey: TARGET, body: "hi", sid: "t1" });
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(finals).toEqual([{ text: "ran" }]);
    expect(filesFor(TARGET)).toEqual([]);
  });

  it("§6: another session's message is stored, not run, and gets one busy notice", async () => {
    focusOn(TARGET);
    const first = await send({ sessionKey: OTHER, body: "one", sid: "o1" });
    expect(first.replyResolver).not.toHaveBeenCalled();
    expect(first.result.queuedFinal).toBe(false);
    expect(first.finals).toEqual([{ text: FOCUS_BUSY_NOTICE }]);
    const stored = filesFor(OTHER);
    expect(stored).toHaveLength(1);
    expect(fs.existsSync(stored[0])).toBe(true);

    // A second message to it gets no second notice.
    const second = await send({ sessionKey: OTHER, body: "two", sid: "o2" });
    expect(second.replyResolver).not.toHaveBeenCalled();
    expect(second.finals).toEqual([]);
    expect(filesFor(OTHER)).toHaveLength(2);
    expect(readFocusState()?.notified).toEqual([OTHER]);
    expect([...(takeHeldFocusFiles().get(OTHER) ?? [])]).toEqual(filesFor(OTHER));
  });

  it("§3.1: no focus → behaviour unchanged (runs, file deleted at turn end)", async () => {
    const { replyResolver, finals } = await send({ sessionKey: OTHER, body: "hi", sid: "n1" });
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(finals).toEqual([{ text: "ran" }]);
    expect(filesFor(OTHER)).toEqual([]);
  });

  it("§3.4, §7.2: an operator's /focusmode alias is handled in a waiting session", async () => {
    focusOn(TARGET);
    const { replyResolver, finals } = await send({
      sessionKey: OTHER,
      body: "/focusmode",
      sid: "f1",
      owner: true,
    });
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(finals).toEqual([{ text: "ran" }]);
    expect(filesFor(OTHER)).toEqual([]);
  });

  it("§4: a non-operator's /focusmode is refused in a waiting session (no turn, no notice, not kept)", async () => {
    focusOn(TARGET);
    const { replyResolver, finals } = await send({
      sessionKey: OTHER,
      body: "/focusmode off",
      sid: "f2",
    });
    expect(replyResolver).not.toHaveBeenCalled();
    expect(finals).toEqual([]);
    expect(filesFor(OTHER)).toEqual([]);
    expect(sessionFocusTier(readFocusState(), TARGET)).toBe("normal");
  });

  it("§4: an authorized sender who is not an owner is refused too", async () => {
    focusOn(TARGET);
    const { replyResolver, finals } = await send({
      sessionKey: OTHER,
      body: "/focusmode off",
      sid: "f3",
      authorizedOnly: true,
    });
    expect(replyResolver).not.toHaveBeenCalled();
    expect(finals).toEqual([]);
    expect(sessionFocusTier(readFocusState(), TARGET)).toBe("normal");
  });
  it("§7.2: an operator's /focus is handled in a waiting session, even under hyper", async () => {
    focusOn(TARGET, "hyper");
    const { replyResolver, finals } = await send({
      sessionKey: OTHER,
      body: "/focus off",
      sid: "f4",
      owner: true,
    });
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(finals).toEqual([{ text: "ran" }]);
    expect(filesFor(OTHER)).toEqual([]);
  });

  it("§7.2: a non-operator's /focus is refused in a waiting session; focus stays", async () => {
    focusOn(TARGET);
    for (const [sid, authorizedOnly] of [
      ["f5", false],
      ["f6", true],
    ] as const) {
      const { replyResolver, finals } = await send({
        sessionKey: OTHER,
        body: "/focus off",
        sid,
        authorizedOnly,
      });
      expect(replyResolver).not.toHaveBeenCalled();
      expect(finals).toEqual([]);
    }
    expect(filesFor(OTHER)).toEqual([]);
    expect(sessionFocusTier(readFocusState(), TARGET)).toBe("normal");
  });
});

describe("focus tiers at the gate (focus-mode ARCH §7.2, §7.6)", () => {
  const N1 = "agent:main:signal:group:n1";
  const N2 = "agent:main:signal:group:n2";
  const THIRD = "agent:main:whatsapp:direct:+3000";
  const HYPER = "agent:main:telegram:direct:4";

  it("two normal sessions run, a third waits with one notice; a hyper fourth runs alone", async () => {
    focusOn(N1);
    focusOn(N2);
    for (const [key, sid] of [
      [N1, "a1"],
      [N2, "a2"],
    ] as const) {
      const { replyResolver, finals } = await send({ sessionKey: key, body: "hi", sid });
      expect(replyResolver).toHaveBeenCalledTimes(1);
      expect(finals).toEqual([{ text: "ran" }]);
    }
    const third1 = await send({ sessionKey: THIRD, body: "one", sid: "a3" });
    expect(third1.replyResolver).not.toHaveBeenCalled();
    expect(third1.finals).toEqual([{ text: FOCUS_BUSY_NOTICE }]);
    const third2 = await send({ sessionKey: THIRD, body: "two", sid: "a4" });
    expect(third2.finals).toEqual([]);
    expect(filesFor(THIRD)).toHaveLength(2);

    // Add hyper on a fourth: only the fourth runs; the two normal ones now wait too.
    focusOn(HYPER, "hyper");
    const hyper = await send({ sessionKey: HYPER, body: "go", sid: "a5" });
    expect(hyper.replyResolver).toHaveBeenCalledTimes(1);
    for (const [key, sid] of [
      [N1, "a6"],
      [N2, "a7"],
    ] as const) {
      const { replyResolver, finals } = await send({ sessionKey: key, body: "wait", sid });
      expect(replyResolver).not.toHaveBeenCalled();
      expect(finals).toEqual([{ text: FOCUS_BUSY_NOTICE }]);
      expect(filesFor(key)).toHaveLength(1);
    }
    const third3 = await send({ sessionKey: THIRD, body: "three", sid: "a8" });
    expect(third3.finals).toEqual([]); // still the same waiting period for the third

    // Remove hyper: the normal ones run again; the third still waits.
    clearSessionFocus(HYPER);
    const n1 = await send({ sessionKey: N1, body: "back", sid: "a9" });
    expect(n1.replyResolver).toHaveBeenCalledTimes(1);
    const third4 = await send({ sessionKey: THIRD, body: "four", sid: "a10" });
    expect(third4.replyResolver).not.toHaveBeenCalled();

    // All off: everything runs.
    clearAllFocus();
    const third5 = await send({ sessionKey: THIRD, body: "five", sid: "a11" });
    expect(third5.replyResolver).toHaveBeenCalledTimes(1);
  });

  it("a held normal session gets a fresh notice in a later waiting period", async () => {
    focusOn(N1);
    focusOn(HYPER, "hyper");
    expect((await send({ sessionKey: N1, body: "x", sid: "b1" })).finals).toEqual([
      { text: FOCUS_BUSY_NOTICE },
    ]);
    clearSessionFocus(HYPER);
    focusOn(HYPER, "hyper");
    expect((await send({ sessionKey: N1, body: "y", sid: "b2" })).finals).toEqual([
      { text: FOCUS_BUSY_NOTICE },
    ]);
  });
});
