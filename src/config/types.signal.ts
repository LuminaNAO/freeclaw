import type { CommonChannelMessagingConfig } from "./types.channel-messaging-common.js";
import type { GroupToolPolicyBySenderConfig, GroupToolPolicyConfig } from "./types.tools.js";

export type SignalReactionNotificationMode = "off" | "own" | "all" | "allowlist";
export type SignalReactionLevel = "off" | "ack" | "minimal" | "extensive";

/**
 * Configuration for the signalcli-archive-raw integration. When enabled,
 * freeclaw spawns the archive supervisor (which spawns signal-cli and runs
 * a tee proxy) and attaches to the proxy's randomised port, enabling
 * lossless raw archival of all signal-cli HTTP traffic.
 */
export type SignalArchiveRawConfig =
  | boolean
  | {
      enabled?: boolean;
      /** Path to the signalcli-archive-raw binary (default: "signalcli-archive-raw" on PATH). */
      binary?: string;
      /** Path to the discovery JSON file the supervisor writes (default: ~/.signal-archive/endpoint.json). */
      endpointFile?: string;
      /** Path to the raw log file the supervisor appends to (default: archive-raw's own default). */
      log?: string;
      /** Lower bound for random port selection (forwarded to archive-raw). */
      portMin?: number;
      /** Upper bound for random port selection (forwarded to archive-raw). */
      portMax?: number;
    };

export type SignalGroupConfig = {
  requireMention?: boolean;
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
};

export type SignalAccountConfig = CommonChannelMessagingConfig & {
  /** Optional explicit E.164 account for signal-cli. */
  account?: string;
  /** Optional account UUID for signal-cli (used for loop protection). */
  accountUuid?: string;
  /** Optional full base URL for signal-cli HTTP daemon. */
  httpUrl?: string;
  /**
   * Optional path to a discovery JSON file produced by an external supervisor
   * (e.g. signalcli-archive-raw) that publishes a randomly chosen proxy port.
   * The file must contain `{ "baseUrl": "http://host:port", ... }`. When set,
   * autoStart defaults to false and the daemon is not spawned by freeclaw.
   * Leading `~/` is expanded to $HOME.
   */
  httpEndpointFile?: string;
  /** HTTP host for signal-cli daemon (default 127.0.0.1). */
  httpHost?: string;
  /**
   * HTTP port for signal-cli daemon.
   * FreeClaw auto-selects and persists a free loopback port on local auto-start.
   */
  httpPort?: number;
  /** signal-cli binary path (default: signal-cli). */
  cliPath?: string;
  /** Auto-start signal-cli daemon (default: true if httpUrl not set). */
  autoStart?: boolean;
  /** Max time to wait for signal-cli daemon startup (ms, cap 120000). */
  startupTimeoutMs?: number;
  receiveMode?: "on-start" | "manual";
  ignoreAttachments?: boolean;
  ignoreStories?: boolean;
  sendReadReceipts?: boolean;
  /**
   * When set, freeclaw spawns signalcli-archive-raw as a managed child
   * instead of signal-cli directly, attaching to the supervisor's tee
   * proxy via the discovery JSON it publishes. See SignalArchiveRawConfig.
   */
  archiveRaw?: SignalArchiveRawConfig;
  /** Per-group overrides keyed by Signal group id (or "*"). */
  groups?: Record<string, SignalGroupConfig>;
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  /** Reaction notification mode (off|own|all|allowlist). Default: own. */
  reactionNotifications?: SignalReactionNotificationMode;
  /** Allowlist for reaction notifications when mode is allowlist. */
  reactionAllowlist?: Array<string | number>;
  /** Action toggles for message tool capabilities. */
  actions?: {
    /** Enable/disable sending reactions via message tool (default: true). */
    reactions?: boolean;
  };
  /**
   * Controls agent reaction behavior:
   * - "off": No reactions
   * - "ack": Only automatic ack reactions (👀 when processing)
   * - "minimal": Agent can react sparingly (default)
   * - "extensive": Agent can react liberally
   */
  reactionLevel?: SignalReactionLevel;
};

export type SignalConfig = {
  /** Optional per-account Signal configuration (multi-account). */
  accounts?: Record<string, SignalAccountConfig>;
  /** Optional default account id when multiple accounts are configured. */
  defaultAccount?: string;
} & SignalAccountConfig;
