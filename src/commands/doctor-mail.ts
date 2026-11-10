// `openclaw doctor` mail connector check (docs/design/mail-push.md §7): flags connectors in
// auth-failed, or in backoff for more than 15 minutes. Reads the state files the gateway writes
// (`<stateDir>/mail/<id>.json`), so it works whether or not the gateway is reachable.
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  type MailConnectorStateFile,
  readMailConnectorState,
  resolveMailStatePath,
} from "../mail/state-store.js";
import { note } from "../terminal/note.js";

export const MAIL_BACKOFF_WARN_MS = 15 * 60_000;

export type MailDoctorFinding = {
  id: string;
  state: "auth-failed" | "backoff";
  sinceMs: number;
  lastError?: string;
};

function minutes(ms: number): string {
  return `${Math.max(1, Math.round(ms / 60_000))} min`;
}

/** Connectors that need attention, from their state files. */
export async function collectMailDoctorFindings(params: {
  cfg: OpenClawConfig;
  now?: number;
  readState?: (id: string) => Promise<MailConnectorStateFile | null>;
}): Promise<MailDoctorFinding[]> {
  const now = params.now ?? Date.now();
  const readState =
    params.readState ?? ((id: string) => readMailConnectorState(resolveMailStatePath(id)));
  const findings: MailDoctorFinding[] = [];
  for (const connector of params.cfg.mail?.connectors ?? []) {
    if (connector.enabled === false) {
      continue;
    }
    const state = await readState(connector.id);
    if (!state?.state) {
      continue;
    }
    const since = state.troubleSince ?? state.stateSince ?? state.updatedAt;
    if (state.state === "auth-failed") {
      findings.push({
        id: connector.id,
        state: "auth-failed",
        sinceMs: now - since,
        ...(state.lastError ? { lastError: state.lastError.message } : {}),
      });
    } else if (state.state === "backoff" && now - since > MAIL_BACKOFF_WARN_MS) {
      findings.push({
        id: connector.id,
        state: "backoff",
        sinceMs: now - since,
        ...(state.lastError ? { lastError: state.lastError.message } : {}),
      });
    }
  }
  return findings;
}

export function formatMailDoctorFindings(findings: MailDoctorFinding[]): string[] {
  return findings.map((finding) => {
    const why = finding.lastError ? ` (${finding.lastError})` : "";
    if (finding.state === "auth-failed") {
      return (
        `- mail connector "${finding.id}" is auth-failed${why}; fix the password secret, then run ` +
        formatCliCommand(`openclaw mail connectors restart ${finding.id}`)
      );
    }
    return (
      `- mail connector "${finding.id}" has been retrying for ${minutes(finding.sinceMs)}${why}; check with ` +
      formatCliCommand(`openclaw mail connectors test ${finding.id}`)
    );
  });
}

export async function noteMailConnectorHealth(cfg: OpenClawConfig): Promise<void> {
  if ((cfg.mail?.connectors?.length ?? 0) === 0) {
    return;
  }
  const findings = await collectMailDoctorFindings({ cfg });
  if (findings.length > 0) {
    note(formatMailDoctorFindings(findings).join("\n"), "Mail connectors");
  }
}
