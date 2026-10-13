# Signal identity is the UUID — ARCH v1

Status: operator-owned. Engineers never edit it; commits name the section.

## 1. Rule

A Signal person is their **ACI UUID**. The phone number is optional, often hidden, can be reassigned, and must not
become anyone's identity anywhere in freeclaw: sender ids, session keys, agent-visible metadata, allow-list writes,
pairing lines, logs that name a sender.

## 2. Sender resolution (`src/signal/identity.ts`)

1. `resolveSignalSender(envelope)` returns `{ kind: "uuid", raw: <uuid>, e164?: <number> }` whenever `sourceUuid` is
   present, **even if `sourceNumber` is also present**. `e164` is kept only as a secondary match key (§3) and is never
   used as the id. `{ kind: "phone", ... }` is returned only when the envelope has no UUID at all.
2. `formatSignalSenderId`, `formatSignalSenderDisplay`, `resolveSignalPeerId` → `uuid:<uuid>` for uuid senders.
   `resolveSignalRecipient` → the uuid (signal-cli accepts it as a recipient).
3. `formatSignalPairingIdLine` → the uuid line for uuid senders; never prints the number.
4. Group-invite inviter labels and every other sender label use `uuid:<uuid>`.
5. Own-message detection matches either the account uuid or the account number (unchanged behaviour, both forms).

## 3. Allow lists and trust (no lock-outs)

1. `isSignalSenderAllowed`: a `uuid:` entry matches the sender uuid; a phone entry still matches the sender's
   secondary `e164` when Signal supplied one (back-compat for existing configs). `*` unchanged.
2. When a phone entry is what let a sender in, log once per (entry, account) at warn:
   `signal allowFrom entry <masked number> matched uuid:<uuid> — replace it with the uuid`. Never rewrite config.
3. Anything freeclaw **writes** (pairing approvals, `signal trust add`, link helper, group-memory `meta.json`
   members) stores `uuid:<uuid>` only. Group-memory members already recorded as numbers are converted to the uuid
   on the next message from that member (uuid known then); unknown numbers are left as they are.

## 4. Session continuity (DMs)

DM session keys are built from the peer id, so a sender who used to resolve by number had
`…:signal:direct:+61…`. After this change the same person resolves to `…:signal:direct:uuid:<uuid>`.

1. On an inbound DM from a uuid sender with a secondary `e164`: if no session exists under the uuid key but one
   exists under the phone key, the store entry is **re-keyed** to the uuid key (same sessionId/transcript, same
   overrides) in one store write, and a one-line notice is logged. Never two live sessions for one person.
2. If both keys exist, the uuid key wins; the phone-keyed entry is left untouched (operator decides).
3. Outbound to a configured phone recipient still works; its session key is the phone form until that person sends
   inbound once (then §4.1 applies).

## 5. Tests

uuid+number envelope → uuid sender with e164 secondary; number-only envelope → phone sender; uuid-only → uuid;
allow list with phone entry still admits the uuid sender (and warns once), uuid entry admits, mismatched denies;
pairing line never contains the number; DM re-key: phone-keyed session moves to uuid key keeping sessionId and
overrides; both-exist case leaves phone entry; group-memory members converted; own-message detection both forms;
inviter label uuid. Existing signal suites green.

## 6. Hygiene

No real numbers or uuids in fixtures (placeholders). Org identity, no trailers. Nobody pushes.
