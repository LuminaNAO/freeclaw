import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SignalSseEvent } from "./client-types.js";
import { socketCheck, socketRpcRequest, streamSocketEvents } from "./socket-client.js";
import { startSocketStub, type StubHandler } from "./socket-test-stub.js";

const stubs: Array<{ close: () => Promise<void> }> = [];
async function stub(handler: StubHandler) {
  const s = await startSocketStub(handler);
  stubs.push(s);
  return s;
}

afterEach(async () => {
  while (stubs.length) {
    await stubs.pop()?.close();
  }
});

const ENVELOPE = {
  account: "+15550001111",
  envelope: { sourceNumber: "+15550002222", timestamp: 1, dataMessage: { message: "hi" } },
};

describe("socketRpcRequest", () => {
  it("returns the result matched by id and sends one JSON line", async () => {
    let seen: unknown;
    const s = await stub((req, conn) => {
      seen = req;
      conn.send({ jsonrpc: "2.0", result: { version: "0.14.5" }, id: req.id });
    });
    const result = await socketRpcRequest<{ version: string }>(s.socketPath, "version", undefined);
    expect(result).toEqual({ version: "0.14.5" });
    expect(seen).toMatchObject({ jsonrpc: "2.0", method: "version" });
  });

  it("maps JSON-RPC errors to the same message shape as HTTP", async () => {
    const s = await stub((req, conn) =>
      conn.send({ jsonrpc: "2.0", error: { code: -5, message: "rate limited" }, id: req.id }),
    );
    await expect(socketRpcRequest(s.socketPath, "send", {})).rejects.toThrow(
      "Signal RPC -5: rate limited",
    );
  });

  it("accepts result:{} for commands without output", async () => {
    const s = await stub((req, conn) => conn.send({ jsonrpc: "2.0", result: {}, id: req.id }));
    await expect(socketRpcRequest(s.socketPath, "sendTyping", {})).resolves.toEqual({});
  });

  it("rejects malformed JSON and envelopes without result or error", async () => {
    const bad = await stub((_req, conn) => conn.sendRaw("not json\n"));
    await expect(socketRpcRequest(bad.socketPath, "version", undefined)).rejects.toThrow(
      /malformed JSON/,
    );
    const empty = await stub((req, conn) => conn.send({ jsonrpc: "2.0", id: req.id }));
    await expect(socketRpcRequest(empty.socketPath, "version", undefined)).rejects.toThrow(
      /invalid response envelope/,
    );
  });

  it("ignores notifications and foreign ids, handles split and coalesced chunks", async () => {
    const s = await stub((req, conn) => {
      const line = JSON.stringify({ jsonrpc: "2.0", result: { ok: 1 }, id: req.id });
      conn.sendRaw(
        `${JSON.stringify({ jsonrpc: "2.0", method: "receive", params: ENVELOPE })}\n` +
          `${JSON.stringify({ jsonrpc: "2.0", result: "x", id: "other" })}\n` +
          line.slice(0, 10),
      );
      setTimeout(() => conn.sendRaw(`${line.slice(10)}\n`), 20);
    });
    await expect(socketRpcRequest(s.socketPath, "version", undefined)).resolves.toEqual({ ok: 1 });
  });

  it("times out on a silent daemon", async () => {
    const s = await stub(() => {});
    await expect(
      socketRpcRequest(s.socketPath, "version", undefined, { timeoutMs: 50 }),
    ).rejects.toThrow(/timed out/);
  });

  it("fails when the daemon closes before responding", async () => {
    const s = await stub((_req, conn) => conn.socket.end());
    await expect(socketRpcRequest(s.socketPath, "version", undefined)).rejects.toThrow(
      /closed before version response/,
    );
  });

  it("enforces the line limit", async () => {
    const s = await stub((_req, conn) => conn.sendRaw("x".repeat(2048)));
    await expect(
      socketRpcRequest(s.socketPath, "version", undefined, { maxLineBytes: 1024 }),
    ).rejects.toThrow(/line limit/);
  });

  it("surfaces ENOENT and ECONNREFUSED with the socket path, never falling back", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sigsock-"));
    const missing = path.join(dir, "missing.sock");
    await expect(socketRpcRequest(missing, "version", undefined)).rejects.toThrow(
      `Signal socket ${missing} unavailable (ENOENT)`,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(process.getuid?.() === 0)(
    "surfaces EACCES when the socket directory is not searchable",
    async () => {
      const s = await stub((req, conn) => conn.send({ jsonrpc: "2.0", result: 1, id: req.id }));
      fs.chmodSync(s.dir, 0o000);
      try {
        await expect(socketRpcRequest(s.socketPath, "version", undefined)).rejects.toThrow(
          /EACCES/,
        );
      } finally {
        fs.chmodSync(s.dir, 0o700);
      }
    },
  );
});

describe("socketCheck", () => {
  it("is ok only when a real RPC succeeds", async () => {
    const s = await stub((req, conn) =>
      conn.send({ jsonrpc: "2.0", result: "0.14.5", id: req.id }),
    );
    await expect(socketCheck(s.socketPath, 500)).resolves.toEqual({
      ok: true,
      status: null,
      error: null,
    });
    const down = await socketCheck(path.join(s.dir, "nope.sock"), 500);
    expect(down.ok).toBe(false);
    expect(down.error).toMatch(/ENOENT/);
  });
});

describe("streamSocketEvents", () => {
  function receiveStub(opts: {
    notifications: (sub: number) => unknown[];
    autoNotify?: unknown[];
  }) {
    return stub((req, conn) => {
      if (req.method !== "subscribeReceive") {
        return;
      }
      for (const n of opts.autoNotify ?? []) {
        conn.send(n);
      }
      conn.send({ jsonrpc: "2.0", result: 7, id: req.id });
      for (const n of opts.notifications(7)) {
        conn.send(n);
      }
      setTimeout(() => conn.socket.end(), 30);
    });
  }

  it("subscribes and emits SSE-shaped receive events with the unwrapped payload", async () => {
    const s = await receiveStub({
      notifications: (sub) => [
        { jsonrpc: "2.0", method: "receive", params: { subscription: sub, result: ENVELOPE } },
        { jsonrpc: "2.0", method: "receive", params: { subscription: 99, result: ENVELOPE } },
        { jsonrpc: "2.0", method: "callEvent", params: { subscription: sub, result: {} } },
      ],
    });
    const events: SignalSseEvent[] = [];
    await streamSocketEvents({ socketPath: s.socketPath, onEvent: (e) => events.push(e) });
    expect(events).toEqual([{ event: "receive", data: JSON.stringify(ENVELOPE) }]);
  });

  it("ignores unwrapped auto-subscription notifications and warns once", async () => {
    const log = vi.fn();
    const auto = { jsonrpc: "2.0", method: "receive", params: ENVELOPE };
    const s = await receiveStub({
      notifications: (sub) => [
        auto,
        auto,
        { jsonrpc: "2.0", method: "receive", params: { subscription: sub, result: ENVELOPE } },
      ],
    });
    const events: SignalSseEvent[] = [];
    await streamSocketEvents({ socketPath: s.socketPath, onEvent: (e) => events.push(e), log });
    expect(events).toHaveLength(1);
    expect(log.mock.calls.filter((c) => String(c[0]).includes("receive-mode manual"))).toHaveLength(
      1,
    );
  });

  it("filters other accounts for an E.164 account, not for UUID accounts", async () => {
    const other = { ...ENVELOPE, account: "+15559999999" };
    const make = () =>
      receiveStub({
        notifications: (sub) => [
          { jsonrpc: "2.0", method: "receive", params: { subscription: sub, result: other } },
          { jsonrpc: "2.0", method: "receive", params: { subscription: sub, result: ENVELOPE } },
        ],
      });
    const e164: SignalSseEvent[] = [];
    await streamSocketEvents({
      socketPath: (await make()).socketPath,
      account: "+15550001111",
      onEvent: (e) => e164.push(e),
    });
    expect(e164).toHaveLength(1);
    const uuid: SignalSseEvent[] = [];
    await streamSocketEvents({
      socketPath: (await make()).socketPath,
      account: "1b4f0e9a-0000-4000-8000-000000000000",
      onEvent: (e) => uuid.push(e),
    });
    expect(uuid).toHaveLength(2);
  });

  it("delivers wrapped notifications that arrive before the subscribeReceive response", async () => {
    const s = await stub((req, conn) => {
      conn.send({
        jsonrpc: "2.0",
        method: "receive",
        params: { subscription: 4, result: ENVELOPE },
      });
      conn.send({
        jsonrpc: "2.0",
        method: "receive",
        params: { subscription: 9, result: ENVELOPE },
      });
      conn.send({ jsonrpc: "2.0", result: 4, id: req.id });
      setTimeout(() => conn.socket.end(), 20);
    });
    const events: SignalSseEvent[] = [];
    await streamSocketEvents({ socketPath: s.socketPath, onEvent: (e) => events.push(e) });
    expect(events).toEqual([{ event: "receive", data: JSON.stringify(ENVELOPE) }]);
  });

  it("rejects when subscribeReceive returns an error", async () => {
    const s = await stub((req, conn) =>
      conn.send({
        jsonrpc: "2.0",
        error: { code: -32601, message: "Method not implemented" },
        id: req.id,
      }),
    );
    await expect(
      streamSocketEvents({ socketPath: s.socketPath, onEvent: () => {} }),
    ).rejects.toThrow(/subscribeReceive failed/);
  });

  it("resolves on EOF after subscribing and ends promptly on abort", async () => {
    const s = await stub((req, conn) => conn.send({ jsonrpc: "2.0", result: 0, id: req.id }));
    const controller = new AbortController();
    const done = streamSocketEvents({
      socketPath: s.socketPath,
      abortSignal: controller.signal,
      onEvent: () => {},
    });
    setTimeout(() => controller.abort(), 30);
    await expect(done).resolves.toBeUndefined();
  });
});
