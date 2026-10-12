import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveStateDir } from "../config/paths.js";
import {
  listStack,
  resolveStackDir,
  stackFilesOf,
  writeStackFile,
} from "../infra/session-stack.js";

const calls: Array<{ source: string; payload: unknown; boundFiles?: string[] }> = [];

vi.mock("../auto-reply/dispatch.js", () => ({
  dispatchInboundMessage: vi.fn(async ({ ctx }: { ctx: object }) => {
    calls.push({ source: "inbound", payload: ctx, boundFiles: stackFilesOf(ctx)?.slice() });
    return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
  }),
}));

vi.mock("./server-methods/agent.js", () => ({
  agentHandlers: {
    agent: vi.fn(
      async ({
        params,
        respond,
      }: {
        params: object;
        respond: (ok: boolean, payload: unknown) => void;
      }) => {
        calls.push({ source: "agent", payload: params, boundFiles: stackFilesOf(params)?.slice() });
        respond(true, { status: "accepted" });
        respond(true, { status: "ok" });
      },
    ),
  },
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  loadConfig: () => ({}),
}));

const { replaySessionStack } = await import("./session-stack-replay.js");

describe("session prompt stack startup replay (§5)", () => {
  it("re-submits oldest first through the original ingress with the payload byte-identical", async () => {
    const key = "agent:main:replay";
    const stored = [
      {
        source: "agent" as const,
        payload: { params: { message: "A", idempotencyKey: "a" }, client: null },
      },
      {
        source: "inbound" as const,
        payload: { ctx: { Body: "B ü\n", SessionKey: key, SenderId: "s", MessageSid: "b" } },
      },
      {
        source: "agent" as const,
        payload: { params: { message: "C", idempotencyKey: "c" }, client: null },
      },
    ];
    const files = stored.map((s) => writeStackFile({ sessionKey: key, ...s }));
    const raw = files.map((f) => JSON.stringify(JSON.parse(fs.readFileSync(f, "utf8")).payload));

    await replaySessionStack({
      logGateway: { info: vi.fn(), warn: vi.fn() },
    } as never);

    expect(calls.map((c) => c.source)).toEqual(["agent", "inbound", "agent"]);
    expect(JSON.stringify(calls[0].payload)).toBe(JSON.stringify(JSON.parse(raw[0]).params));
    expect(JSON.stringify({ ctx: calls[1].payload })).toBe(raw[1]);
    expect(JSON.stringify(calls[2].payload)).toBe(JSON.stringify(JSON.parse(raw[2]).params));
    // Each replayed prompt carries its own file; deletion is left to the turn end (§3).
    expect(calls.map((c) => c.boundFiles)).toEqual(files.map((f) => [f]));
    expect(listStack()[0].entries.map((e) => e.file)).toEqual(files);
  });
});

type Log = { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };

function makeLog(): Log {
  return { info: vi.fn(), warn: vi.fn() };
}

function logLines(log: Log): string[] {
  return log.info.mock.calls.map((c) => String(c[0]));
}

function callsFor(sessionKey: string) {
  return calls.filter(
    (c) =>
      (c.payload as { SessionKey?: string; sessionKey?: string }).SessionKey === sessionKey ||
      (c.payload as { sessionKey?: string }).sessionKey === sessionKey,
  );
}

/** A session with a transcript holding the given user turns (default store, default agent). */
function writeTranscript(sessionKey: string, userTexts: string[]): void {
  const sessionsDir = path.join(resolveStateDir(), "agents", "main", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const storePath = path.join(sessionsDir, "sessions.json");
  const store = fs.existsSync(storePath)
    ? (JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<string, unknown>)
    : {};
  const sessionId = `sess-${Object.keys(store).length + 1}`;
  store[sessionKey] = { sessionId, updatedAt: Date.now() };
  fs.writeFileSync(storePath, JSON.stringify(store));
  const lines = [
    { type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString() },
    ...userTexts.flatMap((text, i) => [
      {
        type: "message",
        id: `u${i}`,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: [{ type: "text", text }] },
      },
      {
        type: "message",
        id: `a${i}`,
        timestamp: new Date().toISOString(),
        message: { role: "assistant", content: [{ type: "text", text: "answered" }] },
      },
    ]),
  ];
  fs.writeFileSync(
    path.join(sessionsDir, `${sessionId}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
}

/** The untrusted conversation metadata block the reply pipeline puts on a user turn. */
function userTurnWithMessageId(id: string, body: string): string {
  return [
    "Conversation info (untrusted metadata):",
    "```json",
    JSON.stringify({ message_id: id, sender_id: "+15550001" }, null, 2),
    "```",
    "",
    body,
  ].join("\n");
}

function inboundEntry(sessionKey: string, sid: string, extra: Record<string, unknown> = {}) {
  return {
    source: "inbound" as const,
    payload: { ctx: { Body: `body ${sid}`, SessionKey: sessionKey, MessageSid: sid, ...extra } },
  };
}

/** Rename a stack file so its arrival time is `ageMs` ago (the name is the arrival time). */
function ageStackFile(file: string, ageMs: number): string {
  const aged = path.join(path.dirname(file), `${Date.now() - ageMs}-0.json`);
  fs.renameSync(file, aged);
  return aged;
}

describe("session prompt stack: stale replay guards (stale replay ARCH §2, §3, §4)", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("§2: an inbound prompt whose message id is already a user turn is dropped, not dispatched", async () => {
    const key = "agent:main:stale-in-transcript";
    // The incident: collected and answered — its id is in the transcript, inside a collect turn.
    writeTranscript(key, [
      `[Queued messages while agent was busy]\n\n---\nQueued #1\n${userTurnWithMessageId("sig-1001", "hello")}`,
    ]);
    const file = writeStackFile({ sessionKey: key, ...inboundEntry(key, "sig-1001") });
    const log = makeLog();

    await replaySessionStack({ logGateway: log } as never);

    expect(callsFor(key)).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
    expect(logLines(log)).toContain(
      `session stack: dropped stale ${key} ${path.basename(file)} (already in transcript)`,
    );
    expect(logLines(log).some((l) => l.startsWith(`session stack: replay ${key} `))).toBe(false);
  });

  it("§2: MessageSidFull is matched too", async () => {
    const key = "agent:main:stale-full-id";
    writeTranscript(key, [userTurnWithMessageId("full-2002", "hi")]);
    const file = writeStackFile({
      sessionKey: key,
      ...inboundEntry(key, "short", { MessageSidFull: "full-2002" }),
    });

    await replaySessionStack({ logGateway: makeLog() } as never);

    expect(callsFor(key)).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("§2: id absent from the transcript → replayed byte-identical (v2 §2.1)", async () => {
    const key = "agent:main:not-in-transcript";
    writeTranscript(key, [userTurnWithMessageId("sig-other", "earlier")]);
    const entry = inboundEntry(key, "sig-3003", { Body: "B ü\n", SenderId: "s" });
    const file = writeStackFile({ sessionKey: key, ...entry });
    const raw = JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8")).payload);

    await replaySessionStack({ logGateway: makeLog() } as never);

    const replayed = callsFor(key);
    expect(replayed).toHaveLength(1);
    expect(JSON.stringify({ ctx: replayed[0].payload })).toBe(raw);
    expect(replayed[0].boundFiles).toEqual([file]);
    expect(fs.existsSync(file)).toBe(true);
    fs.rmSync(file, { force: true });
  });

  it("§2: an id only in an assistant turn does not count; no transcript means replay", async () => {
    const key = "agent:main:id-only-in-assistant";
    writeTranscript(key, []);
    const sessionsDir = path.join(resolveStateDir(), "agents", "main", "sessions");
    const store = JSON.parse(fs.readFileSync(path.join(sessionsDir, "sessions.json"), "utf8"));
    const transcript = path.join(sessionsDir, `${store[key].sessionId}.jsonl`);
    fs.appendFileSync(
      transcript,
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: '"message_id": "sig-4004"' }],
        },
      }) + "\n",
    );
    const a = writeStackFile({ sessionKey: key, ...inboundEntry(key, "sig-4004") });
    const noTranscriptKey = "agent:main:no-transcript";
    const b = writeStackFile({
      sessionKey: noTranscriptKey,
      ...inboundEntry(noTranscriptKey, "sig-5005"),
    });

    await replaySessionStack({ logGateway: makeLog() } as never);

    expect(callsFor(key)).toHaveLength(1);
    expect(callsFor(noTranscriptKey)).toHaveLength(1);
    fs.rmSync(a, { force: true });
    fs.rmSync(b, { force: true });
  });

  it("§2: agent files are replayed unchanged (the transcript does not record the key)", async () => {
    const key = "agent:main:agent-unchanged";
    writeTranscript(key, ["idem-6006 appears as text"]);
    const file = writeStackFile({
      sessionKey: key,
      source: "agent",
      payload: {
        params: { message: "A", sessionKey: key, idempotencyKey: "idem-6006" },
        client: null,
      },
    });

    await replaySessionStack({ logGateway: makeLog() } as never);

    expect(callsFor(key).map((c) => c.source)).toEqual(["agent"]);
    fs.rmSync(file, { force: true });
  });

  it("§3: a file older than 24 h is dropped and logged; a younger one replays", async () => {
    const key = "agent:main:expired";
    const old = ageStackFile(
      writeStackFile({ sessionKey: key, ...inboundEntry(key, "old-1") }),
      49 * 60 * 60 * 1000,
    );
    const recent = ageStackFile(
      writeStackFile({ sessionKey: key, ...inboundEntry(key, "recent-1") }),
      23 * 60 * 60 * 1000,
    );
    const log = makeLog();

    await replaySessionStack({ logGateway: log } as never);

    expect(fs.existsSync(old)).toBe(false);
    expect(logLines(log)).toContain(
      `session stack: dropped expired ${key} ${path.basename(old)} age=49h`,
    );
    expect(callsFor(key).map((c) => (c.payload as { MessageSid?: string }).MessageSid)).toEqual([
      "recent-1",
    ]);
    fs.rmSync(recent, { force: true });
  });

  it("§3: expired agent files are dropped too", async () => {
    const key = "agent:main:expired-agent";
    const old = ageStackFile(
      writeStackFile({
        sessionKey: key,
        source: "agent",
        payload: { params: { message: "A", sessionKey: key, idempotencyKey: "x" }, client: null },
      }),
      25 * 60 * 60 * 1000,
    );

    await replaySessionStack({ logGateway: makeLog() } as never);

    expect(fs.existsSync(old)).toBe(false);
    expect(callsFor(key)).toEqual([]);
  });

  it("§4: one log line per replayed file with session, file, age, source and first 60 chars", async () => {
    const key = "agent:main:observability";
    const long = "x".repeat(100);
    const file = ageStackFile(
      writeStackFile({
        sessionKey: key,
        source: "inbound",
        payload: { ctx: { Body: `${long}\nmore`, SessionKey: key, MessageSid: "obs-1" } },
      }),
      2 * 60 * 60 * 1000 + 5_000,
    );
    const log = makeLog();

    await replaySessionStack({ logGateway: log } as never);

    expect(logLines(log)).toContain(
      `session stack: replay ${key} ${path.basename(file)} age=2h source=inbound ${JSON.stringify("x".repeat(60))}`,
    );
    fs.rmSync(file, { force: true });
  });

  it("drops leave nothing behind in the stack directory", () => {
    const dirs = fs.existsSync(resolveStackDir()) ? fs.readdirSync(resolveStackDir()) : [];
    for (const key of ["agent:main:stale-in-transcript", "agent:main:stale-full-id"]) {
      const dir = encodeURIComponent(key);
      if (dirs.includes(dir)) {
        expect(fs.readdirSync(path.join(resolveStackDir(), dir))).toEqual([]);
      }
    }
  });
});
