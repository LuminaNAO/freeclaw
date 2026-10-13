/**
 * docs/design/signal-uuid-identity.md §4/§5 — DM session re-key from the phone key to
 * the uuid key. Placeholder numbers/uuids only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSessionStoreCacheForTest, loadSessionStore } from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { migrateSignalDmSessionToUuid } from "./dm-session-rekey.js";
import { buildSignalDirectSessionKey } from "./inbound-route.js";

const UUID = "00000000-0000-4000-8000-00000000000a";
const NUMBER = "+15550001111";
const PHONE_KEY = buildSignalDirectSessionKey({ agentId: "main", peerId: NUMBER });
const UUID_KEY = buildSignalDirectSessionKey({ agentId: "main", peerId: `uuid:${UUID}` });

let dir: string;
let storePath: string;

function writeStore(store: Record<string, SessionEntry>) {
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
  clearSessionStoreCacheForTest();
}

function readStore(): Record<string, SessionEntry> {
  clearSessionStoreCacheForTest();
  return loadSessionStore(storePath, { skipCache: true });
}

function phoneEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "sess-phone-0001",
    updatedAt: Date.now(),
    sessionFile: "sess-phone-0001.jsonl",
    modelOverride: "placeholder-model",
    providerOverride: "placeholder-provider",
    thinkingLevel: "high",
    verboseLevel: "on",
    sendPolicy: "allow",
    label: "placeholder label",
    chatType: "direct",
    lastChannel: "signal",
    lastTo: NUMBER,
    deliveryContext: { channel: "signal", to: NUMBER, accountId: "default" },
    origin: { provider: "signal", from: `signal:${NUMBER}`, to: `signal:${NUMBER}` },
    ...overrides,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-rekey-"));
  storePath = path.join(dir, "sessions.json");
});

afterEach(() => {
  clearSessionStoreCacheForTest();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("migrateSignalDmSessionToUuid (§4)", () => {
  it("keys are the expected phone and uuid forms", () => {
    expect(PHONE_KEY).toBe(`agent:main:signal:direct:${NUMBER}`);
    expect(UUID_KEY).toBe(`agent:main:signal:direct:uuid:${UUID}`);
  });

  it("moves the phone-keyed session to the uuid key keeping sessionId, transcript and overrides", async () => {
    const original = phoneEntry();
    const other: SessionEntry = { sessionId: "sess-other", updatedAt: 1 };
    writeStore({ [PHONE_KEY]: original, "agent:main:main": other });
    const transcript = path.join(dir, "sess-phone-0001.jsonl");
    fs.writeFileSync(transcript, '{"placeholder":true}\n');
    const log = vi.fn();

    const result = await migrateSignalDmSessionToUuid({
      storePath,
      phoneSessionKey: PHONE_KEY,
      uuidSessionKey: UUID_KEY,
      phoneE164: NUMBER,
      uuidRecipient: UUID,
      log,
    });

    expect(result).toEqual({ status: "rekeyed", sessionId: "sess-phone-0001" });
    const store = readStore();
    expect(store[PHONE_KEY]).toBeUndefined();
    const moved = store[UUID_KEY];
    expect(moved).toBeDefined();
    expect(moved?.sessionId).toBe(original.sessionId);
    expect(moved?.sessionFile).toBe(original.sessionFile);
    expect(moved?.updatedAt).toBe(original.updatedAt);
    expect(moved?.modelOverride).toBe("placeholder-model");
    expect(moved?.providerOverride).toBe("placeholder-provider");
    expect(moved?.thinkingLevel).toBe("high");
    expect(moved?.verboseLevel).toBe("on");
    expect(moved?.sendPolicy).toBe("allow");
    expect(moved?.label).toBe("placeholder label");
    // routing now names the uuid, never the number (§1)
    expect(moved?.lastTo).toBe(UUID);
    expect(moved?.deliveryContext?.to).toBe(UUID);
    expect(moved?.origin?.from).toBe(`signal:${UUID}`);
    expect(moved?.origin?.to).toBe(`signal:${UUID}`);
    expect(JSON.stringify(moved)).not.toContain(NUMBER);
    // untouched neighbours, transcript still on disk (not archived)
    expect(store["agent:main:main"]?.sessionId).toBe("sess-other");
    expect(fs.existsSync(transcript)).toBe(true);
    // one-line notice, number masked
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain(`uuid:${UUID}`);
    expect(String(log.mock.calls[0]?.[0])).not.toContain(NUMBER);
  });

  it("is idempotent: a second call finds nothing to move", async () => {
    writeStore({ [PHONE_KEY]: phoneEntry() });
    const params = {
      storePath,
      phoneSessionKey: PHONE_KEY,
      uuidSessionKey: UUID_KEY,
      phoneE164: NUMBER,
      uuidRecipient: UUID,
    };
    await migrateSignalDmSessionToUuid(params);
    expect(await migrateSignalDmSessionToUuid(params)).toEqual({ status: "noop" });
    expect(Object.keys(readStore())).toEqual([UUID_KEY]);
  });

  it("both exist: the uuid key wins and the phone-keyed entry is left untouched (§4.2)", async () => {
    const phone = phoneEntry();
    const uuidEntry: SessionEntry = {
      sessionId: "sess-uuid-0002",
      updatedAt: 2,
      modelOverride: "m2",
    };
    writeStore({ [PHONE_KEY]: phone, [UUID_KEY]: uuidEntry });
    const rawBefore = fs.readFileSync(storePath, "utf8");

    const result = await migrateSignalDmSessionToUuid({
      storePath,
      phoneSessionKey: PHONE_KEY,
      uuidSessionKey: UUID_KEY,
      phoneE164: NUMBER,
      uuidRecipient: UUID,
    });

    expect(result).toEqual({ status: "both-exist" });
    // no store write at all: both entries byte-for-byte as they were
    expect(fs.readFileSync(storePath, "utf8")).toBe(rawBefore);
    const store = readStore();
    expect(store[UUID_KEY]?.sessionId).toBe("sess-uuid-0002");
    expect(store[PHONE_KEY]?.sessionId).toBe(phone.sessionId);
    expect(store[PHONE_KEY]?.modelOverride).toBe(phone.modelOverride);
  });

  it("no phone-keyed session: no write at all", async () => {
    writeStore({ "agent:main:main": { sessionId: "s", updatedAt: 1 } });
    const before = fs.statSync(storePath).mtimeMs;
    const result = await migrateSignalDmSessionToUuid({
      storePath,
      phoneSessionKey: PHONE_KEY,
      uuidSessionKey: UUID_KEY,
      phoneE164: NUMBER,
      uuidRecipient: UUID,
    });
    expect(result).toEqual({ status: "noop" });
    expect(fs.statSync(storePath).mtimeMs).toBe(before);
  });
});
