// Mail connector manager (docs/design/mail-push.md §6): starts enabled connectors with the
// gateway, stops them on shutdown, and on config reload restarts only the connectors whose own
// entry changed (new ones start, removed ones stop, unchanged ones keep running).
import { isDeepStrictEqual } from "node:util";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import type { MailConnectorConfig } from "../config/types.mail.js";
import { isSecretRef } from "../config/types.secrets.js";
import { resolveSecretRefString } from "../secrets/resolve.js";
import {
  MailConnector,
  type MailConnectorStatus,
  type MailSessionSink,
  type MailStateIo,
} from "./connector.js";
import { createMailProvider, type MailProviderFactoryParams } from "./providers/index.js";
import { createMailSessionSink } from "./session-sink.js";
import { resolveMailStatePath } from "./state-store.js";
import type { MailLogger, MailProvider, MailProviderStartContext } from "./types.js";

export type MailConnectorSummary = {
  id: string;
  provider: string;
  enabled: boolean;
  state: MailConnectorStatus["state"];
  folders: string[];
  /** IMAP account as user@host (no secrets). */
  account?: string;
  sessions: Array<{ agentId: string; sessionKey: string; wakeMode: string; deliver: boolean }>;
};

export type MailReloadResult = {
  started: string[];
  stopped: string[];
  restarted: string[];
  unchanged: string[];
};

export type MailProviderFactory = (params: MailProviderFactoryParams) => MailProvider;

type Entry = { config: MailConnectorConfig; connector: MailConnector; secrets: string[] };

function listConnectorConfigs(cfg: OpenClawConfig | undefined): MailConnectorConfig[] {
  return Array.isArray(cfg?.mail?.connectors) ? cfg.mail.connectors : [];
}

export class MailConnectorManager {
  private readonly entries = new Map<string, Entry>();
  private readonly log: MailLogger;
  private readonly sink: MailSessionSink;
  private readonly providerFactory: MailProviderFactory;
  private readonly statePathFor: (id: string) => string;
  private readonly io: MailStateIo | undefined;
  private readonly connectorOptions: { retryBaseMs?: number; retryMaxMs?: number };
  private cfg: OpenClawConfig = {};
  private stopped = false;

  constructor(params: {
    log: MailLogger;
    deps?: CliDeps;
    sink?: MailSessionSink;
    providerFactory?: MailProviderFactory;
    statePathFor?: (id: string) => string;
    io?: MailStateIo;
    retryBaseMs?: number;
    retryMaxMs?: number;
  }) {
    this.log = params.log;
    this.sink = params.sink ?? createMailSessionSink({ log: params.log, deps: params.deps });
    this.providerFactory = params.providerFactory ?? createMailProvider;
    this.statePathFor = params.statePathFor ?? ((id) => resolveMailStatePath(id));
    this.io = params.io;
    this.connectorOptions = { retryBaseMs: params.retryBaseMs, retryMaxMs: params.retryMaxMs };
  }

  /** Starts every configured connector (disabled ones only report `disabled`). */
  async start(cfg: OpenClawConfig): Promise<void> {
    this.stopped = false;
    this.cfg = cfg;
    for (const config of listConnectorConfigs(cfg)) {
      await this.startEntry(config);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map((entry) => entry.connector.stop()));
  }

  /** Applies a reloaded config: only connectors whose own entry changed are restarted. */
  async applyConfig(cfg: OpenClawConfig): Promise<MailReloadResult> {
    this.cfg = cfg;
    const result: MailReloadResult = { started: [], stopped: [], restarted: [], unchanged: [] };
    const next = new Map(listConnectorConfigs(cfg).map((config) => [config.id, config]));
    for (const [id, entry] of Array.from(this.entries)) {
      if (!next.has(id)) {
        this.entries.delete(id);
        await entry.connector.stop();
        result.stopped.push(id);
      }
    }
    for (const [id, config] of next) {
      const entry = this.entries.get(id);
      if (!entry) {
        await this.startEntry(config);
        result.started.push(id);
        continue;
      }
      if (isDeepStrictEqual(entry.config, config)) {
        result.unchanged.push(id);
        continue;
      }
      await entry.connector.stop();
      this.entries.delete(id);
      await this.startEntry(config);
      result.restarted.push(id);
    }
    const changed = [...result.started, ...result.restarted, ...result.stopped];
    if (changed.length > 0) {
      this.log.info(
        `mail connectors reloaded: started=${result.started.length} restarted=${result.restarted.length} stopped=${result.stopped.length}`,
      );
    }
    return result;
  }

  /** Stops and starts one connector (clears auth-failed). */
  async restart(id: string): Promise<MailConnectorStatus> {
    const entry = this.entries.get(id);
    const config = entry?.config ?? listConnectorConfigs(this.cfg).find((c) => c.id === id);
    if (!config) {
      throw new Error(`unknown mail connector "${id}"`);
    }
    if (entry) {
      await entry.connector.stop();
      this.entries.delete(id);
    }
    const started = await this.startEntry(config);
    return started.connector.status();
  }

  /** Connect + auth + folder select without side effects. */
  async test(id: string): Promise<{ id: string; ok: boolean; detail: string }> {
    const config =
      this.entries.get(id)?.config ?? listConnectorConfigs(this.cfg).find((c) => c.id === id);
    if (!config) {
      throw new Error(`unknown mail connector "${id}"`);
    }
    let password: string | undefined;
    try {
      password = await this.resolvePassword(config);
    } catch {
      return { id, ok: false, detail: "password secret could not be resolved" };
    }
    const provider = this.providerFactory({ config, password, log: this.log });
    try {
      const result = await provider.test();
      return { id, ok: result.ok, detail: redact(result.detail, password) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { id, ok: false, detail: redact(message, password) };
    }
  }

  list(): MailConnectorSummary[] {
    return listConnectorConfigs(this.cfg).map((config) => {
      const status = this.entries.get(config.id)?.connector.status();
      return {
        id: config.id,
        provider: config.provider,
        enabled: config.enabled !== false,
        state: status?.state ?? (config.enabled === false ? "disabled" : "starting"),
        folders: config.provider === "imap" ? (config.imap?.folders ?? ["INBOX"]) : ["INBOX"],
        ...(config.imap ? { account: `${config.imap.user}@${config.imap.host}` } : {}),
        sessions: config.attach.map((attach) => ({
          agentId: attach.agentId,
          sessionKey: attach.sessionKey,
          wakeMode: attach.wakeMode ?? "now",
          deliver: attach.deliver === true,
        })),
      };
    });
  }

  status(id?: string): MailConnectorStatus[] {
    const ids = id ? [id] : listConnectorConfigs(this.cfg).map((config) => config.id);
    return ids.map((connectorId) => {
      const entry = this.entries.get(connectorId);
      if (!entry) {
        throw new Error(`unknown mail connector "${connectorId}"`);
      }
      return entry.connector.status();
    });
  }

  /** The running connector (tests). */
  get(id: string): MailConnector | undefined {
    return this.entries.get(id)?.connector;
  }

  private async resolvePassword(config: MailConnectorConfig): Promise<string | undefined> {
    if (config.provider !== "imap") {
      return undefined;
    }
    const value: unknown = config.imap?.password;
    if (typeof value === "string" && value) {
      return value;
    }
    if (isSecretRef(value)) {
      return await resolveSecretRefString(value, { config: this.cfg });
    }
    throw new Error("imap password missing");
  }

  private async startEntry(config: MailConnectorConfig): Promise<Entry> {
    const secrets: string[] = [];
    const preResolved = config.imap?.password;
    if (typeof preResolved === "string" && preResolved) {
      secrets.push(preResolved);
    }
    // The provider is created lazily so a secret that fails to resolve ends in backoff
    // (retried) instead of breaking gateway startup.
    const provider: MailProvider = {
      start: async (ctx: MailProviderStartContext) => {
        const password = await this.resolvePassword(config);
        if (password && !secrets.includes(password)) {
          secrets.push(password);
        }
        await this.providerFactory({ config, password, log: this.log }).start(ctx);
      },
      test: async () => await this.test(config.id),
    };
    const connector = new MailConnector({
      config,
      provider,
      sink: this.sink,
      statePath: this.statePathFor(config.id),
      log: this.log,
      io: this.io,
      secrets,
      ...this.connectorOptions,
    });
    const entry: Entry = { config, connector, secrets };
    this.entries.set(config.id, entry);
    if (!this.stopped) {
      await connector.start();
    }
    return entry;
  }
}

function redact(text: string, secret: string | undefined): string {
  return secret ? text.split(secret).join("[redacted]") : text;
}

let activeManager: MailConnectorManager | null = null;

/** The gateway's running manager (set at gateway start, cleared on close). */
export function setActiveMailConnectorManager(manager: MailConnectorManager | null): void {
  activeManager = manager;
}

export function getActiveMailConnectorManager(): MailConnectorManager | null {
  return activeManager;
}
