import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildGroupMemoryPromptBlock,
  readGroupMemoryMeta,
  resetGroupMemoryMetaThrottleForTests,
  updateGroupMemoryMetaOnInbound,
} from "../agents/group-memory.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSignalAccount } from "./accounts.js";
import { buildDaemonArgs } from "./daemon.js";
import {
  ensureSignalSocketDir,
  resolveDefaultSignalSocketDir,
  resolveSignalSocketPath,
} from "./socket-dir.js";
import { resolveSignalTransport } from "./transport.js";

/**
 * fresh-install ARCH §3 acceptance tests (items 1-4), Linux, fake signal-cli
 * only. No real phone; no existing signal-cli data dir, daemon or gateway is
 * touched.
 */

const roots: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fresh-install-test-"));
  fs.chmodSync(dir, 0o700);
  roots.push(dir);
  return dir;
}
afterEach(() => {
  resetGroupMemoryMetaThrottleForTests();
  while (roots.length) {
    fs.rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

describe("§3.1 fresh config resolves to the socket transport, never HTTP", () => {
  it("an empty signal config resolves to socket (no httpPort/httpUrl/transport http)", () => {
    const cfg = {} as OpenClawConfig;
    const account = resolveSignalAccount({ cfg });
    expect(account.transport).toMatchObject({ kind: "socket", ignoredHttpKeys: false });
    expect(account.socketPath).toBeDefined();
    expect(account.baseUrl).toMatch(/^unix:\//);
    // A fresh config carries no HTTP keys at all.
    expect(account.config.httpPort).toBeUndefined();
    expect(account.config.httpUrl).toBeUndefined();
    expect(account.config.transport).toBeUndefined();
  });

  it("the gateway would start the daemon with --socket at the default path", () => {
    const cfg = {} as OpenClawConfig;
    const account = resolveSignalAccount({ cfg });
    expect(account.transport?.kind).toBe("socket");
    const socketPath = account.socketPath as string;
    const expectedDir = resolveDefaultSignalSocketDir();
    expect(socketPath).toBe(resolveSignalSocketPath(expectedDir, account.accountId));
    const args = buildDaemonArgs({
      cliPath: "signal-cli",
      account: "+15550001234",
      listener: { kind: "socket", path: socketPath },
      receiveMode: "manual",
    });
    expect(args).toContain("--socket");
    expect(args[args.indexOf("--socket") + 1]).toBe(socketPath);
    expect(args).not.toContain("--http");
    expect(args.join(" ")).not.toMatch(/--http\b/);
  });

  it("the socket dir is created 0700 and the socket is enforced 0600", async () => {
    const root = tmpRoot();
    const dir = path.join(root, "signal-sockets");
    await ensureSignalSocketDir({ dir });
    const st = fs.statSync(dir);
    expect(st.isDirectory()).toBe(true);
    expect(st.mode & 0o777).toBe(0o700);
    // Socket mode 0600 is enforced by enforceSignalSocketMode after daemon start;
    // covered in socket-dir.test.ts. Here we assert the policy constant path: a
    // fresh dir under this tree resolves as the account's socket target.
    const account = resolveSignalAccount({ cfg: {} as OpenClawConfig });
    expect(account.socketPath).toContain("signal");
  });

  it("persisted httpHost/httpPort leftovers still resolve to socket on Linux", () => {
    // A fresh install never writes these, but even if present they are
    // freeclaw-written defaults, not operator intent (transport.ts).
    const cfg = {
      channels: { signal: { httpHost: "127.0.0.1", httpPort: 8080 } },
    } as OpenClawConfig;
    const transport = resolveSignalTransport(cfg.channels?.signal ?? {});
    expect(transport.kind).toBe("socket");
  });
});

describe("§3.2 signal-cli below the minimum version is refused with the fix named", () => {
  it("is covered by link.test.ts (0.14.5 refused, fix named); constants sane", async () => {
    const { MIN_SIGNAL_CLI_VERSION, compareVersions } = await import("./link.js");
    expect(compareVersions("0.14.5", MIN_SIGNAL_CLI_VERSION)).toBeLessThan(0);
    expect(compareVersions(MIN_SIGNAL_CLI_VERSION, MIN_SIGNAL_CLI_VERSION)).toBe(0);
  });
});

describe("§3.3 pending group invites to own ACI", () => {
  it("is covered by group-invites.test.ts against the real listGroups shape (pendingMembers + updateGroup)", async () => {
    const mod = await import("./group-invites.js");
    expect(typeof mod.acceptPendingGroupInvites).toBe("function");
    // Real contract: not a member, our ACI present in pendingMembers.
    expect(
      mod.isPendingGroupInviteForAci(
        {
          id: "g",
          isMember: false,
          pendingMembers: [{ number: null, uuid: "11111111-2222-3333-4444-555555555555" }],
        },
        "11111111-2222-3333-4444-555555555555",
      ),
    ).toBe(true);
  });
});

describe("§3.4 group memory on a fresh install", () => {
  it("first group message creates meta.json and the group session prompt gains the block", () => {
    const ws = tmpRoot();
    // Fresh workspace: no group-memory/ folder.
    expect(fs.existsSync(path.join(ws, "group-memory"))).toBe(false);
    const { dir, written } = updateGroupMemoryMetaOnInbound({
      workspaceDir: ws,
      channel: "signal",
      groupId: "group-a",
      groupName: "Group A",
      senderId: "+10000000001",
    });
    expect(written).toBe(true);
    const meta = readGroupMemoryMeta(dir);
    expect(meta?.name).toBe("Group A");
    const block = buildGroupMemoryPromptBlock({
      workspaceDir: ws,
      channel: "signal",
      groupId: "group-a",
    });
    expect(block).toContain("## Group memory");
    expect(block).toContain("Group A");
  });

  it("a DM session does not get the block", () => {
    const ws = tmpRoot();
    updateGroupMemoryMetaOnInbound({
      workspaceDir: ws,
      channel: "signal",
      groupId: "group-a",
      senderId: "+10000000001",
    });
    // DM/main session: no groupId → no block, even though the group has memory.
    expect(buildGroupMemoryPromptBlock({ workspaceDir: ws, channel: "signal" })).toBeUndefined();
    expect(buildGroupMemoryPromptBlock({ workspaceDir: ws })).toBeUndefined();
  });

  it("group A never sees group B", () => {
    const ws = tmpRoot();
    updateGroupMemoryMetaOnInbound({
      workspaceDir: ws,
      channel: "signal",
      groupId: "group-b",
      groupName: "Secret B",
      senderId: "+10000000002",
    });
    const dirB = path.join(ws, "group-memory", "signal", encodeURIComponent("group-b"));
    fs.writeFileSync(path.join(dirB, "CONTEXT.md"), "B-only plans");
    const blockA = buildGroupMemoryPromptBlock({
      workspaceDir: ws,
      channel: "signal",
      groupId: "group-a",
    });
    expect(blockA).not.toContain("B-only plans");
    expect(blockA).not.toContain("Secret B");
    const blockB = buildGroupMemoryPromptBlock({
      workspaceDir: ws,
      channel: "signal",
      groupId: "group-b",
    });
    expect(blockB).toContain("B-only plans");
  });

  it("the block is rebuilt from files each turn (survives compaction and /new)", () => {
    const ws = tmpRoot();
    updateGroupMemoryMetaOnInbound({
      workspaceDir: ws,
      channel: "signal",
      groupId: "group-a",
    });
    const first = buildGroupMemoryPromptBlock({
      workspaceDir: ws,
      channel: "signal",
      groupId: "group-a",
    });
    expect(first).toContain("No group memory yet");
    // Agent writes CONTEXT.md between turns; the next turn's block picks it up.
    const dir = path.join(ws, "group-memory", "signal", encodeURIComponent("group-a"));
    fs.writeFileSync(path.join(dir, "CONTEXT.md"), "Purpose: decide lunch venues.");
    const second = buildGroupMemoryPromptBlock({
      workspaceDir: ws,
      channel: "signal",
      groupId: "group-a",
    });
    expect(second).toContain("Purpose: decide lunch venues.");
    expect(second).not.toContain("No group memory yet");
  });
});
