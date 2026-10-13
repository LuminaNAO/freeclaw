/**
 * docs/design/signal-uuid-identity.md §5 through the inbound event handler:
 * uuid-first ids/labels, own-message detection (both forms), pairing line,
 * legacy phone allow-list entries, and the §4 DM session re-key.
 * Placeholder numbers (+1555…) and uuids only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../../auto-reply/templating.js";
import { clearSessionStoreCacheForTest, loadSessionStore } from "../../config/sessions/store.js";
import { resetSignalDmSessionRekeyNoticesForTests } from "../dm-session-rekey.js";
import { resetSignalLegacyAllowWarningsForTests } from "../identity.js";
import { createSignalEventHandler } from "./event-handler.js";
import {
  createBaseSignalEventHandlerDeps,
  createSignalReceiveEvent,
} from "./event-handler.test-harness.js";

const { sendMessageMock, upsertPairingMock, dispatchMock, capture, logWarnMock } = vi.hoisted(
  () => {
    const state: { ctx: MsgContext | undefined } = { ctx: undefined };
    return {
      sendMessageMock: vi.fn(),
      upsertPairingMock: vi.fn(),
      logWarnMock: vi.fn(),
      dispatchMock: vi.fn(async (params: { ctx: MsgContext }) => {
        state.ctx = params.ctx;
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      }),
      capture: state,
    };
  },
);

vi.mock("../send.js", () => ({
  sendMessageSignal: sendMessageMock,
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

vi.mock("../../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn().mockResolvedValue([]),
  upsertChannelPairingRequest: upsertPairingMock,
}));

vi.mock("../../logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logger.js")>();
  return { ...actual, logWarn: logWarnMock };
});

const UUID = "00000000-0000-4000-8000-00000000000a";
const NUMBER = "+15550001111";
const OWN_UUID = "00000000-0000-4000-8000-0000000000ff";
const OWN_NUMBER = "+15550009999";

let dir: string;
let storePath: string;

beforeEach(() => {
  capture.ctx = undefined;
  dispatchMock.mockClear();
  sendMessageMock.mockReset().mockResolvedValue({ messageId: "1" });
  upsertPairingMock.mockReset().mockResolvedValue({ code: "PAIRCODE", created: true });
  logWarnMock.mockReset();
  resetSignalLegacyAllowWarningsForTests();
  resetSignalDmSessionRekeyNoticesForTests();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-uuid-handler-"));
  storePath = path.join(dir, "sessions.json");
});

afterEach(() => {
  clearSessionStoreCacheForTest();
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeHandler(overrides: Parameters<typeof createBaseSignalEventHandlerDeps>[0] = {}) {
  return createSignalEventHandler(
    createBaseSignalEventHandlerDeps({
      // oxlint-disable-next-line typescript/no-explicit-any
      cfg: { messages: { inbound: { debounceMs: 0 } }, session: { store: storePath } } as any,
      account: OWN_NUMBER,
      accountUuid: OWN_UUID,
      historyLimit: 0,
      ...overrides,
    }),
  );
}

function dm(envelope: Record<string, unknown>, message = "hello") {
  return createSignalReceiveEvent({
    sourceName: "Ada",
    dataMessage: { message, attachments: [] },
    ...envelope,
  });
}

describe("signal uuid identity through the event handler", () => {
  it("uuid+number DM: ids, labels and the session key are uuid-first; the number is not agent-visible", async () => {
    await makeHandler()(dm({ sourceUuid: UUID, sourceNumber: NUMBER }));
    const ctx = capture.ctx!;
    expect(ctx).toBeTruthy();
    expect(ctx.SenderId).toBe(`uuid:${UUID}`);
    expect(ctx.From).toBe(`signal:${UUID}`);
    expect(ctx.To).toBe(UUID);
    expect(ctx.SessionKey).toBe(`agent:main:signal:direct:uuid:${UUID}`);
    expect(ctx.SenderE164).toBeUndefined();
    expect(ctx.SenderMatchE164).toBe(NUMBER);
    expect(String(ctx.Body)).not.toContain(NUMBER);
  });

  it("own-message detection matches the account uuid", async () => {
    await makeHandler()(dm({ sourceUuid: OWN_UUID, sourceNumber: null }));
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("own-message detection matches the account number (number-only and uuid+number envelopes)", async () => {
    const handler = makeHandler({ accountUuid: undefined });
    await handler(dm({ sourceNumber: OWN_NUMBER, sourceUuid: null }));
    await handler(dm({ sourceNumber: OWN_NUMBER, sourceUuid: OWN_UUID }));
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("own-message detection is case-insensitive on the uuid", async () => {
    await makeHandler({ accountUuid: OWN_UUID.toUpperCase() })(
      dm({ sourceUuid: OWN_UUID, sourceNumber: null }),
    );
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("pairing reply never contains the number for a uuid sender and pairs the uuid id", async () => {
    await makeHandler({ dmPolicy: "pairing", allowFrom: [] })(
      dm({ sourceUuid: UUID, sourceNumber: NUMBER }),
    );
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(upsertPairingMock).toHaveBeenCalledWith(expect.objectContaining({ id: `uuid:${UUID}` }));
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const [target, text] = sendMessageMock.mock.calls[0] as [string, string];
    expect(target).toBe(`signal:${UUID}`);
    expect(text).toContain(`Your Signal sender id: uuid:${UUID}`);
    expect(text).not.toContain(NUMBER);
  });

  it("a legacy phone allowFrom entry still admits the uuid sender and warns once", async () => {
    const handler = makeHandler({ dmPolicy: "allowlist", allowFrom: [NUMBER] });
    await handler(dm({ sourceUuid: UUID, sourceNumber: NUMBER, timestamp: 1 }));
    await handler(dm({ sourceUuid: UUID, sourceNumber: NUMBER, timestamp: 2 }));
    expect(dispatchMock).toHaveBeenCalledTimes(2);
    const warnings = logWarnMock.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith("signal allowFrom entry"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`matched uuid:${UUID} — replace it with the uuid`);
    expect(warnings[0]).not.toContain(NUMBER);
  });

  it("a mismatched allowFrom denies", async () => {
    await makeHandler({ dmPolicy: "allowlist", allowFrom: ["+15550003333"] })(
      dm({ sourceUuid: UUID, sourceNumber: NUMBER }),
    );
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("re-keys a phone-keyed DM session to the uuid key on the next inbound DM (§4.1)", async () => {
    const phoneKey = `agent:main:signal:direct:${NUMBER}`;
    const uuidKey = `agent:main:signal:direct:uuid:${UUID}`;
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        [phoneKey]: {
          sessionId: "sess-placeholder-1",
          updatedAt: 1_700_000_000_000,
          modelOverride: "placeholder-model",
          thinkingLevel: "high",
          lastTo: NUMBER,
        },
      }),
    );
    clearSessionStoreCacheForTest();
    const log = vi.fn();
    const handler = makeHandler({
      // oxlint-disable-next-line typescript/no-explicit-any
      runtime: { log, error: () => {} } as any,
    });

    await handler(dm({ sourceUuid: UUID, sourceNumber: NUMBER }));

    expect(capture.ctx?.SessionKey).toBe(uuidKey);
    clearSessionStoreCacheForTest();
    // recordInboundSession runs fire-and-forget; wait for the store to settle.
    await vi.waitFor(() => {
      const store = loadSessionStore(storePath, { skipCache: true });
      expect(store[uuidKey]?.sessionId).toBe("sess-placeholder-1");
    });
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store[phoneKey]).toBeUndefined();
    expect(store[uuidKey]?.modelOverride).toBe("placeholder-model");
    expect(store[uuidKey]?.thinkingLevel).toBe("high");
    expect(Object.keys(store).filter((key) => key.includes(":signal:direct:"))).toEqual([uuidKey]);
    expect(
      log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("re-keyed")),
    ).toHaveLength(1);
  });

  it("number-only senders keep the phone session key (outbound/legacy path, §4.3)", async () => {
    await makeHandler()(dm({ sourceNumber: NUMBER, sourceUuid: null }));
    expect(capture.ctx?.SessionKey).toBe(`agent:main:signal:direct:${NUMBER}`);
    expect(capture.ctx?.SenderId).toBe(NUMBER);
  });
});
