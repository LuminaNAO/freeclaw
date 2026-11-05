// `/focus` (focus-mode ARCH §7.4, tests §7.6); `/focusmode` is its hidden alias.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  clearAllFocus,
  readFocusState,
  registerFocusReplayer,
  sessionFocusTier,
  setSessionFocus,
  takeHeldFocusFiles,
} from "../../infra/focus-mode.js";
import { deleteStackFiles, listStack, writeStackFile } from "../../infra/session-stack.js";
import {
  findCommandByNativeName,
  getCommandDetection,
  listChatCommands,
  normalizeCommandBody,
} from "../commands-registry.js";
import { buildCommandsMessage } from "../status.js";
import { FOCUSMODE_RENAMED_NOTICE, handleFocusCommand } from "./commands-focus.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const ownerCfg = { commands: { ownerAllowFrom: ["+2000"] } } as OpenClawConfig;
const OWNER = { SenderId: "+2000", From: "+2000" };
const GROUP = "agent:main:signal:group:abc";

afterEach(() => {
  clearAllFocus();
  registerFocusReplayer(undefined);
  takeHeldFocusFiles();
  deleteStackFiles(listStack().flatMap((s) => s.entries.map((e) => e.file)));
});

async function run(body: string, overrides: Record<string, unknown> = OWNER, cfg = ownerCfg) {
  const params = buildCommandTestParams(body, cfg, overrides);
  return await handleFocusCommand(params, true);
}

async function text(body: string, overrides?: Record<string, unknown>) {
  return (await run(body, overrides))?.reply?.text ?? "";
}

describe("/focus (focus-mode ARCH §7.4)", () => {
  it("/focus <session key> sets normal by default; [normal|hyper] picks the tier", async () => {
    const result = await run(`/focus ${GROUP}`);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toBe(`Focus: ${GROUP} set to normal.\nActive level: normal.`);
    expect(readFocusState()?.sessions[GROUP]).toMatchObject({
      tier: "normal",
      by: "+2000",
    });

    expect(await text(`/focus ${GROUP} hyper`)).toContain(`${GROUP} set to hyper`);
    expect(sessionFocusTier(readFocusState(), GROUP)).toBe("hyper");
    expect(await text(`/focus ${GROUP} HYPER`)).toContain(`${GROUP} stays at hyper`);
    expect(await text(`/focus ${GROUP} normal`)).toContain(`${GROUP} set to normal`);
  });

  it("/focus here [tier] sets the session the command is sent from; main resolves", async () => {
    await run("/focus here hyper");
    expect(sessionFocusTier(readFocusState(), "agent:main:main")).toBe("hyper");
    await run("/focus main normal");
    expect(sessionFocusTier(readFocusState(), "agent:main:main")).toBe("normal");
  });

  it("an unknown tier, `none` as a tier, extra words and a cron run are refused; nothing changes", async () => {
    expect(await text(`/focus ${GROUP} ultra`)).toMatch(/unknown focus tier "ultra"/);
    expect(await text(`/focus ${GROUP} none`)).toMatch(/unknown focus tier "none"/);
    expect(await text(`/focus ${GROUP} hyper extra`)).toMatch(/Usage: \/focus/);
    expect(await text("/focus off a b")).toMatch(/Usage: \/focus/);
    expect(await text("/focus agent:main:cron:job:run:abc")).toMatch(/cron run/);
    expect(readFocusState()).toBeUndefined();
  });

  it("/focus shows each focused session with tier and since, the active level, and waiting per session", async () => {
    expect(await text("/focus")).toBe("Focus is off.");
    setSessionFocus({ sessionKey: "agent:main:main", by: "op", now: 0 });
    setSessionFocus({ sessionKey: GROUP, tier: "hyper", by: "op2", now: 1000 });
    writeStackFile({
      sessionKey: "agent:main:x",
      source: "inbound",
      payload: {},
    });
    const status = await text("/focus");
    expect(status.split("\n")).toEqual([
      "Focus: active level hyper",
      `  ${GROUP}  hyper  since 1970-01-01T00:00:01.000Z by op2`,
      "  agent:main:main  normal  since 1970-01-01T00:00:00.000Z by op",
      "Waiting:",
      "  agent:main:x  waiting=1",
    ]);
    expect(await text("/focus status")).toBe(status);
  });

  it("/focus off here and /focus off <key> set that session back to none; others stay", async () => {
    setSessionFocus({ sessionKey: "agent:main:main", by: "op" });
    setSessionFocus({ sessionKey: GROUP, tier: "hyper", by: "op" });
    expect(await text("/focus off here")).toBe(
      "Focus: agent:main:main back to none.\nActive level: hyper.",
    );
    expect(sessionFocusTier(readFocusState(), "agent:main:main")).toBe("none");
    expect(sessionFocusTier(readFocusState(), GROUP)).toBe("hyper");
    expect(await text("/focus off agent:main:main")).toBe(
      "Focus: agent:main:main was not focused.\nActive level: hyper.",
    );
    expect(await text(`/focus off ${GROUP}`)).toBe(`Focus: ${GROUP} back to none.`);
    expect(readFocusState()).toBeUndefined();
  });

  it("/focus off (alone) clears all focus and reports the replay (§7.3)", async () => {
    setSessionFocus({ sessionKey: "agent:main:main", by: "op" });
    setSessionFocus({ sessionKey: GROUP, tier: "hyper", by: "op" });
    const replayer = vi.fn(() => ({ sessions: 2, done: Promise.resolve() }));
    registerFocusReplayer(replayer);
    expect(await text("/focus off")).toBe(
      "Focus off: cleared 2 session(s).\nReplaying waiting messages for 2 session(s), one combined prompt each.",
    );
    expect(readFocusState()).toBeUndefined();
    expect(replayer).toHaveBeenCalled();
    registerFocusReplayer(undefined);
    expect(await text("/focus off")).toBe("Focus is already off.");
  });

  it("a non-operator is refused (standard refusal: ignored, no change)", async () => {
    setSessionFocus({ sessionKey: "agent:main:main", by: "op" });
    for (const body of ["/focus off", "/focus here hyper", "/focusmode off", "/focus"]) {
      expect(await run(body, { SenderId: "+1000", From: "+1000" })).toEqual({
        shouldContinue: false,
      });
    }
    const params = buildCommandTestParams("/focus off", ownerCfg, OWNER);
    params.command.isAuthorizedSender = false;
    expect(await handleFocusCommand(params, true)).toEqual({
      shouldContinue: false,
    });
    expect(sessionFocusTier(readFocusState(), "agent:main:main")).toBe("normal");
  });

  it("ignored when text commands are off; other commands are not claimed", async () => {
    const params = buildCommandTestParams("/focus off", ownerCfg, OWNER);
    expect(await handleFocusCommand(params, false)).toBeNull();
    expect(await run("/focusing")).toBeNull();
    expect(await run("/unfocus")).toBeNull();
  });
});

describe("/focusmode: hidden alias of /focus for one release (focus-mode ARCH §7.4)", () => {
  it("still works and names /focus", async () => {
    const set = await text(`/focusmode ${GROUP} hyper`);
    expect(set).toContain(`${GROUP} set to hyper`);
    expect(set.split("\n").at(-1)).toBe(FOCUSMODE_RENAMED_NOTICE);
    expect(FOCUSMODE_RENAMED_NOTICE).toContain("/focus.");
    expect(await text("/focusmode")).toContain(FOCUSMODE_RENAMED_NOTICE);
    expect(await text("/focusmode off")).toBe(
      `Focus off: cleared 1 session(s).\n${FOCUSMODE_RENAMED_NOTICE}`,
    );
    // Errors name it too.
    expect(await text("/focusmode x ultra")).toContain(FOCUSMODE_RENAMED_NOTICE);
  });

  it("is recognised as a command but not listed; /focus is listed as the focus-mode command", () => {
    const detection = getCommandDetection();
    expect(detection.exact.has("/focus")).toBe(true);
    expect(detection.exact.has("/focusmode")).toBe(true);
    expect(normalizeCommandBody("/focusmode: off")).toBe("/focusmode off");
    expect(normalizeCommandBody("/focus: off")).toBe("/focus off");

    const focusmode = listChatCommands().find((c) => c.key === "focusmode");
    expect(focusmode?.hidden).toBe(true);
    expect(focusmode?.nativeName).toBeUndefined();
    expect(findCommandByNativeName("focusmode")).toBeUndefined();
    expect(findCommandByNativeName("focus")?.description).toMatch(/only focused sessions run/);

    const list = buildCommandsMessage(ownerCfg);
    expect(list).toContain("/focus - Focus: only focused sessions run");
    expect(list).not.toContain("/focusmode");
  });
});

describe("thread-binding /focus, /unfocus and /subagents focus|unfocus are gone (focus-mode ARCH §7.4)", () => {
  it("the registry has one /focus (focus mode) and no /unfocus", () => {
    const commands = listChatCommands();
    const withFocusAlias = commands.filter((c) =>
      c.textAliases.some((a) => /^\/(?:un)?focus$/i.test(a)),
    );
    expect(withFocusAlias.map((c) => c.key)).toEqual(["focus"]);
    expect(commands.some((c) => c.key === "unfocus")).toBe(false);
    expect(findCommandByNativeName("unfocus")).toBeUndefined();
    expect(getCommandDetection().exact.has("/unfocus")).toBe(false);
    const list = buildCommandsMessage(ownerCfg);
    expect(list).not.toMatch(/\/unfocus|Bind this thread/);
  });
});
