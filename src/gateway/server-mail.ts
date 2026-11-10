// Mail connectors in the gateway (docs/design/mail-push.md §6): started with the gateway,
// stopped on shutdown, reloaded per connector on config changes.
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { MailConnectorManager, setActiveMailConnectorManager } from "../mail/manager.js";
import type { MailLogger } from "../mail/types.js";

export type GatewayMailState = {
  manager: MailConnectorManager | null;
};

function mailConnectorsSkipped(): boolean {
  return isTruthyEnvValue(process.env.OPENCLAW_SKIP_MAIL_CONNECTORS);
}

export async function startGatewayMailConnectors(params: {
  cfg: OpenClawConfig;
  deps: CliDeps;
  log: MailLogger;
}): Promise<GatewayMailState> {
  if (mailConnectorsSkipped()) {
    if ((params.cfg.mail?.connectors?.length ?? 0) > 0) {
      params.log.info("skipping mail connectors (OPENCLAW_SKIP_MAIL_CONNECTORS=1)");
    }
    return { manager: null };
  }
  const manager = new MailConnectorManager({ log: params.log, deps: params.deps });
  setActiveMailConnectorManager(manager);
  try {
    await manager.start(params.cfg);
  } catch (err) {
    params.log.error(`mail connectors failed to start: ${String(err)}`);
  }
  return { manager };
}

/** Applies a reloaded config; only connectors whose own entry changed restart (§6). */
export async function reloadGatewayMailConnectors(params: {
  state: GatewayMailState;
  cfg: OpenClawConfig;
  log: MailLogger;
}): Promise<void> {
  if (!params.state.manager) {
    return;
  }
  try {
    await params.state.manager.applyConfig(params.cfg);
  } catch (err) {
    params.log.error(`mail connectors reload failed: ${String(err)}`);
  }
}

export async function stopGatewayMailConnectors(state: GatewayMailState): Promise<void> {
  const manager = state.manager;
  state.manager = null;
  if (!manager) {
    return;
  }
  setActiveMailConnectorManager(null);
  await manager.stop().catch(() => {});
}
