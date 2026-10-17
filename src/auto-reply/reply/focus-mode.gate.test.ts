// Focus mode gate at inbound dispatch (focus-mode ARCH §3, §6).
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  clearFocusState,
  FOCUS_BUSY_NOTICE,
  readFocusState,
  setFocusState,
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

afterEach(() => {
  resetInboundDedupe();
  clearFocusState();
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
    setFocusState({ target: TARGET, by: "op" });
    const { replyResolver, finals } = await send({ sessionKey: TARGET, body: "hi", sid: "t1" });
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(finals).toEqual([{ text: "ran" }]);
    expect(filesFor(TARGET)).toEqual([]);
  });

  it("§6: another session's message is stored, not run, and gets one busy notice", async () => {
    setFocusState({ target: TARGET, by: "op" });
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

  it("§3.4: an operator's /focusmode is handled in a non-target session while focused", async () => {
    setFocusState({ target: TARGET, by: "op" });
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

  it("§4: a non-operator's /focusmode is refused while focused away (no turn, no notice, not kept)", async () => {
    setFocusState({ target: TARGET, by: "op" });
    const { replyResolver, finals } = await send({
      sessionKey: OTHER,
      body: "/focusmode off",
      sid: "f2",
    });
    expect(replyResolver).not.toHaveBeenCalled();
    expect(finals).toEqual([]);
    expect(filesFor(OTHER)).toEqual([]);
    expect(readFocusState()?.target).toBe(TARGET);
  });

  it("§4: an authorized sender who is not an owner is refused too", async () => {
    setFocusState({ target: TARGET, by: "op" });
    const { replyResolver, finals } = await send({
      sessionKey: OTHER,
      body: "/focusmode off",
      sid: "f3",
      authorizedOnly: true,
    });
    expect(replyResolver).not.toHaveBeenCalled();
    expect(finals).toEqual([]);
    expect(readFocusState()?.target).toBe(TARGET);
  });
});
