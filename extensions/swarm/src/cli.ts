import path from "node:path";
import type { Command } from "commander";
import { callGateway, GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "openclaw/plugin-sdk/swarm";

// `openclaw swarm ...`: a thin client over the swarm.* gateway methods. It never calls
// runtime.subagent, which only exists inside the gateway process (ARCH §1.2, §9).

type CliOpts = {
  url?: string;
  token?: string;
  timeout?: string;
  json?: boolean;
  verbose?: boolean;
};

export type GatewayCaller = (method: string, opts: CliOpts, params: unknown) => Promise<unknown>;

export const defaultGatewayCaller: GatewayCaller = (method, opts, params) =>
  callGateway({
    url: opts.url,
    token: opts.token,
    method,
    params,
    timeoutMs: Number(opts.timeout ?? 30_000),
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    mode: GATEWAY_CLIENT_MODES.CLI,
  });

function withClientOptions(cmd: Command): Command {
  return cmd
    .option("--url <url>", "Gateway WebSocket URL")
    .option("--token <token>", "Gateway token (if required)")
    .option("--timeout <ms>", "Timeout in ms", "30000")
    .option("--json", "Print JSON", false)
    .option("--verbose", "Print the full error (stack) on failure", false);
}

/**
 * The directory the operator ran the command from. Package-manager launchers (`pnpm openclaw`,
 * `pnpm --dir <repo> ...`) start the CLI with cwd = the repo root and record the caller's
 * directory in INIT_CWD; plain `openclaw` runs have no INIT_CWD and cwd is the caller's.
 */
export function callerCwd(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const init = env.INIT_CWD;
  return init && path.isAbsolute(init) ? init : cwd;
}

/** Change 2: a relative --file is the caller's path, never the gateway process cwd. */
export function resolveContractPath(file: string, base = callerCwd()): string {
  return path.resolve(base, file);
}

/** Change 4: one clean line (first line of the message); the stack only with --verbose. */
export function formatCliError(err: unknown, verbose = false): string {
  if (verbose && err instanceof Error && err.stack) {
    return `swarm: ${err.stack}`;
  }
  const raw = err instanceof Error ? err.message : String(err);
  const line = raw.split("\n").find((l) => l.trim()) ?? "unknown error";
  return `swarm: ${line.trim()}`;
}

export type CliIo = {
  log: (line: string) => void;
  error: (line: string) => void;
  /** Mark the process as failed without killing pending output. */
  fail: () => void;
};

type TaskRow = {
  id: string;
  status: string;
  sha: string;
  recentEvent?: string;
  ageMs: number;
};
type EventRow = {
  seq: number;
  ts: number;
  kind: string;
  event: string;
  from?: string;
  to?: string | null;
  sha?: string;
};

type Timeline = {
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  handovers: Array<{
    seq: number;
    ts: number;
    event: string;
    from: string;
    to: string;
    sha: string | null;
    sinceStartMs: number;
    sincePrevMs: number;
  }>;
  activeMs: Record<string, number>;
};

/** Compact duration: 850ms, 42s, 7m05s, 2h03m. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) {
    return "-";
  }
  if (ms < 1000) {
    return `${Math.max(0, Math.round(ms))}ms`;
  }
  const s = Math.floor(ms / 1000);
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m${String(s % 60).padStart(2, "0")}s`;
  }
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** Change 5: handover table, total duration and per-role active time for `swarm show`. */
export function formatTimeline(t: Partial<Timeline>): string[] {
  if (!t.handovers) {
    return [];
  }
  const iso = (ts: number | null | undefined) =>
    ts === null || ts === undefined ? "-" : new Date(ts).toISOString().slice(0, 19) + "Z";
  const lines = [
    `handovers  started ${iso(t.startedAt)}  ended ${t.endedAt ? iso(t.endedAt) : "(open)"}  duration ${formatDuration(t.durationMs)}`,
    `  ${"seq".padStart(4)} ${"time".padEnd(8)} ${"+start".padStart(7)} ${"+prev".padStart(7)} ${"event".padEnd(18)} ${"from -> to".padEnd(24)} sha`,
  ];
  for (const h of t.handovers) {
    lines.push(
      `  ${String(h.seq).padStart(4)} ${new Date(h.ts).toISOString().slice(11, 19)} ${formatDuration(h.sinceStartMs).padStart(7)} ${formatDuration(h.sincePrevMs).padStart(7)} ${h.event.padEnd(18)} ${`${h.from} -> ${h.to}`.padEnd(24)} ${(h.sha ?? "-").slice(0, 10)}`,
    );
  }
  const active = Object.entries(t.activeMs ?? {});
  if (active.length > 0) {
    lines.push(`  active: ${active.map(([r, ms]) => `${r}=${formatDuration(ms)}`).join("  ")}`);
  }
  return lines;
}

function formatAge(ms: number): string {
  const min = Math.floor(ms / 60_000);
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}m`;
}

export function registerSwarmCli(params: {
  program: Command;
  log?: (line: string) => void;
  error?: (line: string) => void;
  fail?: () => void;
  call?: GatewayCaller;
  cwd?: () => string;
}): void {
  const log = params.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const error = params.error ?? ((line: string) => process.stderr.write(`${line}\n`));
  const fail =
    params.fail ??
    (() => {
      process.exitCode = 1;
    });
  const cwd = params.cwd ?? (() => callerCwd());
  const call = params.call ?? defaultGatewayCaller;
  // Change 4: every action reports a failure as one line and a non-zero exit, never a throw.
  const guarded =
    <A extends unknown[]>(fn: (...args: A) => Promise<void>) =>
    async (...args: A): Promise<void> => {
      // Commander calls actions with (...positionals, opts, command).
      const opts = args.at(-2) as CliOpts | undefined;
      try {
        await fn(...args);
      } catch (err) {
        error(formatCliError(err, Boolean(opts?.verbose)));
        fail();
      }
    };
  const swarm = params.program.command("swarm").description("Run and inspect swarm tasks");

  withClientOptions(
    swarm
      .command("start")
      .description("Start a task from a contract file")
      .requiredOption("--file <path>"),
  ).action(
    guarded(async (opts: CliOpts & { file: string }) => {
      const file = resolveContractPath(opts.file, cwd());
      const result = (await call("swarm.start", opts, { file })) as {
        taskId?: string;
        id: string;
        sha: string;
        sessions: Record<string, string>;
        workers: Record<string, { resolved?: string; thinking?: string }>;
      };
      if (opts.json) {
        log(JSON.stringify(result, null, 2));
        return;
      }
      log(`started ${result.taskId ?? result.id} @ ${result.sha}`);
      for (const [role, sessionKey] of Object.entries(result.sessions)) {
        const w = result.workers[role];
        log(
          `  ${role.padEnd(10)} ${sessionKey}${w?.resolved ? `  ${w.resolved} thinking=${w.thinking ?? "-"}` : ""}`,
        );
      }
    }),
  );

  withClientOptions(swarm.command("list").description("List tasks")).action(
    guarded(async (opts: CliOpts) => {
      const { tasks } = (await call("swarm.list", opts, {})) as {
        tasks: TaskRow[];
      };
      if (opts.json) {
        log(JSON.stringify(tasks, null, 2));
        return;
      }
      if (tasks.length === 0) {
        log("no swarm tasks");
        return;
      }
      for (const t of tasks) {
        log(
          `${t.id.padEnd(24)} ${t.status.padEnd(9)} ${t.sha.padEnd(10)} ${formatAge(t.ageMs).padStart(6)}  ${t.recentEvent ?? ""}`,
        );
      }
    }),
  );

  withClientOptions(
    swarm
      .command("show")
      .description("Show one task's models and event log")
      .argument("<taskId>")
      .option("--limit <n>", "Only the last N events"),
  ).action(
    guarded(async (taskId: string, opts: CliOpts & { limit?: string }) => {
      const shown = (await call("swarm.show", opts, {
        taskId,
        ...(opts.limit && { limit: Number(opts.limit) }),
      })) as {
        id: string;
        status: string;
        sha: string;
        models: Record<string, { contract?: string; applied?: string; observed: string[] }>;
        events: EventRow[];
      } & Partial<Timeline>;
      if (opts.json) {
        log(JSON.stringify(shown, null, 2));
        return;
      }
      log(`${shown.id}  ${shown.status}  @ ${shown.sha}`);
      for (const [role, m] of Object.entries(shown.models)) {
        log(
          `  ${role.padEnd(10)} contract=${m.contract ?? "-"} applied=${m.applied ?? "-"} observed=${m.observed.join(",") || "-"}`,
        );
      }
      for (const e of shown.events) {
        const when = new Date(e.ts).toISOString().slice(11, 19);
        log(
          `  ${String(e.seq).padStart(4)} ${when} ${e.kind.padEnd(8)} ${e.event.padEnd(26)} ${e.from ?? ""}${e.to ? ` -> ${e.to}` : ""}`,
        );
      }
      for (const line of formatTimeline(shown)) {
        log(line);
      }
    }),
  );

  withClientOptions(
    swarm
      .command("cancel")
      .description("Cancel a task")
      .argument("<taskId>")
      .option("--reason <text>"),
  ).action(
    guarded(async (taskId: string, opts: CliOpts & { reason?: string }) => {
      const res = (await call("swarm.cancel", opts, { taskId, reason: opts.reason })) as {
        status: string;
        changed: boolean;
      };
      log(
        opts.json
          ? JSON.stringify(res, null, 2)
          : `${taskId}: ${res.status}${res.changed ? "" : " (unchanged)"}`,
      );
    }),
  );

  withClientOptions(
    swarm
      .command("answer")
      .description("Answer the taskmaster (logged as an OPERATOR event)")
      .argument("<taskId>")
      .argument("<message>"),
  ).action(
    guarded(async (taskId: string, message: string, opts: CliOpts) => {
      const res = (await call("swarm.answer", opts, { taskId, message })) as {
        seq: number;
        delivery: string;
      };
      log(
        opts.json
          ? JSON.stringify(res, null, 2)
          : `${taskId}: OPERATOR seq ${res.seq} to taskmaster (${res.delivery})`,
      );
    }),
  );
}
