import { splitArgsPreservingQuotes } from "./arg-split.js";
import type { GatewayServiceRenderArgs } from "./service-types.js";

const SYSTEMD_LINE_BREAKS = /[\r\n]/;

function assertNoSystemdLineBreaks(value: string, label: string): void {
  if (SYSTEMD_LINE_BREAKS.test(value)) {
    throw new Error(`${label} cannot contain CR or LF characters.`);
  }
}

function systemdEscapeArg(value: string): string {
  assertNoSystemdLineBreaks(value, "Systemd unit values");
  if (!/[\s"\\]/.test(value)) {
    return value;
  }
  return `"${value.replace(/\\\\/g, "\\\\\\\\").replace(/"/g, '\\\\"')}"`;
}

function renderEnvLines(env: Record<string, string | undefined> | undefined): string[] {
  if (!env) {
    return [];
  }
  const entries = Object.entries(env).filter(
    ([, value]) => typeof value === "string" && value.trim(),
  );
  if (entries.length === 0) {
    return [];
  }
  return entries.map(([key, value]) => {
    const rawValue = value ?? "";
    assertNoSystemdLineBreaks(key, "Systemd environment variable names");
    assertNoSystemdLineBreaks(rawValue, "Systemd environment variable values");
    return `Environment=${systemdEscapeArg(`${key}=${rawValue.trim()}`)}`;
  });
}

export function buildSystemdUnit({
  description,
  programArguments,
  workingDirectory,
  environment,
}: GatewayServiceRenderArgs): string {
  const execStart = programArguments.map(systemdEscapeArg).join(" ");
  const descriptionValue = description?.trim() || "OpenClaw Gateway";
  assertNoSystemdLineBreaks(descriptionValue, "Systemd Description");
  const descriptionLine = `Description=${descriptionValue}`;
  const workingDirLine = workingDirectory
    ? `WorkingDirectory=${systemdEscapeArg(workingDirectory)}`
    : null;
  const envLines = renderEnvLines(environment);
  return [
    "[Unit]",
    descriptionLine,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    `ExecStart=${execStart}`,
    "Restart=always",
    "RestartSec=5",
    "TimeoutStopSec=30",
    "TimeoutStartSec=30",
    "SuccessExitStatus=0 143",
    // Keep service children in the same lifecycle so restarts do not leave
    // orphan ACP/runtime workers behind.
    "KillMode=control-group",
    workingDirLine,
    ...envLines,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

export function parseSystemdExecStart(value: string): string[] {
  return splitArgsPreservingQuotes(value, { escapeMode: "backslash" });
}

export function parseSystemdEnvAssignment(raw: string): { key: string; value: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const unquoted = (() => {
    if (!(trimmed.startsWith('"') && trimmed.endsWith('"'))) {
      return trimmed;
    }
    let out = "";
    let escapeNext = false;
    for (const ch of trimmed.slice(1, -1)) {
      if (escapeNext) {
        out += ch;
        escapeNext = false;
        continue;
      }
      if (ch === "\\\\") {
        escapeNext = true;
        continue;
      }
      out += ch;
    }
    return out;
  })();

  const eq = unquoted.indexOf("=");
  if (eq <= 0) {
    return null;
  }
  const key = unquoted.slice(0, eq).trim();
  if (!key) {
    return null;
  }
  const value = unquoted.slice(eq + 1);
  return { key, value };
}

/** The KillMode every gateway unit must use (signal-daemon-lifecycle ARCH §3.4). */
export const SYSTEMD_REQUIRED_KILL_MODE = "control-group";

/**
 * Effective KillMode set in the [Service] section of a unit or drop-in, or undefined when the
 * file does not set it. Later assignments win, like systemd; an empty assignment resets.
 */
export function readSystemdKillMode(content: string): string | undefined {
  let section = "";
  let killMode: string | undefined;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    if (line.startsWith("[")) {
      section = line;
      continue;
    }
    if (section !== "[Service]") {
      continue;
    }
    const match = /^KillMode\s*=\s*(.*)$/.exec(line);
    if (match) {
      killMode = match[1].trim() || undefined;
    }
  }
  return killMode;
}

/**
 * Rewrite a unit so its [Service] section has exactly `KillMode=control-group`: existing
 * KillMode lines in [Service] are replaced (the first) or dropped (the rest); a unit without
 * one gets it appended to [Service]. Everything else is kept byte for byte.
 */
export function rewriteSystemdKillMode(content: string): string {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  let section = "";
  let wrote = false;
  let serviceEnd = -1;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      if (section === "[Service]") {
        serviceEnd = out.length;
      }
      section = line;
      out.push(rawLine);
      continue;
    }
    if (section === "[Service]" && /^KillMode\s*=/.test(line)) {
      if (!wrote) {
        out.push(`KillMode=${SYSTEMD_REQUIRED_KILL_MODE}`);
        wrote = true;
      }
      continue;
    }
    out.push(rawLine);
  }
  if (!wrote) {
    if (section === "[Service]") {
      serviceEnd = out.length;
    }
    const line = `KillMode=${SYSTEMD_REQUIRED_KILL_MODE}`;
    if (serviceEnd < 0) {
      // No [Service] section at all: append one.
      while (out.length > 0 && out[out.length - 1] === "") {
        out.pop();
      }
      out.push("", "[Service]", line, "");
    } else {
      // Insert before the blank lines that close the [Service] section.
      let at = serviceEnd;
      while (at > 0 && out[at - 1].trim() === "") {
        at -= 1;
      }
      out.splice(at, 0, line);
    }
  }
  return out.join(eol);
}
