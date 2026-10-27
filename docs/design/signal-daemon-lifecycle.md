---
summary: "signal-cli daemon lifecycle: never orphaned, adopted or reaped on start (ARCH, operator-owned)"
title: "Signal daemon lifecycle"
---

# Signal daemon lifecycle — ARCH (operator)

Owned by the operator; engineers never edit this file. Every commit names the section it implements.

## 1. Problem (seen three times in production)
When the gateway process dies or is restarted (OOM crash, SIGTERM, systemd restart), the signal-cli daemon it spawned
keeps running and keeps holding the account's unix socket. The new gateway then refuses to start Signal
("another signal-cli is serving <socket>; refusing to start a second daemon"), retries 10 times and gives up:
Signal is dead until a human kills the orphan. Causes found:
1. Installed systemd units carry `KillMode=process` (old installs), so stopping the service kills only the gateway,
   not its children. The generator now writes `KillMode=control-group`, but existing unit files were never updated.
2. The daemon is spawned as a normal child with no tie to the gateway's life: if the gateway dies hard (OOM,
   SIGKILL), nothing stops it.
3. On start, a live socket is treated only as "someone else's daemon" with no way to tell ours from a stranger's.

## 2. Goals
- A gateway restart or crash never leaves Signal down. Worst case it recovers by itself within one restart cycle.
- Never kill a daemon that is not ours (another agent's signal-cli on the same host, or one a human started).
- No new dependencies; Linux first (the only production OS), other OSes keep today's behaviour.

## 3. Design
1. **Ownership record.** When the gateway spawns signal-cli it writes `<socket>.owner.json` next to the socket
   (0600, temp+rename): `{ pid, startTime (from /proc/<pid>/stat field 22), account, socketPath, gatewayPid,
   stateDir, cliPath }`. Removed on clean daemon exit.
2. **Die with the parent.** The spawned signal-cli must not outlive the gateway:
   - On Linux, spawn it through a tiny wrapper that sets `PR_SET_PDEATHSIG=SIGTERM` for the child, OR (if a
     dependency-free way is not available from node) the gateway installs handlers for SIGTERM/SIGINT/
     `beforeExit`/`exit` that stop the daemon, and section 3.3 covers the hard-kill case. Pick the simplest one that
     works without a native module; record the choice in the ARCH-referencing commit message.
3. **Adopt-or-reap on start** (replaces the bare refusal in `clearStaleSignalSocket` when the socket is live):
   - Read `<socket>.owner.json`. If the recorded pid is alive AND its `/proc/<pid>/stat` start time matches AND its
     cmdline is signal-cli for the same account AND it runs as the same uid: it is **our orphan**.
   - Our orphan: send SIGTERM, wait up to 10 s for exit and for the socket to stop accepting, then SIGKILL if still
     alive; remove the socket and the owner file; log one line `signal: reaped orphaned signal-cli pid <n>
     (previous gateway <gatewayPid>)`; then start a fresh daemon as normal. (Reap, not adopt: a fresh daemon is
     simpler and keeps one code path.)
   - No owner file, or it does not match: keep today's refusal (never touch someone else's daemon), but make the
     error actionable: name the pid(s) holding the socket (from /proc/net/unix inode -> /proc/*/fd), their uid
     and cmdline, and the exact command to stop it.
4. **systemd unit migration.** `openclaw doctor` reports an installed gateway unit with `KillMode` other than
   `control-group` as a problem, and `openclaw doctor --fix` (and gateway install/update) rewrites it to
   `KillMode=control-group` and runs `daemon-reload`. Drop-in files are respected (a drop-in that sets KillMode is
   reported, not edited).
5. **Retry behaviour.** When the socket is held by a foreign daemon the channel retries as today; when an orphan
   was reaped, the start proceeds immediately (no backoff burned).

## 4. Tests
- Owner file written on spawn, removed on clean exit; atomic and 0600.
- Start with a live socket + matching owner (fake process table) -> SIGTERM, wait, socket cleared, new daemon spawned.
- Orphan ignores SIGTERM -> SIGKILL after the grace.
- Owner file present but pid reused by another program (start time or cmdline mismatch) -> refused, not killed.
- Owner file present but different uid or account -> refused, not killed.
- No owner file + live socket -> refused with the holder's pid/uid/cmdline in the message.
- Gateway shutdown path stops the daemon (SIGTERM handlers / pdeathsig wrapper), including a simulated hard
  exit of the parent process in an integration test that spawns a real child (a stub process, not signal-cli).
- doctor: KillMode=process unit flagged; --fix rewrites to control-group; drop-in reported, not edited.
- Existing socket-dir tests stay green.

## 5. Acceptance
Touched suites green, `pnpm build` green. Live check on the dev gateway: `kill -9` the gateway process; the
supervisor (or a manual start) brings it back and Signal is up within one restart cycle with no human action; the
log shows the reap line.
