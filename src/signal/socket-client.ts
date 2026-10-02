import net from "node:net";
import { generateSecureUuid } from "../infra/secure-random.js";
import type { SignalRpcResponse, SignalSseEvent } from "./client-types.js";

const DEFAULT_TIMEOUT_MS = 10_000;
// Large enough for a base64 attachment at the media cap; bounds a runaway line.
export const SIGNAL_SOCKET_MAX_LINE_BYTES = 64 * 1024 * 1024;

type LineHandler = (line: string) => void;

function attachLineReader(
  sock: net.Socket,
  onLine: LineHandler,
  onOverflow: () => void,
  maxLineBytes: number,
): void {
  let chunks: Buffer[] = [];
  let pending = 0;
  sock.on("data", (data: Buffer) => {
    let start = 0;
    while (start < data.length) {
      const nl = data.indexOf(0x0a, start);
      if (nl === -1) {
        const rest = data.subarray(start);
        pending += rest.length;
        if (pending > maxLineBytes) {
          chunks = [];
          pending = 0;
          onOverflow();
          return;
        }
        chunks.push(rest);
        return;
      }
      const piece = data.subarray(start, nl);
      const line =
        chunks.length > 0
          ? Buffer.concat([...chunks, piece]).toString("utf8")
          : piece.toString("utf8");
      chunks = [];
      pending = 0;
      start = nl + 1;
      const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (trimmed.trim()) {
        onLine(trimmed);
      }
    }
  });
}

function describeConnectError(socketPath: string, err: unknown): Error {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`Signal socket ${socketPath} unavailable (${code ?? message})`, { cause: err });
}

function parseEnvelope<T>(
  line: string,
): SignalRpcResponse<T> & { method?: string; params?: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    throw new Error("Signal RPC returned malformed JSON (socket)", { cause: err });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Signal RPC returned invalid response envelope (socket)");
  }
  return parsed as SignalRpcResponse<T> & { method?: string; params?: unknown };
}

export async function socketRpcRequest<T = unknown>(
  socketPath: string,
  method: string,
  params: Record<string, unknown> | undefined,
  opts: { timeoutMs?: number; maxLineBytes?: number } = {},
): Promise<T> {
  const id = generateSecureUuid();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let connected = false;
    const sock = net.connect(socketPath);
    const finish = (err: Error | null, value?: T) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) {
        reject(err);
      } else {
        resolve(value as T);
      }
    };
    const timer = setTimeout(
      () => finish(new Error(`Signal RPC ${method} timed out after ${timeoutMs}ms (socket)`)),
      Math.max(1, timeoutMs),
    );
    attachLineReader(
      sock,
      (line) => {
        let msg: ReturnType<typeof parseEnvelope<T>>;
        try {
          msg = parseEnvelope<T>(line);
        } catch (err) {
          // One request per connection: a malformed line can only be a broken response.
          finish(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        if (msg.id !== id) {
          return;
        }
        const hasResult = Object.hasOwn(msg, "result");
        if (msg.error) {
          const code = msg.error.code ?? "unknown";
          const text = msg.error.message ?? "Signal RPC error";
          finish(new Error(`Signal RPC ${code}: ${text}`));
          return;
        }
        if (!hasResult) {
          finish(new Error("Signal RPC returned invalid response envelope (socket)"));
          return;
        }
        finish(null, msg.result as T);
      },
      () => finish(new Error(`Signal RPC ${method} response exceeded line limit (socket)`)),
      opts.maxLineBytes ?? SIGNAL_SOCKET_MAX_LINE_BYTES,
    );
    sock.once("connect", () => {
      connected = true;
      sock.write(`${JSON.stringify({ jsonrpc: "2.0", method, params, id })}\n`);
    });
    sock.once("error", (err) => {
      finish(
        connected
          ? new Error(`Signal socket error: ${err.message}`)
          : describeConnectError(socketPath, err),
      );
    });
    sock.once("close", () => {
      finish(new Error(`Signal socket closed before ${method} response`));
    });
  });
}

export async function socketCheck(
  socketPath: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ ok: boolean; status?: number | null; error?: string | null }> {
  try {
    await socketRpcRequest(socketPath, "version", undefined, { timeoutMs });
    return { ok: true, status: null, error: null };
  } catch (err) {
    return { ok: false, status: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function isE164(value: string): boolean {
  return /^\+\d{6,}$/.test(value);
}

/**
 * Long-lived receive stream over the daemon socket. Emits SSE-shaped events so the existing
 * event handler and reconnect loop are transport-agnostic. Resolves on EOF; rejects on errors.
 */
export async function streamSocketEvents(params: {
  socketPath: string;
  account?: string;
  abortSignal?: AbortSignal;
  onEvent: (event: SignalSseEvent) => void;
  log?: (message: string) => void;
  subscribeTimeoutMs?: number;
  maxLineBytes?: number;
}): Promise<void> {
  if (params.abortSignal?.aborted) {
    return;
  }
  const subscribeId = generateSecureUuid();
  const accountFilter = params.account?.trim();
  const filterByAccount = accountFilter ? isE164(accountFilter) : false;
  return await new Promise<void>((resolve, reject) => {
    let settled = false;
    let connected = false;
    let subscription: number | undefined;
    let warnedUnwrapped = false;
    let warnedAccount = false;
    // signal-cli registers the receive handler before writing the subscribeReceive response,
    // and requests run concurrently, so wrapped notifications can precede the id on the wire.
    // Hold them until the id is known instead of dropping (that would be message loss).
    const early: Array<{ subscription?: unknown; result?: unknown }> = [];
    const MAX_EARLY = 1000;
    const sock = net.connect(params.socketPath);
    const subscribeTimer = setTimeout(
      () => finish(new Error("Signal subscribeReceive timed out (socket)")),
      Math.max(1, params.subscribeTimeoutMs ?? DEFAULT_TIMEOUT_MS),
    );
    const onAbort = () => finish(null);
    params.abortSignal?.addEventListener("abort", onAbort, { once: true });
    const finish = (err: Error | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(subscribeTimer);
      params.abortSignal?.removeEventListener("abort", onAbort);
      sock.destroy();
      if (err && !params.abortSignal?.aborted) {
        reject(err);
      } else {
        resolve();
      }
    };

    attachLineReader(
      sock,
      (line) => {
        let msg: ReturnType<typeof parseEnvelope<unknown>>;
        try {
          msg = parseEnvelope<unknown>(line);
        } catch (err) {
          params.log?.(`signal: ignoring unparseable socket line: ${String(err)}`);
          return;
        }
        if (subscription === undefined) {
          if (msg.method === "receive" && msg.params && typeof msg.params === "object") {
            const ep = msg.params as { subscription?: unknown; result?: unknown };
            if (Object.hasOwn(ep, "subscription")) {
              if (early.length >= MAX_EARLY) {
                finish(
                  new Error(
                    "Signal subscribeReceive response not received before notification backlog limit",
                  ),
                );
                return;
              }
              early.push(ep);
              return;
            }
            handleNotification(ep);
            return;
          }
          if (msg.id !== subscribeId) {
            return;
          }
          if (msg.error) {
            finish(
              new Error(
                `Signal subscribeReceive failed: ${msg.error.code ?? "unknown"}: ${msg.error.message ?? ""}`,
              ),
            );
            return;
          }
          if (typeof msg.result !== "number" || !Number.isInteger(msg.result)) {
            finish(new Error("Signal subscribeReceive returned a non-integer subscription id"));
            return;
          }
          subscription = msg.result;
          clearTimeout(subscribeTimer);
          for (const ep of early.splice(0)) {
            handleNotification(ep);
          }
          return;
        }
        if (msg.method !== "receive" || !msg.params || typeof msg.params !== "object") {
          return;
        }
        handleNotification(msg.params as { subscription?: unknown; result?: unknown });
      },
      () => finish(new Error("Signal receive notification exceeded line limit (socket)")),
      params.maxLineBytes ?? SIGNAL_SOCKET_MAX_LINE_BYTES,
    );

    function handleNotification(p: { subscription?: unknown; result?: unknown }): void {
      if (!Object.hasOwn(p, "subscription")) {
        // Auto-subscription notification from a daemon not in manual receive mode. Our own
        // subscription delivers the same message, so skip to avoid double delivery.
        if (!warnedUnwrapped) {
          warnedUnwrapped = true;
          params.log?.(
            "signal: external daemon is not in --receive-mode manual; messages queued while the gateway was down can be lost",
          );
        }
        return;
      }
      if (p.subscription !== subscription || !p.result || typeof p.result !== "object") {
        return;
      }
      const result = p.result as { account?: unknown };
      if (
        filterByAccount &&
        typeof result.account === "string" &&
        result.account !== accountFilter
      ) {
        if (!warnedAccount) {
          warnedAccount = true;
          params.log?.(
            "signal: dropping receive events for another account (multi-account daemon on this socket)",
          );
        }
        return;
      }
      params.onEvent({ event: "receive", data: JSON.stringify(p.result) });
    }

    sock.once("connect", () => {
      connected = true;
      sock.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "subscribeReceive", id: subscribeId })}\n`,
      );
    });
    sock.once("error", (err) => {
      finish(
        connected
          ? new Error(`Signal socket error: ${err.message}`)
          : describeConnectError(params.socketPath, err),
      );
    });
    sock.once("close", () => {
      if (subscription === undefined) {
        finish(new Error("Signal socket closed before subscribeReceive response"));
      } else {
        finish(null);
      }
    });
  });
}
