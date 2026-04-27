import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SignalArchiveRawConfig } from "../config/types.signal.js";
import type { RuntimeEnv } from "../runtime.js";
import type { SignalDaemonExitEvent, SignalDaemonHandle } from "./daemon.js";

const DEFAULT_BINARY = "signalcli-archive-raw";
const DEFAULT_ENDPOINT_FILE = "~/.signal-archive/endpoint.json";

export type ResolvedArchiveRawSettings = {
  enabled: boolean;
  binary: string;
  endpointFile: string;
  log?: string;
  portMin?: number;
  portMax?: number;
};

export function resolveArchiveRawSettings(
  raw: SignalArchiveRawConfig | undefined,
): ResolvedArchiveRawSettings {
  if (raw === undefined || raw === false) {
    return {
      enabled: false,
      binary: DEFAULT_BINARY,
      endpointFile: expandUserPath(DEFAULT_ENDPOINT_FILE),
    };
  }
  if (raw === true) {
    return {
      enabled: true,
      binary: DEFAULT_BINARY,
      endpointFile: expandUserPath(DEFAULT_ENDPOINT_FILE),
    };
  }
  const enabled = raw.enabled !== false;
  return {
    enabled,
    binary: raw.binary?.trim() || DEFAULT_BINARY,
    endpointFile: expandUserPath(raw.endpointFile?.trim() || DEFAULT_ENDPOINT_FILE),
    log: raw.log?.trim() || undefined,
    portMin: raw.portMin,
    portMax: raw.portMax,
  };
}

function expandUserPath(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

export type ArchiveSupervisorOpts = {
  settings: ResolvedArchiveRawSettings;
  account?: string;
  runtime?: RuntimeEnv;
};

// Spawn signalcli-archive-raw as a managed child. The supervisor binary
// itself spawns signal-cli internally and runs a tee proxy on a randomised
// port; freeclaw discovers the proxy URL by reading the endpoint file
// once it appears.
export function spawnArchiveSupervisor(opts: ArchiveSupervisorOpts): SignalDaemonHandle {
  const args: string[] = [];
  if (opts.account) {
    args.push("-a", opts.account);
  }
  args.push("--endpoint", opts.settings.endpointFile);
  if (opts.settings.log) {
    args.push("--log", opts.settings.log);
  }
  if (typeof opts.settings.portMin === "number") {
    args.push("--port-min", String(opts.settings.portMin));
  }
  if (typeof opts.settings.portMax === "number") {
    args.push("--port-max", String(opts.settings.portMax));
  }

  const log = opts.runtime?.log ?? (() => {});
  const error = opts.runtime?.error ?? (() => {});
  const child = spawn(opts.settings.binary, args, { stdio: ["ignore", "pipe", "pipe"] });

  const forwardLines = (
    stream: NodeJS.ReadableStream | null | undefined,
    kind: "log" | "error",
  ) => {
    stream?.on("data", (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        const formatted = `archive-raw: ${trimmed}`;
        if (kind === "error") {
          error(formatted);
        } else {
          log(formatted);
        }
      }
    });
  };
  forwardLines(child.stdout, "log");
  forwardLines(child.stderr, "log");

  let exited = false;
  let settled = false;
  let resolveExit!: (value: SignalDaemonExitEvent) => void;
  const exitedPromise = new Promise<SignalDaemonExitEvent>((resolve) => {
    resolveExit = resolve;
  });
  const settle = (value: SignalDaemonExitEvent) => {
    if (settled) {
      return;
    }
    settled = true;
    exited = true;
    resolveExit(value);
  };

  child.once("exit", (code, signal) => {
    settle({
      source: "process",
      code: typeof code === "number" ? code : null,
      signal: signal ?? null,
    });
  });
  child.once("close", (code, signal) => {
    settle({
      source: "process",
      code: typeof code === "number" ? code : null,
      signal: signal ?? null,
    });
  });
  child.on("error", (err) => {
    error(`archive-raw spawn error: ${String(err)}`);
    settle({ source: "spawn-error", code: null, signal: null });
  });

  return {
    pid: child.pid ?? undefined,
    exited: exitedPromise,
    isExited: () => exited,
    stop: () => {
      if (!child.killed && !exited) {
        child.kill("SIGTERM");
      }
    },
  };
}

export type WaitForEndpointFileOpts = {
  path: string;
  timeoutMs: number;
  pollIntervalMs?: number;
  abortSignal?: AbortSignal;
};

// Poll for the endpoint discovery file written by archive-raw on startup.
// Resolves with its baseUrl, throws on timeout or supervisor exit.
export async function waitForEndpointFile(opts: WaitForEndpointFileOpts): Promise<string> {
  const interval = opts.pollIntervalMs ?? 100;
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    if (opts.abortSignal?.aborted) {
      throw new Error("archive-raw endpoint wait aborted");
    }
    if (existsSync(opts.path)) {
      try {
        return readBaseUrlFromEndpointFile(opts.path);
      } catch {
        // File appeared but is partially written; retry on next tick.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(
    `Timed out after ${opts.timeoutMs}ms waiting for archive-raw endpoint file at ${opts.path}. Is signalcli-archive-raw on PATH and able to spawn signal-cli?`,
  );
}

export function readBaseUrlFromEndpointFile(path: string): string {
  const contents = readFileSync(path, "utf8");
  const parsed: unknown = JSON.parse(contents);
  const baseUrl =
    parsed && typeof parsed === "object" && "baseUrl" in parsed
      ? (parsed as { baseUrl?: unknown }).baseUrl
      : undefined;
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    throw new Error(`archive-raw endpoint file at ${path} is missing a string "baseUrl" field`);
  }
  return baseUrl.trim();
}
