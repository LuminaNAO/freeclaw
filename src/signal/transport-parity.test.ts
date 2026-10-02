import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SignalSseEvent } from "./client-types.js";
import { startSocketStub, type StubConnection, type StubRequest } from "./socket-test-stub.js";

// Real fetch for the HTTP side; the client otherwise resolves it through infra.
vi.mock("../infra/fetch.js", () => ({ resolveFetch: () => fetch }));

const { signalCheck, signalRpcRequest, streamSignalEvents } = await import("./client.js");

const ACCOUNT = "+15550001111";
const PAYLOADS = [
  {
    account: ACCOUNT,
    envelope: { sourceNumber: "+15550002222", timestamp: 1, dataMessage: { message: "a" } },
  },
  {
    account: ACCOUNT,
    envelope: { sourceNumber: "+15550002222", timestamp: 2, dataMessage: { message: "b\nc" } },
  },
  {
    account: ACCOUNT,
    exception: { message: "decrypt failed" },
    envelope: { sourceUuid: "u", timestamp: 3 },
  },
];

/** Scripted fake signal-cli: one behavior, served over the socket and through the bridge. */
function fakeDaemon(req: StubRequest, conn: StubConnection) {
  const reply = (body: Record<string, unknown>) =>
    conn.send({ jsonrpc: "2.0", id: req.id, ...body });
  switch (req.method) {
    case "version":
      return reply({ result: { version: "0.14.5" } });
    case "send":
    case "sendReaction":
      return reply({ result: { timestamp: 1_700_000_000_000 } });
    case "sendTyping":
    case "sendReceipt":
      return reply({ result: {} });
    case "getAttachment":
      return reply({ result: { data: Buffer.from("png-bytes").toString("base64") } });
    case "failing":
      return reply({ error: { code: -5, message: "rate limited" } });
    case "subscribeReceive": {
      reply({ result: 3 });
      for (const p of PAYLOADS) {
        conn.send({ jsonrpc: "2.0", method: "receive", params: { subscription: 3, result: p } });
      }
      setTimeout(() => conn.socket.end(), 20);
      return;
    }
    default:
      return reply({ error: { code: -32601, message: "Method not implemented" } });
  }
}

/** Minimal HTTP bridge implementing the A1-A4 contract (the temporary shim's role). */
async function startBridge(socketPath: string) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/api/v1/check") {
      res.writeHead(200).end();
      return;
    }
    if (url.pathname === "/api/v1/rpc" && req.method === "POST") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const sock = net.connect(socketPath, () => sock.write(`${body.trim()}\n`));
        let buf = "";
        sock.on("data", (d) => {
          buf += d.toString();
          const nl = buf.indexOf("\n");
          if (nl !== -1) {
            res.writeHead(200, { "Content-Type": "application/json" }).end(buf.slice(0, nl));
            sock.destroy();
          }
        });
      });
      return;
    }
    if (url.pathname === "/api/v1/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const sock = net.connect(socketPath, () =>
        sock.write(`${JSON.stringify({ jsonrpc: "2.0", method: "subscribeReceive", id: "s" })}\n`),
      );
      let buf = "";
      sock.on("data", (d) => {
        buf += d.toString();
        let nl = buf.indexOf("\n");
        while (nl !== -1) {
          const msg = JSON.parse(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          if (msg.method === "receive") {
            res.write(`event: receive\ndata: ${JSON.stringify(msg.params.result)}\n\n`);
          }
          nl = buf.indexOf("\n");
        }
      });
      sock.on("close", () => res.end());
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as net.AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).toReversed()) {
    await c();
  }
});

async function endpoints() {
  const stub = await startSocketStub(fakeDaemon);
  cleanups.push(stub.close);
  const bridge = await startBridge(stub.socketPath);
  cleanups.push(bridge.close);
  return { unix: `unix:${stub.socketPath}`, http: bridge.baseUrl };
}

async function settle<T>(p: Promise<T>): Promise<{ ok: T } | { err: string }> {
  try {
    return { ok: await p };
  } catch (e) {
    return { err: (e as Error).message };
  }
}

describe("transport parity: native socket vs HTTP bridge (shim contract A1-A4)", () => {
  it.each([
    ["version", undefined],
    ["send", { account: ACCOUNT, recipient: ["+15550002222"], message: "hi" }],
    [
      "sendReaction",
      { account: ACCOUNT, emoji: "👍", targetAuthor: "+15550002222", targetTimestamp: 1 },
    ],
    ["sendTyping", { account: ACCOUNT, recipient: ["+15550002222"] }],
    ["sendReceipt", { account: ACCOUNT, recipient: "+15550002222", targetTimestamp: 1 }],
    ["getAttachment", { account: ACCOUNT, id: "att1", recipient: "+15550002222" }],
    ["failing", undefined],
  ] as Array<[string, Record<string, unknown> | undefined]>)(
    "A1/A2 %s returns identical results or errors",
    async (method, params) => {
      const ep = await endpoints();
      const viaSocket = await settle(signalRpcRequest(method, params, { baseUrl: ep.unix }));
      const viaHttp = await settle(signalRpcRequest(method, params, { baseUrl: ep.http }));
      expect(viaSocket).toEqual(viaHttp);
    },
  );

  it("A3 health check is ok on both", async () => {
    const ep = await endpoints();
    expect((await signalCheck(ep.unix, 1000)).ok).toBe(true);
    expect((await signalCheck(ep.http, 1000)).ok).toBe(true);
  });

  it("A4 receive stream produces an identical onEvent sequence", async () => {
    const ep = await endpoints();
    const collect = async (baseUrl: string) => {
      const events: SignalSseEvent[] = [];
      await streamSignalEvents({ baseUrl, account: ACCOUNT, onEvent: (e) => events.push(e) });
      return events.map((e) => ({ event: e.event, data: e.data }));
    };
    const viaSocket = await collect(ep.unix);
    const viaHttp = await collect(ep.http);
    expect(viaSocket).toHaveLength(PAYLOADS.length);
    expect(viaSocket).toEqual(viaHttp);
    expect(viaSocket.map((e) => JSON.parse(e.data ?? ""))).toEqual(PAYLOADS);
  });
});
