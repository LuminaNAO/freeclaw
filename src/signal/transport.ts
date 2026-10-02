import { homedir } from "node:os";
import path from "node:path";
import type { SignalAccountConfig } from "../config/types.signal.js";

export type SignalTransportKind = "socket" | "http";

export type ResolvedSignalTransport =
  | {
      kind: "socket";
      /** Explicit socketPath from config (absolute, `~/` expanded), or undefined for the managed default. */
      socketPath?: string;
      socketGroup?: string;
      /** httpHost/httpPort were present but ignored because socket is the default. */
      ignoredHttpKeys: boolean;
    }
  | { kind: "http" };

export const SIGNAL_UNIX_ENDPOINT_PREFIX = "unix:";

export class SignalTransportConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignalTransportConfigError";
  }
}

function expandUserPath(raw: string): string {
  if (raw === "~") {
    return homedir();
  }
  if (raw.startsWith("~/")) {
    return path.join(homedir(), raw.slice(2));
  }
  return raw;
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function archiveRawEnabled(value: SignalAccountConfig["archiveRaw"]): boolean {
  if (value === undefined || value === false) {
    return false;
  }
  if (value === true) {
    return true;
  }
  return value.enabled !== false;
}

/**
 * Resolve which transport an account uses. Socket is the default for daemons freeclaw
 * spawns; HTTP needs explicit intent. Conflicting keys throw instead of silently picking
 * the wider (TCP) transport.
 */
export function resolveSignalTransport(
  config: SignalAccountConfig,
  platform: NodeJS.Platform = process.platform,
): ResolvedSignalTransport {
  const httpOnlyKeys: string[] = [];
  if (hasText(config.httpUrl)) {
    httpOnlyKeys.push("httpUrl");
  }
  if (hasText(config.httpEndpointFile)) {
    httpOnlyKeys.push("httpEndpointFile");
  }
  if (archiveRawEnabled(config.archiveRaw)) {
    httpOnlyKeys.push("archiveRaw");
  }
  const socketKeys: string[] = [];
  if (hasText(config.socketPath)) {
    socketKeys.push("socketPath");
  }
  if (hasText(config.socketGroup)) {
    socketKeys.push("socketGroup");
  }

  if (config.transport === "socket" && httpOnlyKeys.length > 0) {
    throw new SignalTransportConfigError(
      `channels.signal: transport "socket" conflicts with ${httpOnlyKeys.join(", ")}; remove them or set transport "http"`,
    );
  }
  if (config.transport === "http" && socketKeys.length > 0) {
    throw new SignalTransportConfigError(
      `channels.signal: transport "http" conflicts with ${socketKeys.join(", ")}; remove them or set transport "socket"`,
    );
  }
  if (socketKeys.length > 0 && httpOnlyKeys.length > 0) {
    throw new SignalTransportConfigError(
      `channels.signal: ${socketKeys.join(", ")} conflicts with ${httpOnlyKeys.join(", ")}; configure exactly one transport`,
    );
  }

  const socketPath = hasText(config.socketPath)
    ? expandUserPath(config.socketPath.trim())
    : undefined;
  if (socketPath !== undefined && !path.isAbsolute(socketPath)) {
    throw new SignalTransportConfigError(
      `channels.signal.socketPath must be an absolute path (got "${config.socketPath}")`,
    );
  }
  const socketGroup = hasText(config.socketGroup) ? config.socketGroup.trim() : undefined;
  const ignoredHttpKeys = hasText(config.httpHost) || typeof config.httpPort === "number";
  const socket = (): ResolvedSignalTransport => ({
    kind: "socket",
    socketPath,
    socketGroup,
    ignoredHttpKeys,
  });

  if (config.transport === "socket") {
    return socket();
  }
  if (config.transport === "http") {
    return { kind: "http" };
  }
  if (httpOnlyKeys.length > 0) {
    return { kind: "http" };
  }
  if (socketPath !== undefined) {
    return socket();
  }
  // A self-managed daemon (autoStart:false) without socketPath can only be the legacy
  // HTTP daemon at httpHost:httpPort; flipping it would silently break the upgrader.
  if (config.autoStart === false) {
    return { kind: "http" };
  }
  if (platform === "win32") {
    return { kind: "http" };
  }
  if (socketGroup !== undefined) {
    return socket();
  }
  // Default flip: persisted httpHost/httpPort are freeclaw-written, not operator intent.
  return socket();
}

export function formatSignalUnixEndpoint(socketPath: string): string {
  return `${SIGNAL_UNIX_ENDPOINT_PREFIX}${socketPath}`;
}

/** Returns the socket path for a `unix:` endpoint, undefined for anything else. */
export function parseSignalUnixEndpoint(endpoint: string): string | undefined {
  const trimmed = endpoint.trim();
  if (!trimmed.toLowerCase().startsWith(SIGNAL_UNIX_ENDPOINT_PREFIX)) {
    return undefined;
  }
  const socketPath = trimmed.slice(SIGNAL_UNIX_ENDPOINT_PREFIX.length);
  if (!socketPath || !path.isAbsolute(socketPath)) {
    throw new Error(`Signal unix endpoint must use an absolute socket path (got "${endpoint}")`);
  }
  return socketPath;
}
