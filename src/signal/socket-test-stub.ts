import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export type StubRequest = { jsonrpc: string; method: string; params?: unknown; id?: unknown };

export type StubConnection = {
  socket: net.Socket;
  send: (value: unknown) => void;
  sendRaw: (text: string) => void;
};

export type StubHandler = (req: StubRequest, conn: StubConnection) => void;

/** Minimal newline-JSON-RPC unix socket server standing in for `signal-cli daemon --socket`. */
export async function startSocketStub(handler: StubHandler): Promise<{
  socketPath: string;
  dir: string;
  connections: StubConnection[];
  close: () => Promise<void>;
}> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sigsock-"));
  const socketPath = path.join(dir, "d.sock");
  const connections: StubConnection[] = [];
  const server = net.createServer((socket) => {
    const conn: StubConnection = {
      socket,
      send: (value) => socket.write(`${JSON.stringify(value)}\n`),
      sendRaw: (text) => socket.write(text),
    };
    connections.push(conn);
    let buf = "";
    socket.on("data", (d) => {
      buf += d.toString("utf8");
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) {
          handler(JSON.parse(line) as StubRequest, conn);
        }
        nl = buf.indexOf("\n");
      }
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    dir,
    connections,
    close: async () => {
      for (const c of connections) {
        c.socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
