import { randomInt } from "node:crypto";
import net from "node:net";
import type { OpenClawConfig } from "../config/config.js";
import { writeConfigFile } from "../config/config.js";
import { resolveAccountEntry } from "../routing/account-lookup.js";

export const SIGNAL_HTTP_PORT_MIN = 56_000;
export const SIGNAL_HTTP_PORT_MAX = 56_999;

export function isPreferredSignalHttpPort(port: number): boolean {
  return Number.isInteger(port) && port >= SIGNAL_HTTP_PORT_MIN && port <= SIGNAL_HTTP_PORT_MAX;
}

export async function pickSignalHttpPort(params?: {
  host?: string;
  min?: number;
  max?: number;
  attempts?: number;
}): Promise<number> {
  const host = params?.host?.trim() || "127.0.0.1";
  const min = Math.max(1, Math.min(params?.min ?? SIGNAL_HTTP_PORT_MIN, 65_534));
  const max = Math.max(min, Math.min(params?.max ?? SIGNAL_HTTP_PORT_MAX, 65_534));
  const attempts = Math.max(1, params?.attempts ?? max - min + 1);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const port = randomInt(min, max + 1);
    if (port !== 8080 && (await listenForFreePort(host, port))) {
      return port;
    }
  }
  throw new Error("failed to allocate a random Signal HTTP port");
}

async function listenForFreePort(host: string, port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

function resolveSignalAccountConfigTarget(
  cfg: OpenClawConfig,
  accountId: string,
): Record<string, unknown> | undefined {
  const signal = cfg.channels?.signal as
    | (Record<string, unknown> & {
        accounts?: Record<string, Record<string, unknown>>;
      })
    | undefined;
  if (!signal) {
    return undefined;
  }
  const accounts = signal.accounts;
  if (!accounts) {
    return signal;
  }
  const account = resolveAccountEntry(accounts, accountId);
  if (!account) {
    return signal;
  }
  const accountKey = Object.keys(accounts).find(
    (key) => key.toLowerCase() === accountId.toLowerCase(),
  );
  if (!accountKey) {
    return signal;
  }
  return accounts[accountKey];
}

export async function persistSignalHttpPort(params: {
  cfg: OpenClawConfig;
  accountId: string;
  port: number;
}): Promise<void> {
  const nextConfig = structuredClone(params.cfg);
  const signalConfig = resolveSignalAccountConfigTarget(nextConfig, params.accountId);
  if (!signalConfig) {
    return;
  }
  signalConfig.httpPort = params.port;
  await writeConfigFile(nextConfig);
}
