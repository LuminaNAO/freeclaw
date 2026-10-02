import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.js";
import { createSignalTrustGate, type SignalTrustGate } from "../trust/gate.js";
import { updateSignalTrustStore } from "../trust/store.js";
import {
  createBaseSignalEventHandlerDeps,
  createSignalReceiveEvent,
} from "./event-handler.test-harness.js";
import type { SignalEventHandlerDeps } from "./event-handler.types.js";

const mocks = vi.hoisted(() => ({
  dispatchInboundMessage: vi.fn(async () => ({
    queuedFinal: false,
    counts: { tool: 0, block: 0, final: 0 },
  })),
  recordInboundSession: vi.fn(async () => {}),
  enqueueSystemEvent: vi.fn(),
  recordPendingHistoryEntryIfEnabled: vi.fn(() => []),
  resolveSignalAccessState: vi.fn(),
  handleSignalDirectMessageAccess: vi.fn(),
  sendMessageSignal: vi.fn(async () => ({})),
  sendReadReceiptSignal: vi.fn(async () => true),
  sendTypingSignal: vi.fn(async () => true),
  upsertChannelPairingRequest: vi.fn(async () => ({ code: "PAIRCODE", created: true })),
  readChannelAllowFromStore: vi.fn(async () => [] as string[]),
}));

vi.mock("../../auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auto-reply/dispatch.js")>();
  return { ...actual, dispatchInboundMessage: mocks.dispatchInboundMessage };
});
vi.mock("../../channels/session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../channels/session.js")>();
  return { ...actual, recordInboundSession: mocks.recordInboundSession };
});
vi.mock("../../infra/system-events.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/system-events.js")>();
  return { ...actual, enqueueSystemEvent: mocks.enqueueSystemEvent };
});
vi.mock("../../auto-reply/reply/history.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auto-reply/reply/history.js")>();
  return {
    ...actual,
    recordPendingHistoryEntryIfEnabled: mocks.recordPendingHistoryEntryIfEnabled,
  };
});
vi.mock("./access-policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./access-policy.js")>();
  mocks.resolveSignalAccessState.mockImplementation(actual.resolveSignalAccessState);
  mocks.handleSignalDirectMessageAccess.mockImplementation(actual.handleSignalDirectMessageAccess);
  return {
    ...actual,
    resolveSignalAccessState: mocks.resolveSignalAccessState,
    handleSignalDirectMessageAccess: mocks.handleSignalDirectMessageAccess,
  };
});
vi.mock("../send.js", () => ({
  sendMessageSignal: mocks.sendMessageSignal,
  sendReadReceiptSignal: mocks.sendReadReceiptSignal,
  sendTypingSignal: mocks.sendTypingSignal,
}));
vi.mock("../../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: mocks.readChannelAllowFromStore,
  upsertChannelPairingRequest: mocks.upsertChannelPairingRequest,
}));

import { createSignalEventHandler } from "./event-handler.js";

const TRUSTED_NUM = "+15550000001";
const TRUSTED_UUID = "00000000-0000-4000-8000-00000000000a";
const UNTRUSTED_NUM = "+15550000009";
const OTHER_UUID = "00000000-0000-4000-8000-00000000000f";
const GROUP_ID = "Z3JvdXAtc3ludGhldGljLTE=";

let stateDir = "";
let env: NodeJS.ProcessEnv;
let warnings: string[] = [];
const fetchAttachment = vi.fn(async () => ({ path: "/tmp/x", contentType: "image/png" }));

function makeRuntime() {
  return {
    log: (...args: unknown[]) => warnings.push(args.map(String).join(" ")),
    error: (...args: unknown[]) => warnings.push(args.map(String).join(" ")),
    exit: () => {
      throw new Error("exit");
    },
  };
}

function attemptsPath() {
  return path.join(stateDir, "security", "signal-trust-attempts.jsonl");
}

function readAttempts(): Array<Record<string, unknown>> {
  try {
    return fs
      .readFileSync(attemptsPath(), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

async function trust(entries: Array<{ number?: string; uuid?: string }>) {
  await updateSignalTrustStore({
    accountId: "default",
    env,
    mutate: (s) => ({ ...s, trusted: entries }),
  });
}

function enforcingGate(): SignalTrustGate {
  return createSignalTrustGate({ accountId: "default", runtime: makeRuntime(), env });
}

const baseCfg = {
  messages: { inbound: { debounceMs: 0 }, groupChat: { mentionPatterns: ["@bot"] } },
} as unknown as OpenClawConfig;

function makeHandler(overrides: Partial<SignalEventHandlerDeps> = {}) {
  return createSignalEventHandler(
    createBaseSignalEventHandlerDeps({
      cfg: baseCfg,
      trustGate: enforcingGate(),
      // Widest possible legacy policy: the gate must still deny (AND composition).
      dmPolicy: "open",
      allowFrom: ["*"],
      groupPolicy: "open",
      groupAllowFrom: ["*"],
      ignoreAttachments: false,
      sendReadReceipts: true,
      readReceiptsViaDaemon: false,
      fetchAttachment,
      reactionMode: "all",
      isSignalReactionMessage: (r): r is NonNullable<typeof r> => Boolean(r?.emoji),
      shouldEmitSignalReactionNotification: () => true,
      ...overrides,
    }),
  );
}

function expectZeroSinkCalls() {
  expect(mocks.resolveSignalAccessState).not.toHaveBeenCalled();
  expect(mocks.handleSignalDirectMessageAccess).not.toHaveBeenCalled();
  expect(mocks.sendMessageSignal).not.toHaveBeenCalled();
  expect(mocks.upsertChannelPairingRequest).not.toHaveBeenCalled();
  expect(mocks.sendReadReceiptSignal).not.toHaveBeenCalled();
  expect(mocks.sendTypingSignal).not.toHaveBeenCalled();
  expect(fetchAttachment).not.toHaveBeenCalled();
  expect(mocks.recordPendingHistoryEntryIfEnabled).not.toHaveBeenCalled();
  expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
  expect(mocks.recordInboundSession).not.toHaveBeenCalled();
  expect(mocks.dispatchInboundMessage).not.toHaveBeenCalled();
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-trust-handler-"));
  env = {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_OAUTH_DIR: "",
    OPENCLAW_SIGNAL_TRUST_GATE: "enforce",
  };
  warnings = [];
  for (const mock of Object.values(mocks)) {
    mock.mockClear();
  }
  fetchAttachment.mockClear();
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const dataMessage = (extra: Record<string, unknown> = {}) => ({
  message: "hello @bot",
  attachments: [{ id: "att-1", contentType: "image/png", size: 10 }],
  ...extra,
});

const denialCases: Array<[string, Record<string, unknown>]> = [
  ["DM", { sourceNumber: UNTRUSTED_NUM, dataMessage: dataMessage() }],
  [
    "group message",
    {
      sourceNumber: UNTRUSTED_NUM,
      dataMessage: dataMessage({ groupInfo: { groupId: GROUP_ID, groupName: "Synthetic" } }),
    },
  ],
  [
    "group mention-skip (would enter pending history)",
    {
      sourceNumber: UNTRUSTED_NUM,
      dataMessage: dataMessage({
        message: "no mention here",
        groupInfo: { groupId: GROUP_ID, groupName: "Synthetic" },
      }),
    },
  ],
  [
    "reaction",
    {
      sourceNumber: UNTRUSTED_NUM,
      reactionMessage: {
        emoji: "👍",
        targetAuthor: TRUSTED_NUM,
        targetSentTimestamp: 1700000000000,
      },
    },
  ],
  [
    "edit",
    {
      sourceNumber: UNTRUSTED_NUM,
      editMessage: { dataMessage: dataMessage({ message: "edited" }) },
    },
  ],
  [
    "attachment-only DM",
    { sourceNumber: UNTRUSTED_NUM, dataMessage: dataMessage({ message: "" }) },
  ],
];

describe("signal trust gate choke point (ARCH §5.3)", () => {
  it.each(denialCases)(
    "untrusted %s reaches no sink and is flagged once",
    async (_label, envelope) => {
      await trust([{ number: TRUSTED_NUM }]);
      const handler = makeHandler({
        cfg: {
          ...baseCfg,
          channels: { signal: { groups: { "*": { requireMention: true } } } },
        } as unknown as OpenClawConfig,
      });
      await handler(createSignalReceiveEvent(envelope));

      expectZeroSinkCalls();
      const attempts = readAttempts();
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ number: UNTRUSTED_NUM, reason: "not_trusted", count: 1 });
      expect(warnings.filter((w) => w.includes("signal trust gate: denied"))).toHaveLength(1);
    },
  );

  it("denied attempts never log bodies, sourceName, or group names", async () => {
    await trust([{ number: TRUSTED_NUM }]);
    await makeHandler()(
      createSignalReceiveEvent({
        sourceNumber: UNTRUSTED_NUM,
        sourceName: "SyntheticDisplayName",
        dataMessage: dataMessage({
          message: "secret-body-text",
          groupInfo: { groupId: GROUP_ID, groupName: "SyntheticGroupName" },
        }),
      }),
    );
    const everything = `${warnings.join("\n")}\n${fs.readFileSync(attemptsPath(), "utf8")}`;
    for (const leaked of [
      "secret-body-text",
      "SyntheticDisplayName",
      "SyntheticGroupName",
      GROUP_ID,
    ]) {
      expect(everything).not.toContain(leaked);
    }
    expect(readAttempts()[0]?.group).toMatch(/^sha256:[0-9a-f]{8}$/);
  });
});

describe("AND composition with legacy policy (ARCH §5.4)", () => {
  it.each([
    ["dmPolicy=open + allowFrom=*", {}],
    ["sender listed in allowFrom", { allowFrom: [UNTRUSTED_NUM] }],
    ["sender listed in groupAllowFrom", { groupAllowFrom: [UNTRUSTED_NUM] }],
  ])("%s is still denied when not trusted", async (_label, overrides) => {
    await trust([{ number: TRUSTED_NUM }]);
    await makeHandler(overrides)(
      createSignalReceiveEvent({ sourceNumber: UNTRUSTED_NUM, dataMessage: dataMessage() }),
    );
    expectZeroSinkCalls();
  });

  it("a sender approved in the pairing store is still denied when not trusted", async () => {
    await trust([{ number: TRUSTED_NUM }]);
    mocks.readChannelAllowFromStore.mockResolvedValueOnce([UNTRUSTED_NUM]);
    await makeHandler({ dmPolicy: "pairing", allowFrom: [] })(
      createSignalReceiveEvent({ sourceNumber: UNTRUSTED_NUM, dataMessage: dataMessage() }),
    );
    expectZeroSinkCalls();
  });

  it("a trusted sender under dmPolicy=pairing who is not in allowFrom still gets today's pairing flow", async () => {
    await trust([{ number: TRUSTED_NUM }]);
    await makeHandler({ dmPolicy: "pairing", allowFrom: [] })(
      createSignalReceiveEvent({ sourceNumber: TRUSTED_NUM, dataMessage: dataMessage() }),
    );
    expect(mocks.resolveSignalAccessState).toHaveBeenCalledTimes(1);
    expect(mocks.upsertChannelPairingRequest).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessageSignal).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchInboundMessage).not.toHaveBeenCalled();
    expect(readAttempts()).toEqual([]);
  });
});

describe("spoof vectors (ARCH §5.5)", () => {
  // These prove misleading envelope content is rejected. They cannot prove resistance to a
  // hostile signal-cli daemon, which is outside the gate's trust boundary (ARCH §4.3).
  it.each<[string, Record<string, unknown>]>([
    ["sourceName equal to a trusted contact name", { sourceName: "Trusted Contact" }],
    [
      "quote author/text naming a trusted id",
      { dataMessage: dataMessage({ quote: { text: TRUSTED_NUM, author: TRUSTED_NUM } }) },
    ],
    [
      "mention of a trusted uuid",
      {
        dataMessage: dataMessage({
          message: "￼ hi",
          mentions: [{ uuid: TRUSTED_UUID, number: TRUSTED_NUM, start: 0, length: 1 }],
        }),
      },
    ],
    [
      "message text claiming a trusted number",
      { dataMessage: dataMessage({ message: `I am ${TRUSTED_NUM}` }) },
    ],
    [
      "reaction targetAuthor equal to a trusted id",
      {
        reactionMessage: {
          emoji: "👍",
          targetAuthor: TRUSTED_NUM,
          targetAuthorUuid: TRUSTED_UUID,
          targetSentTimestamp: 1,
        },
      },
    ],
  ])("%s is denied", async (_label, extra) => {
    await trust([{ number: TRUSTED_NUM, uuid: TRUSTED_UUID }]);
    await makeHandler()(
      createSignalReceiveEvent({
        sourceNumber: UNTRUSTED_NUM,
        sourceName: "Trusted Contact",
        dataMessage: dataMessage(),
        ...extra,
      }),
    );
    expectZeroSinkCalls();
  });

  it("number matches a bound entry but uuid conflicts => identity_conflict", async () => {
    await trust([{ number: TRUSTED_NUM, uuid: TRUSTED_UUID }]);
    await makeHandler()(
      createSignalReceiveEvent({
        sourceNumber: TRUSTED_NUM,
        sourceUuid: OTHER_UUID,
        dataMessage: dataMessage(),
      }),
    );
    expectZeroSinkCalls();
    expect(readAttempts()[0]).toMatchObject({ reason: "identity_conflict" });
  });

  it.each(["+1 (555) 000-0001", "15550000001", "+", "+1555\u001b[2Jcleared"])(
    "formatted/garbage number %j is malformed, never coerced to the trusted number",
    async (raw) => {
      await trust([{ number: TRUSTED_NUM }]);
      await makeHandler()(
        createSignalReceiveEvent({ sourceNumber: raw, dataMessage: dataMessage() }),
      );
      expectZeroSinkCalls();
      const [attempt] = readAttempts();
      expect(attempt).toMatchObject({ reason: "malformed_identity" });
      expect(String(attempt?.number)).toMatch(/^malformed\(len=\d+,sha256=[0-9a-f]{8}\)$/);
      expect(warnings.join("\n")).not.toContain("\u001b");
    },
  );

  it("garbage number is not rescued by a valid trusted uuid", async () => {
    await trust([{ uuid: TRUSTED_UUID }]);
    await makeHandler()(
      createSignalReceiveEvent({
        sourceNumber: "not-a-number",
        sourceUuid: TRUSTED_UUID,
        dataMessage: dataMessage(),
      }),
    );
    expectZeroSinkCalls();
  });

  it("uuid case variants of a trusted uuid are accepted; compact form is not", async () => {
    await trust([{ uuid: TRUSTED_UUID }]);
    const handler = makeHandler();
    await handler(
      createSignalReceiveEvent({
        sourceNumber: null,
        sourceUuid: TRUSTED_UUID.toUpperCase(),
        dataMessage: dataMessage({ attachments: [] }),
      }),
    );
    expect(mocks.dispatchInboundMessage).toHaveBeenCalledTimes(1);

    mocks.dispatchInboundMessage.mockClear();
    await handler(
      createSignalReceiveEvent({
        sourceNumber: null,
        sourceUuid: TRUSTED_UUID.replace(/-/g, ""),
        dataMessage: dataMessage({ attachments: [] }),
      }),
    );
    expect(mocks.dispatchInboundMessage).not.toHaveBeenCalled();
  });
});

describe("fail-closed store at the handler (ARCH §5.2)", () => {
  it.each([
    ["missing store", () => {}],
    [
      "corrupt store",
      () => {
        const p = path.join(stateDir, "credentials", "signal-trust-default.json");
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, "{corrupt", { mode: 0o600 });
      },
    ],
  ])(
    "%s denies even a would-be-trusted sender and logs one error per state",
    async (_label, setup) => {
      setup();
      const handler = makeHandler();
      for (let i = 0; i < 3; i += 1) {
        await handler(
          createSignalReceiveEvent({ sourceNumber: TRUSTED_NUM, dataMessage: dataMessage() }),
        );
      }
      expectZeroSinkCalls();
      expect(warnings.filter((w) => w.includes("DENYING ALL"))).toHaveLength(1);
    },
  );
});

describe("defense in depth (ARCH §5.6)", () => {
  it("revocation while a message sits in the debouncer drops the flush with recheck_denied", async () => {
    await trust([{ number: TRUSTED_NUM }]);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const handler = makeHandler({
        cfg: { messages: { inbound: { debounceMs: 50 } } } as unknown as OpenClawConfig,
      });
      await handler(
        createSignalReceiveEvent({
          sourceNumber: TRUSTED_NUM,
          dataMessage: dataMessage({ attachments: [] }),
        }),
      );
      expect(mocks.dispatchInboundMessage).not.toHaveBeenCalled();
      await trust([]);
      await vi.advanceTimersByTimeAsync(100);
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(() =>
      expect(readAttempts().some((a) => a.reason === "recheck_denied")).toBe(true),
    );
    expect(mocks.dispatchInboundMessage).not.toHaveBeenCalled();
    expect(mocks.recordInboundSession).not.toHaveBeenCalled();
  });

  it("a forged trusted-sender object is rejected at recheck", async () => {
    await trust([{ number: TRUSTED_NUM }]);
    const gate = enforcingGate();
    const forged = { number: TRUSTED_NUM } as unknown as Parameters<SignalTrustGate["recheck"]>[0];
    expect(await gate.recheck(forged, { kind: "dm" })).toBe(false);
  });
});

describe("positive path (ARCH §5.7)", () => {
  it.each<[string, Array<{ number?: string; uuid?: string }>, Record<string, unknown>]>([
    ["number entry", [{ number: TRUSTED_NUM }], { sourceNumber: TRUSTED_NUM }],
    ["uuid entry", [{ uuid: TRUSTED_UUID }], { sourceNumber: null, sourceUuid: TRUSTED_UUID }],
    [
      "bound pair",
      [{ number: TRUSTED_NUM, uuid: TRUSTED_UUID }],
      { sourceNumber: TRUSTED_NUM, sourceUuid: TRUSTED_UUID },
    ],
  ])("trusted sender via %s reaches dispatch with no flag", async (_label, entries, identity) => {
    await trust(entries);
    await makeHandler()(
      createSignalReceiveEvent({ ...identity, dataMessage: dataMessage({ attachments: [] }) }),
    );
    expect(mocks.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    expect(mocks.recordInboundSession).toHaveBeenCalledTimes(1);
    expect(readAttempts()).toEqual([]);
  });

  it("trusted reaction reaches the system-event sink", async () => {
    await trust([{ number: TRUSTED_NUM }]);
    await makeHandler()(
      createSignalReceiveEvent({
        sourceNumber: TRUSTED_NUM,
        reactionMessage: { emoji: "👍", targetAuthor: TRUSTED_NUM, targetSentTimestamp: 1 },
      }),
    );
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(1);
  });

  it("an untrusted sender in a group with a trusted member is dropped per sender", async () => {
    await trust([{ number: TRUSTED_NUM }]);
    const handler = makeHandler();
    const group = { groupInfo: { groupId: GROUP_ID, groupName: "Synthetic" }, attachments: [] };
    await handler(
      createSignalReceiveEvent({ sourceNumber: TRUSTED_NUM, dataMessage: dataMessage(group) }),
    );
    await handler(
      createSignalReceiveEvent({ sourceNumber: UNTRUSTED_NUM, dataMessage: dataMessage(group) }),
    );
    expect(mocks.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    expect(readAttempts()).toHaveLength(1);
  });
});
