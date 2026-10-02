import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSignalTrustAttemptRecorder,
  SIGNAL_TRUST_COALESCE_WINDOW_MS,
  SIGNAL_TRUST_GLOBAL_LINES_PER_MINUTE,
} from "./attempts.js";
import { parseEnvelopeIdentity } from "./identity.js";

let dir = "";
let clock = 0;
let warns: string[] = [];
let errors: string[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-trust-attempts-"));
  clock = Date.UTC(2026, 0, 1);
  warns = [];
  errors = [];
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function recorder(maxBytes?: number) {
  return createSignalTrustAttemptRecorder({
    warn: (m) => warns.push(m),
    error: (m) => errors.push(m),
    filePath: path.join(dir, "security", "attempts.jsonl"),
    now: () => clock,
    maxBytes,
  });
}

function attempt(sourceNumber: string) {
  return {
    accountId: "default",
    identity: parseEnvelopeIdentity({ sourceNumber }),
    reason: "not_trusted" as const,
    kind: "dm" as const,
    flag: true,
  };
}

function lines(file: string) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

describe("attempt log/flag bounds (ARCH §5.8)", () => {
  it("coalesces 10,000 denials from one sender into one line plus one summary", () => {
    const rec = recorder();
    for (let i = 0; i < 10_000; i += 1) {
      rec.record(attempt("+15550000009"));
    }
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("suppressed=0");
    clock += SIGNAL_TRUST_COALESCE_WINDOW_MS + 1;
    rec.record(attempt("+15550000008"));
    const summary = warns.find(
      (w) => w.includes("sender=+15550000009") && w.includes("suppressed=9999"),
    );
    expect(summary).toBeDefined();
    const flags = lines(rec.filePath).map(
      (l) => JSON.parse(l) as { number: string; count: number },
    );
    const total = flags
      .filter((f) => f.number === "+15550000009")
      .reduce((sum, f) => sum + f.count, 0);
    expect(total).toBe(10_000);
  });

  it("caps distinct-sender floods at the global per-minute line limit plus an overflow summary", () => {
    const rec = recorder();
    for (let i = 0; i < 500; i += 1) {
      rec.record(attempt(`+1555${String(1_000_000 + i)}`));
    }
    expect(warns).toHaveLength(SIGNAL_TRUST_GLOBAL_LINES_PER_MINUTE);
    clock += 60_001;
    rec.record(attempt("+15559999999"));
    expect(warns.some((w) => /\d+ additional denial log lines suppressed/.test(w))).toBe(true);
  });

  it("keeps the flag file at or under the size bound with a single rotated backup", () => {
    const maxBytes = 4096;
    const rec = recorder(maxBytes);
    for (let i = 0; i < 2_000; i += 1) {
      rec.record(attempt(`+1555${String(1_000_000 + i)}`));
    }
    const primary = fs.statSync(rec.filePath).size;
    const backup = fs.statSync(`${rec.filePath}.1`).size;
    expect(primary).toBeLessThanOrEqual(maxBytes);
    expect(backup).toBeLessThanOrEqual(maxBytes);
    expect(fs.readdirSync(path.dirname(rec.filePath)).toSorted()).toEqual([
      "attempts.jsonl",
      "attempts.jsonl.1",
    ]);
  });

  it("records malformed senders only as length+hash and never emits control characters", () => {
    const rec = recorder();
    rec.record({
      ...attempt("+1555\u001b[31m\nFAKE LOG LINE"),
      reason: "malformed_identity",
    });
    const all = `${warns.join("\n")}\n${fs.readFileSync(rec.filePath, "utf8")}`;
    expect(all).not.toContain("FAKE LOG LINE");
    expect(all).not.toContain("\u001b");
    expect(warns[0]).toMatch(/sender=malformed\(len=\d+,sha256=[0-9a-f]{8}\)/);
  });

  it.runIf(process.platform !== "win32")("creates the flag file 0600 in a 0700 directory", () => {
    const rec = recorder();
    rec.record(attempt("+15550000009"));
    expect(fs.statSync(rec.filePath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(rec.filePath)).mode & 0o777).toBe(0o700);
  });

  it("a flag write failure is logged once and never throws", () => {
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "");
    const rec = createSignalTrustAttemptRecorder({
      warn: (m) => warns.push(m),
      error: (m) => errors.push(m),
      filePath: path.join(blocker, "attempts.jsonl"),
      now: () => clock,
    });
    for (let i = 0; i < 5; i += 1) {
      expect(() => rec.record(attempt(`+1555000000${i}`))).not.toThrow();
    }
    expect(errors).toHaveLength(1);
  });

  it("unflagged denials (no_identity) are logged but not written to the flag file", () => {
    const rec = recorder();
    rec.record({ ...attempt(""), reason: "no_identity", flag: false });
    expect(warns).toHaveLength(1);
    expect(lines(rec.filePath)).toEqual([]);
  });
});
