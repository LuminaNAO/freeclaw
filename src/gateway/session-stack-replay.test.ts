import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { listStack, stackFilesOf, writeStackFile } from "../infra/session-stack.js";

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
