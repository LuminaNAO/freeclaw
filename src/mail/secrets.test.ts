// docs/design/mail-push.md §9.11: the IMAP password (a SecretRef) never appears in logs, the state
// file, status output or events. Real manager, real state files in a temp dir, real imap provider
// against an in-process IMAP server on 127.0.0.1 (ephemeral port).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import imapkit from "imapkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { MailConnectorManager } from "./manager.js";
import { runMailConnectorOp } from "./ops.js";
import { createRecordingLogger, createRecordingSink, waitFor } from "./test-helpers.js";

const PASSWORD = "s3cret-mail-pw-4d1e8b";

let server: ReturnType<typeof imapkit>;
let port: number;
let dir: string;
let manager: MailConnectorManager | null = null;

beforeEach(async () => {
  server = imapkit({ plugins: ["IDLE"], users: { testuser: { password: PASSWORD } } });
  port = await server.start(0, "127.0.0.1");
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mail-secrets-"));
  await fs.writeFile(path.join(dir, "secrets.json"), JSON.stringify({ imap: { work: PASSWORD } }));
  await fs.chmod(path.join(dir, "secrets.json"), 0o600);
});

afterEach(async () => {
  await manager?.stop();
  manager = null;
  await server.stop();
  await fs.rm(dir, { recursive: true, force: true });
});

function config(userName: string): OpenClawConfig {
  return {
    secrets: {
      providers: {
        mailfile: { source: "file", path: path.join(dir, "secrets.json"), mode: "json" },
      },
    },
    mail: {
      connectors: [
        {
          id: "work",
          provider: "imap",
          imap: {
            host: "127.0.0.1",
            port,
            tls: false,
            user: userName,
            password: { source: "file", provider: "mailfile", id: "/imap/work" },
          },
          batch: { windowSeconds: 0 },
          attach: [{ agentId: "main", sessionKey: "agent:main:mail:work" }],
        },
      ],
    },
  } as OpenClawConfig;
}

async function everything(log: { lines: string[] }, sink: { events: unknown[] }) {
  const stateFiles = await fs.readdir(path.join(dir, "state")).catch(() => [] as string[]);
  const stateText = (
    await Promise.all(stateFiles.map((name) => fs.readFile(path.join(dir, "state", name), "utf8")))
  ).join("\n");
  const ops = manager!;
  const surfaces = JSON.stringify([
    await runMailConnectorOp(ops, "list"),
    await runMailConnectorOp(ops, "status"),
    await runMailConnectorOp(ops, "test", "work"),
  ]);
  return { stateText, surfaces, logs: log.lines.join("\n"), events: JSON.stringify(sink.events) };
}

describe("mail connector secrets (§9.11)", () => {
  it("resolves the SecretRef and keeps the password out of logs, state, status and events", async () => {
    const log = createRecordingLogger();
    const sink = createRecordingSink();
    manager = new MailConnectorManager({
      log,
      sink,
      statePathFor: (id) => path.join(dir, "state", `${id}.json`),
    });
    await manager.start(config("testuser"));
    await waitFor(() => manager!.get("work")?.status().state === "idle", 5_000, "idle");
    server.control.addMessage("INBOX", {
      raw: `From: a@b.example\r\nSubject: password is ${"*".repeat(3)}\r\n\r\nhello\r\n`,
    });
    await waitFor(() => sink.events.length === 1, 5_000, "event");
    await manager.get("work")!.idle();
    const out = await everything(log, sink);
    expect(out.stateText).toContain('"lastUid": 1');
    for (const text of Object.values(out)) {
      expect(text).not.toContain(PASSWORD);
    }
    expect(out.surfaces).toContain('"ok":true');
  });

  it("an auth failure with the resolved password leaks it nowhere", async () => {
    const log = createRecordingLogger();
    const sink = createRecordingSink();
    manager = new MailConnectorManager({
      log,
      sink,
      statePathFor: (id) => path.join(dir, "state", `${id}.json`),
    });
    // Wrong user: the server refuses the (correct) password, the error path runs.
    await manager.start(config("nobody"));
    await waitFor(
      () => (manager!.get("work")?.status().state ?? "") === "backoff",
      5_000,
      "backoff",
    );
    const out = await everything(log, sink);
    expect(out.surfaces).toContain('"ok":false');
    for (const text of Object.values(out)) {
      expect(text).not.toContain(PASSWORD);
    }
  });

  it("a SecretRef that cannot be resolved ends in backoff, not a crash", async () => {
    const log = createRecordingLogger();
    manager = new MailConnectorManager({
      log,
      sink: createRecordingSink(),
      statePathFor: (id) => path.join(dir, "state", `${id}.json`),
      retryBaseMs: 60_000,
    });
    await fs.writeFile(path.join(dir, "secrets.json"), JSON.stringify({ imap: {} }));
    await manager.start(config("testuser"));
    await waitFor(() => manager!.get("work")?.status().state === "backoff", 5_000, "backoff");
    const test = await runMailConnectorOp(manager, "test", "work");
    expect(test).toEqual({
      id: "work",
      ok: false,
      detail: "password secret could not be resolved",
    });
  });
});
