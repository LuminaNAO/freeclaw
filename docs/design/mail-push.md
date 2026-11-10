# Mail push connectors

Status: design (operator, 2026-11-10). Owner of this file: operator. Builders do not edit it; a disagreement is raised, not patched.

## 1. Goal

An agent learns about new email the moment it arrives, without polling crons. A **mail connector** watches a
mailbox and pushes each new message into one or more **attached sessions** as an inbound event. The event does
not mean "tell the user": what the agent does with it (ignore, file, summarise, alert) is soft logic the operator
writes in the agent's workspace files (e.g. `MAIL.md`). Core provides the plumbing only.

## 2. Principles

- One ops core, thin frontends: config, gateway methods and CLI share one implementation; every CLI verb has `--json`.
- Mail is untrusted input. Every pushed message is wrapped as external untrusted content (the existing
  `EXTERNAL_UNTRUSTED_CONTENT` wrapper used by web fetch), never as instructions.
- Read-only. Connectors never send, move, flag or delete mail. Marking read is not done either.
- Secrets only through SecretRef (env/file/exec), never in config values, logs or events.
- No floods: first start and reconnects resume from a stored cursor; nothing older is pushed unless asked.
- Default `deliver: false`: the agent turn runs, nothing goes to a chat unless the agent itself sends.

## 3. Config (`mail.connectors`, schema-validated)

```json5
mail: {
  connectors: [
    {
      id: "work",                       // [a-z0-9-], unique
      enabled: true,
      provider: "imap",                 // "imap" | "fake" (tests); further providers plug in via §5
      imap: {
        host: "imap.example.com", port: 993, tls: true,   // tls: true | "starttls" | false (false only for 127.0.0.1)
        user: "me@example.com",
        password: { source: "file", ... },                 // SecretRef
        folders: ["INBOX"],                                // default ["INBOX"]
        idle: true,                                        // IMAP IDLE; false = poll
        pollSeconds: 60,                                   // used when idle is false or unsupported (min 15)
      },
      filter: {                                            // optional, all optional, AND-ed
        from: ["*@client.com"], to: [], subjectIncludes: [], excludeFrom: ["noreply@*"],
        maxAgeMinutes: 1440,                               // ignore mail whose Date is older than this
      },
      body: { maxChars: 8000, attachments: "names" },      // attachments: "none" | "names" (never content)
      batch: { windowSeconds: 20, max: 10 },               // coalesce bursts into one event
      attach: [
        {
          agentId: "main",
          sessionKey: "agent:main:mail:work",              // any session key; created if missing
          wakeMode: "now",                                 // "now" | "next-heartbeat"
          deliver: false,                                  // default false
          channel: null, to: null,                         // only used when deliver is true
          instructionsFile: "MAIL.md",                     // workspace-relative; named in the event, not inlined
          model: null, thinking: null,                     // optional per-attachment overrides
        },
      ],
    },
  ],
}
```

Validation: unknown keys rejected; `attach` non-empty when enabled; sessionKey must belong to `agentId`;
`deliver: true` requires channel+to (or `channel: "last"`).

## 4. Event

Per batch, each attached session receives one agent turn (`wakeMode: now`) or one queued system event
(`next-heartbeat`) whose text is:

```
[mail:<connectorId>] <n> new message(s). Handle them per <instructionsFile> (if present).
<EXTERNAL_UNTRUSTED_CONTENT ...>
From / To / Cc / Date / Subject / Message-ID / folder / attachment names
<body text, plain, trimmed to maxChars>
</EXTERNAL_UNTRUSTED_CONTENT>
...
```

HTML bodies are converted to text. Quoted reply chains may be cut. The event carries a stable id per message
(connector id + folder + UID validity + UID) so the agent can refer to it.

## 5. Provider interface

`src/mail/providers/<name>.ts` implements:

```ts
interface MailProvider {
  start(ctx: {
    cursor: Cursor | null;
    onMessages(msgs: MailMessage[], cursor: Cursor): Promise<void>;
    onState(s: ConnectorState): void;
    signal: AbortSignal;
  }): Promise<void>;
  test(): Promise<{ ok: boolean; detail: string }>; // connect + auth + folder select, no side effects
}
```

The cursor is committed only after every attached session accepted the batch (at-least-once; the agent sees
the message id, duplicates after a crash are possible and named in the docs). Phase 1 providers: `imap`
(IDLE with poll fallback, reconnect with backoff 5 s -> 5 min, UIDVALIDITY change = reset cursor to "now",
no backfill) and `fake` (in-memory, for tests). Later providers (Microsoft Graph delta/subscriptions, Gmail
history) implement the same interface; the existing Gmail Pub/Sub hook preset stays as it is.

## 6. Runtime

- `src/mail/manager.ts` starts enabled connectors with the gateway, stops them on shutdown, restarts a connector
  on config reload when only its own entry changed.
- State per connector in `<stateDir>/mail/<id>.json`: cursor, last event time, last error (no content).
- States: `starting | idle | polling | backoff | auth-failed | disabled`. `auth-failed` stops retrying after 3
  tries and needs `mail connectors restart <id>`.
- Logging: one line per batch (connector, count, sessions), never subjects, bodies or addresses at info level.

## 7. Surfaces

- Gateway methods: `mail.connectors.list`, `mail.connectors.status`, `mail.connectors.test`, `mail.connectors.restart`.
- CLI (thin, all with `--json`): `openclaw mail connectors list|status|test <id>|restart <id>`.
- `openclaw doctor`: flags connectors in `auth-failed`/`backoff` > 15 min.
- Docs: `docs/automation/mail-push.md` (setup, `MAIL.md` example, at-least-once note, security notes).

## 8. Out of scope

Sending or modifying mail; attachment content; providers other than imap/fake; per-message routing rules beyond
the filter (the agent's `MAIL.md` does that).

## 9. Tests (all required)

1. Schema: valid example passes; unknown keys, empty attach, bad sessionKey/agent pairing, deliver without target rejected.
2. Fake provider: one message -> one event in the attached session, wrapped as untrusted content, `deliver:false` sends nothing.
3. Two attached sessions both receive the batch; cursor commits only after both accepted.
4. Batch window coalesces 5 messages into one event; `max` splits larger bursts.
5. Filter: from/excludeFrom/subject/maxAge each tested.
6. Restart resumes from cursor: no re-push of old mail; first start pushes nothing older than start.
7. Crash before commit -> message re-pushed once (at-least-once) with the same id.
8. `next-heartbeat` queues a system event instead of running a turn.
9. Body trimmed to maxChars; HTML converted to text; attachment names only.
10. IMAP provider against an in-process IMAP test server: IDLE push, poll fallback, reconnect backoff, UIDVALIDITY reset, auth failure -> `auth-failed` after 3.
11. Secrets: password never appears in logs, state file, status output or events.
12. CLI/gateway parity: every CLI verb maps to a gateway method; `--json` output matches the method result.
13. Config reload restarts only the changed connector.
14. Read-only: provider never issues STORE/MOVE/EXPUNGE/APPEND (asserted on the test server).

## 10. Acceptance (operator, after the build)

On a dev gateway with a test mailbox: send a mail -> the attached session gets one event within 30 s, nothing is
posted to any chat, `MAIL.md` directions are followed; restart the gateway -> no duplicate; wrong password ->
`auth-failed` shown in status and doctor.
