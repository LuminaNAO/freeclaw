# Teleport

Move the OpenClaw gateway to a remote machine while keeping inference on the origin (home) machine. One place at a time — not two gateways, not concurrent writes.

## Architecture

```
┌─────────────────────┐         ┌──────────────────────┐
│   HOME (Framework)   │         │   REMOTE (Laptop)     │
│                      │         │                        │
│  llama.cpp :40801 ◄──┼────────┼──→ localhost:40801    │
│  (always running)    │    SSH │  (tunnel endpoint)    │
│                      │  tunnel│                        │
│  .openclaw/workspace ┼───────►│  .openclaw/workspace  │
│  (origin of truth)   │  SSHFS │  (mounted read/write) │
│                      │        │                        │
│  gateway: STOPPED ◄──┤        │  gateway: RUNNING      │
│                      │        │                        │
│  Signal: ACTIVE      │        │  Channels via home     │
└─────────────────────┘         └──────────────────────┘
```

Three components, two locations:

| Component | Home            | Remote         |
| --------- | --------------- | -------------- |
| Inference | Always running  | Tunnel to home |
| Workspace | Origin of truth | SSHFS mount    |
| Gateway   | Stopped         | Running        |

## Prerequisites

- SSH access from remote → home (key-based, no password)
- `sshfs` installed on remote machine
- OpenClaw installed on remote machine
- Same workspace git repo cloned on remote (as fallback/local copy)
- Home machine reachable (LAN, Tailscale, or public IP)

## Teleport To (Home → Remote)

Run these on the **remote** machine:

### 1. SSH Tunnel (inference)

```bash
ssh -N -L 40801:localhost:40801 home-user@home-host &
TUNNEL_PID=$!
```

Maps `localhost:40801` on remote → `localhost:40801` on home.

### 2. SSHFS Mount (workspace)

```bash
mkdir -p ~/.openclaw/workspace
sshfs home-user@home-host:<home-user-home>/.openclaw/workspace \
    ~/.openclaw/workspace \
    -o allow_other,reconnect
```

Mounts home's workspace at `~/.openclaw/workspace` on remote.

### 3. Stop home gateway (optional but recommended)

```bash
ssh home-user@home-host "openclaw gateway stop"
```

Prevents dual-gateway conflicts. Skip if home gateway is already stopped.

### 4. Start remote gateway

```bash
# Point provider to local tunnel endpoint
openclaw config set models.providers.llama.cpp.baseUrl "http://localhost:40801"

openclaw gateway start
```

Gateway runs locally on remote, inference routes through tunnel to home.

### 5. Verify

```bash
openclaw health
# Should show gateway running, model reachable
```

## Teleport Back (Remote → Home)

Run on the **remote** machine:

### 1. Stop remote gateway

```bash
openclaw gateway stop
```

### 2. Unmount workspace

```bash
fusermount -u ~/.openclaw/workspace 2>/dev/null || \
    umount ~/.openclaw/workspace 2>/dev/null
```

### 3. Kill SSH tunnel

```bash
kill $TUNNEL_PID 2>/dev/null
# Or: pkill -f "ssh -N -L 40801"
```

### 4. Start home gateway

```bash
ssh home-user@home-host "openclaw gateway start"
```

## Scripts

Helper scripts for one-command teleport:

- `scripts/teleport-to.sh <home-host>` — run on remote, teleports to remote
- `scripts/teleport-back.sh <home-host>` — run on remote, teleports back to home

See `scripts/teleport-to.sh` and `scripts/teleport-back.sh`.

## Channel Routing

**Channels (Signal, Telegram, etc.) stay on home.** The gateway on remote can reach them via home if needed, but the simplest approach:

- While teleported: use TUI or local webchat on remote for interaction
- Channels continue working on home gateway if you choose not to stop it
- If home gateway is stopped: channels are unavailable until teleport back

Future: remote gateway connects to home as a node host for channel relay.

## Safety Rules

1. **One gateway at a time.** Never run both simultaneously — race conditions on `sessions.json`, memory files, cron state.
2. **Workspace is write-through via SSHFS.** All changes persist to home immediately. No sync step needed on return.
3. **Inference never stops.** The llama.cpp server on home stays running throughout. Only the gateway moves.
4. **Clean exit.** Always run `teleport-back` or manual cleanup. Don't just walk away with SSHFS mounted.
5. **SSHFS is not for concurrent writers.** If home gateway is accidentally started while SSHFS is mounted, stop it immediately.

## Phase 2: Bidirectional Tunnel

If the remote machine is behind NAT/firewall and home can't reach it:

- Reverse SSH tunnel from remote → home for management
- Home can remotely trigger `teleport-back` via the reverse tunnel
- Or: Tailscale magic DNS handles reachability both ways

## Phase 3: Automatic Failover

- Health check: if home gateway dies, auto-teleport to paired remote
- Cron job on home monitors gateway, triggers teleport script on remote via reverse tunnel
- Manual approval gate before any auto-teleport

## Config Notes

The remote machine needs a minimal `config.yaml` or env override:

```yaml
models:
  providers:
    llama.cpp:
      baseUrl: "http://localhost:40801" # tunnel endpoint
```

Everything else (workspace, memory, identity) comes from the SSHFS mount.

## Troubleshooting

| Problem                       | Fix                                             |
| ----------------------------- | ----------------------------------------------- |
| Tunnel drops                  | Add `ServerAliveInterval 30` to SSH config      |
| SSHFS stale files             | Remount with `-o reconnect`                     |
| Model unreachable             | Check `ss -tlnp \| grep 40801` on both machines |
| Gateway won't start on remote | Check `~/.openclaw/workspace` mount is active   |
| Permission denied on mount    | Add `-o allow_other` to sshfs                   |
