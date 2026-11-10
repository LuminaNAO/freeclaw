// Test helpers for mail push (no production use).
import type { MailConnectorConfig } from "../config/types.mail.js";
import type { MailSessionEvent, MailSessionSink, MailStateIo } from "./connector.js";
import type { MailConnectorStateFile } from "./state-store.js";
import type { MailLogger } from "./types.js";

export function createMemoryStateIo(): MailStateIo & {
  files: Map<string, MailConnectorStateFile>;
  writes: number;
} {
  const files = new Map<string, MailConnectorStateFile>();
  const io = {
    files,
    writes: 0,
    read: async (filePath: string) => {
      const file = files.get(filePath);
      return file ? structuredClone(file) : null;
    },
    write: async (filePath: string, state: MailConnectorStateFile) => {
      io.writes += 1;
      files.set(filePath, structuredClone(state));
    },
  };
  return io;
}

export function createRecordingLogger(): MailLogger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (message) => lines.push(`info ${message}`),
    warn: (message) => lines.push(`warn ${message}`),
    error: (message) => lines.push(`error ${message}`),
    debug: (message) => lines.push(`debug ${message}`),
  };
}

export type RecordingSink = MailSessionSink & {
  events: MailSessionEvent[];
  /** Per sessionKey: throw on the next N deliveries. */
  failNext: Map<string, number>;
  /** Per sessionKey: block deliveries until released. */
  hold: Map<string, Promise<void>>;
};

export function createRecordingSink(): RecordingSink {
  const events: MailSessionEvent[] = [];
  const failNext = new Map<string, number>();
  const hold = new Map<string, Promise<void>>();
  const sink = (async (event: MailSessionEvent) => {
    const gate = hold.get(event.attach.sessionKey);
    if (gate) {
      await gate;
    }
    const failures = failNext.get(event.attach.sessionKey) ?? 0;
    if (failures > 0) {
      failNext.set(event.attach.sessionKey, failures - 1);
      throw new Error(`session ${event.attach.sessionKey} busy`);
    }
    events.push(event);
  }) as RecordingSink;
  sink.events = events;
  sink.failNext = failNext;
  sink.hold = hold;
  return sink;
}

export function fakeConnectorConfig(
  overrides: Partial<MailConnectorConfig> = {},
): MailConnectorConfig {
  return {
    id: "work",
    provider: "fake",
    batch: { windowSeconds: 0, max: 10 },
    attach: [{ agentId: "main", sessionKey: "agent:main:mail:work" }],
    ...overrides,
  };
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
