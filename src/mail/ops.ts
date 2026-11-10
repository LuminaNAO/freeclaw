// One ops core for mail connectors (docs/design/mail-push.md §2, §7): the gateway methods
// `mail.connectors.{list,status,test,restart}` and the CLI `openclaw mail connectors ...` share
// these request/report shapes; the CLI prints the method result as-is with --json.
import type { MailConnectorStatus } from "./connector.js";
import type { MailConnectorManager, MailConnectorSummary } from "./manager.js";

export const MAIL_CONNECTOR_METHODS = {
  list: "mail.connectors.list",
  status: "mail.connectors.status",
  test: "mail.connectors.test",
  restart: "mail.connectors.restart",
} as const;

export type MailConnectorVerb = keyof typeof MAIL_CONNECTOR_METHODS;

export type MailConnectorsListReport = { connectors: MailConnectorSummary[] };
export type MailConnectorsStatusReport = { now: number; connectors: MailConnectorStatus[] };
export type MailConnectorsTestReport = { id: string; ok: boolean; detail: string };
export type MailConnectorsRestartReport = {
  id: string;
  restarted: true;
  status: MailConnectorStatus;
};

export type MailConnectorsReport =
  | MailConnectorsListReport
  | MailConnectorsStatusReport
  | MailConnectorsTestReport
  | MailConnectorsRestartReport;

/** Reads a connector id from method params; undefined when absent, error text when invalid. */
export function readConnectorIdParam(
  params: Record<string, unknown>,
  required: boolean,
): { id?: string } | { error: string } {
  const raw = params.id;
  if (raw === undefined || raw === null || raw === "") {
    return required ? { error: "id required" } : {};
  }
  if (typeof raw !== "string" || !/^[a-z0-9-]{1,64}$/.test(raw.trim())) {
    return { error: "id must be a connector id ([a-z0-9-])" };
  }
  return { id: raw.trim() };
}

/** Runs one verb against the manager (the gateway method body). */
export async function runMailConnectorOp(
  manager: MailConnectorManager,
  verb: MailConnectorVerb,
  id?: string,
): Promise<MailConnectorsReport> {
  switch (verb) {
    case "list":
      return { connectors: manager.list() };
    case "status":
      return { now: Date.now(), connectors: manager.status(id) };
    case "test":
      return await manager.test(requireId(verb, id));
    case "restart": {
      const connectorId = requireId(verb, id);
      return { id: connectorId, restarted: true, status: await manager.restart(connectorId) };
    }
  }
  throw new Error(`unknown mail connectors verb "${String(verb)}"`);
}

function requireId(verb: string, id: string | undefined): string {
  if (!id) {
    throw new Error(`mail connectors ${verb}: id required`);
  }
  return id;
}

function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 120) {
    return `${seconds}s`;
  }
  const minutes = Math.round(seconds / 60);
  return minutes < 120 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

/** Human-readable lines for the CLI (the --json output is the report itself). */
export function formatMailConnectorsReport(
  verb: MailConnectorVerb,
  report: MailConnectorsReport,
): string[] {
  if (verb === "list") {
    const { connectors } = report as MailConnectorsListReport;
    if (connectors.length === 0) {
      return ["No mail connectors configured (mail.connectors)."];
    }
    return connectors.map((c) => {
      const sessions = c.sessions.map((s) => `${s.sessionKey} (${s.wakeMode})`).join(", ");
      const account = c.account ? ` ${c.account}` : "";
      return `${c.id}: ${c.provider}${account} [${c.folders.join(", ")}] ${c.state} -> ${sessions}`;
    });
  }
  if (verb === "status") {
    const { connectors, now } = report as MailConnectorsStatusReport;
    if (connectors.length === 0) {
      return ["No mail connectors configured (mail.connectors)."];
    }
    return connectors.map((c) => {
      const parts = [`${c.id}: ${c.state} for ${formatAge(now - c.stateSince)}`];
      if (c.detail) {
        parts.push(`(${c.detail})`);
      }
      if (c.lastEventAt) {
        parts.push(`last event ${formatAge(now - c.lastEventAt)} ago`);
      }
      if (c.pending > 0) {
        parts.push(`${c.pending} pending`);
      }
      if (c.lastError) {
        parts.push(`last error ${formatAge(now - c.lastError.at)} ago: ${c.lastError.message}`);
      }
      return parts.join(" ");
    });
  }
  if (verb === "test") {
    const r = report as MailConnectorsTestReport;
    return [`${r.id}: ${r.ok ? "ok" : "FAILED"} - ${r.detail}`];
  }
  const r = report as MailConnectorsRestartReport;
  return [`${r.id}: restarted, ${r.status.state}`];
}
