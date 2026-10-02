# ARCH: Signal ingress trust gate

Revision 2. This revision addresses audit findings AR1-AR8 and privacy findings P1/P2. The table at the end maps
each finding to the section that resolves it.

## 1. Goal and scope

A sender who is not in the trust store must never reach agent inference, and nothing the sender produces may reach
anything the agent can see. The gate does this with a set-membership check in code, so it never relies on a model
to refuse. Each denial is logged and flagged.

In scope: the Signal channel only (`src/signal/**` plus a small CLI). Out of scope: every other channel (Telegram,
Discord, Slack, iMessage, WhatsApp web, and extension channels) and outbound sends. The gate adds no restriction
on who the agent may message.

## 2. Current enforcement (baseline)

There is one Signal ingress path: `extensions/signal/src/channel.ts:305-314`, then `monitorSignalProvider`
(`src/signal/monitor.ts:337`), then the SSE loop (`monitor.ts:529-540`), then `createSignalEventHandler`
(`src/signal/monitor/event-handler.ts:79`). For each event, the handler (`event-handler.ts:447-782`) does the
following in order:

1. It parses the JSON and drops events that are not `receive` or have no envelope (`:448-465`).
2. `resolveSignalSender` (`src/signal/identity.ts:31-48`) resolves the sender. `sourceNumber` wins over
   `sourceUuid` and only one of them is kept. `sourceName` is display-only, but it later becomes the sender name
   the agent sees.
3. It drops messages from the bot's own account (`:476-482`) and all `syncMessage` envelopes (`:488-490`).
4. `resolveSignalAccessState` (`access-policy.ts:12-42`) merges config `allowFrom` with the pairing allowFrom
   store. The decision itself is in `dm-policy-shared.ts:105-197`. `dmPolicy: "open"` allows everyone (`:170`),
   `groupPolicy: "open"` allows any group sender, and store read errors are swallowed into `[]` (`:102`).
5. The reaction-only path (`:370-445`) calls `enqueueSystemEvent` into the routed session. **Agent-visible sink.**
6. For DMs, `handleSignalDirectMessageAccess` (`access-policy.ts:44-87`) either blocks (`logVerbose` only) or
   sends a pairing code.
7. For groups, the policy check (`:570-582`) logs drops with `logVerbose` only.
8. When a group message is skipped for lacking a mention, `recordPendingHistoryEntryIfEnabled` (`:640-681`)
   stores its body, and that body is injected into the next inference in that group. **Agent-visible sink.**
9. Attachment fetch (`:695`), read receipt (`:743`), `inboundDebouncer.enqueue` (`:763`), then
   `handleSignalInboundMessage` (`:100`), which calls `recordInboundSession` (`:202`) and
   `dispatchInboundMessage` (`:292`). **Inference.**

## 3. Gaps

- G1, config can open the door. `dmPolicy`/`groupPolicy: "open"` and `"*"` admit everyone, and `configWrites`
  defaults to true (`src/channels/plugins/config-writes.ts:51`), so a chat `/config set` can widen ingress.
- G2, no durable trust record. Trust is whatever the current policy computes. The pairing store is also written
  from chat by `/allowlist add` (`src/auto-reply/reply/commands-allowlist.ts:201-213`), and for the default
  account it merges a legacy unscoped file (`pairing-store.ts:555-560`).
- G3, sinks sit before and beside dispatch. Reaction system events (step 5) and pending history (step 8) reach the
  agent even though they are not "dispatch".
- G4, weak identity handling. `normalizeE164` (`src/utils.ts:76-83`) strips non-digits, so garbage input becomes
  `"+"` or bare digits. UUID comparison is raw and case-sensitive. When a number is present, the UUID is ignored.
- G5, denials are invisible. They are logged with `logVerbose` only, `disabled` is not logged at all, and nothing
  is flagged.

## 4. Design

### 4.1 Trust model and onboarding (AR1)

Only the operator grants trust, through a shell CLI or a hand-edited file (section 4.2). Pairing is **not** an
onboarding path while the gate is enforcing:

- The gate drops untrusted senders before any pairing logic runs. They get no pairing code, no read receipt, no
  typing indicator, and no reply of any kind. No outbound traffic reveals that the bot exists.
- Pairing approval (`approveChannelPairingCode`) and `/allowlist add` do **not** write the trust store. They keep
  their current behavior, which now matters only for senders who are already trusted.
- To onboard someone, the operator reads the flagged attempt (section 4.6) to get the sender id, then runs
  `openclaw signal trust add <id>`.

The gate and the existing policy compose with **AND**. A message proceeds only if the gate allows it **and** the
existing `dmPolicy`/`groupPolicy`/allowFrom/pairing checks allow it. For trusted senders those checks behave
exactly as they do today. `dmPolicy: "open"`, `groupPolicy: "open"`, `"*"`, `groupAllowFrom`, pairing-store
entries, and group membership can never widen the gate.

### 4.2 Trust store (AR2)

This is a new file, separate from the pairing store:

`$OPENCLAW_STATE_DIR/credentials/signal-trust-<accountKey>.json`

`<accountKey>` is the normalized account id, sanitized the same way as `safeAccountKey` in
`pairing-store.ts:79`. There is no unscoped or legacy file and no fallback between accounts. A sender trusted on
account A is untrusted on account B.

Schema (version 1):

```json
{
  "version": 1,
  "accountId": "default",
  "trusted": [
    {
      "number": "+15550000001",
      "uuid": "00000000-0000-4000-8000-000000000001",
      "addedAt": "2026-01-01T00:00:00Z"
    },
    { "number": "+15550000002", "addedAt": "2026-01-01T00:00:00Z" },
    { "uuid": "00000000-0000-4000-8000-000000000003", "addedAt": "2026-01-01T00:00:00Z" }
  ]
}
```

- Each entry has `number`, `uuid`, or both, in canonical form (section 4.3). `addedAt` is informational. Unknown
  keys are rejected.
- No wildcards. `"*"`, empty strings, and any value that is not canonical make the whole store invalid.
- A duplicate number or uuid across entries also makes the whole store invalid.

Writers (the complete list):

1. `openclaw signal trust add|remove <id> [--account <id>]`: a new operator shell CLI, `src/cli/signal-trust-cli.ts`.
2. `openclaw signal trust import-allowfrom [--account <id>]`: a one-shot, explicit copy of the canonical entries
   in config `allowFrom`. It skips and reports `"*"`, `signal:`/`uuid:` forms it cannot canonicalize, and garbage
   values. This is the only link between allowFrom and the store. There is no automatic or startup seeding, and
   removing an entry from allowFrom later does **not** revoke trust. Revocation is `trust remove`.
3. Hand-editing the file by the operator.

No agent tool, chat command (`/allowlist`, `/config`), pairing approval, or gateway RPC writes this file. The
implementation adds no new writer. The review check is that `signal-trust-` appears only in the store module and
the CLI.

### 4.3 Identity binding, canonicalization, and trust boundary (AR3)

**Trust boundary.** The monitor consumes JSON envelopes from the signal-cli daemon over HTTP SSE. There is no
per-field authentication, so every envelope field is exactly as trustworthy as that daemon endpoint. The gate
trusts the daemon to report the Signal-authenticated sender in `sourceNumber`/`sourceUuid`. It **cannot** defend
against:

- a compromised signal-cli,
- a malicious process on the SSE endpoint, or
- a non-loopback endpoint (`httpUrl`, `httpEndpointFile`, or an archive-raw proxy; `src/signal/accounts.ts:96-111`).

The gate therefore recommends a loopback endpoint and logs a startup warning when enforcing against a non-loopback
host. The spoof tests prove that malformed, conflicting, or misleading envelope content is rejected. They do not
and cannot prove resistance to Signal-protocol forgery or a hostile daemon.

**Identity fields.** Only `envelope.sourceNumber` and `envelope.sourceUuid` count. `sourceName`, quote
author/text, mentions, reaction `targetAuthor*`, group id/name, message text, and attachments are never consulted.
The gate reads the raw envelope fields itself rather than `resolveSignalSender`, which discards one of them.

**Canonicalization** is strict and never coerces:

- Number: the trimmed raw value must match `^\+[1-9]\d{6,14}$` exactly. `normalizeE164` is not used, so
  `"+1 (555) 000-0001"`, `"15550000001"`, and `"abc"` are all malformed rather than coerced.
- UUID: the trimmed raw value must match `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`
  and is lowercased before comparison. Compact 32-hex forms and `looksLikeUuid` heuristics are not accepted from
  envelopes.
- Store entries must already be canonical (lowercase UUID). The CLI accepts `signal:` and `uuid:` prefixes and
  uppercase UUIDs and canonicalizes them before writing. The loader never normalizes; a non-canonical entry makes
  the store invalid.

**Decision rule.** Let `N` be the envelope number and `U` the envelope uuid (each may be absent).

1. If neither field is present, **deny** (`no_identity`).
2. If any present field is malformed, **deny + flag** (`malformed_identity`), even if the other field is valid.
3. If any entry has a field equal to an envelope field and another field that differs (for example the entry
   binds `+A`/`u1` and the envelope says `+A`/`u2`), **deny + flag** (`identity_conflict`). A match on either
   field does not win when the other conflicts.
4. If some entry matches on at least one field present in both, with no conflicts, **allow**.
5. Otherwise, **deny + flag** (`not_trusted`).

This means a number-only entry trusts that number with any uuid, and a uuid-only entry trusts that uuid with any
number, or with none. Operators who want both fields bound record both.

### 4.4 Choke point and defense in depth (AR4, AR8)

**Primary gate.** In the returned handler in `event-handler.ts`, the gate runs immediately after envelope parse,
sender presence, the own-account drop, and the `syncMessage` drop, and before reaction detection. It applies to
every envelope kind: data, edit, reaction, story, receipt, and typing. When the gate denies, the handler returns
before all of the following run:

- `resolveSignalAccessState`,
- the reaction path,
- pairing,
- read receipts,
- attachment fetch,
- pending history,
- the debouncer, `recordInboundSession`, and `dispatchInboundMessage`.

The own-account and sync drops stay first, because they only drop and it avoids flagging the bot's own echoes.

**Groups.** The check is per sender. Group id, group name, group membership, `groupAllowFrom`, and
`groupPolicy: "open"` never confer trust. An untrusted sender in a trusted group is dropped, and their message
never enters pending history.

**Defense in depth.** On allow, the gate returns an opaque `SignalTrustedSender` value: a module-private brand
holding the canonical ids and the store generation. The final sinks take that value and re-verify it against the
current store snapshot before acting:

- `handleSignalInboundMessage`: the `SignalInboundEntry` gains a required `trusted` field, which is re-checked for
  every entry in a debounced batch.
- The reaction `enqueueSystemEvent` call.
- `recordPendingHistoryEntryIfEnabled`.

A future code path that reaches one of these sinks without going through the gate fails the type check. If the
store changed in between, for example a revocation, the re-check denies. Re-check denials are logged as
`recheck_denied`.

### 4.5 Enablement, fail-closed loading, and rollout (AR5, AR6)

**Switch.** The environment variable `OPENCLAW_SIGNAL_TRUST_GATE=enforce` controls the gate. The gateway reads it
once at monitor start, and the gate is off when it is unset. It is deliberately **not** an `openclaw.json` key,
so neither `/config set` nor `configWrites` nor any gateway config RPC can flip it. Changing it takes a service
environment edit and a gateway restart, both of which only the operator can do. When the gate is off, the handler
behaves exactly like today (no code path change beyond a no-op check). Enforcement is per process and applies to
every Signal account in that gateway.

**Fail closed.** While enforcing, any of the following means **deny every sender** for that account:

- the store is missing,
- it is not a regular file (checked with `lstat`, so symlinks are rejected),
- it is group- or world-writable, or on POSIX not owned by the process uid,
- it is unreadable, or has invalid JSON,
- it has the wrong `version` or an `accountId` mismatch,
- it has unknown keys, a wildcard, a non-canonical value, or a duplicate entry.

Each of these is logged at error level. The log fires once when the store's state changes, not once per event, so
a flood cannot amplify it. There is never a fallback to allowFrom, policy, or the pairing store. A valid store
with an empty `trusted` list is legal and denies everyone, with a startup warning.

**Reload and revocation.** Before each decision the gate calls `lstat` on the store. If dev, ino, mtime, and size
are unchanged, it uses the cached snapshot; otherwise it re-reads and re-validates. Writes are atomic renames and
change the inode, so a revocation takes effect on the **next inbound event**. That event pays one extra read and
there is no timer, so revocation latency is bounded by event arrival. A message already in the debouncer window
(1.5 s by default) is caught by the sink re-check in section 4.4.

**Writes** (CLI only): take the existing file lock (`src/infra/file-lock.ts`), write the temp file with mode 0600,
fsync it, rename it over the store, and ensure the `credentials/` directory is mode 0700.

**Upgrade and rollout.** Existing installs see no change until the operator sets the variable. The operator
rollout is:

1. Run `openclaw signal trust import-allowfrom` and/or `trust add` for each sender.
2. Run `openclaw signal trust list` to check the entries.
3. Set `OPENCLAW_SIGNAL_TRUST_GATE=enforce` in the service environment and restart the gateway.
4. Confirm the startup line `signal trust gate: enforcing (account=<id>, trusted=<n>, endpoint=loopback)`.

If the store is missing at step 3, all Signal ingress is dropped and the error says which command to run.

**Out of the gate's reach.** The switch and store protect against untrusted **senders**. They do not protect
against an agent that a trusted sender has given host shell access (for example exec tools), because that agent
runs as the gateway user and could edit the environment or the file. That is a separate trust decision about
tool policy.

### 4.6 Log and flag (AR7)

**Log.** Denials are logged through the runtime logger at warn level, which is never verbose-only:

`signal trust gate: denied account=<id> sender=<sender> reason=<code> kind=<dm|group|reaction|other> suppressed=<n>`

- `<sender>` is the canonical number and/or `uuid:<uuid>` when the field is well-formed. When it is malformed, the
  log records `malformed(len=<n>,sha256=<first 8 hex>)` and never the raw value.
- `sourceName`, message bodies, quote text, attachment names, group names, and raw group ids are never logged.
  When relevant, the group is recorded as `group=sha256:<first 8 hex>`.
- Because every logged value is canonical or a hash, no control characters or newlines can reach the log.

**Rate limiting.** The first denial for each (account, sender key) is logged immediately. Later ones within a
10-minute window are counted and reported in `suppressed=` on the next line after the window closes. The
coalescing map is an LRU capped at 1024 keys. On top of that there is a global cap of 30 denial lines per minute;
overflow is counted and reported in one summary line.

**Flag.** The flag is a JSONL record appended to `$OPENCLAW_STATE_DIR/security/signal-trust-attempts.jsonl`
(file 0600, directory 0700), with the same coalescing as the log:

```json
{
  "ts": "2026-01-01T00:00:00Z",
  "accountId": "default",
  "number": "+15550000009",
  "uuid": null,
  "reason": "not_trusted",
  "kind": "dm",
  "group": null,
  "count": 1
}
```

The file is capped at 1 MiB and rotates to `.1` with one backup, so it is bounded at 2 MiB. Write failures are
logged once and never turn a deny into an allow. `openclaw signal trust attempts [--account <id>] [--limit <n>]`
reads it. The flag is **never** delivered as a system event, a chat message, or anything else agent-visible.

Privacy note: the attempt file holds phone numbers and uuids of people who messaged the bot. The operator needs
them to grant trust. The file stays on the gateway host with mode 0600, is never transmitted, and holds no message
content.

### 4.7 Modules (minimal footprint)

- `src/signal/trust/identity.ts`: strict canonicalization and the decision rule (pure).
- `src/signal/trust/store.ts`: path resolution, `lstat`-keyed snapshot cache, fail-closed validation, atomic
  0600 write.
- `src/signal/trust/gate.ts`: `createSignalTrustGate({ accountId, env, runtime })` returns `evaluate(envelope)`
  and `recheck(trusted)`, plus the branded type.
- `src/signal/trust/attempts.ts`: coalescing, rate limiting, and the bounded JSONL flag file.
- `src/cli/signal-trust-cli.ts`: `add`, `remove`, `list`, `import-allowfrom`, `attempts`, and `status`.
- Wiring: `monitor.ts` creates the gate and passes it through `SignalEventHandlerDeps`, and `event-handler.ts`
  runs it at the choke point and the three sinks. `access-policy.ts`, `dm-policy-shared.ts`, and
  `pairing-store.ts` are unchanged.
- Docs: a "Trust gate" section in `docs/channels/signal.md`.

## 5. Test plan (AR8)

All values in tests and fixtures are synthetic (`+1555000xxxx` numbers, made-up uuids). Every store and attempt
file lives in a temp state dir.

1. **Identity (pure):** the E.164 regex accepts and rejects the right values. Formatted, bare-digit, `"+"`, and
   control-character numbers are malformed. UUID case and hyphen variants: an uppercase envelope UUID matches a
   lowercase entry, and compact form is malformed. The CLI canonicalizes `signal:` and `uuid:` prefixes. The
   decision rule covers `no_identity`, `malformed_identity` (including valid uuid plus garbage number),
   `identity_conflict` (number matches, uuid differs, and the reverse), number-only and uuid-only entries, and
   `not_trusted`.
2. **Store failure modes:** missing, empty file, corrupt JSON, wrong version, account mismatch, unknown key, `"*"`,
   non-canonical entry, duplicate, symlink, and group- or world-writable mode all deny everyone and log one error
   per state change. An empty `trusted` list denies everyone. Revocation: `remove` followed by the next event
   denies. The atomic write leaves mode 0600.
3. **Choke point (event-handler harness):** for untrusted DMs, group messages, reactions, edits, mention-skip group
   messages, and messages with attachments, assert **zero** calls to `resolveSignalAccessState`,
   `sendMessageSignal` (no pairing code), `sendReadReceiptSignal`, `fetchAttachment`,
   `recordPendingHistoryEntryIfEnabled`, `enqueueSystemEvent`, `recordInboundSession`, and
   `dispatchInboundMessage`. Assert one flag record and one warn log.
4. **AND composition:** `dmPolicy: "open"` plus `allowFrom: ["*"]`, `groupPolicy: "open"`, a sender in
   `groupAllowFrom`, and a sender in the pairing store are all still denied when not trusted. A trusted sender
   under `dmPolicy: "pairing"` who is not yet in allowFrom still gets today's pairing behavior.
5. **Spoof vectors:** `sourceName` equal to a trusted contact's name; a quote author or mention naming a trusted
   uuid; message text claiming a trusted number; a reaction `targetAuthor` equal to a trusted id. All are denied.
6. **Defense in depth:** a message is enqueued in the debouncer, trust is then revoked, and the flush is dropped
   with `recheck_denied`. Calling the sinks without a `SignalTrustedSender` value is a compile error, checked with
   a `// @ts-expect-error` fixture.
7. **Positive path:** a trusted sender (number, uuid, or both bound) reaches `dispatchInboundMessage` with
   unchanged context fields. With the gate off, existing Signal tests pass unmodified.
8. **Log and flag bounds:** 10,000 denials from one sender produce one line plus a coalesced summary; many distinct
   senders are capped at 30 lines per minute plus an overflow summary. The attempt file never exceeds 2 MiB. A
   malformed sender is recorded only as a hash. No record contains a body or `sourceName`.
9. **Switch:** the variable unset means no gate. `enforce` means the gate is on. A `/config set` of any
   `channels.signal.*` key cannot turn it off.

## 6. Finding map

| Finding                        | Resolved in                                                                                                                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AR1 pairing contradiction      | 4.1 (operator-only grants; no pairing replies to untrusted senders)                                                                                                           |
| AR2 store identity and writers | 4.2 (new per-account file, schema, full writer list, one-shot import only, no `"*"`)                                                                                          |
| AR3 spoof model                | 4.3 (daemon trust boundary, strict canonicalization, conflict rule, named vectors) and 5.1, 5.5                                                                               |
| AR4 sinks and re-check         | 2 (sinks enumerated) and 4.4 (choke point before reactions; branded re-check at three sinks)                                                                                  |
| AR5 fail closed                | 4.5 (deny-all cases, `lstat`/perms, atomic 0600, `lstat`-keyed reload, revocation latency)                                                                                    |
| AR6 switch and rollout         | 4.5 (env switch outside the config-write path, upgrade no-op, rollout steps)                                                                                                  |
| AR7 log and flag               | 4.6 (warn-level log, sanitization, coalescing and caps, bounded JSONL flag, no agent-visible flag)                                                                            |
| AR8 groups, scope, tests       | 1, 4.4, and 5                                                                                                                                                                 |
| P1/P2 commit identity          | The revision is committed as `Claude <claude@local>` through per-command git identity, and the earlier commit with the wrong author was replaced before push (see build log). |
