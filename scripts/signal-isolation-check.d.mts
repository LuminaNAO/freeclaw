export type CheckState = "PASS" | "WARN" | "WAIVED" | "UNKNOWN" | "FAIL";

export type DaemonRecord = {
  pid: number;
  uid: number | undefined;
  account: string | undefined;
  argv: string[];
  socketPaths: string[];
  checks: { c1: CheckState; c2: CheckState; c3: CheckState; c4: CheckState };
  reasons: string[];
};

export type RelayRecord = {
  pid: number;
  uid: number | undefined;
  argv: string[];
  socketPath: string;
  listen: string[];
};

export type CheckReport = {
  overall: CheckState | "PASS_WITH_WAIVERS";
  exitCode: 0 | 1 | 3 | 4;
  daemons: DaemonRecord[];
  missing: Array<{ account: string; state: CheckState; reason: string }>;
  c5: {
    state: CheckState;
    reasons: string[];
    relays: RelayRecord[];
    gatewayClients: RelayRecord[];
    socketPaths: string[];
  };
  notes: string[];
};

export type CheckOptions = {
  procRoot?: string;
  manifest?: { agents?: Array<{ uid?: number; account: string; socketPath?: string }> };
  ssOutput?: string;
  noSs?: boolean;
  extraSocketPaths?: string[];
  allowGroup?: boolean;
  group?: number;
  allowDown?: boolean;
  allowHttp?: string[];
};

export function runCheck(options?: CheckOptions): CheckReport;
export function parseSignalCliArgv(argv: string[]):
  | {
      account?: string;
      subcommand?: string;
      socket: string[];
      tcp: boolean;
      http: boolean;
      receiveMode?: string;
    }
  | undefined;
export function parseSsUnix(text: string): {
  rows: Array<{ state: string; localPath: string; localInode: string; peerInode: string }>;
  parsed: number;
};
