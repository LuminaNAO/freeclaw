import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import {
  resolveSignalLinkTarget,
  runSignalLink,
  type SignalLinkResult,
} from "../../signal/link.js";
import { renderQrPngBase64 } from "../../web/qr-image.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

export type SignalLinkState = "waiting" | "expired-renewed" | "linked" | "failed";

type SignalLinkSession = {
  linkId: string;
  configDir: string;
  state: SignalLinkState;
  number?: string;
  error?: string;
  pngPath: string;
  expiresAt: number;
  cancel: () => void;
  done: Promise<void>;
};

const sessions = new Map<string, SignalLinkSession>();
/** One link at a time per config dir (ARCH §2). */
const activeByConfigDir = new Map<string, string>();

const LINK_SESSION_TTL_MS = 10 * 60_000;
const QR_LIFETIME_MS = 120_000;
const PNG_READY_TIMEOUT_MS = 60_000;

function sweepSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (
      now - session.expiresAt > LINK_SESSION_TTL_MS &&
      session.state !== "waiting" &&
      session.state !== "expired-renewed"
    ) {
      sessions.delete(id);
      if (activeByConfigDir.get(session.configDir) === id) {
        activeByConfigDir.delete(session.configDir);
      }
    }
  }
}

async function resolveSignalLinkDir(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const dir = path.join(resolveStateDir(env), "signal-link");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});
  return dir;
}

function assertPlainParams(params: Record<string, unknown>): {
  account?: string;
  name?: string;
  number?: string;
} {
  const account = typeof params.account === "string" ? params.account : undefined;
  const name = typeof params.name === "string" ? params.name : undefined;
  const number = typeof params.number === "string" ? params.number : undefined;
  return { account, name, number };
}

async function startLink(params: {
  account?: string;
  name?: string;
  number?: string;
}): Promise<{ linkId: string; qrPngPath: string; expiresAt: number }> {
  sweepSessions();
  const cfg = loadConfig();
  const resolution = resolveSignalLinkTarget({
    cfg,
    accountId: params.account,
    name: params.name,
    number: params.number,
  });
  if (activeByConfigDir.has(resolution.configDir)) {
    throw new Error(
      `A link is already in progress for ${resolution.configDir}; cancel it or wait for it to finish.`,
    );
  }
  const linkId = randomUUID();
  const dir = await resolveSignalLinkDir();
  const pngPath = path.join(dir, `${linkId}.png`);

  let killChild: () => void = () => {};
  const output = { log: () => {}, error: () => {} };
  const session: SignalLinkSession = {
    linkId,
    configDir: resolution.configDir,
    state: "waiting",
    pngPath,
    expiresAt: Date.now() + QR_LIFETIME_MS,
    cancel: () => {
      // Same as §1.4 Ctrl-C: kill the signal-cli child, then the run settles
      // as failed. Do not just flip state — a live child would keep holding
      // the config dir.
      killChild();
    },
    done: Promise.resolve(),
  };
  sessions.set(linkId, session);
  activeByConfigDir.set(resolution.configDir, linkId);

  let resolvePngReady!: () => void;
  let rejectPngReady!: (err: Error) => void;
  const pngReady = new Promise<void>((resolve, reject) => {
    resolvePngReady = resolve;
    rejectPngReady = reject;
  });
  const pngReadyTimeout = setTimeout(() => {
    rejectPngReady(new Error("Timed out waiting for the QR PNG."));
  }, PNG_READY_TIMEOUT_MS);

  const resultPromise = runSignalLink({
    resolution,
    pngPath,
    json: false,
    output,
    // RPC links are non-interactive: never remove local account data.
    relink: false,
    confirmedRelink: false,
    confirm: async () => false,
    renderTerminalQr: () => {
      // RPC surface: QR goes to the PNG only; the URI is never returned (ARCH §2).
    },
    writePng: async (uri: string, target: string) => {
      const base64 = await renderQrPngBase64(uri);
      await writeFile(target, Buffer.from(base64, "base64"), { mode: 0o600 });
      await chmod(target, 0o600).catch(() => {});
      const hadQr = session.state !== "waiting";
      session.expiresAt = Date.now() + QR_LIFETIME_MS;
      if (hadQr) {
        // A renewed QR replaced a previous one mid-flight (ARCH §2).
        session.state = "expired-renewed";
      }
      resolvePngReady();
    },
    registerKill: (kill) => {
      killChild = kill;
    },
    onAccountUuid: (uuid) => {
      // fresh-install ARCH §1.4: persist the ACI through the validated writer.
      const uuidPath = resolution.configAccountPath.endsWith(".account")
        ? `${resolution.configAccountPath.slice(0, -".account".length)}.accountUuid`
        : `${resolution.configAccountPath}.accountUuid`;
      void import("../../cli/config-cli.js")
        .then(({ setConfigValueLikeConfigSet }) =>
          setConfigValueLikeConfigSet({ path: uuidPath, value: uuid }),
        )
        .catch(() => {});
    },
  });

  session.done = (async () => {
    try {
      const result: SignalLinkResult = await resultPromise;
      if (result.ok) {
        session.state = "linked";
        session.number = result.number;
      } else {
        session.state = "failed";
        session.error = result.error ?? "link failed";
      }
    } catch (err) {
      session.state = "failed";
      session.error = String(err);
    } finally {
      activeByConfigDir.delete(resolution.configDir);
      session.expiresAt = Date.now(); // start the retention TTL now
      await rm(pngPath, { force: true }).catch(() => {});
    }
  })();

  // Reply only once the PNG exists, so qrPngPath is usable immediately and
  // expiresAt reflects the real QR lifetime. If the link fails before the
  // first QR, surface that error instead.
  const pngWait = pngReady.finally(() => clearTimeout(pngReadyTimeout));
  const failedEarly = session.done.then(() => {
    if (session.state === "failed") {
      throw new Error(session.error ?? "link failed");
    }
  });
  try {
    await Promise.race([pngWait, failedEarly]);
  } catch (err) {
    sessions.delete(linkId);
    activeByConfigDir.delete(resolution.configDir);
    session.cancel();
    throw err;
  }
  // Confirm the PNG is really there before handing the path to an agent.
  await stat(pngPath);
  return { linkId, qrPngPath: pngPath, expiresAt: session.expiresAt };
}

function getSession(linkId: string): SignalLinkSession {
  sweepSessions();
  const session = sessions.get(linkId);
  if (!session) {
    throw new Error(`Unknown or expired linkId: ${linkId}`);
  }
  return session;
}

export const signalLinkHandlers: GatewayRequestHandlers = {
  "signal.link.start": async ({ params, respond }) => {
    try {
      const p = assertPlainParams(params);
      const started = await startLink(p);
      respond(true, started, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },
  "signal.link.status": ({ params, respond }) => {
    try {
      const linkId = typeof params.linkId === "string" ? params.linkId : "";
      const session = getSession(linkId);
      respond(true, {
        state: session.state,
        ...(session.number ? { number: session.number } : {}),
        ...(session.error ? { error: session.error } : {}),
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },
  "signal.link.cancel": ({ params, respond }) => {
    try {
      const linkId = typeof params.linkId === "string" ? params.linkId : "";
      const session = getSession(linkId);
      session.cancel();
      respond(true, { cancelled: true }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },
};
