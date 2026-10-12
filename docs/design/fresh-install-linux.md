# Fresh install: Signal and group memory work out of the box (Linux first) — ARCH

Owned by the operator; engineers do not edit it. Each commit names the section it implements. A real conflict with
the code is `BLOCKED`, not resolved in code. Builds on `docs/design/signal-link-helper.md` and
`docs/design/group-memory.md` (both on this branch, both operator-owned).

## 0. Goal and philosophy

**Linux first.** Other operating systems must keep working where they work today, but nothing is designed or
tested for them in this task. On Linux, one path must hold: fresh install → onboarding → link Signal → the agent
answers in a Signal group, with group memory working, and Signal on the unix socket transport. No hand edits.

## 1. Signal on a fresh install

1. **Socket by default on Linux.** Onboarding and `signal link --write-config` write config that resolves to the
   socket transport (no `httpPort`, `httpUrl` or `transport: "http"` written, ever). Verify the gateway starts the
   daemon with `--socket` at the documented default path, dir 0700, socket 0600. If any code path on Linux still
   ends up on HTTP for a fresh config, fix it.
2. **signal-cli install:** onboarding installs the latest signal-cli release (existing `signal-install`), and refuses
   a known-bad version: minimum version constant `0.14.9` (0.14.5 fails linking with "network failed" on current
   phones — observed live). `signal link` preflight warns and stops if the found signal-cli is below the minimum,
   naming the fix (`openclaw channels add signal` reinstalls, or set `channels.signal.cliPath`).
3. **Link from onboarding:** where onboarding today prints "Link device with: signal-cli link …", it runs the link
   helper instead (QR in the terminal, PNG, auto-renew, verify, write config). Registration by SMS stays manual.
4. **Linked-device group invites:** a group invite addressed to the account's phone number cannot be accepted by a
   linked signal-cli device ("Cannot find service ID for self", observed live). After a successful link, the helper
   records the account's ACI (uuid) and prints it with the hint "invite this agent to groups by its uuid". The
   gateway, on start, accepts pending group invites addressed to its own ACI automatically, but only for groups
   whose inviter is allowed by `groupAllowFrom` (the existing access policy decides; invites from anyone else stay
   pending and are logged).
5. **Group-first default:** onboarding asks "Allow direct messages?" default **No** → `dmPolicy: "disabled"`,
   `groupPolicy: "allowlist"`, and the operator's own Signal id (asked once, uuid or number) goes into
   `groupAllowFrom`. Nothing else is opened.

## 2. Group memory on a fresh install

Group memory (group-memory ARCH) is enabled by default and needs no setup: a fresh workspace has no `group-memory/`
folder; it appears the first time a group message arrives. The default workspace template carries the §4 lines of
the group-memory ARCH. Implement the group-memory ARCH in full as part of this task.

## 3. Acceptance (Linux, on a throwaway user/state dir)

1. Fresh state dir → `openclaw onboard` non-interactive path (or the equivalent `config set` + `channels add
signal` sequence) with a fake signal-cli for CI: config has no HTTP keys; the gateway would start the daemon on a
   socket (assert the built args and the resolved transport).
2. signal-cli below 0.14.9 is refused with the fix named.
3. Pending group invite to own ACI from an allowed inviter is accepted on start; from a non-allowed inviter is not.
4. Group memory: first group message creates `meta.json`; the group session prompt contains the Group memory block;
   a DM session (if enabled) does not; group A never sees group B.
5. The real end-to-end run is done by the operator on a dedicated test agent (testclaw128) after DONE: fresh
   install, link, group message, memory file appears. Not part of the swarm's test (no real phone).
6. Touched suites green; full unit lane no new failures vs origin/supermaster.
