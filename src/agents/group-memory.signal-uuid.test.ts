/**
 * docs/design/signal-uuid-identity.md §3.3/§5 — group-memory meta.json members.
 * New writes are uuid-only; members recorded as numbers are converted to the uuid on
 * that member's next message; unknown numbers are left as they are. Placeholders only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readGroupMemoryMeta,
  resetGroupMemoryMetaThrottleForTests,
  resolveGroupMemoryDir,
  updateGroupMemoryMetaOnInbound,
} from "./group-memory.js";

const UUID_A = "00000000-0000-4000-8000-00000000000a";
const NUMBER_A = "+15550001111";
const NUMBER_UNKNOWN = "+15550002222";
const UUID_B = "00000000-0000-4000-8000-00000000000b";

const roots: string[] = [];
function tmpWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "groupmem-uuid-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  resetGroupMemoryMetaThrottleForTests();
  while (roots.length) {
    fs.rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

function seedMeta(ws: string, members: string[]) {
  const dir = resolveGroupMemoryDir({ workspaceDir: ws, channel: "signal", groupId: "g1" });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({
      channel: "signal",
      groupId: "g1",
      name: "Placeholder Group",
      members,
      firstSeen: new Date(0).toISOString(),
      lastSeen: new Date(0).toISOString(),
      custom: "kept",
    }),
  );
  return dir;
}

describe("group-memory members convert to the uuid (signal uuid ARCH §3.3)", () => {
  it("replaces a member recorded as a number with uuid:<uuid> in place; unknown numbers stay", () => {
    const ws = tmpWorkspace();
    const dir = seedMeta(ws, [NUMBER_UNKNOWN, NUMBER_A, `uuid:${UUID_B}`]);
    const result = updateGroupMemoryMetaOnInbound({
      workspaceDir: ws,
      channel: "signal",
      groupId: "g1",
      senderId: `uuid:${UUID_A}`,
      legacySenderIds: [NUMBER_A],
      now: 1_000_000,
    });
    expect(result.written).toBe(true);
    const meta = readGroupMemoryMeta(dir);
    expect(meta?.members).toEqual([NUMBER_UNKNOWN, `uuid:${UUID_A}`, `uuid:${UUID_B}`]);
    expect((meta as Record<string, unknown>)?.custom).toBe("kept");
  });

  it("drops the number when the uuid is already a member (no duplicates)", () => {
    const ws = tmpWorkspace();
    const dir = seedMeta(ws, [NUMBER_A, `uuid:${UUID_A}`]);
    updateGroupMemoryMetaOnInbound({
      workspaceDir: ws,
      channel: "signal",
      groupId: "g1",
      senderId: `uuid:${UUID_A}`,
      legacySenderIds: [NUMBER_A],
      now: 1_000_000,
    });
    expect(readGroupMemoryMeta(dir)?.members).toEqual([`uuid:${UUID_A}`]);
  });

  it("a conversion seen while throttled is deferred to the next write, not lost", () => {
    const ws = tmpWorkspace();
    const dir = seedMeta(ws, [NUMBER_A]);
    // First write starts the throttle window.
    updateGroupMemoryMetaOnInbound({
      workspaceDir: ws,
      channel: "signal",
      groupId: "g1",
      senderId: `uuid:${UUID_B}`,
      now: 1_000_000,
    });
    const throttled = updateGroupMemoryMetaOnInbound({
      workspaceDir: ws,
      channel: "signal",
      groupId: "g1",
      senderId: `uuid:${UUID_A}`,
      legacySenderIds: [NUMBER_A],
      now: 1_010_000,
    });
    expect(throttled.reason).toBe("throttled");
    expect(readGroupMemoryMeta(dir)?.members).toEqual([NUMBER_A, `uuid:${UUID_B}`]);
    // Next write (any sender) after the window applies the deferred conversion.
    updateGroupMemoryMetaOnInbound({
      workspaceDir: ws,
      channel: "signal",
      groupId: "g1",
      senderId: `uuid:${UUID_B}`,
      groupName: "Renamed",
      now: 1_100_000,
    });
    expect(readGroupMemoryMeta(dir)?.members).toEqual([`uuid:${UUID_A}`, `uuid:${UUID_B}`]);
  });

  it("new members are written as the sender id only (uuid), never the number", () => {
    const ws = tmpWorkspace();
    const { dir } = updateGroupMemoryMetaOnInbound({
      workspaceDir: ws,
      channel: "signal",
      groupId: "g2",
      senderId: `uuid:${UUID_A}`,
      legacySenderIds: [NUMBER_A],
      now: 1_000,
    });
    const raw = fs.readFileSync(path.join(dir, "meta.json"), "utf8");
    expect(readGroupMemoryMeta(dir)?.members).toEqual([`uuid:${UUID_A}`]);
    expect(raw).not.toContain(NUMBER_A);
  });
});
