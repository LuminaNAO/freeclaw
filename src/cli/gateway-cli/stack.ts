// `openclaw gateway stack` and `openclaw gateway stack drop` (docs/design/durable-inbox.md §7).
// Both read the stack files directly, so they work with the gateway up or down.
import { readBestEffortConfig, resolveGatewayPort } from "../../config/config.js";
import { findVerifiedGatewayListenerPidsOnPortSync } from "../../infra/gateway-processes.js";
import { deleteStackFiles, listStack, type StackEntry } from "../../infra/session-stack.js";
import { defaultRuntime } from "../../runtime.js";
import { runDaemonStop } from "../daemon-cli.js";
import { promptYesNo } from "../prompt.js";

function promptText(entry: StackEntry): string {
  const payload = entry.content.payload as {
    ctx?: { Body?: unknown };
    params?: { message?: unknown };
  };
  const raw = entry.content.source === "agent" ? payload?.params?.message : payload?.ctx?.Body;
  return typeof raw === "string" ? raw : "";
}

function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)}m`;
  }
  if (s < 86_400) {
    return `${Math.floor(s / 3600)}h`;
  }
  return `${Math.floor(s / 86_400)}d`;
}

export function formatStackLines(now: number = Date.now()): string[] {
  const sessions = listStack();
  if (sessions.length === 0) {
    return ["Session stack is empty."];
  }
  return sessions.map((session) => {
    const oldest = session.entries[0];
    const preview = promptText(oldest).replace(/\s+/g, " ").slice(0, 80);
    return `${session.sessionKey}  files=${session.entries.length}  oldest=${formatAge(now - oldest.arrivalMs)}  ${JSON.stringify(preview)}`;
  });
}

export async function runGatewayStack(): Promise<void> {
  for (const line of formatStackLines()) {
    defaultRuntime.log(line);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pids: number[], timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pids.some(isAlive)) {
    if (Date.now() > deadline) {
      throw new Error(`gateway did not stop within ${timeoutMs / 1000}s; nothing dropped`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function waitForPortFree(port: number, cause: unknown, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (findVerifiedGatewayListenerPidsOnPortSync(port).length === 0) {
        return;
      }
    } catch (err) {
      cause = err;
    }
    if (Date.now() > deadline) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`${detail}; nothing dropped`, { cause });
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export async function runGatewayStackDrop(opts: { yes?: boolean }): Promise<void> {
  if (!opts.yes) {
    const ok = await promptYesNo(
      "Stop the gateway and delete every session stack file (nothing will be replayed)?",
    );
    if (!ok) {
      defaultRuntime.log("Aborted.");
      return;
    }
  }
  const port = resolveGatewayPort(await readBestEffortConfig().catch(() => undefined));
  // An unattributable port owner must not block a service-managed stop (ARCH
  // gateway-process-title-discovery §2.3); runDaemonStop refuses the unmanaged case itself
  // (§2.2), and nothing is dropped until the port is confirmed free.
  let ownerUnknown: unknown = null;
  let pids: number[] = [];
  try {
    pids = findVerifiedGatewayListenerPidsOnPortSync(port);
  } catch (err) {
    ownerUnknown = err;
  }
  await runDaemonStop();
  // Delete only once the gateway is gone, so it cannot write or replay meanwhile.
  await waitForExit(pids);
  if (ownerUnknown) {
    await waitForPortFree(port, ownerUnknown);
  }
  const sessions = listStack();
  if (sessions.length === 0) {
    defaultRuntime.log("Dropped 0 prompt(s).");
    return;
  }
  for (const session of sessions) {
    deleteStackFiles(session.entries.map((e) => e.file));
    defaultRuntime.log(`${session.sessionKey}  dropped=${session.entries.length}`);
  }
}
