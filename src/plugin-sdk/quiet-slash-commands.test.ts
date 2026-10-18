/**
 * docs/design/agent-peers-and-quiet-sessions.md §3.1 for channel plugins: the plugin-sdk wrapper
 * over the real runtime channel surface, against a real session store.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store.js";
import { createRuntimeChannel } from "../plugins/runtime/runtime-channel.js";
import {
  hasSessionControlCommandWithRuntime,
  isSlashTextForQuietSessionWithRuntime,
} from "./quiet-slash-commands.js";

const QUIET = "agent:main:matrix:channel:!quiet";
let dir: string;
let cfg: OpenClawConfig;
const runtime = { channel: createRuntimeChannel() };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-quiet-"));
  const store = path.join(dir, "sessions.json");
  fs.writeFileSync(
    store,
    JSON.stringify({ [QUIET]: { sessionId: "q", updatedAt: 1, slashCommands: false } }),
  );
  clearSessionStoreCacheForTest();
  cfg = { session: { store } } as OpenClawConfig;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("plugin-sdk quiet slash commands (ARCH §3.1)", () => {
  const detect = runtime.channel.text.hasControlCommand;

  it("the runtime exposes the shared predicate", () => {
    expect(typeof runtime.channel.commands.isSlashTextForQuietSession).toBe("function");
    expect(typeof runtime.channel.commands.hasSessionControlCommand).toBe("function");
  });

  it("quiet session: /status is not a control command; /session still is", () => {
    expect(
      hasSessionControlCommandWithRuntime({
        runtime,
        text: "/status",
        cfg,
        sessionKey: QUIET,
        detect,
      }),
    ).toBe(false);
    expect(
      hasSessionControlCommandWithRuntime({
        runtime,
        text: "/session slash-commands on",
        cfg,
        sessionKey: QUIET,
        detect,
      }),
    ).toBe(true);
    expect(
      isSlashTextForQuietSessionWithRuntime({ runtime, text: "/status", cfg, sessionKey: QUIET }),
    ).toBe(true);
  });

  it("other or missing session, or a runtime without the predicate: today's detector", () => {
    for (const sessionKey of ["agent:main:matrix:channel:!other", undefined]) {
      expect(
        hasSessionControlCommandWithRuntime({ runtime, text: "/status", cfg, sessionKey, detect }),
      ).toBe(true);
    }
    expect(
      hasSessionControlCommandWithRuntime({
        runtime: { channel: {} },
        text: "/status",
        cfg,
        sessionKey: QUIET,
        detect,
      }),
    ).toBe(true);
  });
});
