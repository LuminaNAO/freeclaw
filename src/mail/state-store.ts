// Per-connector state file (docs/design/mail-push.md §6): `<stateDir>/mail/<id>.json` holds the
// cursor, the last event time and the last error. Never mail content, addresses or secrets.
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { writeJsonAtomic } from "../infra/json-files.js";
import type { MailConnectorStateName, MailCursor } from "./types.js";

export type MailConnectorStateFile = {
  version: 1;
  connectorId: string;
  cursor: MailCursor | null;
  /** Last batch accepted by every attached session (epoch ms). */
  lastEventAt?: number;
  lastEventCount?: number;
  /** Last connector state and when it was entered (epoch ms). */
  state?: MailConnectorStateName;
  stateSince?: number;
  /** Since when the connector is in backoff/auth-failed without a successful connect between. */
  troubleSince?: number;
  lastError?: { at: number; message: string };
  updatedAt: number;
};

export function resolveMailStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "mail");
}

export function resolveMailStatePath(
  connectorId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveMailStateDir(env), `${connectorId}.json`);
}

function isCursor(value: unknown): value is MailCursor {
  if (!value || typeof value !== "object") {
    return false;
  }
  const folders = (value as { folders?: unknown }).folders;
  if (!folders || typeof folders !== "object") {
    return false;
  }
  return Object.values(folders as Record<string, unknown>).every(
    (entry) =>
      !!entry &&
      typeof entry === "object" &&
      typeof (entry as { uidValidity?: unknown }).uidValidity === "string" &&
      typeof (entry as { lastUid?: unknown }).lastUid === "number",
  );
}

export async function readMailConnectorState(
  filePath: string,
): Promise<MailConnectorStateFile | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<MailConnectorStateFile>;
    if (!parsed || typeof parsed !== "object" || typeof parsed.connectorId !== "string") {
      return null;
    }
    return {
      version: 1,
      connectorId: parsed.connectorId,
      cursor: isCursor(parsed.cursor) ? parsed.cursor : null,
      lastEventAt: typeof parsed.lastEventAt === "number" ? parsed.lastEventAt : undefined,
      lastEventCount: typeof parsed.lastEventCount === "number" ? parsed.lastEventCount : undefined,
      state: typeof parsed.state === "string" ? parsed.state : undefined,
      stateSince: typeof parsed.stateSince === "number" ? parsed.stateSince : undefined,
      troubleSince: typeof parsed.troubleSince === "number" ? parsed.troubleSince : undefined,
      lastError:
        parsed.lastError && typeof parsed.lastError.message === "string"
          ? { at: parsed.lastError.at || 0, message: parsed.lastError.message }
          : undefined,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

export async function writeMailConnectorState(
  filePath: string,
  state: MailConnectorStateFile,
): Promise<void> {
  await writeJsonAtomic(filePath, state, { mode: 0o600, ensureDirMode: 0o700 });
}
