// docs/design/mail-push.md §9.10 and §9.14: the imap provider against an in-process IMAP test
// server (imapkit, dev dependency) on 127.0.0.1 with an ephemeral port.
import imapkit from "imapkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MailImapConfig } from "../../config/types.mail.js";
import { MailConnector } from "../connector.js";
import {
  createMemoryStateIo,
  createRecordingLogger,
  createRecordingSink,
  fakeConnectorConfig,
  waitFor,
} from "../test-helpers.js";
import type { ConnectorState } from "../types.js";
import { ImapMailProvider } from "./imap.js";

type ImapServer = ReturnType<typeof imapkit>;

/** Commands that would change the mailbox; a read-only provider never sends them. */
const WRITE_COMMANDS = [
  "STORE",
  "UID STORE",
  "MOVE",
  "UID MOVE",
  "COPY",
  "UID COPY",
  "EXPUNGE",
  "UID EXPUNGE",
  "APPEND",
  "DELETE",
  "RENAME",
  "CREATE",
  "SELECT",
];

const PASSWORD = "imap-test-pw-7f3a9c";

let server: ImapServer;
let port: number;
let commands: Array<{ command: string; status: string; session: number }>;

function rawMessage(params: {
  subject: string;
  from?: string;
  body?: string;
  html?: boolean;
  attachment?: string;
}): string {
  const from = params.from ?? "Ann <ann@client.com>";
  const headers = [
    `From: ${from}`,
    "To: me@example.com",
    `Subject: ${params.subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${params.subject.replace(/\W+/g, "-")}@client.com>`,
    "MIME-Version: 1.0",
  ];
  if (params.attachment) {
    return [
      ...headers,
      'Content-Type: multipart/mixed; boundary="b1"',
      "",
      "--b1",
      "Content-Type: text/plain; charset=utf-8",
      "",
      params.body ?? "hello",
      "--b1",
      `Content-Type: application/pdf; name="${params.attachment}"`,
      `Content-Disposition: attachment; filename="${params.attachment}"`,
      "Content-Transfer-Encoding: base64",
      "",
      "JVBERi0xLjQKc2VjcmV0IGF0dGFjaG1lbnQgY29udGVudA==",
      "--b1--",
      "",
    ].join("\r\n");
  }
  return [
    ...headers,
    `Content-Type: ${params.html ? "text/html" : "text/plain"}; charset=utf-8`,
    "",
    params.body ?? "hello",
    "",
  ].join("\r\n");
}

function imapConfig(overrides: Partial<MailImapConfig> = {}): MailImapConfig {
  return {
    host: "127.0.0.1",
    port,
    tls: false,
    user: "testuser",
    password: { source: "env", provider: "default", id: "MAIL_TEST_PASSWORD" },
    folders: ["INBOX"],
    idle: true,
    ...overrides,
  };
}

function setup(params: {
  imap?: Partial<MailImapConfig>;
  password?: string;
  pollIntervalMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}) {
  const log = createRecordingLogger();
  const sink = createRecordingSink();
  const io = createMemoryStateIo();
  const states: ConnectorState[] = [];
  const password = params.password ?? PASSWORD;
  const provider = new ImapMailProvider({
    connectorId: "work",
    imap: imapConfig(params.imap),
    password,
    log,
    pollIntervalMs: params.pollIntervalMs,
    backoffBaseMs: params.backoffBaseMs ?? 20,
    backoffMaxMs: params.backoffMaxMs ?? 200,
    socketTimeoutMs: 5_000,
  });
  // Record every state the provider reports, then pass it on.
  const recordingProvider = {
    test: () => provider.test(),
    start: (ctx: Parameters<ImapMailProvider["start"]>[0]) =>
      provider.start({
        ...ctx,
        onState: (state) => {
          states.push(state);
          ctx.onState(state);
        },
      }),
  };
  const connector = new MailConnector({
    config: fakeConnectorConfig({ provider: "imap", imap: imapConfig(params.imap) }),
    provider: recordingProvider,
    sink,
    statePath: "/state/mail/work.json",
    log,
    io,
    secrets: [password],
    retryBaseMs: 20,
    retryMaxMs: 200,
  });
  connectors.push(connector);
  return { log, sink, io, states, connector, provider };
}

const connectors: MailConnector[] = [];

beforeEach(async () => {
  commands = [];
  server = imapkit({
    plugins: ["IDLE", "ENABLE", "UIDPLUS", "MOVE"],
    users: { testuser: { password: PASSWORD } },
  });
  server.on("command", (event: { command: string; status: string; session: number }) => {
    commands.push({ command: event.command, status: event.status, session: event.session });
  });
  port = await server.start(0, "127.0.0.1");
});

afterEach(async () => {
  await Promise.all(connectors.splice(0).map((connector) => connector.stop()));
  await server.stop();
});

function addMail(params: Parameters<typeof rawMessage>[0]) {
  return server.control.addMessage("INBOX", { raw: rawMessage(params) });
}

function idling(): Promise<void> {
  return new Promise((resolve) => {
    const onSession = (event: { type: string; command?: string }) => {
      if (event.type === "waiting" && event.command === "IDLE") {
        server.off("session", onSession);
        resolve();
      }
    };
    server.on("session", onSession);
  });
}

describe("imap provider (§9.10, §9.14)", () => {
  it("IDLE push: a delivered message arrives without polling; nothing older is pushed", async () => {
    addMail({ subject: "old mail before start" });
    const { sink, connector, states } = setup({});
    const waitIdle = idling();
    await connector.start();
    await waitIdle;
    expect(states.map((s) => s.state)).toContain("idle");
    const commandsBefore = commands.length;
    addMail({ subject: "pushed by IDLE", body: "Hi there" });
    await waitFor(() => sink.events.length === 1, 5_000, "IDLE push");
    // The server announced the mail during IDLE: no NOOP/poll was needed to find it.
    expect(commands.slice(commandsBefore).map((c) => c.command)).not.toContain("NOOP");
    expect(commands.slice(commandsBefore)[0]?.command).toBe("IDLE");
    await connector.idle();
    expect(sink.events[0].text).toContain("Subject: pushed by IDLE");
    expect(sink.events[0].text).toContain("Hi there");
    expect(sink.events[0].text).toContain("From: Ann <ann@client.com>");
    expect(sink.events[0].text).not.toContain("old mail before start");
    const uidValidity = String(server.control.getMailbox("INBOX").uidvalidity);
    expect(sink.events[0].messageIds).toEqual([`mail:work/INBOX/${uidValidity}/2`]);
    expect(connector.status().cursor?.folders.INBOX).toEqual({ uidValidity, lastUid: 2 });
  });

  it("poll fallback: idle false polls with NOOP and still delivers", async () => {
    const { sink, connector, states } = setup({ imap: { idle: false }, pollIntervalMs: 50 });
    await connector.start();
    await waitFor(() => connector.status().state === "polling", 5_000, "polling");
    expect(states.map((s) => s.state)).not.toContain("idle");
    await waitFor(() => commands.some((c) => c.command === "NOOP"), 5_000, "first poll");
    addMail({ subject: "found by polling" });
    await waitFor(() => sink.events.length === 1, 5_000, "poll delivery");
    expect(sink.events[0].text).toContain("Subject: found by polling");
    expect(commands.some((c) => c.command === "IDLE")).toBe(false);
  });

  it("poll fallback: a server without IDLE is polled", async () => {
    await server.stop();
    server = imapkit({ plugins: ["ENABLE"], users: { testuser: { password: PASSWORD } } });
    server.on("command", (event: { command: string; status: string; session: number }) => {
      commands.push(event);
    });
    port = await server.start(0, "127.0.0.1");
    const { sink, connector } = setup({ pollIntervalMs: 50 });
    await connector.start();
    await waitFor(() => connector.status().state === "polling", 5_000, "polling");
    addMail({ subject: "no idle server" });
    await waitFor(() => sink.events.length === 1, 5_000, "poll delivery");
    expect(sink.events[0].text).toContain("Subject: no idle server");
  });

  it("reconnects with backoff after the server drops the connection, without re-pushing", async () => {
    const { sink, connector, states } = setup({ backoffBaseMs: 30 });
    const waitIdle = idling();
    await connector.start();
    await waitIdle;
    addMail({ subject: "first" });
    await waitFor(() => sink.events.length === 1, 5_000, "first");
    await connector.idle();
    server.control.disconnect({ user: "testuser" }, { text: "maintenance" });
    await waitFor(() => states.some((s) => s.state === "backoff"), 5_000, "backoff");
    const backoff = states.find((s) => s.state === "backoff")!;
    expect(backoff.retryAt).toBeGreaterThan(0);
    await waitFor(() => connector.status().state === "idle", 5_000, "reconnected");
    addMail({ subject: "second" });
    await waitFor(() => sink.events.length === 2, 5_000, "second");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sink.events).toHaveLength(2);
    expect(sink.events[1].text).toContain("Subject: second");
    expect(sink.events[1].text).not.toContain("Subject: first");
  });

  it("backoff grows from the base delay and is capped", async () => {
    const { connector, states } = setup({ backoffBaseMs: 20, backoffMaxMs: 80 });
    // Refuse every connection with a greeting BYE.
    server.script.add({ on: "greeting", send: "* BYE go away\r\n", close: true });
    const reported: Array<{ at: number; retryAt: number }> = [];
    const seen = new Set<ConnectorState>();
    const track = setInterval(() => {
      for (const state of states) {
        if (state.state === "backoff" && state.retryAt && !seen.has(state)) {
          seen.add(state);
          reported.push({ at: Date.now(), retryAt: state.retryAt });
        }
      }
    }, 1);
    await connector.start();
    await waitFor(() => reported.length >= 5, 10_000, "several backoffs");
    clearInterval(track);
    const delays = reported.map((entry) => entry.retryAt - entry.at);
    // 20, 40, 80, 80, 80 (+/- scheduling noise): grows, then stays at the cap.
    expect(delays[0]).toBeLessThan(40);
    expect(delays[1]).toBeGreaterThan(delays[0]);
    for (const delay of delays) {
      expect(delay).toBeLessThanOrEqual(80);
    }
    expect(delays.at(-1)).toBeGreaterThanOrEqual(60);
    expect(connector.status().state).toBe("backoff");
    expect(connector.status().troubleSince).toBeGreaterThan(0);
  });

  it("UIDVALIDITY change resets the cursor to now without backfill", async () => {
    addMail({ subject: "a" });
    addMail({ subject: "b" });
    const { sink, connector } = setup({ backoffBaseMs: 20 });
    const waitIdle = idling();
    await connector.start();
    await waitIdle;
    const before = connector.status().cursor?.folders.INBOX;
    expect(before?.lastUid).toBe(2);
    const reset = server.control.resetUidValidity("INBOX", { uids: "renumber" });
    await waitFor(
      () => connector.status().cursor?.folders.INBOX.uidValidity === String(reset.uidvalidity),
      5_000,
      "cursor reset",
    );
    await connector.idle();
    expect(sink.events).toHaveLength(0);
    addMail({ subject: "after reset" });
    await waitFor(() => sink.events.length === 1, 5_000, "after reset");
    expect(sink.events[0].text).toContain("Subject: after reset");
    expect(sink.events[0].messageIds[0]).toBe(`mail:work/INBOX/${reset.uidvalidity}/3`);
  });

  it("auth failure -> auth-failed after 3 tries, then stops retrying", async () => {
    const { connector, states, log, io } = setup({ password: "wrong-password-123" });
    await connector.start();
    await waitFor(() => connector.status().state === "auth-failed", 10_000, "auth-failed");
    const logins = commands.filter((c) => c.command === "LOGIN");
    expect(logins).toHaveLength(3);
    expect(logins.every((c) => c.status === "NO")).toBe(true);
    expect(states.filter((s) => s.state === "backoff")).toHaveLength(2);
    expect(connector.status().detail).toContain("openclaw mail connectors restart work");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(commands.filter((c) => c.command === "LOGIN")).toHaveLength(3);
    // §9.11: the password never shows up in logs, state or status.
    const status = JSON.stringify(connector.status());
    expect(status).not.toContain("wrong-password-123");
    expect(JSON.stringify([...io.files.values()])).not.toContain("wrong-password-123");
    expect(log.lines.join("\n")).not.toContain("wrong-password-123");
    expect(io.files.get("/state/mail/work.json")?.state).toBe("auth-failed");
  });

  it("test(): connect + auth + examine, reports auth failure without side effects", async () => {
    addMail({ subject: "x" });
    const ok = await setup({}).provider.test();
    expect(ok).toMatchObject({ ok: true });
    expect(ok.detail).toContain("INBOX: 1 message(s)");
    const bad = await setup({ password: "nope-nope" }).provider.test();
    expect(bad).toEqual({ ok: false, detail: "authentication failed" });
    expect(server.control.listMessages("INBOX")[0].flags).not.toContain("\\Seen");
  });

  it("HTML bodies and attachment names over IMAP; attachment content is never fetched", async () => {
    const { sink, connector } = setup({});
    const waitIdle = idling();
    await connector.start();
    await waitIdle;
    addMail({
      subject: "html",
      html: true,
      body: "<p>Hello <b>there</b></p><div style='display:none'>hidden</div>",
    });
    addMail({ subject: "with file", body: "see attached", attachment: "report.pdf" });
    await waitFor(
      () => sink.events.flatMap((e) => e.messageIds).length === 2,
      5_000,
      "two messages",
    );
    const text = sink.events.map((e) => e.text).join("\n");
    expect(text).toContain("Hello there");
    expect(text).not.toContain("<b>");
    expect(text).not.toContain("hidden");
    expect(text).toContain("Attachments: report.pdf");
    expect(text).not.toContain("secret attachment content");
    expect(text).not.toContain("JVBERi0x");
  });

  it("§9.14 read-only: never STORE/MOVE/EXPUNGE/APPEND; messages stay unseen", async () => {
    addMail({ subject: "pre-existing" });
    const { sink, connector } = setup({ backoffBaseMs: 20 });
    const waitIdle = idling();
    await connector.start();
    await waitIdle;
    addMail({ subject: "one", attachment: "a.pdf" });
    addMail({ subject: "two", html: true, body: "<p>x</p>" });
    await waitFor(() => sink.events.flatMap((e) => e.messageIds).length === 2, 5_000, "mail");
    server.control.disconnect({ user: "testuser" });
    await waitFor(() => connector.status().state === "idle", 5_000, "reconnected");
    addMail({ subject: "three" });
    await waitFor(() => sink.events.flatMap((e) => e.messageIds).length === 3, 5_000, "three");
    await connector.stop();
    expect(await setup({}).provider.test()).toMatchObject({ ok: true });

    const issued = new Set(commands.map((c) => c.command.toUpperCase()));
    for (const command of WRITE_COMMANDS) {
      expect(issued.has(command), `${command} must never be sent`).toBe(false);
    }
    expect(issued.has("EXAMINE")).toBe(true);
    for (const message of server.control.listMessages("INBOX")) {
      expect(message.flags).not.toContain("\\Seen");
      expect(message.flags).not.toContain("\\Deleted");
    }
    expect(server.control.listMessages("INBOX")).toHaveLength(4);
  });
});
