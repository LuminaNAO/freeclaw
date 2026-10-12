// docs/design/gateway-crash-log.md §5.1 (memory sampler half, §3.2 threshold) and §1.4 announce.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginGatewayRun,
  resetGatewayCrashLogStateForTest,
  writeRunMarker,
} from "../infra/gateway-crash-log.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../infra/system-events.js";
import {
  appendMemorySample,
  collectMemorySample,
  resetAutoHeapSnapshotForTest,
  rotateMemoryLog,
  runMemorySampleTick,
  writeGatewayHeapSnapshot,
} from "./memory-evidence.js";
import { announceGatewayCrash } from "./server-crash-announce.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-memlog-"));
  resetAutoHeapSnapshotForTest();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  resetAutoHeapSnapshotForTest();
});

const mem = (heapUsed: number): NodeJS.MemoryUsage => ({
  rss: heapUsed * 2,
  heapUsed,
  heapTotal: heapUsed + 1,
  external: 3,
  arrayBuffers: 4,
});

const sources = (heapUsed: number) => ({
  now: () => 1_000,
  memoryUsage: () => mem(heapUsed),
  uptimeMs: () => 500,
  activeRuns: () => 2,
  queueDepth: () => 5,
});

describe("memory sample (§2)", () => {
  it("has the documented shape", () => {
    expect(collectMemorySample(sources(10))).toEqual({
      at: 1_000,
      pid: process.pid,
      uptimeMs: 500,
      rss: 20,
      heapUsed: 10,
      heapTotal: 11,
      external: 3,
      arrayBuffers: 4,
      activeRuns: 2,
      queueDepth: 5,
    });
  });

  it("omits counters it cannot read", () => {
    const sample = collectMemorySample({
      ...sources(1),
      activeRuns: () => {
        throw new Error("x");
      },
    });
    expect(sample).not.toHaveProperty("activeRuns");
    expect(sample.queueDepth).toBe(5);
  });

  it("appends one JSON line per tick", () => {
    const file = path.join(dir, "memory.jsonl");
    const log = { info: vi.fn(), warn: vi.fn() };
    runMemorySampleTick({ log, file, sources: sources(1), heapLimit: () => 1e12 });
    runMemorySampleTick({ log, file, sources: sources(2), heapLimit: () => 1e12 });
    const lines = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.heapUsed)).toEqual([1, 2]);
  });

  it("rotates by dropping the oldest half on a line boundary, staying under the cap", () => {
    const file = path.join(dir, "memory.jsonl");
    const maxBytes = 4096;
    for (let i = 0; i < 200; i += 1) {
      appendMemorySample({ ...collectMemorySample(sources(i)), at: i }, { file, maxBytes });
      expect(fs.statSync(file).size).toBeLessThan(maxBytes);
    }
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    // Every surviving line is whole JSON, the newest is kept, the oldest are gone.
    const ats = lines.map((l) => JSON.parse(l).at as number);
    expect(ats.at(-1)).toBe(199);
    expect(ats[0]).toBeGreaterThan(0);
    expect(ats).toEqual([...ats].toSorted((a, b) => a - b));
  });

  it("rotateMemoryLog leaves small files alone", () => {
    const file = path.join(dir, "m.jsonl");
    fs.writeFileSync(file, "a\nb\n");
    expect(rotateMemoryLog(file, 1024)).toBe(false);
    expect(rotateMemoryLog(file, 4)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("b\n");
  });
});

describe("automatic heap snapshot (§3.2)", () => {
  it("fires once per process when heapUsed crosses 75% of the heap limit", () => {
    const file = path.join(dir, "memory.jsonl");
    const log = { info: vi.fn(), warn: vi.fn() };
    const writeSnapshot = vi.fn(() => "/x/heap-auto.heapsnapshot");
    const recordNearHeapLimit = vi.fn();
    const opts = { log, file, heapLimit: () => 1000, writeSnapshot, recordNearHeapLimit };
    runMemorySampleTick({ ...opts, sources: sources(749) });
    expect(writeSnapshot).not.toHaveBeenCalled();
    runMemorySampleTick({ ...opts, sources: sources(750) });
    runMemorySampleTick({ ...opts, sources: sources(900) });
    expect(writeSnapshot).toHaveBeenCalledTimes(1);
    expect(recordNearHeapLimit).toHaveBeenCalledTimes(1);
    expect(recordNearHeapLimit.mock.calls[0][0]).toMatchObject({ kind: "near-heap-limit" });
    expect(log.warn.mock.calls.flat().join("\n")).toContain("/x/heap-auto.heapsnapshot");
  });
});

describe("heap snapshot (§3.1)", () => {
  it("writes heap-<ts>.heapsnapshot into the given dir", () => {
    const file = writeGatewayHeapSnapshot({ dir, now: Date.UTC(2026, 0, 2, 3, 4, 5) });
    expect(path.dirname(file)).toBe(dir);
    expect(path.basename(file)).toBe("heap-2026-01-02T03-04-05-000Z.heapsnapshot");
    expect(fs.statSync(file).size).toBeGreaterThan(0);
  }, 60_000);
});

describe("crash announce (§1.4)", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-announce-"));
    resetGatewayCrashLogStateForTest();
    resetSystemEventsForTest();
  });
  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
    resetGatewayCrashLogStateForTest();
    resetSystemEventsForTest();
  });

  it("enqueues exactly one system event to the main session after a crash", () => {
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    writeRunMarker({ pid: 999_999_002, startedAt: 0, version: "v" }, env);
    beginGatewayRun({ env, installHooks: false });
    const log = { warn: vi.fn() };
    expect(announceGatewayCrash({}, log)).toBe(true);
    expect(announceGatewayCrash({}, log)).toBe(false);
    const events = peekSystemEvents("agent:main:main");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatch(/^Gateway restarted after crash: unknown \(no exit record\)/);
  });

  it("enqueues nothing after a clean start", () => {
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    beginGatewayRun({ env, installHooks: false });
    expect(announceGatewayCrash({}, { warn: vi.fn() })).toBe(false);
    expect(peekSystemEvents("agent:main:main")).toEqual([]);
  });
});
