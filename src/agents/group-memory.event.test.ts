import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GROUP_MEMORY_STARTER_PURPOSE,
  resetGroupMemoryMetaThrottleForTests,
  resolveGroupMemoryDir,
  starterGroupContext,
  updateGroupMemoryMetaOnInbound,
} from "./group-memory.js";

// group-memory ARCH §8: the new-group event and the starter CONTEXT.md.

const roots: string[] = [];
function tmpWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "groupmem-event-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  resetGroupMemoryMetaThrottleForTests();
  while (roots.length) {
    fs.rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

describe("new-group event (§8.1)", () => {
  it("is reported once on creation, with name and path only", () => {
    const ws = tmpWorkspace();
    const base = { workspaceDir: ws, channel: "signal", groupId: "g1" };
    const first = updateGroupMemoryMetaOnInbound({
      ...base,
      groupName: "Garden Club",
      senderId: "+10000000001",
      now: 1_000,
    });
    expect(first.event).toEqual({
      reason: "created",
      channel: "signal",
      groupId: "g1",
      name: "Garden Club",
      dir: resolveGroupMemoryDir(base),
      firstSeen: new Date(1_000).toISOString(),
    });
    // §8.3: no member ids or content in the event.
    expect(JSON.stringify(first.event)).not.toContain("+10000000001");
    expect(Object.keys(first.event ?? {}).toSorted()).toEqual(
      ["channel", "dir", "firstSeen", "groupId", "name", "reason"].toSorted(),
    );
  });

  it("is never reported on ordinary updates (new members, lastSeen, same name)", () => {
    const ws = tmpWorkspace();
    const base = { workspaceDir: ws, channel: "signal", groupId: "g1", groupName: "Garden Club" };
    updateGroupMemoryMetaOnInbound({ ...base, senderId: "+10000000001", now: 1_000 });
    const events: unknown[] = [];
    let now = 1_000;
    for (let i = 2; i < 6; i++) {
      now += 61_000;
      const r = updateGroupMemoryMetaOnInbound({ ...base, senderId: `+1000000000${i}`, now });
      expect(r.written).toBe(true);
      if (r.event) {
        events.push(r.event);
      }
    }
    // Throttled ticks carry no event either.
    const throttled = updateGroupMemoryMetaOnInbound({ ...base, senderId: "+19", now: now + 1 });
    expect(throttled.event).toBeUndefined();
    expect(events).toEqual([]);
  });

  it("is reported once per rename with reason renamed", () => {
    const ws = tmpWorkspace();
    const base = { workspaceDir: ws, channel: "signal", groupId: "g1" };
    updateGroupMemoryMetaOnInbound({ ...base, groupName: "Garden Club", now: 1_000 });
    const renamed = updateGroupMemoryMetaOnInbound({
      ...base,
      groupName: "Allotment Crew",
      now: 70_000,
    });
    expect(renamed.event?.reason).toBe("renamed");
    expect(renamed.event?.name).toBe("Allotment Crew");
    expect(renamed.event?.firstSeen).toBe(new Date(1_000).toISOString());
    // The same name again is not a rename.
    const again = updateGroupMemoryMetaOnInbound({
      ...base,
      groupName: "Allotment Crew",
      senderId: "+10000000009",
      now: 140_000,
    });
    expect(again.written).toBe(true);
    expect(again.event).toBeUndefined();
    const second = updateGroupMemoryMetaOnInbound({
      ...base,
      groupName: "Seed Swap",
      now: 210_000,
    });
    expect(second.event?.reason).toBe("renamed");
    expect(second.event?.name).toBe("Seed Swap");
  });

  it("is not reported when disabled", () => {
    const ws = tmpWorkspace();
    const r = updateGroupMemoryMetaOnInbound({
      workspaceDir: ws,
      channel: "signal",
      groupId: "g1",
      groupName: "Garden Club",
      cfg: { agents: { defaults: { groupMemory: { enabled: false } } } },
    });
    expect(r.event).toBeUndefined();
  });
});

describe("starter CONTEXT.md (§8.2)", () => {
  it("is written on creation when absent: title line and the purpose line, mode 0600", () => {
    const ws = tmpWorkspace();
    const { dir } = updateGroupMemoryMetaOnInbound({
      workspaceDir: ws,
      channel: "signal",
      groupId: "g1",
      groupName: "Garden Club",
      now: 1_000,
    });
    const file = path.join(dir, "CONTEXT.md");
    expect(fs.readFileSync(file, "utf8")).toBe(
      `# Garden Club\n\n${GROUP_MEMORY_STARTER_PURPOSE}\n`,
    );
    expect(GROUP_MEMORY_STARTER_PURPOSE).toBe(
      "Purpose: (not yet known — learn it from the conversation)",
    );
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("never overwrites an existing CONTEXT.md", () => {
    const ws = tmpWorkspace();
    const dir = resolveGroupMemoryDir({ workspaceDir: ws, channel: "signal", groupId: "g1" });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "CONTEXT.md"), "# Ours\n\nPurpose: plotting tomatoes\n");
    // meta.json is missing, so this is a creation, but CONTEXT.md stays as it is.
    const r = updateGroupMemoryMetaOnInbound({
      workspaceDir: ws,
      channel: "signal",
      groupId: "g1",
      groupName: "Garden Club",
      now: 1_000,
    });
    expect(r.event?.reason).toBe("created");
    expect(fs.readFileSync(path.join(dir, "CONTEXT.md"), "utf8")).toBe(
      "# Ours\n\nPurpose: plotting tomatoes\n",
    );
  });

  it("is not rewritten on later updates or renames after the agent replaced it", () => {
    const ws = tmpWorkspace();
    const base = { workspaceDir: ws, channel: "signal", groupId: "g1" };
    const { dir } = updateGroupMemoryMetaOnInbound({ ...base, groupName: "Garden Club", now: 1 });
    fs.writeFileSync(path.join(dir, "CONTEXT.md"), "# Garden Club\n\nPurpose: veg plots\n");
    updateGroupMemoryMetaOnInbound({ ...base, groupName: "Allotment Crew", now: 100_000 });
    expect(fs.readFileSync(path.join(dir, "CONTEXT.md"), "utf8")).toBe(
      "# Garden Club\n\nPurpose: veg plots\n",
    );
    // A deleted CONTEXT.md is not re-seeded by an ordinary update either (creation only).
    fs.rmSync(path.join(dir, "CONTEXT.md"));
    updateGroupMemoryMetaOnInbound({ ...base, senderId: "+10000000001", now: 200_000 });
    expect(fs.existsSync(path.join(dir, "CONTEXT.md"))).toBe(false);
  });

  it("keeps the title on one line", () => {
    expect(starterGroupContext("Two\nLines")).toBe(
      `# Two Lines\n\n${GROUP_MEMORY_STARTER_PURPOSE}\n`,
    );
  });
});
