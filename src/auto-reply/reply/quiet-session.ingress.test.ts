/**
 * docs/design/agent-peers-and-quiet-sessions.md §3.1: the shared ingress predicate every channel
 * command gate consults. Placeholders only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store.js";
import { isControlCommandMessage } from "../command-detection.js";
import { hasSessionControlCommand, isSlashTextForQuietSession } from "./quiet-session.js";

const QUIET = "agent:main:telegram:group:-100quiet";
const LOUD = "agent:main:telegram:group:-100loud";
let dir: string;
let cfg: OpenClawConfig;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "quiet-ingress-"));
  const store = path.join(dir, "sessions.json");
  fs.writeFileSync(
    store,
    JSON.stringify({
      [QUIET]: { sessionId: "q", updatedAt: 1, slashCommands: false },
      [LOUD]: { sessionId: "l", updatedAt: 1 },
    }),
  );
  clearSessionStoreCacheForTest();
  cfg = { session: { store } } as OpenClawConfig;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("hasSessionControlCommand / isSlashTextForQuietSession (ARCH §3.1)", () => {
  it("unset session, unknown session or no key: identical to hasControlCommand", () => {
    for (const sessionKey of [LOUD, "agent:main:telegram:group:-100none", undefined]) {
      expect(hasSessionControlCommand({ text: "/status", cfg, sessionKey })).toBe(true);
      expect(hasSessionControlCommand({ text: "hello", cfg, sessionKey })).toBe(false);
      expect(isSlashTextForQuietSession({ text: "/status", cfg, sessionKey })).toBe(false);
    }
  });

  it("slashCommands: false: /… is not a control command at ingress", () => {
    expect(hasSessionControlCommand({ text: "/status", cfg, sessionKey: QUIET })).toBe(false);
    expect(hasSessionControlCommand({ text: "/new hello", cfg, sessionKey: QUIET })).toBe(false);
    expect(isSlashTextForQuietSession({ text: "/status", cfg, sessionKey: QUIET })).toBe(true);
  });

  it("slashCommands: false: /session stays a command at ingress (operator undo path)", () => {
    expect(
      hasSessionControlCommand({ text: "/session slash-commands on", cfg, sessionKey: QUIET }),
    ).toBe(true);
    expect(isSlashTextForQuietSession({ text: "/session quiet", cfg, sessionKey: QUIET })).toBe(
      false,
    );
  });

  it("accepts a custom detector (isControlCommandMessage for stop words)", () => {
    expect(
      hasSessionControlCommand({
        text: "stop",
        cfg,
        sessionKey: LOUD,
        detect: isControlCommandMessage,
      }),
    ).toBe(true);
    // Only `/…` text is affected: a plain stop word is still a control command.
    expect(
      hasSessionControlCommand({
        text: "stop",
        cfg,
        sessionKey: QUIET,
        detect: isControlCommandMessage,
      }),
    ).toBe(true);
    expect(
      hasSessionControlCommand({
        text: "/stop",
        cfg,
        sessionKey: QUIET,
        detect: isControlCommandMessage,
      }),
    ).toBe(false);
  });
});
