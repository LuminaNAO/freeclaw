/**
 * group-memory ARCH §9: purpose read for other features. Placeholders only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  GROUP_PURPOSE_MAX_CHARS,
  resetGroupMemoryMetaThrottleForTests,
  resolveGroupMemoryDir,
  resolveGroupPurpose,
  starterGroupContext,
  updateGroupMemoryMetaOnInbound,
} from "./group-memory.js";

const roots: string[] = [];
function tmpWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "groupmem-purpose-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  resetGroupMemoryMetaThrottleForTests();
  while (roots.length) {
    fs.rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

const GROUP = "group:abc==";
const MEMBER = "uuid:00000000-0000-4000-8000-00000000000a";

function cfgFor(ws: string, extra: Partial<OpenClawConfig["agents"]> = {}): OpenClawConfig {
  return { agents: { defaults: { workspace: ws }, ...extra } } as OpenClawConfig;
}

function seed(
  ws: string,
  opts: { meta?: Record<string, unknown>; files?: Record<string, string> } = {},
): string {
  const dir = resolveGroupMemoryDir({ workspaceDir: ws, channel: "signal", groupId: GROUP });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({
      channel: "signal",
      groupId: GROUP,
      name: "Placeholder Group",
      members: [MEMBER],
      firstSeen: new Date(0).toISOString(),
      lastSeen: new Date(0).toISOString(),
      ...opts.meta,
    }),
  );
  for (const [name, content] of Object.entries(opts.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

// Every file under the workspace with its content and mtime: "never writes" compares these.
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out[`${p}/`] = String(fs.statSync(p).mtimeMs);
        walk(p);
      } else {
        out[p] = `${fs.statSync(p).mtimeMs}:${fs.readFileSync(p, "utf8")}`;
      }
    }
  };
  walk(root);
  return out;
}

const read = (ws: string, cfg = cfgFor(ws)) =>
  resolveGroupPurpose({ cfg, agentId: "main", channel: "signal", groupId: GROUP });

describe("resolveGroupPurpose (group-memory §9)", () => {
  it("starter only → not known (with or without its heading); empty file → not known", () => {
    const ws = tmpWorkspace();
    const dir = seed(ws, { files: { "CONTEXT.md": starterGroupContext("Placeholder Group") } });
    expect(read(ws)).toEqual({ known: false, text: "" });
    fs.writeFileSync(
      path.join(dir, "CONTEXT.md"),
      "Purpose: (not yet known — learn it from the conversation)\n",
    );
    expect(read(ws)).toEqual({ known: false, text: "" });
    fs.writeFileSync(path.join(dir, "CONTEXT.md"), "");
    expect(read(ws)).toEqual({ known: false, text: "" });
  });

  it("the starter as group memory writes it on creation → not known", () => {
    const ws = tmpWorkspace();
    updateGroupMemoryMetaOnInbound({
      workspaceDir: ws,
      channel: "signal",
      groupId: GROUP,
      groupName: "Placeholder Group",
      senderId: MEMBER,
      cfg: cfgFor(ws),
      agentId: "main",
    });
    expect(read(ws)).toEqual({ known: false, text: "" });
  });

  it("edited context → known with its text, without the first heading and without history", () => {
    const ws = tmpWorkspace();
    seed(ws, {
      files: {
        "CONTEXT.md": "# Placeholder Group\n\nPurpose: planning the weekend hiking trips.\n",
        "history.md": "- 2026-01-01 history line never read\n",
      },
    });
    const p = read(ws);
    expect(p.known).toBe(true);
    expect(p.text).toBe("Purpose: planning the weekend hiking trips.");
    expect(p.text).not.toContain("history line");
    expect(p.text).not.toContain("# Placeholder Group");
  });

  it("description only → known; the description comes first", () => {
    const ws = tmpWorkspace();
    seed(ws, { meta: { description: "A book club for sci-fi novels." } });
    expect(read(ws)).toEqual({ known: true, text: "A book club for sci-fi novels." });
    seed(ws, {
      meta: { description: "A book club." },
      files: { "CONTEXT.md": "# Title\nMeets monthly.\n" },
    });
    expect(read(ws)).toEqual({ known: true, text: "A book club.\n\nMeets monthly." });
  });

  it("an empty description and a starter context → not known", () => {
    const ws = tmpWorkspace();
    seed(ws, {
      meta: { description: "   " },
      files: { "CONTEXT.md": starterGroupContext("Placeholder Group") },
    });
    expect(read(ws).known).toBe(false);
  });

  it("text is cut to 800 characters and never carries member ids", () => {
    const ws = tmpWorkspace();
    seed(ws, {
      files: { "CONTEXT.md": `# T\nPeople: ${MEMBER} leads.\n${"x".repeat(2000)}\n` },
    });
    const p = read(ws);
    expect(p.known).toBe(true);
    expect(p.text.length).toBe(GROUP_PURPOSE_MAX_CHARS);
    expect(p.text).not.toContain(MEMBER);
    expect(p.text).not.toContain(MEMBER.slice(5));
  });

  it("honours the context_file override", () => {
    const ws = tmpWorkspace();
    seed(ws, {
      meta: { context_file: "notes/shared.md" },
      files: {
        "CONTEXT.md": "# T\nnot this one\n",
        "notes/shared.md": "# Shared\nThe override purpose.\n",
      },
    });
    expect(read(ws)).toEqual({ known: true, text: "The override purpose." });
  });

  it("resolves a legacy-layout folder (read where it is, not migrated)", () => {
    const ws = tmpWorkspace();
    const legacy = path.join(ws, "group-memory", "signal", encodeURIComponent("ABC=="));
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "CONTEXT.md"), "# Old\nThe legacy purpose.\n");
    fs.writeFileSync(
      path.join(legacy, "meta.json"),
      JSON.stringify({ signal_id: "group:ABC==", name: "Old", members: [MEMBER] }),
    );
    const before = snapshot(ws);
    expect(read(ws)).toEqual({ known: true, text: "The legacy purpose." });
    expect(snapshot(ws)).toEqual(before);
    expect(fs.existsSync(legacy)).toBe(true);
  });

  it("disabled → not known, for defaults and for a per-agent override", () => {
    const ws = tmpWorkspace();
    seed(ws, { meta: { description: "known purpose" } });
    expect(
      read(ws, cfgFor(ws, { defaults: { workspace: ws, groupMemory: { enabled: false } } })),
    ).toEqual({ known: false, text: "" });
    expect(
      read(
        ws,
        cfgFor(ws, { list: [{ id: "main", default: true, groupMemory: { enabled: false } }] }),
      ),
    ).toEqual({ known: false, text: "" });
  });

  it("never writes: no folder is created for an unknown group, nothing changes for a known one", () => {
    const ws = tmpWorkspace();
    expect(read(ws)).toEqual({ known: false, text: "" });
    expect(fs.readdirSync(ws)).toEqual([]);
    seed(ws, { files: { "CONTEXT.md": starterGroupContext("Placeholder Group") } });
    const before = snapshot(ws);
    read(ws);
    expect(snapshot(ws)).toEqual(before);
  });

  it("another group's folder is never read", () => {
    const ws = tmpWorkspace();
    const other = resolveGroupMemoryDir({
      workspaceDir: ws,
      channel: "signal",
      groupId: "group:other==",
    });
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, "CONTEXT.md"), "# Other\nOther purpose.\n");
    expect(read(ws)).toEqual({ known: false, text: "" });
  });
});
