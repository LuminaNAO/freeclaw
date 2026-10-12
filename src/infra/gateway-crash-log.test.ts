// docs/design/gateway-crash-log.md §5.1 (crash log half).
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  beginGatewayRun,
  CRASH_REASON_UNKNOWN,
  detectPreviousCrash,
  formatCrashAnnouncement,
  installExitHooks,
  readCrashEntries,
  readLastExitRecord,
  readRunMarker,
  removeRunMarker,
  resetGatewayCrashLogStateForTest,
  resolveCrashLogPath,
  resolveLastExitPath,
  resolveMemoryLogPath,
  resolveRunMarkerPath,
  takeCrashAnnouncement,
  writeLastExitRecord,
  writeRunMarker,
} from "./gateway-crash-log.js";

let stateDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-crashlog-"));
  env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  resetGatewayCrashLogStateForTest();
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  resetGatewayCrashLogStateForTest();
});

const DEAD_PID = 999_999_001;

describe("run marker (§1.1)", () => {
  it("is written at start with pid, startedAt and version", () => {
    expect(beginGatewayRun({ env, now: 1_000, installHooks: false })).toBeNull();
    expect(resolveRunMarkerPath(env)).toBe(path.join(stateDir, "run", "gateway.json"));
    const marker = readRunMarker(env);
    expect(marker).toEqual({ pid: process.pid, startedAt: 1_000, version: expect.any(String) });
    expect(marker?.version.length).toBeGreaterThan(0);
  });

  it("is removed on clean shutdown, so the next start reports nothing", () => {
    beginGatewayRun({ env, installHooks: false });
    removeRunMarker(env);
    expect(fs.existsSync(resolveRunMarkerPath(env))).toBe(false);
    expect(detectPreviousCrash({ env })).toBeNull();
    expect(fs.existsSync(resolveCrashLogPath(env))).toBe(false);
  });

  it("is not removed when it belongs to another pid (respawned child)", () => {
    writeRunMarker({ pid: DEAD_PID, startedAt: 1, version: "x" }, env);
    removeRunMarker(env);
    expect(readRunMarker(env)?.pid).toBe(DEAD_PID);
  });

  it("an in-process restart (same pid) is not a crash", () => {
    beginGatewayRun({ env, now: 1, installHooks: false });
    expect(beginGatewayRun({ env, now: 2, installHooks: false })).toBeNull();
    expect(readCrashEntries({ env })).toEqual([]);
  });
});

describe("crash detection (§1.2)", () => {
  it("detects an unclean previous run and appends one line of the documented shape", () => {
    writeRunMarker({ pid: DEAD_PID, startedAt: 10_000, version: "1.2.3" }, env);
    const crash = beginGatewayRun({ env, now: 50_000, installHooks: false });
    expect(crash).not.toBeNull();
    const lines = fs.readFileSync(resolveCrashLogPath(env), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(Object.keys(entry).toSorted()).toEqual(
      ["detectedAt", "pid", "startedAt", "uptimeMs", "version", "reason", "lastHeap"].toSorted(),
    );
    expect(entry).toMatchObject({
      detectedAt: 50_000,
      pid: DEAD_PID,
      startedAt: 10_000,
      version: "1.2.3",
      reason: CRASH_REASON_UNKNOWN,
      lastHeap: null,
      uptimeMs: null,
    });
    // The new run's marker replaces the stale one.
    expect(readRunMarker(env)?.pid).toBe(process.pid);
  });

  it("takes reason from the exit record and lastHeap/uptime from the last memory sample", () => {
    writeRunMarker({ pid: DEAD_PID, startedAt: 10_000, version: "1.2.3" }, env);
    fs.mkdirSync(path.dirname(resolveMemoryLogPath(env)), { recursive: true });
    const sample = (pid: number, at: number, heapUsed: number) =>
      JSON.stringify({
        at,
        pid,
        uptimeMs: at,
        rss: heapUsed * 2,
        heapUsed,
        heapTotal: heapUsed,
      }).concat("\n");
    fs.writeFileSync(
      resolveMemoryLogPath(env),
      sample(DEAD_PID, 20_000, 100) + sample(DEAD_PID, 30_000, 200) + sample(4, 40_000, 999),
    );
    writeLastExitRecord(
      {
        pid: DEAD_PID,
        at: 35_000,
        kind: "uncaughtException",
        message: "boom",
        stack: "Error: boom",
      },
      env,
    );
    const crash = detectPreviousCrash({ env, now: 60_000 });
    expect(crash).toMatchObject({
      reason: "uncaughtException: boom",
      uptimeMs: 25_000,
      lastHeap: { at: 30_000, heapUsed: 200, rss: 400, heapTotal: 200 },
    });
    expect(fs.existsSync(resolveLastExitPath(env))).toBe(false);
  });

  it("uses the last sample time for uptime when there is no exit record", () => {
    writeRunMarker({ pid: DEAD_PID, startedAt: 10_000, version: "v" }, env);
    fs.mkdirSync(path.dirname(resolveMemoryLogPath(env)), { recursive: true });
    fs.writeFileSync(
      resolveMemoryLogPath(env),
      `${JSON.stringify({ at: 70_000, pid: DEAD_PID, rss: 1, heapUsed: 1, heapTotal: 1 })}\n`,
    );
    expect(detectPreviousCrash({ env, now: 80_000 })).toMatchObject({
      reason: CRASH_REASON_UNKNOWN,
      uptimeMs: 60_000,
    });
  });

  it("ignores an exit record from a different pid", () => {
    writeRunMarker({ pid: DEAD_PID, startedAt: 1, version: "v" }, env);
    writeLastExitRecord({ pid: 7, kind: "signal", message: "SIGHUP" }, env);
    expect(detectPreviousCrash({ env })?.reason).toBe(CRASH_REASON_UNKNOWN);
  });

  it("appends across crashes and honours --limit", () => {
    for (const pid of [DEAD_PID, DEAD_PID + 1, DEAD_PID + 2]) {
      writeRunMarker({ pid, startedAt: 1, version: "v" }, env);
      detectPreviousCrash({ env });
    }
    expect(readCrashEntries({ env }).map((e) => e.pid)).toEqual([
      DEAD_PID,
      DEAD_PID + 1,
      DEAD_PID + 2,
    ]);
    expect(readCrashEntries({ env, limit: 1 }).map((e) => e.pid)).toEqual([DEAD_PID + 2]);
  });
});

describe("exit record (§1.3)", () => {
  it("is written synchronously with a stack trimmed to 40 lines and read back", () => {
    const stack = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
    writeLastExitRecord({ kind: "uncaughtException", message: "boom", stack }, env);
    const record = readLastExitRecord(env);
    expect(record).toMatchObject({ pid: process.pid, kind: "uncaughtException", message: "boom" });
    expect(record?.stack?.split("\n")).toHaveLength(40);
    expect(typeof record?.at).toBe("number");
  });

  it("returns null when absent or malformed", () => {
    expect(readLastExitRecord(env)).toBeNull();
    fs.mkdirSync(path.dirname(resolveLastExitPath(env)), { recursive: true });
    fs.writeFileSync(resolveLastExitPath(env), "{not json");
    expect(readLastExitRecord(env)).toBeNull();
  });

  it("hooks record uncaughtException, fatal signals and non-zero exits", () => {
    const fake = Object.assign(new EventEmitter(), {
      pid: process.pid,
      kill: () => true,
    }) as unknown as Parameters<typeof installExitHooks>[1];
    installExitHooks(env, fake);
    (fake as unknown as EventEmitter).emit("uncaughtException", new Error("kaboom"));
    expect(readLastExitRecord(env)).toMatchObject({ kind: "uncaughtException", message: "kaboom" });

    resetGatewayCrashLogStateForTest();
    (fake as unknown as EventEmitter).emit("SIGHUP");
    expect(readLastExitRecord(env)).toMatchObject({ kind: "signal", message: "SIGHUP" });

    resetGatewayCrashLogStateForTest();
    (fake as unknown as EventEmitter).emit("unhandledRejection", new Error("nope"));
    (fake as unknown as EventEmitter).emit("exit", 1);
    expect(readLastExitRecord(env)).toMatchObject({
      kind: "unhandledRejection",
      message: "nope",
    });
  });

  it("a clean shutdown leaves no exit record behind", () => {
    const fake = Object.assign(new EventEmitter(), {
      pid: process.pid,
      kill: () => true,
    }) as unknown as Parameters<typeof installExitHooks>[1];
    installExitHooks(env, fake);
    beginGatewayRun({ env, installHooks: false });
    removeRunMarker(env);
    (fake as unknown as EventEmitter).emit("exit", 1);
    expect(readLastExitRecord(env)).toBeNull();
  });
});

describe("crash announcement (§1.4)", () => {
  it("is produced exactly once after a crash", () => {
    writeRunMarker({ pid: DEAD_PID, startedAt: 0, version: "v" }, env);
    beginGatewayRun({ env, installHooks: false });
    const text = takeCrashAnnouncement();
    expect(text).toMatch(/^Gateway restarted after crash: unknown \(no exit record\), uptime/);
    expect(takeCrashAnnouncement()).toBeNull();
    // An in-process restart in the same process does not re-announce.
    beginGatewayRun({ env, installHooks: false });
    expect(takeCrashAnnouncement()).toBeNull();
  });

  it("is not produced after a clean start", () => {
    beginGatewayRun({ env, installHooks: false });
    expect(takeCrashAnnouncement()).toBeNull();
  });

  it("formats uptime in hours and heap in GB", () => {
    expect(
      formatCrashAnnouncement({
        detectedAt: 0,
        pid: 1,
        startedAt: 0,
        uptimeMs: 48 * 3_600_000,
        version: "v",
        reason: "near-heap-limit: x",
        lastHeap: { at: 0, rss: 0, heapTotal: 0, heapUsed: 16.29 * 1024 ** 3 },
      }),
    ).toBe(
      "Gateway restarted after crash: near-heap-limit: x, uptime 48.0h, heap 16.29 GB at last sample",
    );
  });
});
