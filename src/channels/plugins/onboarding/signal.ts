import { formatCliCommand } from "../../../cli/command-format.js";
import { detectBinary } from "../../../commands/onboard-helpers.js";
import {
  installSignalCli,
  isSignalCliVersionBelowMinimum,
  MIN_SIGNAL_CLI_VERSION,
} from "../../../commands/signal-install.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { runCommandWithTimeout } from "../../../process/exec.js";
import {
  listSignalAccountIds,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
} from "../../../signal/accounts.js";
import { formatDocsLink } from "../../../terminal/links.js";
import { normalizeE164 } from "../../../utils.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import type { ChannelOnboardingAdapter, ChannelOnboardingDmPolicy } from "../onboarding-types.js";
import * as onboardingHelpers from "./helpers.js";

const channel = "signal" as const;
const MIN_E164_DIGITS = 5;
const MAX_E164_DIGITS = 15;
const DIGITS_ONLY = /^\d+$/;
const INVALID_SIGNAL_ACCOUNT_ERROR =
  "Invalid E.164 phone number (must start with + and country code, e.g. +15555550123)";

export function normalizeSignalAccountInput(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = normalizeE164(trimmed);
  const digits = normalized.slice(1);
  if (!DIGITS_ONLY.test(digits)) {
    return null;
  }
  if (digits.length < MIN_E164_DIGITS || digits.length > MAX_E164_DIGITS) {
    return null;
  }
  return `+${digits}`;
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function parseSignalAllowFromEntries(raw: string): { entries: string[]; error?: string } {
  return onboardingHelpers.parseOnboardingEntriesAllowingWildcard(raw, (entry) => {
    if (entry.toLowerCase().startsWith("uuid:")) {
      const id = entry.slice("uuid:".length).trim();
      if (!id) {
        return { error: "Invalid uuid entry" };
      }
      return { value: `uuid:${id}` };
    }
    if (isUuidLike(entry)) {
      return { value: `uuid:${entry}` };
    }
    const normalized = normalizeSignalAccountInput(entry);
    if (!normalized) {
      return { error: `Invalid entry: ${entry}` };
    }
    return { value: normalized };
  });
}

async function promptSignalAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<OpenClawConfig> {
  return onboardingHelpers.promptParsedAllowFromForScopedChannel({
    cfg: params.cfg,
    channel: "signal",
    accountId: params.accountId,
    defaultAccountId: resolveDefaultSignalAccountId(params.cfg),
    prompter: params.prompter,
    noteTitle: "Signal allowlist",
    noteLines: [
      "Allowlist Signal DMs by sender id.",
      "Examples:",
      "- +15555550123",
      "- uuid:123e4567-e89b-12d3-a456-426614174000",
      "Multiple entries: comma-separated.",
      `Docs: ${formatDocsLink("/signal", "signal")}`,
    ],
    message: "Signal allowFrom (E.164 or uuid)",
    placeholder: "+15555550123, uuid:123e4567-e89b-12d3-a456-426614174000",
    parseEntries: parseSignalAllowFromEntries,
    getExistingAllowFrom: ({ cfg, accountId }) => {
      const resolved = resolveSignalAccount({ cfg, accountId });
      return resolved.config.allowFrom ?? [];
    },
  });
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Signal",
  channel,
  policyKey: "channels.signal.dmPolicy",
  allowFromKey: "channels.signal.allowFrom",
  getCurrent: (cfg) => cfg.channels?.signal?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) =>
    onboardingHelpers.setChannelDmPolicyWithAllowFrom({
      cfg,
      channel: "signal",
      dmPolicy: policy,
    }),
  promptAllowFrom: promptSignalAllowFrom,
};

export const signalOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const configured = listSignalAccountIds(cfg).some(
      (accountId) => resolveSignalAccount({ cfg, accountId }).configured,
    );
    const signalCliPath = cfg.channels?.signal?.cliPath ?? "signal-cli";
    const signalCliDetected = await detectBinary(signalCliPath);
    return {
      channel,
      configured,
      statusLines: [
        `Signal: ${configured ? "configured" : "needs setup"}`,
        `signal-cli: ${signalCliDetected ? "found" : "missing"} (${signalCliPath})`,
      ],
      selectionHint: signalCliDetected ? "signal-cli found" : "signal-cli missing",
      quickstartScore: signalCliDetected ? 1 : 0,
    };
  },
  configure: async ({
    cfg,
    runtime,
    prompter,
    accountOverrides,
    shouldPromptAccountIds,
    options,
  }) => {
    const defaultSignalAccountId = resolveDefaultSignalAccountId(cfg);
    const signalAccountId = await onboardingHelpers.resolveAccountIdForConfigure({
      cfg,
      prompter,
      label: "Signal",
      accountOverride: accountOverrides.signal,
      shouldPromptAccountIds,
      listAccountIds: listSignalAccountIds,
      defaultAccountId: defaultSignalAccountId,
    });

    let next = cfg;
    const resolvedAccount = resolveSignalAccount({
      cfg: next,
      accountId: signalAccountId,
    });
    const accountConfig = resolvedAccount.config;
    let resolvedCliPath = accountConfig.cliPath ?? "signal-cli";
    let cliDetected = await detectBinary(resolvedCliPath);
    if (options?.allowSignalInstall) {
      // fresh-install ARCH §1.2: a detected-but-known-bad signal-cli is worse
      // than none — linking fails later with "network failed" on current phones.
      let detectedTooOld = false;
      if (cliDetected) {
        const vResult = await runCommandWithTimeout([resolvedCliPath, "--version"], {
          timeoutMs: 10_000,
        }).catch(() => null);
        const versionLine = (vResult?.stdout ?? "").trim();
        detectedTooOld = Boolean(versionLine) && isSignalCliVersionBelowMinimum(versionLine);
        if (detectedTooOld) {
          await prompter.note(
            `signal-cli at ${resolvedCliPath} is below the minimum supported version ${MIN_SIGNAL_CLI_VERSION} (older builds fail linking with "network failed" on current phones).`,
            "Signal",
          );
        }
      }
      const wantsInstall = await prompter.confirm({
        message: !cliDetected
          ? "signal-cli not found. Install now?"
          : detectedTooOld
            ? `signal-cli is below ${MIN_SIGNAL_CLI_VERSION}. Install a newer one now?`
            : "signal-cli detected. Reinstall/update now?",
        initialValue: !cliDetected || detectedTooOld,
      });
      if (wantsInstall) {
        try {
          const result = await installSignalCli(runtime);
          if (result.ok && result.cliPath) {
            cliDetected = true;
            resolvedCliPath = result.cliPath;
            await prompter.note(`Installed signal-cli at ${result.cliPath}`, "Signal");
          } else if (!result.ok) {
            await prompter.note(result.error ?? "signal-cli install failed.", "Signal");
          }
        } catch (err) {
          await prompter.note(`signal-cli install failed: ${String(err)}`, "Signal");
        }
      }
    }

    if (!cliDetected) {
      await prompter.note(
        "signal-cli not found. Install it, then rerun this step or set channels.signal.cliPath.",
        "Signal",
      );
    }

    let account = accountConfig.account ?? "";
    if (account) {
      const normalizedExisting = normalizeSignalAccountInput(account);
      if (!normalizedExisting) {
        await prompter.note(
          "Existing Signal account isn't a valid E.164 number. Please enter it again.",
          "Signal",
        );
        account = "";
      } else {
        account = normalizedExisting;
        const keep = await prompter.confirm({
          message: `Signal account set (${account}). Keep it?`,
          initialValue: true,
        });
        if (!keep) {
          account = "";
        }
      }
    }

    if (!account) {
      const rawAccount = await prompter.text({
        message: "Signal bot number (E.164)",
        validate: (value) =>
          normalizeSignalAccountInput(value ?? "") ? undefined : INVALID_SIGNAL_ACCOUNT_ERROR,
      });
      account = normalizeSignalAccountInput(rawAccount) ?? "";
    }

    if (account) {
      next = onboardingHelpers.patchChannelConfigForAccount({
        cfg: next,
        channel: "signal",
        accountId: signalAccountId,
        patch: {
          account,
          cliPath: resolvedCliPath ?? "signal-cli",
        },
      });
    }

    // fresh-install ARCH §1.5 (group-first default): onboarding asks "Allow
    // direct messages?" default No → dmPolicy "disabled", groupPolicy
    // "allowlist", and the operator's own Signal id goes into groupAllowFrom.
    const allowDms = await prompter.confirm({
      message: "Allow direct messages? (default: No — groups only)",
      initialValue: false,
    });
    if (!allowDms) {
      const rawOperatorId = await prompter.text({
        message: "Your Signal id (uuid or E.164) for group invites/admin",
        placeholder: "uuid:123e4567-e89b-12d3-a456-426614174000 or +15555550123",
        validate: (value) => {
          const parsed = parseSignalAllowFromEntries(value ?? "");
          return parsed.error ?? (parsed.entries.length === 1 ? undefined : "Enter exactly one id");
        },
      });
      const operatorEntry = parseSignalAllowFromEntries(rawOperatorId).entries[0];
      next = onboardingHelpers.patchChannelConfigForAccount({
        cfg: next,
        channel: "signal",
        accountId: signalAccountId,
        patch: {
          dmPolicy: "disabled",
          groupPolicy: "allowlist",
          ...(operatorEntry ? { groupAllowFrom: [operatorEntry] } : {}),
        },
      });
    }

    // fresh-install ARCH §1.3: where onboarding printed "Link device with:
    // signal-cli link …", it now runs the link helper instead (QR in the
    // terminal, auto-renew, verify). Registration by SMS stays manual.
    if (cliDetected && account) {
      const wantsLink = await prompter.confirm({
        message: "Link this device to the Signal account now? (QR in the terminal)",
        initialValue: true,
      });
      if (wantsLink) {
        const { resolveSignalLinkTarget, runSignalLink } = await import("../../../signal/link.js");
        const { default: qrcode } = await import("qrcode-terminal");
        const resolution = resolveSignalLinkTarget({
          cfg: next,
          accountId: signalAccountId,
          number: account,
        });
        // fresh-install ARCH §1.4: record the account ACI into the config so the
        // gateway can auto-accept pending group invites addressed to it.
        let linkedAci: string | undefined;
        const result = await runSignalLink({
          resolution,
          writeConfig: false,
          renderTerminalQr: (uri) => qrcode.generate(uri, { small: true }),
          output: {
            log: (line) => runtime.log(line),
            error: (line) => runtime.error(line),
          },
          onAccountUuid: (uuid) => {
            linkedAci = uuid;
          },
        });
        if (linkedAci) {
          next = onboardingHelpers.patchChannelConfigForAccount({
            cfg: next,
            channel: "signal",
            accountId: signalAccountId,
            patch: { accountUuid: linkedAci },
          });
        }
        if (result.ok) {
          await prompter.note(
            linkedAci
              ? `Linked ${result.number}. Account ACI (uuid): ${linkedAci} — invite this agent to groups by its uuid.`
              : `Linked ${result.number}.`,
            "Signal",
          );
        } else {
          await prompter.note(
            `Link failed: ${result.error ?? "unknown error"}. You can retry with: ${formatCliCommand("openclaw signal link")}`,
            "Signal",
          );
        }
      } else {
        await prompter.note(
          [
            `Link later with: ${formatCliCommand("openclaw signal link --write-config")}`,
            `Then run: ${formatCliCommand("openclaw gateway call channels.status --params '{\"probe\":true}'")}`,
            `Docs: ${formatDocsLink("/signal", "signal")}`,
          ].join("\n"),
          "Signal next steps",
        );
      }
    }

    return { cfg: next, accountId: signalAccountId };
  },
  dmPolicy,
  disable: (cfg) => onboardingHelpers.setOnboardingChannelEnabled(cfg, channel, false),
};
