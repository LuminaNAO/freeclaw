// `openclaw gateway focus [set <key>|off|status]` (docs/design/focus-mode.md §4).
// Calls the gateway `focus` method (operator scope). `status` falls back to reading
// <stateDir>/focus.json and the stack files directly when the gateway is down.
import { readBestEffortConfig } from "../../config/config.js";
import {
  type FocusState,
  type FocusWaiting,
  formatFocusStatusLines,
  readFocusStatus,
} from "../../infra/focus-mode.js";
import { defaultRuntime } from "../../runtime.js";
import { callGatewayCli, type GatewayRpcOpts } from "./call.js";

export type GatewayFocusAction = "set" | "off" | "status";

export async function runGatewayFocus(params: {
  action: GatewayFocusAction;
  target?: string;
  opts: GatewayRpcOpts;
}): Promise<void> {
  const { action, target, opts } = params;
  if (action === "set" && !target?.trim()) {
    throw new Error("usage: openclaw gateway focus set <session-key>");
  }
  const config = await readBestEffortConfig().catch(() => undefined);
  let result: Record<string, unknown>;
  try {
    result = await callGatewayCli(
      "focus",
      { ...opts, config },
      action === "set" ? { action, target } : { action },
    );
  } catch (err) {
    if (action !== "status") {
      throw err;
    }
    // Gateway down: the state is on disk.
    const status = readFocusStatus();
    if (opts.json) {
      defaultRuntime.log(
        JSON.stringify({ focus: status.focus ?? null, waiting: status.waiting }, null, 2),
      );
      return;
    }
    for (const line of formatFocusStatusLines(status)) {
      defaultRuntime.log(line);
    }
    return;
  }
  if (opts.json) {
    defaultRuntime.log(JSON.stringify(result, null, 2));
    return;
  }
  if (action === "set") {
    const focus = result.focus as FocusState | undefined;
    defaultRuntime.log(`Focus mode on ${focus?.target ?? target}.`);
    return;
  }
  if (action === "off") {
    if (!result.ended) {
      defaultRuntime.log("Focus mode is already off.");
      return;
    }
    const replaying = typeof result.replaying === "number" ? result.replaying : 0;
    defaultRuntime.log(
      replaying > 0
        ? `Focus mode off. Replaying waiting messages for ${replaying} session(s).`
        : "Focus mode off. No messages were waiting.",
    );
    return;
  }
  for (const line of formatFocusStatusLines({
    focus: (result.focus as FocusState | null) ?? undefined,
    waiting: (result.waiting as FocusWaiting[] | undefined) ?? [],
  })) {
    defaultRuntime.log(line);
  }
}
