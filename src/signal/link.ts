import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isSignalCliVersionBelowMinimum,
  MIN_SIGNAL_CLI_VERSION,
  parseSignalCliVersion,
} from "../commands/signal-install.js";
import type { OpenClawConfig } from "../config/config.js";
import { normalizeAccountId } from "../routing/account-id.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { resolveSignalAccount } from "./accounts.js";

export const SIGNAL_LINK_URI_PREFIX = "sgnl://linkdevice?";
export const SIGNAL_LINK_MAX_ATTEMPTS = 10;
export const SIGNAL_LINK_DEFAULT_TIMEOUT_MS = 600_000;
export const SIGNAL_LINK_RECEIVE_TIMEOUT_MS = 10_000;

// fresh-install ARCH §1.2: the minimum-version constant and comparisons live in
// commands/signal-install.js (shared with onboarding); re-exported here for callers.
export {
  MIN_SIGNAL_CLI_VERSION,
  compareVersions,
  parseSignalCliVersion,
  isSignalCliVersionBelowMinimum,
} from "../commands/signal-install.js";

export type SignalLinkResolution = {
  accountId: string;
  cliPath: string;
  configDir: string;
  deviceName: string;
  expectedNumber?: string;
  /** accounts.<id>.account when the account lives under channels.signal.accounts. */
  configAccountPath: string;
};

export type SignalLinkOutput = {
  log: (line: string) => void;
  error: (line: string) => void;
};

export type SignalLinkRunParams = {
  resolution: SignalLinkResolution;
  pngPath?: string;
  timeoutMs?: number;
  writeConfig?: boolean;
  json?: boolean;
  /** Attempt cap; ARCH §1.4 default 3. */
  maxAttempts?: number;
  /** receive step timeout; ARCH §1.6 default 10 s. */
  receiveTimeoutMs?: number;
  /**
   * Remove an existing local account for --number first (ARCH §1.1 --relink).
   * Confirmed interactively unless confirmedRelink is true.
   */
  relink?: boolean;
  confirmedRelink?: boolean;
  output?: SignalLinkOutput;
  /** Prompt for y/N; injected by tests. Defaults to readline on stdio. */
  confirm?: (question: string) => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  /** Overrides for the config write path; injected by tests / RPC. */
  writeConfigFn?: (params: { configAccountPath: string; number: string }) => Promise<void>;
  /**
   * Called after a successful link with the account's ACI (fresh-install ARCH
   * §1.4) so the CLI/RPC layer can persist it (channels.signal.accountUuid).
   * Never awaited; errors are swallowed by the caller.
   */
  onAccountUuid?: (uuid: string) => void;
  /** QR renderers; injected by tests. */
  renderTerminalQr?: (uri: string) => void;
  writePng?: (uri: string, pngPath: string) => Promise<void>;
  /**
   * Fired with the PNG path as its only argument the moment the PNG is
   * written, and again after each auto-renew (ARCH §1.3/§1.4). Never awaited.
   * The URI must never be passed to it.
   */
  onQr?: (pngPath: string) => void;
  /**
   * Called once the link child exists; the callback receives a kill function
   * for that child. Lets the RPC cancel path (ARCH §2) kill the child the same
   * way Ctrl-C does (§1.4). Called again with a fresh kill fn on each renew.
   */
  registerKill?: (kill: () => void) => void;
};

export type SignalLinkResult = {
  ok: boolean;
  number?: string;
  device?: string;
  configDir?: string;
  signalCliVersion?: string;
  attempts?: number;
  configWritten?: boolean;
  /** Account ACI (uuid) captured after a successful link (fresh-install ARCH §1.4). */
  accountUuid?: string;
  error?: string;
};

/** Strict parse: a trimmed line that is exactly one sgnl://linkdevice? URI (ARCH §1.2). */
export function parseLinkUriLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(SIGNAL_LINK_URI_PREFIX)) {
    return null;
  }
  if (/\s/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/** Extract the linked E.164 number from signal-cli's success output. */
export function parseLinkedNumber(line: string): string | null {
  const match = /(\+[0-9]{6,15})/.exec(line);
  return match?.[1] ?? null;
}

/** Extract an ACI (account UUID) from `signal-cli listDevices` output (fresh-install ARCH §1.4). */
export function parseAccountUuid(output: string): string | null {
  const match = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(output);
  return match ? match[0].toLowerCase() : null;
}

/** Redact a link URI if one ever leaks into text we print (defense in depth; ARCH §1.2). */
export function redactLinkUri(text: string): string {
  return text.replace(/sgnl:\/\/\S+/g, "sgnl://<redacted>");
}

/**
 * Env override for the signal-cli config dir used by the link flow. The
 * daemon never passes --config, so it always uses signal-cli's default
 * ($XDG_DATA_HOME/signal-cli, else ~/.local/share/signal-cli). This override
 * exists so operators and tests can point the whole flow (preflight + link)
 * at a throwaway dir; when it is set, the CLI prints a loud warning because
 * the daemon will NOT see accounts linked there.
 */
export const SIGNAL_LINK_CONFIG_DIR_ENV = "OPENCLAW_SIGNAL_CLI_CONFIG_DIR";

export function resolveSignalCliConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[SIGNAL_LINK_CONFIG_DIR_ENV]?.trim();
  if (override) {
    return override;
  }
  const xdg = env.XDG_DATA_HOME?.trim();
  if (xdg) {
    return path.join(xdg, "signal-cli");
  }
  return path.join(os.homedir(), ".local", "share", "signal-cli");
}

export function resolveSignalLinkTarget(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  number?: string;
  name?: string;
  env?: NodeJS.ProcessEnv;
}): SignalLinkResolution {
  const accountId = normalizeAccountId(params.accountId);
  const account = resolveSignalAccount({ cfg: params.cfg, accountId });
  const merged = account.config;
  const cliPath = merged.cliPath?.trim() || "signal-cli";
  // signal-cli's own default config dir; the daemon never passes --config, so
  // account stores live here for both. Keep resolution identical to the daemon.
  const configDir = resolveSignalCliConfigDir(params.env ?? process.env);
  const deviceName = params.name?.trim() || params.cfg.gateway?.instanceName?.trim() || "openclaw";
  const isNamedAccount = Boolean(
    params.cfg.channels?.signal?.accounts &&
    Object.hasOwn(params.cfg.channels.signal.accounts, accountId),
  );
  const configAccountPath = isNamedAccount
    ? `channels.signal.accounts.${accountId}.account`
    : "channels.signal.account";
  return {
    accountId,
    cliPath,
    configDir,
    deviceName,
    expectedNumber: params.number?.trim() || undefined,
    configAccountPath,
  };
}

function defaultOutput(runtime: RuntimeEnv): SignalLinkOutput {
  return {
    log: (line) => runtime.log(line),
    error: (line) => runtime.error(line),
  };
}

async function defaultConfirm(question: string): Promise<boolean> {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer.startsWith("y");
  } finally {
    rl.close();
  }
}

function runCapture(params: {
  cliPath: string;
  args: string[];
  timeoutMs?: number;
}): Promise<{ ok: boolean; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(params.cliPath, params.args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (ok: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ ok, stdout, stderr, timedOut });
    };
    const timer =
      params.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, params.timeoutMs)
        : undefined;
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.once("error", (err) => {
      if (timer) {
        clearTimeout(timer);
      }
      stderr += String(err);
      finish(false);
    });
    child.once("close", (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      finish(code === 0 && !timedOut);
    });
  });
}

function isLikelyJavaCli(text: string): boolean {
  return /\bjava\b|\.jar\b/i.test(text);
}

function readAccountDirs(configDir: string): string[] {
  const accountsDir = path.join(configDir, "data");
  try {
    return fs
      .readdirSync(accountsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\+[0-9]{6,15}$/.test(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function readAccountsFile(configDir: string): string[] {
  try {
    const raw = fs.readFileSync(path.join(configDir, "data", "accounts.json"), "utf8");
    const parsed = JSON.parse(raw) as { accounts?: Array<{ number?: string }> };
    return (parsed.accounts ?? [])
      .map((a) => (typeof a.number === "string" ? a.number : ""))
      .filter((n) => /^\+[0-9]{6,15}$/.test(n));
  } catch {
    return [];
  }
}

export function listLocalSignalAccounts(configDir: string): string[] {
  const merged = new Set([...readAccountDirs(configDir), ...readAccountsFile(configDir)]);
  return [...merged];
}

function findLockHolderPid(configDir: string): number | null {
  const procRoot = "/proc";
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(procRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9]+$/.test(entry.name)) {
      continue;
    }
    const fdDir = path.join(procRoot, entry.name, "fd");
    let fds: string[];
    try {
      fds = fs.readdirSync(fdDir);
    } catch {
      continue; // not our process, or it exited
    }
    for (const fd of fds) {
      let target: string;
      try {
        target = fs.readlinkSync(path.join(fdDir, fd));
      } catch {
        continue;
      }
      if (target === configDir || target.startsWith(configDir + path.sep)) {
        // Don't flag ourselves.
        const pid = Number.parseInt(entry.name, 10);
        if (pid !== process.pid) {
          return pid;
        }
      }
    }
  }
  return null;
}

type LinkAttemptOutcome =
  | { kind: "linked"; number: string }
  | { kind: "expired" }
  | { kind: "failed"; error: string };

function isExpiryText(text: string): boolean {
  return /expired|timed?\s*out|already been used|invalid.*link|connection closed/i.test(text);
}

async function runLinkAttempt(params: {
  resolution: SignalLinkResolution;
  deadlineMs: number;
  output: SignalLinkOutput;
  pngPath?: string;
  renderTerminalQr: (uri: string) => void;
  writePng?: (uri: string, pngPath: string) => Promise<void>;
  onQr?: (pngPath: string) => void;
  onCancel: (cancel: () => void) => void;
}): Promise<LinkAttemptOutcome> {
  const { resolution, output } = params;
  return await new Promise<LinkAttemptOutcome>((resolve) => {
    let settled = false;
    let linkedNumber: string | null = null;
    let uriShown = false;
    let expired = false;
    let stderrTail = "";
    const child = spawn(
      resolution.cliPath,
      ["--config", resolution.configDir, "link", "-n", resolution.deviceName],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const remaining = () => Math.max(0, params.deadlineMs - Date.now());
    const timeout = setTimeout(() => {
      if (!settled) {
        child.kill("SIGKILL");
      }
    }, remaining());

    const settle = (outcome: LinkAttemptOutcome) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(outcome);
    };

    params.onCancel(() => {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
      setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
        }
      }, 2_000).unref();
    });

    const handleLine = async (line: string) => {
      const uri = parseLinkUriLine(line);
      if (uri && !uriShown) {
        uriShown = true;
        // Speed first (operator note): write the PNG and fire onQr the moment
        // the sgnl:// line appears, before the terminal render or anything
        // else. The URI is handed only to the renderers, never to onQr.
        if (params.pngPath && params.writePng) {
          try {
            await params.writePng(uri, params.pngPath);
            params.onQr?.(params.pngPath);
          } catch (err) {
            output.error(`Failed to write QR PNG: ${redactLinkUri(String(err))}`);
          }
        }
        try {
          params.renderTerminalQr(uri);
        } catch (err) {
          output.error(`Failed to render QR: ${redactLinkUri(String(err))}`);
        }
        const target = resolution.expectedNumber ?? "the account";
        output.log(
          `Scan with Signal on the phone for ${target}: Settings → Linked devices → Link new device. Expires in about 1 minute (a new QR follows automatically).`,
        );
        if (params.pngPath) {
          output.log(`QR PNG: ${params.pngPath}`);
        }
        return;
      }
      const number = parseLinkedNumber(line);
      if (number && /associated|linked|registered|successfully/i.test(line)) {
        linkedNumber = number;
      }
      if (isExpiryText(line)) {
        expired = true;
      }
      // Never echo signal-cli output verbatim: it can carry the URI (ARCH §1.2).
    };

    let stdoutBuf = "";
    const pending: Promise<void>[] = [];
    child.stdout?.on("data", (d) => {
      stdoutBuf += d.toString();
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        pending.push(handleLine(line));
      }
    });
    child.stderr?.on("data", (d) => {
      const text = d.toString();
      stderrTail = (stderrTail + text).slice(-2_000);
      if (isExpiryText(text)) {
        expired = true;
      }
    });
    child.once("error", (err) => {
      settle({ kind: "failed", error: `signal-cli spawn failed: ${String(err)}` });
    });
    child.once("close", (code) => {
      void Promise.all(pending).then(() => {
        if (linkedNumber && code === 0) {
          settle({ kind: "linked", number: linkedNumber });
          return;
        }
        if (Date.now() >= params.deadlineMs) {
          settle({ kind: "failed", error: "Timed out waiting for the phone to confirm." });
          return;
        }
        if (expired) {
          settle({ kind: "expired" });
          return;
        }
        settle({
          kind: "failed",
          error: `signal-cli link exited (code ${String(code)}) before the link completed.`,
        });
      });
    });
  });
}

/**
 * Run the ARCH §1 link flow end to end. The link URI is consumed only by the
 * QR renderers and never printed, logged, or returned.
 */
export async function runSignalLink(params: SignalLinkRunParams): Promise<SignalLinkResult> {
  const output = params.output ?? defaultOutput(defaultRuntime);
  const resolution = params.resolution;
  const timeoutMs = params.timeoutMs ?? SIGNAL_LINK_DEFAULT_TIMEOUT_MS;
  const maxAttempts = params.maxAttempts ?? SIGNAL_LINK_MAX_ATTEMPTS;
  const deadlineMs = Date.now() + timeoutMs;
  const confirm = params.confirm ?? defaultConfirm;
  const fail = (error: string, extra?: Partial<SignalLinkResult>): SignalLinkResult => {
    const result: SignalLinkResult = { ok: false, error, ...extra };
    if (params.json) {
      output.log(JSON.stringify(result));
    } else {
      output.error(error);
    }
    return result;
  };

  // §1.1 preflight: binary exists and runs.
  const version = await runCapture({
    cliPath: resolution.cliPath,
    args: ["--version"],
    timeoutMs: 15_000,
  });
  if (!version.ok && version.timedOut) {
    return fail(`signal-cli --version timed out at ${resolution.cliPath}.`);
  }
  if (!version.ok && !version.stdout.trim() && !version.stderr.trim()) {
    return fail(
      `signal-cli not found or not runnable: ${resolution.cliPath}. Set channels.signal.cliPath.`,
    );
  }
  const signalCliVersion = (version.stdout || version.stderr).trim().split(/\r?\n/)[0];
  // fresh-install ARCH §1.2: refuse a known-bad signal-cli before doing any work.
  if (isSignalCliVersionBelowMinimum(signalCliVersion)) {
    const found = parseSignalCliVersion(signalCliVersion) ?? signalCliVersion;
    return fail(
      `signal-cli ${found} is below the minimum supported version ${MIN_SIGNAL_CLI_VERSION} ` +
        `(older builds fail linking with "network failed" on current phones). ` +
        `Fix: run \`openclaw channels add signal\` to reinstall, or set channels.signal.cliPath to a newer binary.`,
      { configDir: resolution.configDir, signalCliVersion },
    );
  }
  if (isLikelyJavaCli(version.stderr)) {
    const java = await runCapture({ cliPath: "java", args: ["-version"], timeoutMs: 10_000 });
    if (!java.ok && !java.stderr.trim()) {
      return fail("Java is required for this signal-cli build but was not found on PATH.");
    }
  }
  if (!params.json) {
    output.log(`signal-cli: ${redactLinkUri(signalCliVersion)}`);
  }
  const envForDir = params.env ?? process.env;
  if (envForDir[SIGNAL_LINK_CONFIG_DIR_ENV]?.trim()) {
    output.log(
      `WARNING: ${SIGNAL_LINK_CONFIG_DIR_ENV} is set; linking into ${resolution.configDir}, which a normally-configured daemon will NOT use.`,
    );
  }

  // §1.1 preflight: config dir writable.
  try {
    fs.mkdirSync(resolution.configDir, { recursive: true, mode: 0o700 });
    fs.accessSync(resolution.configDir, fs.constants.W_OK);
  } catch (err) {
    return fail(
      `signal-cli config dir ${resolution.configDir} is not writable by this user: ${String(err)}`,
      { configDir: resolution.configDir, signalCliVersion },
    );
  }

  // §1.1 preflight: existing account for --number.
  const existing = listLocalSignalAccounts(resolution.configDir);
  if (resolution.expectedNumber && existing.includes(resolution.expectedNumber)) {
    if (!params.relink) {
      return fail(
        `${resolution.expectedNumber} already has an account in ${resolution.configDir}. Pass --relink to remove only that local account's data first.`,
        { configDir: resolution.configDir, signalCliVersion },
      );
    }
    const confirmed =
      params.confirmedRelink === true ||
      (await confirm(`Remove the local signal-cli account data for ${resolution.expectedNumber}?`));
    if (!confirmed) {
      return fail("Relink declined; keeping the existing local account.", {
        configDir: resolution.configDir,
        signalCliVersion,
      });
    }
    const target = path.join(resolution.configDir, "data", resolution.expectedNumber);
    fs.rmSync(target, { recursive: true, force: true });
    if (!params.json) {
      output.log(`Removed local account data for ${resolution.expectedNumber}.`);
    }
  }

  // §1.1 preflight: no process holding the config dir.
  const holderPid = findLockHolderPid(resolution.configDir);
  if (holderPid !== null) {
    return fail(
      `signal-cli process (pid ${holderPid}) is holding ${resolution.configDir}. Stop the gateway / daemon for this account first.`,
      { configDir: resolution.configDir, signalCliVersion },
    );
  }

  // §1.2-1.4 link attempts with expiry renewal.
  let cancelCurrent: (() => void) | null = null;
  const onSigint = () => {
    cancelCurrent?.();
  };
  process.once("SIGINT", onSigint);
  let attempts = 0;
  let linkedNumber: string | null = null;
  try {
    while (attempts < maxAttempts) {
      if (Date.now() >= deadlineMs) {
        return fail("Timed out waiting for the phone to confirm.", {
          configDir: resolution.configDir,
          signalCliVersion,
          attempts,
        });
      }
      attempts += 1;
      if (attempts > 1 && !params.json) {
        output.log("QR expired, new QR shown");
      }
      const outcome = await runLinkAttempt({
        resolution,
        deadlineMs,
        output,
        pngPath: params.pngPath,
        renderTerminalQr:
          params.renderTerminalQr ??
          ((uri: string) => {
            // Default renderer; lazy so tests can inject.
            throw new Error(`no terminal QR renderer configured (${uri.length} chars)`);
          }),
        writePng: params.writePng,
        onQr: params.onQr,
        onCancel: (cancel) => {
          cancelCurrent = cancel;
          params.registerKill?.(cancel);
        },
      });
      if (outcome.kind === "linked") {
        linkedNumber = outcome.number;
        break;
      }
      if (outcome.kind === "failed") {
        return fail(outcome.error, {
          configDir: resolution.configDir,
          signalCliVersion,
          attempts,
        });
      }
      // expired → loop for a fresh QR
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
  }

  if (!linkedNumber) {
    return fail(`QR expired ${maxAttempts} times; giving up. Rerun the command to try again.`, {
      configDir: resolution.configDir,
      signalCliVersion,
      attempts,
    });
  }

  // §1.5 verify: number match + the account exists in the config dir.
  if (resolution.expectedNumber && linkedNumber !== resolution.expectedNumber) {
    return fail(
      `Linked number ${linkedNumber} does not match --number ${resolution.expectedNumber}; not writing config.`,
      { configDir: resolution.configDir, signalCliVersion, attempts },
    );
  }
  const verify = await runCapture({
    cliPath: resolution.cliPath,
    args: ["--config", resolution.configDir, "-a", linkedNumber, "listDevices"],
    timeoutMs: 30_000,
  });
  if (!verify.ok) {
    return fail(
      `Link verification failed (listDevices). The account may not be fully provisioned yet.`,
      {
        configDir: resolution.configDir,
        signalCliVersion,
        attempts,
        number: linkedNumber,
      },
    );
  }

  // fresh-install ARCH §1.4: record the account's ACI so the operator can invite
  // this agent to groups by its uuid (a phone-number invite cannot be accepted by
  // a linked device). Also lets the gateway auto-accept group invites to our ACI.
  const accountUuid = parseAccountUuid(verify.stdout) ?? undefined;
  if (accountUuid) {
    try {
      params.onAccountUuid?.(accountUuid);
    } catch {
      // persistence is best-effort; the printed uuid is the record
    }
  }

  // §1.6 first sync, bounded; content is never printed.
  await runCapture({
    cliPath: resolution.cliPath,
    args: ["--config", resolution.configDir, "-a", linkedNumber, "receive", "-t", "5"],
    timeoutMs: params.receiveTimeoutMs ?? SIGNAL_LINK_RECEIVE_TIMEOUT_MS,
  });

  // §1.7 optional config write through the validated writer.
  let configWritten = false;
  if (params.writeConfig) {
    if (!params.writeConfigFn) {
      return fail("No config writer available for --write-config.", {
        configDir: resolution.configDir,
        signalCliVersion,
        attempts,
        number: linkedNumber,
      });
    }
    try {
      await params.writeConfigFn({
        configAccountPath: resolution.configAccountPath,
        number: linkedNumber,
      });
      configWritten = true;
    } catch (err) {
      return fail(`Config write failed: ${redactLinkUri(String(err))}`, {
        configDir: resolution.configDir,
        signalCliVersion,
        attempts,
        number: linkedNumber,
      });
    }
  }

  const result: SignalLinkResult = {
    ok: true,
    number: linkedNumber,
    device: resolution.deviceName,
    configDir: resolution.configDir,
    signalCliVersion,
    attempts,
    configWritten,
    accountUuid,
  };
  if (params.json) {
    output.log(JSON.stringify(result));
  } else {
    output.log(
      `Linked ${linkedNumber} as device "${resolution.deviceName}" after ${attempts} attempt(s).`,
    );
    // fresh-install ARCH §1.4: a group invite addressed to the phone number
    // cannot be accepted by a linked device; the ACI can.
    if (accountUuid) {
      output.log(`Account ACI (uuid): ${accountUuid} — invite this agent to groups by its uuid.`);
    }
    if (configWritten) {
      output.log(`Wrote ${resolution.configAccountPath} to the config.`);
      output.log("Next step: restart the gateway, then send a test message.");
    } else {
      output.log(
        `Next step: set ${resolution.configAccountPath} to ${linkedNumber} (or rerun with --write-config), restart the gateway, then send a test message.`,
      );
    }
  }
  return result;
}
