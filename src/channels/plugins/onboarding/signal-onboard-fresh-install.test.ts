import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import { signalOnboardingAdapter } from "./signal.js";

/**
 * fresh-install ARCH §1.3/§1.5: signal onboarding runs the link helper, and
 * defaults to group-first (dmPolicy disabled, groupPolicy allowlist, operator
 * id in groupAllowFrom). Uses a fake signal-cli on a throwaway state dir.
 */

const roots: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onboard-signal-test-"));
  fs.chmodSync(dir, 0o700);
  roots.push(dir);
  return dir;
}
afterEach(() => {
  while (roots.length) {
    fs.rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

const FAKE_URI =
  "sgnl://linkdevice?uuid=fakeuuid-0000-0000-0000-000000000000&pub_key=BfAkEfAkEfAkEfAkEfAkEfAkEfAkEfAkEfAkEfAkEfA";
const FAKE_ACI = "123e4567-e89b-12d3-a456-426614174000";
const FAKE_NUMBER = "+15550001234";

function makeFakeSignalCli(dir: string): string {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const cli = path.join(bin, "signal-cli");
  fs.writeFileSync(
    cli,
    `#!/usr/bin/env bash
set -u
case "$1" in
  --version) echo "signal-cli 99.99.99-test"; exit 0;;
esac
args="$*"
if [[ "$args" == *" link "* ]]; then
  echo "${FAKE_URI}"
  echo "Associated with: ${FAKE_NUMBER}"
  exit 0
fi
if [[ "$args" == *"listDevices"* ]]; then
  echo "- device 2 (this device)"
  echo "uuid: ${FAKE_ACI}"
  exit 0
fi
if [[ "$args" == *"receive"* ]]; then
  exit 0
fi
exit 0
`,
    { mode: 0o755 },
  );
  return cli;
}

type PromptCall =
  | { kind: "confirm"; message: string; initialValue?: boolean }
  | { kind: "text"; message: string }
  | { kind: "note"; message: string; title?: string };

function makePrompter(script: { confirm?: boolean | Array<boolean>; text?: Array<string> }): {
  prompter: WizardPrompter;
  calls: PromptCall[];
} {
  const calls: PromptCall[] = [];
  const confirmAnswers = Array.isArray(script.confirm)
    ? [...script.confirm]
    : script.confirm !== undefined
      ? [script.confirm]
      : [];
  const textAnswers = [...(script.text ?? [])];
  const prompter = {
    confirm: async (params: { message: string; initialValue?: boolean }) => {
      calls.push({ kind: "confirm", message: params.message, initialValue: params.initialValue });
      return confirmAnswers.length > 0
        ? (confirmAnswers.shift() as boolean)
        : (params.initialValue ?? false);
    },
    text: async (params: { message: string }) => {
      calls.push({ kind: "text", message: params.message });
      const next = textAnswers.shift();
      if (next === undefined) {
        throw new Error(`unexpected text prompt: ${params.message}`);
      }
      return next;
    },
    note: async (message: string, title?: string) => {
      calls.push({ kind: "note", message, title });
    },
    select: async () => {
      throw new Error("unexpected select prompt");
    },
    multiselect: async () => {
      throw new Error("unexpected multiselect prompt");
    },
  } as unknown as WizardPrompter;
  return { prompter, calls };
}

function baseRuntime() {
  return {
    log: () => {},
    error: () => {},
    exit: (code: number) => {
      throw new Error(`exit ${code}`);
    },
  };
}

describe("signal onboarding (fresh-install ARCH §1.3, §1.5)", () => {
  it("links via the helper, writes no HTTP keys, and applies the group-first default", async () => {
    const root = tmpRoot();
    const cli = makeFakeSignalCli(root);
    const cliConfigDir = path.join(root, "signal-cli-config");
    process.env.OPENCLAW_SIGNAL_CLI_CONFIG_DIR = cliConfigDir;
    try {
      const { prompter, calls } = makePrompter({
        // 1: reinstall/update? → no. 2: keep account? n/a. 3: allow DMs? → no.
        // 4: link now? → yes.
        confirm: [false, false, true],
        text: [FAKE_NUMBER, `uuid:${FAKE_ACI}`],
      });
      const cfg = {
        channels: { signal: { cliPath: cli } },
      } as OpenClawConfig;
      const result = await signalOnboardingAdapter.configure({
        cfg,
        runtime: baseRuntime(),
        prompter,
        accountOverrides: {},
        shouldPromptAccountIds: false,
        forceAllowFrom: false,
        options: { allowSignalInstall: true },
      });
      expect(result).not.toBe("skip");
      const nextCfg = (result as { cfg: OpenClawConfig }).cfg;
      const signal = nextCfg.channels?.signal ?? {};
      // §1.1: no HTTP keys are ever written for a fresh config.
      expect(signal.account).toBe(FAKE_NUMBER);
      expect(signal).not.toHaveProperty("httpPort");
      expect(signal).not.toHaveProperty("httpUrl");
      expect(signal).not.toHaveProperty("httpHost");
      expect(signal.transport).not.toBe("http");
      // §1.5: group-first default.
      expect(signal.dmPolicy).toBe("disabled");
      expect(signal.groupPolicy).toBe("allowlist");
      expect(signal.groupAllowFrom).toEqual([`uuid:${FAKE_ACI}`]);
      // §1.4: the ACI is persisted so the gateway can auto-accept pending invites.
      expect(signal.accountUuid).toBe(FAKE_ACI);
      // §1.3: the link helper ran (QR rendered, account linked).
      const notes = calls.filter((c) => c.kind === "note").map((c) => c.message);
      expect(notes.some((m) => m.includes("Linked") && m.includes(FAKE_NUMBER))).toBe(true);
      // §1.4: the ACI is printed with the invite hint.
      expect(notes.some((m) => m.includes(FAKE_ACI) && m.includes("invite this agent"))).toBe(true);
      // The old manual instructions are gone.
      expect(notes.some((m) => m.includes("Link device with: signal-cli link"))).toBe(false);
    } finally {
      delete process.env.OPENCLAW_SIGNAL_CLI_CONFIG_DIR;
    }
  });
});
