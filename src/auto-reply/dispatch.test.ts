import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  readGroupMemoryMeta,
  resetGroupMemoryMetaThrottleForTests,
  resolveGroupMemoryDir,
} from "../agents/group-memory.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-helpers.js";
import { dispatchInboundMessage, withReplyDispatcher } from "./dispatch.js";
import type { ReplyDispatcher } from "./reply/reply-dispatcher.js";
import { buildTestCtx } from "./reply/test-ctx.js";

function createDispatcher(record: string[]): ReplyDispatcher {
  return {
    sendToolResult: () => true,
    sendBlockReply: () => true,
    sendFinalReply: () => true,
    getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
    markComplete: () => {
      record.push("markComplete");
    },
    waitForIdle: async () => {
      record.push("waitForIdle");
    },
  };
}

describe("withReplyDispatcher", () => {
  it("always marks complete and waits for idle after success", async () => {
    const order: string[] = [];
    const dispatcher = createDispatcher(order);

    const result = await withReplyDispatcher({
      dispatcher,
      run: async () => {
        order.push("run");
        return "ok";
      },
      onSettled: () => {
        order.push("onSettled");
      },
    });

    expect(result).toBe("ok");
    expect(order).toEqual(["run", "markComplete", "waitForIdle", "onSettled"]);
  });

  it("still drains dispatcher after run throws", async () => {
    const order: string[] = [];
    const dispatcher = createDispatcher(order);
    const onSettled = vi.fn(() => {
      order.push("onSettled");
    });

    await expect(
      withReplyDispatcher({
        dispatcher,
        run: async () => {
          order.push("run");
          throw new Error("boom");
        },
        onSettled,
      }),
    ).rejects.toThrow("boom");

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["run", "markComplete", "waitForIdle", "onSettled"]);
  });

  it("dispatchInboundMessage owns dispatcher lifecycle", async () => {
    const order: string[] = [];
    const dispatcher = {
      sendToolResult: () => true,
      sendBlockReply: () => true,
      sendFinalReply: () => {
        order.push("sendFinalReply");
        return true;
      },
      getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
      markComplete: () => {
        order.push("markComplete");
      },
      waitForIdle: async () => {
        order.push("waitForIdle");
      },
    } satisfies ReplyDispatcher;

    await dispatchInboundMessage({
      ctx: buildTestCtx(),
      cfg: {} as OpenClawConfig,
      dispatcher,
      replyResolver: async () => ({ text: "ok" }),
    });

    expect(order).toEqual(["sendFinalReply", "markComplete", "waitForIdle"]);
  });
});

describe("dispatchInboundMessage group memory meta (group-memory ARCH §3)", () => {
  const roots: string[] = [];
  function tmpWorkspace(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-groupmem-"));
    roots.push(dir);
    return dir;
  }
  afterEach(() => {
    resetGroupMemoryMetaThrottleForTests();
    while (roots.length) {
      fs.rmSync(roots.pop() as string, { recursive: true, force: true });
    }
  });

  function silentDispatcher(): ReplyDispatcher {
    return {
      sendToolResult: () => true,
      sendBlockReply: () => true,
      sendFinalReply: () => true,
      getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
      markComplete: () => {},
      waitForIdle: async () => {},
    };
  }

  it("creates/updates meta.json for a group message on any channel", async () => {
    const ws = tmpWorkspace();
    const cfg = {
      agents: { defaults: { workspace: ws } },
    } as OpenClawConfig;
    await dispatchInboundMessage({
      ctx: buildTestCtx({
        From: "signal:group:dgvzda==",
        To: "signal:+15550001234",
        ChatType: "group",
        Provider: "signal",
        Surface: "signal",
        GroupSubject: "Ops Room",
        SenderId: "+10000000001",
      }),
      cfg,
      dispatcher: silentDispatcher(),
      replyResolver: async () => ({ text: "ok" }),
    });
    const dir = resolveGroupMemoryDir({ workspaceDir: ws, channel: "signal", groupId: "dgvzda==" });
    const meta = readGroupMemoryMeta(dir);
    expect(meta?.name).toBe("Ops Room");
    expect(meta?.members).toEqual(["+10000000001"]);
    expect(meta?.channel).toBe("signal");
    expect(meta?.groupId).toBe("dgvzda==");
  });

  it("converts a member recorded as a number to the uuid sender id (signal uuid ARCH §3.3)", async () => {
    const ws = tmpWorkspace();
    const cfg = { agents: { defaults: { workspace: ws } } } as OpenClawConfig;
    const dir = resolveGroupMemoryDir({ workspaceDir: ws, channel: "signal", groupId: "dgvzda==" });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({
        channel: "signal",
        groupId: "dgvzda==",
        name: "Ops Room",
        members: ["+15550001111", "+15550002222"],
        firstSeen: new Date(0).toISOString(),
        lastSeen: new Date(0).toISOString(),
      }),
    );
    await dispatchInboundMessage({
      ctx: buildTestCtx({
        From: "signal:group:dgvzda==",
        ChatType: "group",
        Provider: "signal",
        Surface: "signal",
        SenderId: "uuid:00000000-0000-4000-8000-00000000000a",
        SenderMatchE164: "+15550001111",
      }),
      cfg,
      dispatcher: silentDispatcher(),
      replyResolver: async () => ({ text: "ok" }),
    });
    expect(readGroupMemoryMeta(dir)?.members).toEqual([
      "uuid:00000000-0000-4000-8000-00000000000a",
      "+15550002222",
    ]);
  });

  it("never writes meta for a DM", async () => {
    const ws = tmpWorkspace();
    const cfg = { agents: { defaults: { workspace: ws } } } as OpenClawConfig;
    await dispatchInboundMessage({
      ctx: buildTestCtx({
        From: "signal:+10000000001",
        ChatType: "direct",
        Provider: "signal",
        Surface: "signal",
      }),
      cfg,
      dispatcher: silentDispatcher(),
      replyResolver: async () => ({ text: "ok" }),
    });
    expect(fs.existsSync(path.join(ws, "group-memory"))).toBe(false);
  });

  it("disabled config stops meta writes", async () => {
    const ws = tmpWorkspace();
    const cfg = {
      agents: { defaults: { workspace: ws, groupMemory: { enabled: false } } },
    } as OpenClawConfig;
    await dispatchInboundMessage({
      ctx: buildTestCtx({
        From: "signal:group:dgvzda==",
        ChatType: "group",
        Provider: "signal",
        Surface: "signal",
      }),
      cfg,
      dispatcher: silentDispatcher(),
      replyResolver: async () => ({ text: "ok" }),
    });
    expect(fs.existsSync(path.join(ws, "group-memory"))).toBe(false);
  });
});

describe("dispatchInboundMessage group_memory_created hook (group-memory ARCH §8)", () => {
  const roots: string[] = [];
  function tmpWorkspace(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-groupmem-hook-"));
    roots.push(dir);
    return dir;
  }
  afterEach(() => {
    resetGroupMemoryMetaThrottleForTests();
    resetGlobalHookRunner();
    vi.useRealTimers();
    while (roots.length) {
      fs.rmSync(roots.pop() as string, { recursive: true, force: true });
    }
  });

  const dispatcher = (): ReplyDispatcher => ({
    sendToolResult: () => true,
    sendBlockReply: () => true,
    sendFinalReply: () => true,
    getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
    markComplete: () => {},
    waitForIdle: async () => {},
  });

  const groupCtx = (o: Record<string, unknown> = {}) =>
    buildTestCtx({
      From: "signal:group:dgvzda==",
      To: "signal:+15550001234",
      ChatType: "group",
      Provider: "signal",
      Surface: "signal",
      GroupSubject: "Ops Room",
      SenderId: "+10000000001",
      Body: "secret chat words",
      ...o,
    });

  const flush = () => new Promise((r) => setImmediate(r)).then(() => new Promise(setImmediate));

  it("fires once on creation with name and path, never content or member ids", async () => {
    const ws = tmpWorkspace();
    const cfg = { agents: { defaults: { workspace: ws } } } as OpenClawConfig;
    const handler = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "group_memory_created", handler }]),
    );
    await dispatchInboundMessage({
      ctx: groupCtx(),
      cfg,
      dispatcher: dispatcher(),
      replyResolver: async () => ({ text: "ok" }),
    });
    await flush();
    expect(handler).toHaveBeenCalledTimes(1);
    const [event, ctx] = handler.mock.calls[0];
    const dir = resolveGroupMemoryDir({ workspaceDir: ws, channel: "signal", groupId: "dgvzda==" });
    expect(event).toEqual({
      agentId: "main",
      channel: "signal",
      groupId: "dgvzda==",
      name: "Ops Room",
      dir,
      firstSeen: readGroupMemoryMeta(dir)?.firstSeen,
      reason: "created",
    });
    expect(ctx).toEqual({ agentId: "main", channelId: "signal" });
    expect(JSON.stringify(event)).not.toContain("+10000000001");
    expect(JSON.stringify(event)).not.toContain("secret chat words");
    // A second message is an ordinary update: no event.
    await dispatchInboundMessage({
      ctx: groupCtx({ SenderId: "+10000000002" }),
      cfg,
      dispatcher: dispatcher(),
      replyResolver: async () => ({ text: "ok" }),
    });
    await flush();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("fires again on rename with reason renamed", async () => {
    const ws = tmpWorkspace();
    const cfg = { agents: { defaults: { workspace: ws } } } as OpenClawConfig;
    const handler = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "group_memory_created", handler }]),
    );
    await dispatchInboundMessage({
      ctx: groupCtx(),
      cfg,
      dispatcher: dispatcher(),
      replyResolver: async () => ({ text: "ok" }),
    });
    // Past the one-write-per-minute throttle.
    resetGroupMemoryMetaThrottleForTests();
    await dispatchInboundMessage({
      ctx: groupCtx({ GroupSubject: "Ops Room 2" }),
      cfg,
      dispatcher: dispatcher(),
      replyResolver: async () => ({ text: "ok" }),
    });
    await flush();
    expect(handler.mock.calls.map((c) => [c[0].reason, c[0].name])).toEqual([
      ["created", "Ops Room"],
      ["renamed", "Ops Room 2"],
    ]);
  });

  it("a throwing or hanging handler never affects message handling", async () => {
    const ws = tmpWorkspace();
    const cfg = { agents: { defaults: { workspace: ws } } } as OpenClawConfig;
    const thrower = vi.fn(() => {
      throw new Error("handler exploded");
    });
    const hanger = vi.fn(() => new Promise<void>(() => {}));
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "group_memory_created", handler: thrower },
        { hookName: "group_memory_created", handler: hanger },
      ]),
    );
    const finals: string[] = [];
    const d = { ...dispatcher(), sendFinalReply: (p: { text?: string }) => !!finals.push(p.text!) };
    await expect(
      dispatchInboundMessage({
        ctx: groupCtx(),
        cfg,
        dispatcher: d as ReplyDispatcher,
        replyResolver: async () => ({ text: "still replied" }),
      }),
    ).resolves.toBeDefined();
    expect(finals).toEqual(["still replied"]);
    // Handlers run after the message, detached from it.
    await flush();
    expect(thrower).toHaveBeenCalledTimes(1);
    expect(hanger).toHaveBeenCalledTimes(1);
    const dir = resolveGroupMemoryDir({ workspaceDir: ws, channel: "signal", groupId: "dgvzda==" });
    expect(fs.readFileSync(path.join(dir, "CONTEXT.md"), "utf8")).toContain("# Ops Room");
  });
});
