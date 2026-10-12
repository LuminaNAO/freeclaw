import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  buildGroupMemoryPromptBlock,
  encodeGroupMemoryId,
  GROUP_MEMORY_DEFAULTS,
  readGroupMemoryMeta,
  resetGroupMemoryMetaThrottleForTests,
  resolveGroupMemoryConfig,
  resolveGroupMemoryDir,
  updateGroupMemoryMetaOnInbound,
} from "./group-memory.js";

const roots: string[] = [];
function tmpWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "groupmem-test-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  resetGroupMemoryMetaThrottleForTests();
  while (roots.length) {
    fs.rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

describe("resolveGroupMemoryConfig (§5)", () => {
  it("defaults to enabled, 20 history lines, 16 KiB context", () => {
    const resolved = resolveGroupMemoryConfig({ cfg: {} as OpenClawConfig });
    expect(resolved).toEqual({
      enabled: GROUP_MEMORY_DEFAULTS.enabled,
      historyLines: 20,
      maxContextBytes: 16_384,
    });
  });

  it("applies agents.defaults.groupMemory", () => {
    const cfg = {
      agents: { defaults: { groupMemory: { enabled: false, historyLines: 5 } } },
    } as OpenClawConfig;
    const resolved = resolveGroupMemoryConfig({ cfg });
    expect(resolved.enabled).toBe(false);
    expect(resolved.historyLines).toBe(5);
    expect(resolved.maxContextBytes).toBe(16_384);
  });

  it("per-agent override wins over defaults", () => {
    const cfg = {
      agents: {
        defaults: { groupMemory: { historyLines: 5 } },
        list: [{ id: "work", groupMemory: { historyLines: 3, maxContextBytes: 1024 } }],
      },
    } as OpenClawConfig;
    const resolved = resolveGroupMemoryConfig({ cfg, agentId: "work" });
    expect(resolved.historyLines).toBe(3);
    expect(resolved.maxContextBytes).toBe(1024);
    expect(resolved.enabled).toBe(true);
  });
});

describe("updateGroupMemoryMetaOnInbound (§3)", () => {
  it("creates meta.json on first message with dir 0700 and file 0600", () => {
    const ws = tmpWorkspace();
    const { dir, written } = updateGroupMemoryMetaOnInbound({
      workspaceDir: ws,
      channel: "signal",
      groupId: "abc==",
      groupName: "Test Group",
      senderId: "+10000000000",
      now: 1_000,
    });
    expect(written).toBe(true);
    const meta = readGroupMemoryMeta(dir);
    expect(meta?.channel).toBe("signal");
    expect(meta?.groupId).toBe("abc==");
    expect(meta?.name).toBe("Test Group");
    expect(meta?.members).toEqual(["+10000000000"]);
    expect(meta?.firstSeen).toBe(new Date(1_000).toISOString());
    expect(meta?.lastSeen).toBe(new Date(1_000).toISOString());
    expect(dir).toBe(path.join(ws, "group-memory", "signal", encodeURIComponent("abc==")));
    const dirMode = fs.statSync(dir).mode & 0o777;
    expect(dirMode).toBe(0o700);
    const fileMode = fs.statSync(path.join(dir, "meta.json")).mode & 0o777;
    expect(fileMode).toBe(0o600);
  });

  it("updates members and lastSeen, throttled to one write per minute", () => {
    const ws = tmpWorkspace();
    const base = { workspaceDir: ws, channel: "signal", groupId: "g1" };
    updateGroupMemoryMetaOnInbound({ ...base, senderId: "+10000000001", now: 10_000 });
    // Second write within a minute is throttled.
    const throttled = updateGroupMemoryMetaOnInbound({
      ...base,
      senderId: "+10000000002",
      now: 20_000,
    });
    expect(throttled.written).toBe(false);
    expect(throttled.reason).toBe("throttled");
    // After a minute the write lands with the new member and lastSeen.
    const later = updateGroupMemoryMetaOnInbound({
      ...base,
      senderId: "+10000000002",
      now: 80_000,
    });
    expect(later.written).toBe(true);
    const meta = readGroupMemoryMeta(later.dir);
    expect(meta?.members).toEqual(["+10000000001", "+10000000002"]);
    expect(meta?.lastSeen).toBe(new Date(80_000).toISOString());
    expect(meta?.firstSeen).toBe(new Date(10_000).toISOString());
  });

  it("a throttled tick defers a new member instead of dropping them", () => {
    const ws = tmpWorkspace();
    const base = { workspaceDir: ws, channel: "signal", groupId: "g1" };
    const first = updateGroupMemoryMetaOnInbound({
      ...base,
      senderId: "+10000000001",
      now: 10_000,
    });
    expect(first.written).toBe(true);
    // New sender inside the throttle window: no write, but the member is deferred.
    const throttled = updateGroupMemoryMetaOnInbound({
      ...base,
      senderId: "+10000000002",
      now: 20_000,
    });
    expect(throttled.written).toBe(false);
    expect(readGroupMemoryMeta(first.dir)?.members).toEqual(["+10000000001"]);
    // The next write after the window merges the deferred member even when the
    // triggering message is from an already-known member.
    const later = updateGroupMemoryMetaOnInbound({
      ...base,
      groupName: "Renamed Group",
      now: 80_000,
    });
    expect(later.written).toBe(true);
    const meta = readGroupMemoryMeta(later.dir);
    expect(meta?.members).toContain("+10000000002");
    expect(meta?.members).toContain("+10000000001");
  });

  it("preserves unknown keys on update (§6)", () => {
    const ws = tmpWorkspace();
    const { dir } = updateGroupMemoryMetaOnInbound({
      workspaceDir: ws,
      channel: "signal",
      groupId: "g1",
      now: 1_000,
    });
    const metaPath = path.join(dir, "meta.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    meta.customKey = { keep: "me" };
    fs.writeFileSync(metaPath, JSON.stringify(meta));
    updateGroupMemoryMetaOnInbound({
      workspaceDir: ws,
      channel: "signal",
      groupId: "g1",
      senderId: "+10000000003",
      now: 200_000,
    });
    const updated = readGroupMemoryMeta(dir);
    expect((updated as Record<string, unknown>)?.customKey).toEqual({ keep: "me" });
    expect(updated?.members).toContain("+10000000003");
  });

  it("does nothing when disabled (§5)", () => {
    const ws = tmpWorkspace();
    const cfg = {
      agents: { defaults: { groupMemory: { enabled: false } } },
    } as OpenClawConfig;
    const { written, reason, dir } = updateGroupMemoryMetaOnInbound({
      workspaceDir: ws,
      channel: "signal",
      groupId: "g1",
      cfg,
    });
    expect(written).toBe(false);
    expect(reason).toBe("disabled");
    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe("buildGroupMemoryPromptBlock (§2)", () => {
  it("returns undefined without channel/groupId (DM/main sessions never load it)", () => {
    const ws = tmpWorkspace();
    expect(buildGroupMemoryPromptBlock({ workspaceDir: ws, channel: "signal" })).toBeUndefined();
    expect(buildGroupMemoryPromptBlock({ workspaceDir: ws })).toBeUndefined();
  });

  it("shows the no-memory hint for a new group", () => {
    const ws = tmpWorkspace();
    const block = buildGroupMemoryPromptBlock({
      workspaceDir: ws,
      channel: "signal",
      groupId: "g1",
    });
    expect(block).toContain("## Group memory");
    expect(block).toContain("No group memory yet");
    expect(block).toContain(path.join(ws, "group-memory", "signal"));
  });

  it("includes meta, CONTEXT.md and the last N history lines", () => {
    const ws = tmpWorkspace();
    updateGroupMemoryMetaOnInbound({
      workspaceDir: ws,
      channel: "signal",
      groupId: "g1",
      groupName: "Ops Room",
      senderId: "+10000000001",
    });
    const dir = resolveGroupMemoryDir({ workspaceDir: ws, channel: "signal", groupId: "g1" });
    fs.writeFileSync(path.join(dir, "CONTEXT.md"), "Purpose: run the ops room.\n");
    const history = Array.from({ length: 30 }, (_, i) => `- event ${i + 1}`).join("\n");
    fs.writeFileSync(path.join(dir, "history.md"), `${history}\n`);
    const block = buildGroupMemoryPromptBlock({
      workspaceDir: ws,
      channel: "signal",
      groupId: "g1",
    });
    expect(block).toContain("Group: Ops Room (1 member)");
    expect(block).toContain("Purpose: run the ops room.");
    expect(block).toContain("- event 30");
    expect(block).toContain("- event 11");
    expect(block).not.toContain("- event 10");
  });

  it("respects a custom historyLines limit (§5)", () => {
    const ws = tmpWorkspace();
    const dir = resolveGroupMemoryDir({ workspaceDir: ws, channel: "signal", groupId: "g1" });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "history.md"), "- one\n- two\n- three\n");
    const cfg = {
      agents: { defaults: { groupMemory: { historyLines: 2 } } },
    } as OpenClawConfig;
    const block = buildGroupMemoryPromptBlock({
      workspaceDir: ws,
      channel: "signal",
      groupId: "g1",
      cfg,
    });
    expect(block).toContain("- three");
    expect(block).toContain("- two");
    expect(block).not.toContain("- one");
  });

  it("truncates CONTEXT.md at maxContextBytes with a note (§5)", () => {
    const ws = tmpWorkspace();
    const dir = resolveGroupMemoryDir({ workspaceDir: ws, channel: "signal", groupId: "g1" });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "CONTEXT.md"), "x".repeat(5_000));
    const cfg = {
      agents: { defaults: { groupMemory: { maxContextBytes: 1_000 } } },
    } as OpenClawConfig;
    const block = buildGroupMemoryPromptBlock({
      workspaceDir: ws,
      channel: "signal",
      groupId: "g1",
      cfg,
    });
    expect(block).toContain("x".repeat(1_000));
    expect(block).not.toContain("x".repeat(1_001));
    expect(block).toContain("truncated at 1000 bytes");
  });

  it("group A never sees group B (§2 isolation)", () => {
    const ws = tmpWorkspace();
    updateGroupMemoryMetaOnInbound({
      workspaceDir: ws,
      channel: "signal",
      groupId: "group-b",
      groupName: "Group B Secret",
    });
    const dirB = resolveGroupMemoryDir({
      workspaceDir: ws,
      channel: "signal",
      groupId: "group-b",
    });
    fs.writeFileSync(path.join(dirB, "CONTEXT.md"), "B-only secret context");
    const blockA = buildGroupMemoryPromptBlock({
      workspaceDir: ws,
      channel: "signal",
      groupId: "group-a",
    });
    expect(blockA).not.toContain("B-only secret context");
    expect(blockA).not.toContain("Group B Secret");
    expect(blockA).not.toContain(encodeGroupMemoryId("group-b"));
  });

  it("honours an existing context_file override (§6)", () => {
    const ws = tmpWorkspace();
    const dir = resolveGroupMemoryDir({ workspaceDir: ws, channel: "signal", groupId: "g1" });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({
        channel: "signal",
        groupId: "g1",
        name: "G1",
        members: [],
        firstSeen: "2026-01-01T00:00:00.000Z",
        lastSeen: "2026-01-01T00:00:00.000Z",
        context_file: "notes/shared.md",
      }),
    );
    fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
    fs.writeFileSync(path.join(dir, "notes", "shared.md"), "legacy context location");
    const block = buildGroupMemoryPromptBlock({
      workspaceDir: ws,
      channel: "signal",
      groupId: "g1",
    });
    expect(block).toContain("legacy context location");
  });

  it("returns undefined when disabled (§5)", () => {
    const ws = tmpWorkspace();
    const cfg = {
      agents: { defaults: { groupMemory: { enabled: false } } },
    } as OpenClawConfig;
    expect(
      buildGroupMemoryPromptBlock({
        workspaceDir: ws,
        channel: "signal",
        groupId: "g1",
        cfg,
      }),
    ).toBeUndefined();
  });

  it("per-agent disable via session key stops loading (§5)", () => {
    const ws = tmpWorkspace();
    const cfg = {
      agents: {
        list: [{ id: "quiet", groupMemory: { enabled: false } }],
      },
    } as OpenClawConfig;
    expect(
      buildGroupMemoryPromptBlock({
        workspaceDir: ws,
        channel: "signal",
        groupId: "g1",
        cfg,
        sessionKey: "agent:quiet:signal:group:g1",
      }),
    ).toBeUndefined();
    expect(
      buildGroupMemoryPromptBlock({
        workspaceDir: ws,
        channel: "signal",
        groupId: "g1",
        cfg,
        sessionKey: "agent:main:signal:group:g1",
      }),
    ).toBeDefined();
  });
});
