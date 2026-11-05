// `openclaw gateway focus [status|set <key> [--tier t]|off [<key>|--all]] [--json]`
// (docs/design/focus-mode.md §7.4). Calls the gateway `focus` method (operator
// scope), which runs the same ops function as `/focus`; `--json` prints the same
// report the method returns. `status` falls back to the state on disk when the
// gateway is down (the same ops function, run locally); set/off need the gateway,
// because releasing sessions replays through it (§7.3).
import { readBestEffortConfig } from "../../config/config.js";
import {
  type FocusOpRequest,
  type FocusReport,
  formatFocusReportLines,
  runFocusOp,
} from "../../infra/focus-mode-actions.js";
import { defaultRuntime } from "../../runtime.js";
import { callGatewayCli, type GatewayRpcOpts } from "./call.js";

export type GatewayFocusAction = "set" | "off" | "status";

export const GATEWAY_FOCUS_USAGE =
  "usage: openclaw gateway focus [status|set <session-key> [--tier normal|hyper]|off [<session-key>|--all]] [--json]";

/** The CLI arguments as the method's params (the method parses them as for any client). */
export function buildGatewayFocusParams(params: {
  action: GatewayFocusAction;
  target?: string;
  tier?: string;
  all?: boolean;
}): Record<string, unknown> {
  const target = params.target?.trim();
  const tier = params.tier?.trim();
  if (params.action === "set") {
    if (!target || params.all) {
      throw new Error(GATEWAY_FOCUS_USAGE);
    }
    return { action: "set", target, ...(tier ? { tier } : {}) };
  }
  if (tier) {
    throw new Error(`--tier only applies to set; ${GATEWAY_FOCUS_USAGE}`);
  }
  if (params.action === "off") {
    if (target && params.all) {
      throw new Error(`give a session key or --all, not both; ${GATEWAY_FOCUS_USAGE}`);
    }
    if (!target && !params.all) {
      throw new Error(`off needs a session key or --all; ${GATEWAY_FOCUS_USAGE}`);
    }
    return target ? { action: "off", target } : { action: "off", all: true };
  }
  if (target || params.all) {
    throw new Error(GATEWAY_FOCUS_USAGE);
  }
  return { action: "status" };
}

function print(report: FocusReport, json: boolean | undefined): void {
  if (json) {
    defaultRuntime.log(JSON.stringify(report, null, 2));
    return;
  }
  for (const line of formatFocusReportLines(report)) {
    defaultRuntime.log(line);
  }
}

export async function runGatewayFocus(params: {
  action: GatewayFocusAction;
  target?: string;
  tier?: string;
  all?: boolean;
  opts: GatewayRpcOpts;
}): Promise<void> {
  const { opts } = params;
  const methodParams = buildGatewayFocusParams(params);
  const config = await readBestEffortConfig().catch(() => undefined);
  let report: FocusReport;
  try {
    report = (await callGatewayCli("focus", { ...opts, config }, methodParams)) as FocusReport;
  } catch (err) {
    if (params.action !== "status") {
      throw err;
    }
    // Gateway down: the state is on disk; same ops function, same report.
    const request: FocusOpRequest = { action: "status" };
    report = runFocusOp({ cfg: config ?? {}, request, by: "cli" }).report;
  }
  print(report, opts.json);
}
