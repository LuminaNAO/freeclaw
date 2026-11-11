// docs/design/mail-push.md §9.1: schema validation of `mail.connectors`.
import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "../config/zod-schema.js";

function exampleConnector(): Record<string, unknown> {
  return {
    id: "work",
    enabled: true,
    provider: "imap",
    imap: {
      host: "imap.example.com",
      port: 993,
      tls: true,
      user: "me@example.com",
      password: { source: "file", provider: "mailfile", id: "/imap/work" },
      folders: ["INBOX"],
      idle: true,
      pollSeconds: 60,
    },
    filter: {
      from: ["*@client.com"],
      to: [],
      subjectIncludes: [],
      excludeFrom: ["noreply@*"],
      maxAgeMinutes: 1440,
    },
    body: { maxChars: 8000, attachments: "names" },
    batch: { windowSeconds: 20, max: 10 },
    attach: [
      {
        agentId: "main",
        sessionKey: "agent:main:mail:work",
        wakeMode: "now",
        deliver: false,
        channel: null,
        to: null,
        instructionsFile: "MAIL.md",
        model: null,
        thinking: null,
      },
    ],
  };
}

function parse(connector: Record<string, unknown>) {
  return OpenClawSchema.safeParse({ mail: { connectors: [connector] } });
}

function issueText(result: ReturnType<typeof parse>): string {
  return result.success
    ? ""
    : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n");
}

describe("mail.connectors schema (§9.1)", () => {
  it("accepts the design example", () => {
    const result = parse(exampleConnector());
    expect(issueText(result)).toBe("");
    expect(result.success).toBe(true);
  });

  it("accepts a minimal fake connector", () => {
    const result = parse({
      id: "test-1",
      provider: "fake",
      attach: [{ agentId: "ops", sessionKey: "agent:ops:mail:test" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown keys at every level", () => {
    expect(parse({ ...exampleConnector(), extra: 1 }).success).toBe(false);
    const imap = { ...(exampleConnector().imap as object), starttls: true };
    expect(parse({ ...exampleConnector(), imap }).success).toBe(false);
    expect(parse({ ...exampleConnector(), filter: { fromm: ["a@b"] } }).success).toBe(false);
    const attach = [{ ...(exampleConnector().attach as object[])[0], notify: true }];
    expect(parse({ ...exampleConnector(), attach }).success).toBe(false);
    expect(OpenClawSchema.safeParse({ mail: { connectors: [], extra: true } }).success).toBe(false);
  });

  it("rejects an empty attach list on an enabled connector", () => {
    const result = parse({ ...exampleConnector(), attach: [] });
    expect(result.success).toBe(false);
    expect(issueText(result)).toContain("attach");
    // A disabled connector may be parked without sessions.
    expect(parse({ ...exampleConnector(), enabled: false, attach: [] }).success).toBe(true);
  });

  it("rejects a sessionKey that does not belong to agentId", () => {
    const wrongAgent = [{ agentId: "main", sessionKey: "agent:ops:mail:work" }];
    const result = parse({ ...exampleConnector(), attach: wrongAgent });
    expect(result.success).toBe(false);
    expect(issueText(result)).toContain('belongs to agent "ops"');
    const notAgentKey = [{ agentId: "main", sessionKey: "mail:work" }];
    expect(parse({ ...exampleConnector(), attach: notAgentKey }).success).toBe(false);
  });

  it("rejects deliver: true without a target, accepts channel+to or channel last", () => {
    const base = { agentId: "main", sessionKey: "agent:main:mail:work" };
    expect(parse({ ...exampleConnector(), attach: [{ ...base, deliver: true }] }).success).toBe(
      false,
    );
    expect(
      parse({ ...exampleConnector(), attach: [{ ...base, deliver: true, channel: "signal" }] })
        .success,
    ).toBe(false);
    expect(
      parse({
        ...exampleConnector(),
        attach: [{ ...base, deliver: true, channel: "signal", to: "+15550001111" }],
      }).success,
    ).toBe(true);
    expect(
      parse({ ...exampleConnector(), attach: [{ ...base, deliver: true, channel: "last" }] })
        .success,
    ).toBe(true);
  });

  it("rejects bad ids, duplicate ids, plaintext passwords and remote plaintext IMAP", () => {
    expect(parse({ ...exampleConnector(), id: "Work_1" }).success).toBe(false);
    expect(
      OpenClawSchema.safeParse({ mail: { connectors: [exampleConnector(), exampleConnector()] } })
        .success,
    ).toBe(false);
    const plainPassword = { ...(exampleConnector().imap as object), password: "hunter2" };
    expect(parse({ ...exampleConnector(), imap: plainPassword }).success).toBe(false);
    const remotePlain = { ...(exampleConnector().imap as object), tls: false };
    expect(parse({ ...exampleConnector(), imap: remotePlain }).success).toBe(false);
    const loopbackPlain = {
      ...(exampleConnector().imap as object),
      host: "127.0.0.1",
      tls: false,
    };
    expect(parse({ ...exampleConnector(), imap: loopbackPlain }).success).toBe(true);
    const fastPoll = { ...(exampleConnector().imap as object), pollSeconds: 5 };
    expect(parse({ ...exampleConnector(), imap: fastPoll }).success).toBe(false);
  });

  it("requires imap settings for the imap provider only", () => {
    const { imap: _imap, ...noImap } = exampleConnector();
    expect(parse(noImap).success).toBe(false);
    expect(parse({ ...exampleConnector(), provider: "fake" }).success).toBe(false);
    expect(parse({ ...exampleConnector(), provider: "pop3" }).success).toBe(false);
  });

  it("rejects an instructionsFile outside the workspace and unknown thinking levels", () => {
    const base = { agentId: "main", sessionKey: "agent:main:mail:work" };
    expect(
      parse({ ...exampleConnector(), attach: [{ ...base, instructionsFile: "../MAIL.md" }] })
        .success,
    ).toBe(false);
    expect(
      parse({ ...exampleConnector(), attach: [{ ...base, instructionsFile: "/etc/MAIL.md" }] })
        .success,
    ).toBe(false);
    expect(
      parse({ ...exampleConnector(), attach: [{ ...base, thinking: "ludicrous" }] }).success,
    ).toBe(false);
  });
});
