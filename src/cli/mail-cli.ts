// `openclaw mail connectors list|status [id]|test <id>|restart <id>` (docs/design/mail-push.md
// §7): a thin frontend over the gateway methods `mail.connectors.*`. Every verb maps to exactly
// one method; --json prints the method result unchanged.
import type { Command } from "commander";
import { danger } from "../globals.js";
import {
  formatMailConnectorsReport,
  MAIL_CONNECTOR_METHODS,
  type MailConnectorsReport,
  type MailConnectorVerb,
} from "../mail/ops.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { addGatewayClientOptions, callGatewayFromCli, type GatewayRpcOpts } from "./gateway-rpc.js";

export type MailCliOpts = GatewayRpcOpts & { json?: boolean };

/** Runs one verb through its gateway method and prints the report (or the JSON as-is). */
export async function runMailConnectorsCli(params: {
  verb: MailConnectorVerb;
  id?: string;
  opts: MailCliOpts;
}): Promise<MailConnectorsReport> {
  const method = MAIL_CONNECTOR_METHODS[params.verb];
  const methodParams = params.id ? { id: params.id } : {};
  const report = (await callGatewayFromCli(
    method,
    params.opts,
    methodParams,
  )) as MailConnectorsReport;
  if (params.opts.json) {
    defaultRuntime.log(JSON.stringify(report, null, 2));
  } else {
    for (const line of formatMailConnectorsReport(params.verb, report)) {
      defaultRuntime.log(line);
    }
  }
  if (params.verb === "test" && (report as { ok?: boolean }).ok === false) {
    defaultRuntime.exit(1);
  }
  return report;
}

function action(verb: MailConnectorVerb) {
  return async (...args: unknown[]) => {
    const takesId = verb !== "list";
    const id = takesId && typeof args[0] === "string" ? args[0] : undefined;
    const opts = (takesId ? args[1] : args[0]) as MailCliOpts;
    try {
      await runMailConnectorsCli({ verb, id, opts });
    } catch (err) {
      defaultRuntime.error(danger(String(err)));
      defaultRuntime.exit(1);
    }
  };
}

export function registerMailCli(program: Command) {
  const mail = program
    .command("mail")
    .description("Mail push connectors (watch mailboxes, push new mail into sessions)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/automation/mail-push", "docs.openclaw.ai/automation/mail-push")}\n`,
    );
  const connectors = mail.command("connectors").description("Inspect and control mail connectors");

  addGatewayClientOptions(
    connectors
      .command("list")
      .description("List configured mail connectors and their attached sessions")
      .option("--json", "Output JSON", false)
      .action(action("list")),
  );
  addGatewayClientOptions(
    connectors
      .command("status")
      .description("Show connector state, last event and last error")
      .argument("[id]", "Connector id (default: all)")
      .option("--json", "Output JSON", false)
      .action(action("status")),
  );
  addGatewayClientOptions(
    connectors
      .command("test")
      .description("Connect, authenticate and open the folders (read-only, no side effects)")
      .argument("<id>", "Connector id")
      .option("--json", "Output JSON", false)
      .action(action("test")),
  );
  addGatewayClientOptions(
    connectors
      .command("restart")
      .description("Restart a connector (also clears auth-failed)")
      .argument("<id>", "Connector id")
      .option("--json", "Output JSON", false)
      .action(action("restart")),
  );
}
