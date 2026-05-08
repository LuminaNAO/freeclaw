import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAccountListHelpers } from "../channels/plugins/account-helpers.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SignalAccountConfig } from "../config/types.js";
import { resolveAccountEntry } from "../routing/account-lookup.js";
import { normalizeAccountId } from "../routing/session-key.js";

function expandUserPath(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

// Read a discovery JSON written by an external supervisor (e.g.
// signalcli-archive-raw) and return its baseUrl. Synchronous because account
// resolution itself is synchronous and runs once at channel start; the file
// is small and local.
function readEndpointFile(rawPath: string): string {
  const path = expandUserPath(rawPath.trim());
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      throw new Error(
        `Signal httpEndpointFile not found at ${path}. Is the external signal-cli supervisor (e.g. signalcli-archive-raw) running?`,
        { cause: err },
      );
    }
    throw new Error(`Failed to read Signal httpEndpointFile at ${path}: ${String(err)}`, {
      cause: err,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (err) {
    throw new Error(`Signal httpEndpointFile at ${path} is not valid JSON: ${String(err)}`, {
      cause: err,
    });
  }
  const baseUrl =
    parsed && typeof parsed === "object" && "baseUrl" in parsed
      ? (parsed as { baseUrl?: unknown }).baseUrl
      : undefined;
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    throw new Error(`Signal httpEndpointFile at ${path} is missing a string "baseUrl" field`);
  }
  return baseUrl.trim();
}

export type ResolvedSignalAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  baseUrl: string;
  configured: boolean;
  config: SignalAccountConfig;
};

const { listAccountIds, resolveDefaultAccountId } = createAccountListHelpers("signal");
export const listSignalAccountIds = listAccountIds;
export const resolveDefaultSignalAccountId = resolveDefaultAccountId;

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): SignalAccountConfig | undefined {
  return resolveAccountEntry(cfg.channels?.signal?.accounts, accountId);
}

function mergeSignalAccountConfig(cfg: OpenClawConfig, accountId: string): SignalAccountConfig {
  const { accounts: _ignored, ...base } = (cfg.channels?.signal ?? {}) as SignalAccountConfig & {
    accounts?: unknown;
  };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

export function resolveSignalAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedSignalAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.channels?.signal?.enabled !== false;
  const merged = mergeSignalAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const host = merged.httpHost?.trim() || "127.0.0.1";
  // Legacy placeholder used before local auto-start persists a free port.
  const port = merged.httpPort ?? 8080;
  // Precedence: httpEndpointFile (dynamic, from external supervisor) >
  // httpUrl (static config) > httpHost:httpPort (default).
  // When archiveRaw is enabled, defer file resolution: the file does not
  // exist until the supervisor spawns. monitor.ts re-reads it post-spawn
  // and overrides baseUrl for downstream use.
  const archiveRawDeferred =
    merged.archiveRaw === true ||
    (typeof merged.archiveRaw === "object" && merged.archiveRaw?.enabled !== false);
  const baseUrl =
    (merged.httpEndpointFile?.trim() && !archiveRawDeferred
      ? readEndpointFile(merged.httpEndpointFile)
      : undefined) ||
    merged.httpUrl?.trim() ||
    `http://${host}:${port}`;
  const configured = Boolean(
    merged.account?.trim() ||
    merged.httpUrl?.trim() ||
    merged.httpEndpointFile?.trim() ||
    merged.cliPath?.trim() ||
    merged.httpHost?.trim() ||
    typeof merged.httpPort === "number" ||
    typeof merged.autoStart === "boolean" ||
    merged.archiveRaw !== undefined,
  );
  return {
    accountId,
    enabled,
    name: merged.name?.trim() || undefined,
    baseUrl,
    configured,
    config: merged,
  };
}

export function listEnabledSignalAccounts(cfg: OpenClawConfig): ResolvedSignalAccount[] {
  return listSignalAccountIds(cfg)
    .map((accountId) => resolveSignalAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
