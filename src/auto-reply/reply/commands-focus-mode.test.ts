// `/focusmode` (focus-mode ARCH §4). `/focus` (thread binding) is a different command.
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  clearFocusState,
  readFocusState,
  setFocusState,
  takeHeldFocusFiles,
} from "../../infra/focus-mode.js";
import { deleteStackFiles, listStack, writeStackFile } from "../../infra/session-stack.js";
import { handleFocusModeCommand } from "./commands-focus-mode.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const ownerCfg = { commands: { ownerAllowFrom: ["+2000"] } } as OpenClawConfig;
const OWNER = { SenderId: "+2000", From: "+2000" };

afterEach(() => {
  clearFocusState();
  takeHeldFocusFiles();
  deleteStackFiles(listStack().flatMap((s) => s.entries.map((e) => e.file)));
});

async function run(body: string, overrides: Record<string, unknown> = OWNER, cfg = ownerCfg) {
  const params = buildCommandTestParams(body, cfg, overrides);
  return await handleFocusModeCommand(params, true);
}

describe("/focusmode (focus-mode ARCH §4)", () => {
  it("does not claim /focus or /unfocus (thread binding stays as it is)", async () => {
    expect(await run("/focus codex")).toBeNull();
    expect(await run("/unfocus")).toBeNull();
    expect(await run("/focusing")).toBeNull();
  });

  it("<session-key> sets the target", async () => {
    const result = await run("/focusmode agent:main:signal:group:abc");
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("agent:main:signal:group:abc");
    expect(readFocusState()).toMatchObject({ target: "agent:main:signal:group:abc", by: "+2000" });
  });

  it("main resolves to the main session key", async () => {
    await run("/focusmode main");
    expect(readFocusState()?.target).toBe("agent:main:main");
  });

  it("here sets the session the command is sent from", async () => {
    await run("/focusmode here");
    expect(readFocusState()?.target).toBe("agent:main:main");
  });

  it("a cron run is refused as a target", async () => {
    const result = await run("/focusmode agent:main:cron:job:run:abc");
    expect(result?.reply?.text).toMatch(/cron run/);
    expect(readFocusState()).toBeUndefined();
  });

  it("no argument shows target, since and waiting per session", async () => {
    expect((await run("/focusmode"))?.reply?.text).toBe("Focus mode is off.");
    setFocusState({ target: "agent:main:main", by: "op", now: 0 });
    writeStackFile({ sessionKey: "agent:main:x", source: "inbound", payload: {} });
    const text = (await run("/focusmode"))?.reply?.text ?? "";
    expect(text).toContain("Focus mode: on agent:main:main");
    expect(text).toContain("since 1970-01-01T00:00:00.000Z by op");
    expect(text).toContain("agent:main:x  waiting=1");
  });

  it("off ends it", async () => {
    setFocusState({ target: "agent:main:main", by: "op" });
    const result = await run("/focusmode off");
    expect(result?.reply?.text).toMatch(/^Focus mode off\./);
    expect(readFocusState()).toBeUndefined();
    expect((await run("/focusmode off"))?.reply?.text).toBe("Focus mode is already off.");
  });

  it("a non-operator is refused (standard refusal: ignored, no change)", async () => {
    setFocusState({ target: "agent:main:main", by: "op" });
    const notOwner = await run("/focusmode off", { SenderId: "+1000", From: "+1000" });
    expect(notOwner).toEqual({ shouldContinue: false });
    expect(readFocusState()?.target).toBe("agent:main:main");

    const params = buildCommandTestParams("/focusmode off", ownerCfg, OWNER);
    params.command.isAuthorizedSender = false;
    expect(await handleFocusModeCommand(params, true)).toEqual({ shouldContinue: false });
    expect(readFocusState()?.target).toBe("agent:main:main");
  });

  it("ignored when text commands are off", async () => {
    const params = buildCommandTestParams("/focusmode off", ownerCfg, OWNER);
    expect(await handleFocusModeCommand(params, false)).toBeNull();
  });
});
