---
summary: "Per-agent Signal daemon isolation: socket default, migration from HTTP, and the conformance check"
read_when:
  - Hosting several agents with Signal on one machine
  - Upgrading a Signal setup from HTTP to the socket transport
  - Auditing a host for exposed signal-cli daemons
title: "Signal daemon isolation"
---

# Signal daemon isolation

The `signal-cli` daemon has no authentication. On its HTTP transport, any local user who can reach the port can read the account's incoming messages and send as it. OpenClaw therefore runs `signal-cli` on a unix socket by default, so file permissions limit access to the gateway's OS user.

Setup and config keys: [Signal](/channels/signal#transport-socket-default).

## Threat model

Protected: other local, unprivileged users. They cannot reach a socket-mode account's daemon, because its directory is `0700` and owned by the gateway user, and the daemon has no TCP port.

Not protected:

- root, or any process holding `CAP_DAC_OVERRIDE`.
- Other processes running as the same OS user. That includes every Signal account served by one gateway, and any tool the agent runs as that user. Isolation is per user, so to isolate agents, run one gateway per OS user.
- Members of `channels.signal.socketGroup`, which is a deliberate grant.
- Accounts kept on HTTP (`transport: "http"`, `httpUrl`, `httpEndpointFile`, `archiveRaw`).

## Upgrading

Accounts whose daemon OpenClaw starts move to the socket on the first gateway restart after the upgrade. Any saved `httpPort` is ignored, with a log line.

Accounts with an external daemon (`httpUrl`, `httpEndpointFile`, `archiveRaw`, or `autoStart: false` without `socketPath`) keep HTTP. Nothing changes for them.

Anything outside OpenClaw that used the old HTTP port stops working after the flip. That includes scripts, monitoring, archive tools, relays and bridges, and plugins that store their own `httpUrl` or port for the daemon. OpenClaw keeps no list of these consumers, so you have to find them yourself before you upgrade (see the preflight below). Move each one to the socket (same OS user, or `socketGroup`), or keep the account on HTTP with `channels.signal.transport: "http"`.

## Cutover: managed account (HTTP to socket)

1. Preflight:
   - `openclaw channels status --probe` is green.
   - Note the daemon's port: `ss -ltnp | grep -i java`.
   - Find other consumers of that port: `ss -tnp | grep :<port>` for clients other than the gateway. Also search the host's config, plugin, script and service files for the port and for `httpUrl`. Confirm the list with whoever runs the host.
2. Optional: pin the path with `openclaw config set channels.signal.socketPath <absolute path>`.
3. Restart the gateway. The HTTP daemon stops before the socket daemon starts, so the two never listen at the same time.
4. Verify:
   - `ss -ltnp` shows no `signal-cli`/java TCP listener.
   - `ls -ld <dir> <dir>/<account>.sock` shows `drwx------` and `srw-------`, owned by the gateway user.
   - `openclaw channels status --probe` is green and reports `unix:/...`.
   - Send a test DM in both directions.
   - `node scripts/signal-isolation-check.mjs` passes.
5. Messages sent during the restart are queued on the Signal server. They are delivered once the gateway subscribes again, because the daemon always runs in manual receive mode.

Rollback: `openclaw config set channels.signal.transport http`, then restart the gateway.

Downgrading to a release from before the socket transport: older releases reject the `transport`, `socketPath` and `socketGroup` keys as unknown config, so remove them (and switch the account back to HTTP) before downgrading.

## Cutover: external socket daemon behind an HTTP bridge

If `signal-cli` already runs in socket mode under your own service manager, and something re-exposes it over HTTP for the gateway, the daemon can stay as it is:

1. Preflight: `openclaw channels status --probe` is green through the bridge, and the socket's directory is `drwx------`, owned by the gateway user.
2. Configure the account with `socketPath: "<the daemon's --socket path>"` and `autoStart: false`, and remove `httpUrl`. Keeping both is a config error by design.
3. Restart the gateway. It now talks to the socket directly.
4. Verify as above, then stop and disable the bridge. `ss -ltnp` should no longer show its port.

Rollback: restore `httpUrl`, remove `socketPath`, restart the gateway, and start the bridge again. The daemon is never restarted in either direction.

Recommended afterwards: give the daemon a per-account socket path instead of signal-cli's default `$XDG_RUNTIME_DIR/signal-cli/socket`, or let OpenClaw manage it by dropping `autoStart: false`.

## Gateway restarts and crashes

- Gateway stop: the daemon gets SIGTERM and removes its socket.
- Daemon crash: the gateway restarts the channel with backoff. The stale socket is detected (connection refused) and removed before the new daemon starts.
- Gateway SIGKILL under the installed systemd unit: the daemon is killed too. Without systemd an orphaned daemon can keep serving. The next start then refuses to run a second daemon on the same socket instead of double-serving. Stop the orphan (`pgrep -af signal-cli`) and restart.
- Config reload: a change under `channels.signal` stops the account before starting it again.

## Conformance check

`scripts/signal-isolation-check.mjs` is read-only. It never changes anything on the host.

Requirements:

- Linux with procfs.
- Node 22+.
- iproute2 `ss` that supports `-x -H` and prints the peer inode column for unix sockets (verified on iproute2 7.2.0). With an older or missing `ss`, the relay check (C5) reports UNKNOWN.

Run it as root for a full-host verdict. As an unprivileged user, it reports other users' processes as UNKNOWN.

```bash
sudo node scripts/signal-isolation-check.mjs
sudo node scripts/signal-isolation-check.mjs --manifest /etc/openclaw/signal-agents.json --json
```

What it checks, per discovered `signal-cli daemon` process:

| Check | Fails when                                                                                                                                                                                                                                                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1    | The daemon holds a TCP listener, or has `--http`/`--tcp` in its arguments.                                                                                                                                                                                                                        |
| C2    | It has no filesystem unix socket (abstract sockets fail); the socket or its directory is not owned by the daemon's user; the socket has group or other bits (group allowed with `--allow-group`, optionally pinned with `--group <gid>`); or the directory is other-accessible or group-writable. |
| C3    | The daemon has no `-a` account (multi-account mode), two daemons serve one account, or the `--manifest` does not match.                                                                                                                                                                           |
| C4    | Warning only: the daemon is not in `--receive-mode manual`.                                                                                                                                                                                                                                       |
| C5    | Any process on the host, whatever program it runs, is connected to a `signal-cli` socket and also holds a TCP listener. That is a relay that re-opens the hole. It is reported with pid, user and command line.                                                                                   |

C5 counts TCP sockets in any state, and judges processes with the same user and identical command line together. That catches a forking relay whose parent holds the listener while a child holds the socket connection, and a relay handed an accepted connection by a socket-activation manager. A relay with no TCP socket of its own, whose listener sits in a differently named process, is not linked.

For C5, a same-user OpenClaw gateway (a legitimate socket client that serves its own port) is reported as a `gateway-client` warning, not a failure. C5 is a point-in-time check. A PASS means no relay was seen holding a connection to a daemon at that moment, not that no relay exists: an idle relay with no client connected has no connection to the daemon and cannot be seen. C1, the manifest and repeated runs remain the primary guard.

Manifest format (one entry per agent account):

```json
{
  "agents": [
    {
      "uid": 1001,
      "account": "+15550001111",
      "socketPath": "/run/user/1001/openclaw-signal/default.sock"
    }
  ]
}
```

Exit codes:

| Code | Meaning                                                                                                                       |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- |
| 0    | PASS                                                                                                                          |
| 1    | FAIL                                                                                                                          |
| 2    | Usage or platform error                                                                                                       |
| 3    | UNKNOWN: a check could not finish (unreadable process, missing `ss`) or there was nothing to check. Never treat it as a pass. |
| 4    | PASS with waivers: only accounts waived with `--allow-http <account>` failed C1.                                              |

An account kept on HTTP on purpose shows as a C1 failure until you waive it with `--allow-http`, so legacy exposure stays visible.
