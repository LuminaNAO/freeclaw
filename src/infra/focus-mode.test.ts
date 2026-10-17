import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearFocusState,
  focusHolding,
  formatFocusStatusLines,
  holdFocusFiles,
  markFocusNotified,
  readFocusState,
  readFocusStatus,
  resolveFocusFile,
  setFocusState,
  takeHeldFocusFiles,
} from "./focus-mode.js";
import { writeStackFile } from "./session-stack.js";

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "focus-test-"));
});

afterEach(() => {
  takeHeldFocusFiles();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("focus mode state (focus-mode ARCH §2)", () => {
  it("none by default", () => {
    expect(readFocusState(stateDir)).toBeUndefined();
    expect(focusHolding("agent:main:x", stateDir)).toBeUndefined();
  });

  it("stores { target, since, by } in <stateDir>/focus.json, 0600, no temp file left", () => {
    const state = setFocusState({ target: "agent:main:main", by: "op", stateDir, now: 1234 });
    expect(state).toEqual({ target: "agent:main:main", since: 1234, by: "op" });
    const file = resolveFocusFile(stateDir);
    expect(file).toBe(path.join(stateDir, "focus.json"));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(state);
    expect(fs.readdirSync(stateDir)).toEqual(["focus.json"]);
  });

  it("survives a restart: the value is read back from disk", () => {
    setFocusState({ target: "agent:main:main", by: "op", stateDir, now: 5 });
    expect(readFocusState(stateDir)).toEqual({ target: "agent:main:main", since: 5, by: "op" });
  });

  it("refuses a cron run as a target", () => {
    expect(() =>
      setFocusState({ target: "agent:main:cron:job-1:run:abc", by: "op", stateDir }),
    ).toThrow(/cron run/);
    expect(readFocusState(stateDir)).toBeUndefined();
  });

  it("accepts any other session key (group, DM, main, console)", () => {
    for (const target of [
      "agent:main:main",
      "agent:main:signal:group:abc",
      "agent:main:telegram:direct:42",
      "agent:main:cron:job-1",
    ]) {
      expect(setFocusState({ target, by: "op", stateDir }).target).toBe(target);
    }
  });

  it("holds every session but the target", () => {
    setFocusState({ target: "agent:main:main", by: "op", stateDir });
    expect(focusHolding("agent:main:main", stateDir)).toBeUndefined();
    expect(focusHolding("AGENT:main:Main", stateDir)).toBeUndefined();
    expect(focusHolding("agent:main:other", stateDir)?.target).toBe("agent:main:main");
  });

  it("clear removes the file and returns the previous value", () => {
    setFocusState({ target: "agent:main:main", by: "op", stateDir, now: 1 });
    expect(clearFocusState(stateDir)?.target).toBe("agent:main:main");
    expect(fs.existsSync(resolveFocusFile(stateDir))).toBe(false);
    expect(clearFocusState(stateDir)).toBeUndefined();
  });

  it("busy notice once per session per focus period, recorded on disk (§3.2)", () => {
    expect(markFocusNotified("agent:main:a", stateDir)).toBe(false); // no focus
    setFocusState({ target: "agent:main:main", by: "op", stateDir });
    expect(markFocusNotified("agent:main:a", stateDir)).toBe(true);
    expect(markFocusNotified("agent:main:a", stateDir)).toBe(false);
    expect(markFocusNotified("agent:main:b", stateDir)).toBe(true);
    expect(readFocusState(stateDir)?.notified).toEqual(["agent:main:a", "agent:main:b"]);
    // A new focus period starts fresh.
    clearFocusState(stateDir);
    setFocusState({ target: "agent:main:main", by: "op", stateDir });
    expect(markFocusNotified("agent:main:a", stateDir)).toBe(true);
  });

  it("an unreadable file means no focus", () => {
    fs.writeFileSync(resolveFocusFile(stateDir), "{not json");
    expect(readFocusState(stateDir)).toBeUndefined();
  });

  it("held files are taken once", () => {
    holdFocusFiles("agent:main:a", ["/x/1", "/x/2"]);
    holdFocusFiles("agent:main:a", ["/x/2", "/x/3"]);
    const taken = takeHeldFocusFiles();
    expect([...(taken.get("agent:main:a") ?? [])]).toEqual(["/x/1", "/x/2", "/x/3"]);
    expect(takeHeldFocusFiles().size).toBe(0);
  });

  it("status: target, since, by, and inbound prompts waiting per non-target session (§4)", () => {
    setFocusState({ target: "agent:main:main", by: "op", stateDir, now: 0 });
    writeStackFile({ sessionKey: "agent:main:a", source: "inbound", payload: {}, stateDir });
    writeStackFile({ sessionKey: "agent:main:a", source: "inbound", payload: {}, stateDir });
    writeStackFile({ sessionKey: "agent:main:main", source: "inbound", payload: {}, stateDir });
    writeStackFile({ sessionKey: "agent:main:b", source: "agent", payload: {}, stateDir });
    const status = readFocusStatus(stateDir);
    expect(status.waiting).toEqual([{ sessionKey: "agent:main:a", count: 2 }]);
    expect(formatFocusStatusLines(status)).toEqual([
      "Focus mode: on agent:main:main",
      "since 1970-01-01T00:00:00.000Z by op",
      "Waiting:",
      "  agent:main:a  waiting=2",
    ]);
    clearFocusState(stateDir);
    expect(formatFocusStatusLines(readFocusStatus(stateDir))).toEqual(["Focus mode is off."]);
  });
});
