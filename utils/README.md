# openclaw-helpers

Helper scripts for building, configuring, and operating local FreeClaw (OpenClaw fork) installs.

## Scripts

### `build-switch.sh`

Builds a branch of `~/code/freeclaw` and installs it as a shell command + systemd user service.

```bash
./build-switch.sh                    # Interactive branch picker
./build-switch.sh <branch>           # Build any local branch (e.g. freeclaw, freeclaw-dev)
./build-switch.sh status             # Show current build + gateway status
./build-switch.sh <branch> <agent>   # Isolated install under ~/.<agent>, <agent>-gateway.service
```

Branch selection is dynamic — any local branch works. Run with no args to see what's available.

Version strings are derived from the branch: `main/master` → vanilla, `freeclaw` → `f<version>`, `freeclaw-*` → `f<version>-<suffix>`, anything else → `<version>-<branch>`.

After a successful build run `llamacpp-init.sh` to wire up the local inference server.

### `llamacpp-init.sh`

Configures an OpenClaw install to use a local llama.cpp server. Auto-detects model ID and reasoning format from the running server on port 40801. If Signal is configured with a local `signal-cli` HTTP endpoint, rewrites it to an owned auto-start daemon on a free local port instead of attaching to a shared `127.0.0.1:8080` listener.

```bash
./llamacpp-init.sh                # Configure default install (~/.openclaw)
./llamacpp-init.sh <agent>        # Configure an isolated agent install
./llamacpp-init.sh --force        # Overwrite existing non-llama.cpp config
GATEWAY_BIND=loopback ./llamacpp-init.sh  # Non-interactive gateway access: local machine only
GATEWAY_BIND=lan ./llamacpp-init.sh       # Non-interactive gateway access: any LAN machine
GATEWAY_PASSWORD="use-a-long-password" GATEWAY_BIND=lan ./llamacpp-init.sh
```

FreeClaw gateway ports are assigned from `40701-40798`; `40801` remains the default llama.cpp port. Init enables native gateway HTTPS with an auto-generated certificate and writes `https://...` Control UI origins for the selected access mode. Device pairing is disabled for the Control UI. When LAN access is selected, init allows any browser origin but configures `gateway.auth.mode=token-password`; localhost can still use token auth, while non-localhost access must provide both the gateway token and gateway password. LAN access also requires the host firewall to allow the local service range, e.g. `sudo ufw allow from <your-network>/24 to any port 40700:40900 proto tcp`.

### `diagnose-gateway-hang.sh`

Triage script for a stuck or unresponsive OpenClaw gateway: checks binary, ports, state files, locks, sockets, disk/memory, and environment overrides.

### `freeclaw_heartbeat_toggle.sh`

Durably enables/disables OpenClaw agent heartbeats by editing `openclaw.json` directly, then attempts the runtime gateway toggle with a bounded timeout. Use this instead of relying only on `openclaw system heartbeat disable`, which can be runtime-only.

```bash
./freeclaw_heartbeat_toggle.sh status
./freeclaw_heartbeat_toggle.sh disable
./freeclaw_heartbeat_toggle.sh enable --every 30m
./freeclaw_heartbeat_toggle.sh disable --no-runtime  # config-only, no gateway RPC
```

### `rustyclaw-driver.sh`

Watchdog driver that feeds tasks to an OpenClaw session and monitors llama.cpp logs for failures. Used for long unattended runs.

### `signal-group-toggle.sh`

Interactive TUI for toggling which Signal groups OpenClaw subscribes to in `~/.openclaw/openclaw.json`.

### `signal-group-memory.sh`

Syncs Signal group membership into per-group memory directories under an OpenClaw workspace. Generates:

- `group-memory/signal/<group-id>/meta.json` — group metadata (name, description, status)
- `group-memory/signal/<group-id>/members.json` — uuid-keyed member roster
- `group-memory/signal/<group-id>/history.md` — narrative (stubbed only if missing)
- `group-memory/signal/index.json` — chat_id → path index for agent lookups

```bash
./signal-group-memory.sh <workspace>              # Refresh dump + sync
./signal-group-memory.sh <workspace> --no-refresh # Sync from existing dump
./signal-group-memory.sh <workspace> --dry-run    # Preview without writing
```

### `signal-identity-diff.sh`

Diffs the current Signal identity dump against the previous one. Run by `signal-group-memory.sh` automatically. Outputs joined/left/changed counts.

### `trustgraph-build.sh`

Builds and updates Lumina's L3 Trust Graph (`trustgraph.yaml`) from the Signal identity dump. Designed to run during the sleep cycle (Stage 2: The Scholar), not during active sessions — zero context cost to working sessions.

```bash
./trustgraph-build.sh <workspace>              # Build from default dump
./trustgraph-build.sh <workspace> --dry-run    # Preview without writing
```

**Purpose:** Long-term social memory tracking every person Lumina interacts with — their nature, trust level (0–5), preferences, expertise, and key interaction history.

**Schema:** YAML keyed on Signal UUID (`uuid:xxxx`). Non-destructive merges — never overwrites known fields with null. Groups membership is NOT stored (derived on demand from the signal dump).

**Trust scale:** 0=unknown, 1=introduced, 2=brief, 3=working, 4=demonstrated, 5=deep trust.

See `trustgraph.yaml` in the workspace for the full schema documentation.

## Typical Workflow

```bash
# 1. Build & install a branch
./build-switch.sh freeclaw-dev

# 2. Wire up llama.cpp
./llamacpp-init.sh

# 3. Check it's running
./build-switch.sh status
```
