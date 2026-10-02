import { describe, expect, it } from "vitest";
import { createSignalTrustGate } from "../trust/gate.js";
import {
  enqueueTrustedSignalSystemEvent,
  recordTrustedSignalPendingHistory,
} from "./trusted-sinks.js";

const gate = createSignalTrustGate({
  accountId: "default",
  runtime: { log: () => {}, error: () => {}, exit: () => {} },
  env: {},
});

describe("trusted sinks require a gate-minted sender (ARCH §4.4)", () => {
  it("rejects plain objects at compile time and at runtime", async () => {
    const forged = { number: "+15550000001" };
    const queued = await enqueueTrustedSignalSystemEvent({
      gate,
      // @ts-expect-error a plain object is not a SignalTrustedSender
      trusted: forged,
      text: "x",
      options: { sessionKey: "agent:main:signal:direct:+15550000001" },
    });
    expect(queued).toBe(false);

    const recorded = await recordTrustedSignalPendingHistory({
      gate,
      // @ts-expect-error a plain object is not a SignalTrustedSender
      trusted: forged,
      historyMap: new Map(),
      historyKey: "g",
      limit: 5,
      entry: { sender: "x", body: "y" },
    });
    expect(recorded).toBe(false);
  });
});
