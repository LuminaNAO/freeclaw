import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeFocusLevel,
  clearAllFocus,
  clearSessionFocus,
  FOCUS_TIERS,
  focusAllows,
  focusHolding,
  formatFocusStatusLines,
  holdFocusFiles,
  isFocusCommandText,
  listHeldFocusSessions,
  markFocusNotified,
  parseFocusTier,
  readFocusState,
  readFocusStatus,
  registerFocusReplayer,
  resolveFocusFile,
  sessionFocusTier,
  setSessionFocus,
  takeHeldFocusFiles,
} from "./focus-mode.js";
import { writeStackFile } from "./session-stack.js";

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "focus-test-"));
});

afterEach(() => {
  takeHeldFocusFiles();
  registerFocusReplayer(undefined);
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function writeRaw(value: unknown): void {
  fs.writeFileSync(resolveFocusFile(stateDir), JSON.stringify(value));
}

const A = "agent:main:a";
const B = "agent:main:b";
const C = "agent:main:c";
const D = "agent:main:d";

describe("focus state (focus-mode ARCH §7.1)", () => {
  it("tiers are an ordered list: none < normal < hyper", () => {
    expect(FOCUS_TIERS).toEqual(["none", "normal", "hyper"]);
    expect(parseFocusTier(" Hyper ")).toBe("hyper");
    expect(parseFocusTier("ultra")).toBeUndefined();
  });

  it("none by default", () => {
    expect(readFocusState(stateDir)).toBeUndefined();
    expect(activeFocusLevel(undefined)).toBe("none");
    expect(focusHolding(A, stateDir)).toBeUndefined();
  });

  it("stores { sessions: { key: { tier, since, by } } } in <stateDir>/focus.json, 0600, no temp file", () => {
    const result = setSessionFocus({ sessionKey: A, by: "op", stateDir, now: 1234 });
    expect(result.entry).toEqual({ tier: "normal", since: 1234, by: "op" });
    const file = resolveFocusFile(stateDir);
    expect(file).toBe(path.join(stateDir, "focus.json"));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      sessions: { [A]: { tier: "normal", since: 1234, by: "op" } },
    });
    expect(fs.readdirSync(stateDir)).toEqual(["focus.json"]);
  });

  it("v2 round-trips: what is written is read back (survives a restart)", () => {
    setSessionFocus({ sessionKey: A, tier: "normal", by: "op", stateDir, now: 1 });
    setSessionFocus({ sessionKey: B, tier: "hyper", by: "op2", stateDir, now: 2 });
    const state = readFocusState(stateDir);
    expect(state).toEqual({
      sessions: {
        [A]: { tier: "normal", since: 1, by: "op" },
        [B]: { tier: "hyper", since: 2, by: "op2" },
      },
    });
    // Write that value back out and read it again: identical.
    writeRaw(state);
    expect(readFocusState(stateDir)).toEqual(state);
  });

  it("a v1 file { target, since, by } loads as one normal session", () => {
    writeRaw({ target: A, since: 7, by: "op", notified: [B] });
    expect(readFocusState(stateDir)).toEqual({
      sessions: { [A]: { tier: "normal", since: 7, by: "op" } },
      notified: [B],
    });
    expect(activeFocusLevel(readFocusState(stateDir))).toBe("normal");
    expect(focusHolding(A, stateDir)).toBeUndefined();
    expect(focusHolding(B, stateDir)).toBeDefined();
  });

  it("a v1 file is rewritten in v2 form the next time it is saved", () => {
    writeRaw({ target: A, since: 7, by: "op" });
    setSessionFocus({ sessionKey: B, by: "op2", stateDir, now: 8 });
    expect(JSON.parse(fs.readFileSync(resolveFocusFile(stateDir), "utf8"))).toEqual({
      sessions: {
        [A]: { tier: "normal", since: 7, by: "op" },
        [B]: { tier: "normal", since: 8, by: "op2" },
      },
    });
  });

  it("refuses a cron run as a target", () => {
    expect(() =>
      setSessionFocus({ sessionKey: "agent:main:cron:job-1:run:abc", by: "op", stateDir }),
    ).toThrow(/cron run/);
    expect(readFocusState(stateDir)).toBeUndefined();
  });

  it("accepts any other session key (group, DM, main, cron job)", () => {
    for (const key of [
      "agent:main:main",
      "agent:main:signal:group:abc",
      "agent:main:telegram:direct:42",
      "agent:main:cron:job-1",
    ]) {
      expect(setSessionFocus({ sessionKey: key, by: "op", stateDir }).sessionKey).toBe(key);
    }
    expect(Object.keys(readFocusState(stateDir)?.sessions ?? {})).toHaveLength(4);
  });

  it("setting tier none removes the session; the last one removes the file", () => {
    setSessionFocus({ sessionKey: A, by: "op", stateDir });
    const result = setSessionFocus({ sessionKey: A, tier: "none", by: "op", stateDir });
    expect(result.entry).toBeUndefined();
    expect(result.previous?.tier).toBe("normal");
    expect(fs.existsSync(resolveFocusFile(stateDir))).toBe(false);
  });

  it("session keys match case-insensitively; re-setting replaces the tier", () => {
    setSessionFocus({ sessionKey: A, by: "op", stateDir });
    setSessionFocus({ sessionKey: A.toUpperCase(), tier: "hyper", by: "op", stateDir });
    const state = readFocusState(stateDir);
    expect(Object.keys(state?.sessions ?? {})).toHaveLength(1);
    expect(sessionFocusTier(state, A)).toBe("hyper");
  });

  it("an unreadable or empty file means no focus", () => {
    fs.writeFileSync(resolveFocusFile(stateDir), "{not json");
    expect(readFocusState(stateDir)).toBeUndefined();
    writeRaw({ sessions: {} });
    expect(readFocusState(stateDir)).toBeUndefined();
    writeRaw({ sessions: { [A]: { tier: "none", since: 1, by: "op" } } });
    expect(readFocusState(stateDir)).toBeUndefined();
  });
});

describe("the rule (focus-mode ARCH §7.2)", () => {
  it("active level is the highest tier held; a session runs iff its tier ≥ the active level", () => {
    setSessionFocus({ sessionKey: A, by: "op", stateDir });
    setSessionFocus({ sessionKey: B, by: "op", stateDir });
    let state = readFocusState(stateDir);
    expect(activeFocusLevel(state)).toBe("normal");
    expect([A, B, C, D].map((key) => focusAllows(state, key))).toEqual([true, true, false, false]);

    setSessionFocus({ sessionKey: D, tier: "hyper", by: "op", stateDir });
    state = readFocusState(stateDir);
    expect(activeFocusLevel(state)).toBe("hyper");
    expect([A, B, C, D].map((key) => focusAllows(state, key))).toEqual([false, false, false, true]);

    clearSessionFocus(D, stateDir);
    state = readFocusState(stateDir);
    expect(activeFocusLevel(state)).toBe("normal");
    expect([A, B, C, D].map((key) => focusAllows(state, key))).toEqual([true, true, false, false]);

    clearAllFocus(stateDir);
    expect(readFocusState(stateDir)).toBeUndefined();
    expect([A, B, C, D].every((key) => focusAllows(undefined, key))).toBe(true);
  });

  it("the focus command is recognised by both names", () => {
    expect(isFocusCommandText("/focus")).toBe(true);
    expect(isFocusCommandText("/focus off here")).toBe(true);
    expect(isFocusCommandText("/FocusMode off")).toBe(true);
    expect(isFocusCommandText("/focusing")).toBe(false);
    expect(isFocusCommandText("focus")).toBe(false);
  });
});

describe("busy notice (focus-mode ARCH §3.2 under §7)", () => {
  it("once per session per focus period, recorded on disk", () => {
    expect(markFocusNotified(C, stateDir)).toBe(false); // no focus
    setSessionFocus({ sessionKey: A, by: "op", stateDir });
    expect(markFocusNotified(A, stateDir)).toBe(false); // allowed, never notified
    expect(markFocusNotified(C, stateDir)).toBe(true);
    expect(markFocusNotified(C, stateDir)).toBe(false);
    expect(markFocusNotified(D, stateDir)).toBe(true);
    expect(readFocusState(stateDir)?.notified).toEqual([C, D]);
    // A new focus period starts fresh.
    clearAllFocus(stateDir);
    setSessionFocus({ sessionKey: A, by: "op", stateDir });
    expect(markFocusNotified(C, stateDir)).toBe(true);
  });

  it("a session that is allowed again leaves the list; if held again later it gets a new notice", () => {
    setSessionFocus({ sessionKey: A, by: "op", stateDir });
    expect(markFocusNotified(B, stateDir)).toBe(true);
    setSessionFocus({ sessionKey: D, tier: "hyper", by: "op", stateDir });
    expect(markFocusNotified(A, stateDir)).toBe(true); // A now waits too
    expect(readFocusState(stateDir)?.notified).toEqual([B, A]);
    clearSessionFocus(D, stateDir); // A allowed again, B still waits
    expect(readFocusState(stateDir)?.notified).toEqual([B]);
    setSessionFocus({ sessionKey: D, tier: "hyper", by: "op", stateDir });
    expect(markFocusNotified(A, stateDir)).toBe(true);
  });
});

describe("release (focus-mode ARCH §7.3)", () => {
  it("every change replays the held sessions allowed at the new level, after the state is saved", () => {
    const seen: Array<{ allowed: string[]; active: string }> = [];
    registerFocusReplayer((allow) => {
      const taken = takeHeldFocusFiles(allow);
      seen.push({
        allowed: [...taken.keys()],
        active: activeFocusLevel(readFocusState(stateDir)),
      });
      return { sessions: taken.size, done: Promise.resolve() };
    });
    setSessionFocus({ sessionKey: A, by: "op", stateDir });
    setSessionFocus({ sessionKey: B, by: "op", stateDir });
    holdFocusFiles(C, ["/x/c1"]);
    setSessionFocus({ sessionKey: D, tier: "hyper", by: "op", stateDir });
    holdFocusFiles(A, ["/x/a1"]);
    holdFocusFiles(B, ["/x/b1"]);
    seen.length = 0;

    // Lower: hyper removed → A and B released, C still held.
    const lowered = clearSessionFocus(D, stateDir);
    expect(lowered.replaying).toBe(2);
    expect(seen).toEqual([{ allowed: [A, B], active: "normal" }]);
    expect(listHeldFocusSessions()).toEqual([C]);

    // A tier rising to meet the level releases that session.
    holdFocusFiles(D, ["/x/d1"]);
    const raised = setSessionFocus({ sessionKey: D, by: "op", stateDir });
    expect(raised.replaying).toBe(1);
    expect(seen[1]).toEqual({ allowed: [D], active: "normal" });
    expect(listHeldFocusSessions()).toEqual([C]);

    // Clearing the last focus replays all waiting sessions.
    const off = clearAllFocus(stateDir);
    expect(off.replaying).toBe(1);
    expect(seen[2]).toEqual({ allowed: [C], active: "none" });
    expect(Object.keys(off.ended).toSorted()).toEqual([A, B, D]);
    expect(listHeldFocusSessions()).toEqual([]);
  });

  it("without a registered replayer nothing is replayed and held files stay held", () => {
    setSessionFocus({ sessionKey: A, by: "op", stateDir });
    holdFocusFiles(C, ["/x/c1"]);
    expect(clearAllFocus(stateDir).replaying).toBe(0);
    expect(listHeldFocusSessions()).toEqual([C]);
  });

  it("raising the level holds nothing new by itself and replays nothing", () => {
    const replayer = vi.fn((allow: (key: string) => boolean) => {
      const taken = takeHeldFocusFiles(allow);
      return { sessions: taken.size, done: Promise.resolve() };
    });
    registerFocusReplayer(replayer);
    setSessionFocus({ sessionKey: A, by: "op", stateDir });
    holdFocusFiles(C, ["/x/c1"]);
    expect(setSessionFocus({ sessionKey: D, tier: "hyper", by: "op", stateDir }).replaying).toBe(0);
    expect(listHeldFocusSessions()).toEqual([C]);
  });
});

describe("held files", () => {
  it("are taken once; a filter takes only the sessions it accepts", () => {
    holdFocusFiles(A, ["/x/1", "/x/2"]);
    holdFocusFiles(A, ["/x/2", "/x/3"]);
    holdFocusFiles(B, ["/x/4"]);
    const onlyB = takeHeldFocusFiles((key) => key === B);
    expect([...onlyB.keys()]).toEqual([B]);
    const taken = takeHeldFocusFiles();
    expect([...(taken.get(A) ?? [])]).toEqual(["/x/1", "/x/2", "/x/3"]);
    expect(takeHeldFocusFiles().size).toBe(0);
  });
});

describe("status (focus-mode ARCH §7.4)", () => {
  it("each focused session with tier and since, the active level, and waiting per held session", () => {
    setSessionFocus({ sessionKey: A, by: "op", stateDir, now: 0 });
    setSessionFocus({ sessionKey: D, tier: "hyper", by: "op2", stateDir, now: 1000 });
    writeStackFile({ sessionKey: A, source: "inbound", payload: {}, stateDir });
    writeStackFile({ sessionKey: C, source: "inbound", payload: {}, stateDir });
    writeStackFile({ sessionKey: C, source: "inbound", payload: {}, stateDir });
    writeStackFile({ sessionKey: D, source: "inbound", payload: {}, stateDir });
    writeStackFile({ sessionKey: B, source: "agent", payload: {}, stateDir });
    const status = readFocusStatus(stateDir);
    expect(status.active).toBe("hyper");
    expect(status.sessions.map((s) => [s.sessionKey, s.tier])).toEqual([
      [D, "hyper"],
      [A, "normal"],
    ]);
    expect(status.waiting.toSorted((x, y) => x.sessionKey.localeCompare(y.sessionKey))).toEqual([
      { sessionKey: A, count: 1 },
      { sessionKey: C, count: 2 },
    ]);
    expect(formatFocusStatusLines({ ...status, waiting: [{ sessionKey: C, count: 2 }] })).toEqual([
      "Focus: active level hyper",
      `  ${D}  hyper  since 1970-01-01T00:00:01.000Z by op2`,
      `  ${A}  normal  since 1970-01-01T00:00:00.000Z by op`,
      "Waiting:",
      `  ${C}  waiting=2`,
    ]);
    clearAllFocus(stateDir);
    expect(readFocusStatus(stateDir)).toEqual({ active: "none", sessions: [], waiting: [] });
    expect(formatFocusStatusLines(readFocusStatus(stateDir))).toEqual(["Focus is off."]);
  });
});
