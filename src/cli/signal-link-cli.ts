import { spawn } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import type { Command } from "commander";
import qrcode from "qrcode-terminal";
import { loadConfig } from "../config/config.js";
import { danger } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import { resolveSignalLinkTarget, runSignalLink } from "../signal/link.js";
import { renderQrPngBase64 } from "../web/qr-image.js";

function renderTerminalQr(uri: string): void {
  // qrcode-terminal writes the QR directly to the terminal; it never receives
  // the URI as a printed line, only as QR modules (ARCH §1.2/§1.3).
  qrcode.generate(uri, { small: true });
}

async function writePng(uri: string, pngPath: string): Promise<void> {
  const base64 = await renderQrPngBase64(uri);
  await writeFile(pngPath, Buffer.from(base64, "base64"), { mode: 0o600 });
  await chmod(pngPath, 0o600);
}

/** The same validated writer as `openclaw config set` (ARCH §1.7). */
async function writeSignalAccountConfig(params: {
  configAccountPath: string;
  number: string;
}): Promise<void> {
  const { setConfigValueLikeConfigSet } = await import("./config-cli.js");
  await setConfigValueLikeConfigSet({ path: params.configAccountPath, value: params.number });
}

/**
 * Persist the linked account's ACI (fresh-install ARCH §1.4) next to the
 * account config so the gateway can auto-accept group invites addressed to it.
 */
async function writeSignalAccountUuidConfig(params: {
  configAccountPath: string;
  uuid: string;
}): Promise<void> {
  const { setConfigValueLikeConfigSet } = await import("./config-cli.js");
  // channels.signal.account -> channels.signal.accountUuid,
  // channels.signal.accounts.<id>.account -> channels.signal.accounts.<id>.accountUuid
  const uuidPath = params.configAccountPath.endsWith(".account")
    ? `${params.configAccountPath.slice(0, -".account".length)}.accountUuid`
    : `${params.configAccountPath}.accountUuid`;
  await setConfigValueLikeConfigSet({ path: uuidPath, value: params.uuid });
}

export function registerSignalLinkCli(signal: Command) {
  signal
    .command("link")
    .description("Link signal-cli as a secondary device of a Signal account (QR flow)")
    .option("--account <accountId>", "Signal account id (default account when omitted)")
    .option(
      "--name <deviceName>",
      "Linked device name (default: gateway.instanceName, else openclaw)",
    )
    .option("--number <e164>", "Expected E.164 number; refuses to write config on mismatch")
    .option("--png <path>", "Also write the QR as a PNG (mode 0600) at this path")
    .option("--timeout <seconds>", "Overall timeout in seconds", "600")
    .option("--write-config", "Write the linked number into the config after linking", false)
    .option("--json", "Print one JSON result object (never contains the link URI)", false)
    .option(
      "--on-qr <command>",
      "Run <command> with the PNG path as its only argument as soon as the QR PNG is written (and after each auto-renew); never awaited",
    )
    .option("--relink", "Remove existing local account data for --number first (asks y/N)", false)
    .option("--yes", "Answer yes to the --relink confirmation", false)
    .action(async (opts) => {
      const runtime = defaultRuntime;
      let code = 0;
      try {
        const cfg = loadConfig();
        const timeoutSeconds = Number.parseInt(String(opts.timeout), 10);
        if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
          throw new Error("--timeout must be a positive number of seconds.");
        }
        const resolution = resolveSignalLinkTarget({
          cfg,
          accountId: typeof opts.account === "string" ? opts.account : undefined,
          number: typeof opts.number === "string" ? opts.number : undefined,
          name: typeof opts.name === "string" ? opts.name : undefined,
        });
        const onQrCommand = typeof opts.onQr === "string" ? opts.onQr : undefined;
        if (onQrCommand && typeof opts.png !== "string") {
          throw new Error("--on-qr requires --png.");
        }
        const result = await runSignalLink({
          resolution,
          pngPath: typeof opts.png === "string" ? opts.png : undefined,
          timeoutMs: timeoutSeconds * 1000,
          writeConfig: Boolean(opts.writeConfig),
          json: Boolean(opts.json),
          relink: Boolean(opts.relink),
          confirmedRelink: Boolean(opts.yes),
          renderTerminalQr,
          writePng,
          // Fire-and-forget; the PNG path is the only argument. The URI is
          // never passed to the command, its args, or its env.
          onQr: onQrCommand
            ? (pngPath) => {
                const child = spawn(onQrCommand, [pngPath], {
                  stdio: "ignore",
                  detached: true,
                });
                child.on("error", () => {});
                child.unref();
              }
            : undefined,
          writeConfigFn: writeSignalAccountConfig,
          onAccountUuid: (uuid) => {
            void writeSignalAccountUuidConfig({
              configAccountPath: resolution.configAccountPath,
              uuid,
            }).catch(() => {
              // best-effort; the uuid is printed either way
            });
          },
        });
        code = result.ok ? 0 : 1;
      } catch (err) {
        runtime.error(danger(String(err)));
        code = 1;
      }
      runtime.exit(code);
    });
}
