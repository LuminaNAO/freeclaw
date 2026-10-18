/**
 * docs/design/agent-peers-and-quiet-sessions.md §2.2, §2.3 and §4 (marked agent, no mention -> no
 * turn, history recorded; with mention -> turn runs; unmarked -> unchanged; nothing marked ->
 * identical behaviour to base). Placeholder numbers and uuids only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/types.js";
import { createSignalAgentPeers } from "../trust/agent-peers.js";
import { createSignalEventHandler } from "./event-handler.js";
import {
  createBaseSignalEventHandlerDeps,
  createSignalReceiveEvent,
} from "./event-handler.test-harness.js";

const { dispatchMock, captured } = vi.hoisted(() => {
  const captured: MsgContext[] = [];
  return {
    captured,
    dispatchMock: vi.fn(async (params: { ctx: MsgContext }) => {
      captured.push(params.ctx);
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    }),
  };
});

vi.mock("../send.js", () => ({
  sendMessageSignal: vi.fn(),
  sendTypingSignal: vi.fn().mockResolvedValue(true),
  sendReadReceiptSignal: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auto-reply/dispatch.js")>();
  return {
    ...actual,
    dispatchInboundMessage: dispatchMock,
    dispatchInboundMessageWithDispatcher: dispatchMock,
    dispatchInboundMessageWithBufferedDispatcher: dispatchMock,
  };
});

const AGENT_UUID = "00000000-0000-4000-8000-0000000000a1";
const HUMAN_UUID = "00000000-0000-4000-8000-0000000000b2";
const OUR_UUID = "00000000-0000-4000-8000-0000000000c3";
const OUR_NUMBER = "+15550009999";

let dir: string;
let storePath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-agent-peers-"));
  storePath = path.join(dir, "signal-trust-default.json");
  captured.length = 0;
  dispatchMock.mockClear();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeStore(trusted: Array<Record<string, unknown>>) {
  fs.writeFileSync(storePath, JSON.stringify({ version: 1, accountId: "default", trusted }), {
    mode: 0o600,
  });
  fs.chmodSync(storePath, 0o600);
}

/** Group with requireMention off, so without the agent check every message runs a turn. */
function makeCfg(): OpenClawConfig {
  return {
    messages: {
      inbound: { debounceMs: 0 },
      groupChat: { mentionPatterns: ["@bot"] },
    },
    channels: { signal: { groups: { "*": { requireMention: false } } } },
  } as unknown as OpenClawConfig;
}

function makeHandler(opts: { withAgentPeers: boolean }) {
  const groupHistories = new Map();
  const handler = createSignalEventHandler(
    createBaseSignalEventHandlerDeps({
      cfg: makeCfg(),
      account: OUR_NUMBER,
      accountUuid: OUR_UUID,
      historyLimit: 5,
      groupHistories,
      ...(opts.withAgentPeers
        ? { agentPeers: createSignalAgentPeers({ accountId: "default", env: {}, storePath }) }
        : {}),
    }),
  );
  return { handler, groupHistories };
}

function groupEvent(params: {
  senderUuid: string;
  message: string;
  mentions?: Array<{ uuid?: string; number?: string; start: number; length: number }>;
  timestamp?: number;
}) {
  return createSignalReceiveEvent({
    sourceNumber: undefined,
    sourceUuid: params.senderUuid,
    sourceName: "Peer",
    timestamp: params.timestamp ?? 1700000000000,
    dataMessage: {
      message: params.message,
      attachments: [],
      mentions: params.mentions,
      groupInfo: { groupId: "g1", groupName: "Test Group" },
    },
  });
}

function dmEvent(senderUuid: string, message: string) {
  return createSignalReceiveEvent({
    sourceNumber: undefined,
    sourceUuid: senderUuid,
    sourceName: "Peer",
    dataMessage: { message, attachments: [] },
  });
}

describe("signal agent peers (ARCH §2.2)", () => {
  it("marked agent without a mention: no turn, message recorded in group history", async () => {
    writeStore([{ uuid: AGENT_UUID, agent: true }]);
    const { handler, groupHistories } = makeHandler({ withAgentPeers: true });
    await handler(groupEvent({ senderUuid: AGENT_UUID, message: "⚠️ Agent failed before reply" }));
    expect(dispatchMock).not.toHaveBeenCalled();
    const entries = groupHistories.get("g1");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ sender: "Peer", body: "⚠️ Agent failed before reply" });
  });

  it("marked agent mentioning our name (mention pattern): turn runs", async () => {
    writeStore([{ uuid: AGENT_UUID, agent: true }]);
    const { handler } = makeHandler({ withAgentPeers: true });
    await handler(groupEvent({ senderUuid: AGENT_UUID, message: "@bot can you check this?" }));
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(captured[0]?.WasMentioned).toBe(true);
  });

  it("marked agent with a Signal mention of our account uuid: turn runs", async () => {
    writeStore([{ uuid: AGENT_UUID, agent: true }]);
    const { handler } = makeHandler({ withAgentPeers: true });
    await handler(
      groupEvent({
        senderUuid: AGENT_UUID,
        message: "\uFFFC please look",
        mentions: [{ uuid: OUR_UUID.toUpperCase(), start: 0, length: 1 }],
      }),
    );
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(captured[0]?.WasMentioned).toBe(true);
  });

  it("marked agent with a Signal mention of our account number: turn runs", async () => {
    writeStore([{ uuid: AGENT_UUID, agent: true }]);
    const { handler } = makeHandler({ withAgentPeers: true });
    await handler(
      groupEvent({
        senderUuid: AGENT_UUID,
        message: "\uFFFC please look",
        mentions: [{ number: OUR_NUMBER, start: 0, length: 1 }],
      }),
    );
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("marked agent mentioning somebody else: no turn", async () => {
    writeStore([{ uuid: AGENT_UUID, agent: true }]);
    const { handler, groupHistories } = makeHandler({ withAgentPeers: true });
    await handler(
      groupEvent({
        senderUuid: AGENT_UUID,
        message: "\uFFFC over to you",
        mentions: [{ uuid: HUMAN_UUID, start: 0, length: 1 }],
      }),
    );
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(groupHistories.get("g1")).toHaveLength(1);
  });

  it("unmarked sender in the same group: unchanged, turn runs without a mention", async () => {
    writeStore([{ uuid: AGENT_UUID, agent: true }, { uuid: HUMAN_UUID }]);
    const { handler } = makeHandler({ withAgentPeers: true });
    await handler(groupEvent({ senderUuid: HUMAN_UUID, message: "hello everyone" }));
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(captured[0]?.WasMentioned).toBe(false);
  });

  it("DMs from a marked agent are unchanged", async () => {
    writeStore([{ uuid: AGENT_UUID, agent: true }]);
    const { handler } = makeHandler({ withAgentPeers: true });
    await handler(dmEvent(AGENT_UUID, "hello in private"));
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("unmarking takes effect on the next inbound event", async () => {
    writeStore([{ uuid: AGENT_UUID, agent: true }]);
    const { handler } = makeHandler({ withAgentPeers: true });
    await handler(groupEvent({ senderUuid: AGENT_UUID, message: "first" }));
    expect(dispatchMock).not.toHaveBeenCalled();
    // Rewrite via rename so the reader's lstat key changes, as the real writer does.
    const tmp = `${storePath}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({ version: 1, accountId: "default", trusted: [{ uuid: AGENT_UUID }] }),
      { mode: 0o600 },
    );
    fs.renameSync(tmp, storePath);
    await handler(
      groupEvent({ senderUuid: AGENT_UUID, message: "second", timestamp: 1700000000001 }),
    );
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });
});

describe("signal agent peers: nothing marked is a no-op (ARCH §2.3)", () => {
  const events = () => [
    groupEvent({ senderUuid: AGENT_UUID, message: "hello everyone", timestamp: 1700000000010 }),
    groupEvent({ senderUuid: AGENT_UUID, message: "@bot ping", timestamp: 1700000000011 }),
    groupEvent({
      senderUuid: HUMAN_UUID,
      message: "\uFFFC hi",
      mentions: [{ uuid: OUR_UUID, start: 0, length: 1 }],
      timestamp: 1700000000012,
    }),
    dmEvent(AGENT_UUID, "a direct message"),
  ];

  async function runAll(withAgentPeers: boolean) {
    captured.length = 0;
    dispatchMock.mockClear();
    const { handler, groupHistories } = makeHandler({ withAgentPeers });
    for (const event of events()) {
      await handler(event);
    }
    return {
      ctxs: JSON.stringify(captured),
      histories: JSON.stringify([...groupHistories.entries()]),
      calls: dispatchMock.mock.calls.length,
    };
  }

  it.each([
    ["no store file", () => {}],
    ["store with no marks", () => writeStore([{ uuid: AGENT_UUID }, { uuid: HUMAN_UUID }])],
    ["store marking an unrelated uuid", () => writeStore([{ uuid: OUR_UUID, agent: true }])],
    ["invalid store", () => fs.writeFileSync(storePath, "{not json", { mode: 0o600 })],
  ])("%s: dispatch contexts and history identical to base", async (_label, setup) => {
    const base = await runAll(false);
    setup();
    const withPeers = await runAll(true);
    expect(base.calls).toBe(4);
    expect(withPeers).toEqual(base);
  });
});
