# Teleport — Human Quick Start

Move your OpenClaw gateway to another machine (laptop, cafe, etc.) while keeping inference on your home machine.

From your perspective:

- You run one command on the machine you want Lucy to “live” on.
- You use OpenClaw from there (TUI / webchat).
- You run one command to come back.
- Your workspace stays on the home machine; nothing duplicated.

Scripts are located at:

- scripts/teleport-to.sh
- scripts/teleport-back.sh

Run them from this directory or adjust the path accordingly.

## Prerequisites (do this once)

On the remote machine:

- SSH key login to your home machine (no password prompts).
- `sshfs` installed.
- OpenClaw installed.

Example:

- `ssh lumina@framed` works without a password.

On the home machine:

- OpenClaw workspace exists at `~/.openclaw/workspace`.

## Teleport To (Home → Remote)

On the remote machine:

1. Run:
   - `./teleport-to.sh lumina@framed`
2. You’ll see:
   - Stopping home gateway
   - Starting SSH tunnel
   - Mounting workspace
   - Starting local gateway
3. If it succeeds:
   - Use OpenClaw from this machine (TUI / webchat).

## Teleport Back (Remote → Home)

On the remote machine:

1. Run:
   - `./teleport-back.sh lumina@framed`
2. You’ll see:
   - Stopping local gateway
   - Unmounting workspace
   - Killing tunnel
   - Starting home gateway

That’s it.

## Bidirectional Use (v2 design)

Teleport is bidirectional in intent:

- From laptop → server:
  - Use when laptop is more secure.
  - Lucy runs on laptop, reaches server via SSH.
- From server → laptop (or dangerous/external location):
  - Use when deploying Lucy into a less trusted environment.
  - Lucy runs locally on that machine, with native access.

Direction is determined by where you run the scripts:

- The machine you run teleport-to on is where Lucy “lives” until you run teleport-back.

## Important Rules (short)

- Only one gateway at a time.
- Always run `teleport-back` when done.
- Don’t manually start the home gateway while teleported.

## Troubleshooting (short)

- “sshfs not found” → Install sshfs on the remote machine.
- “openclaw not found” → Install OpenClaw on the remote machine.
- “Tunnel failed” or “SSHFS mount failed” → Ensure SSH to home works; check firewall / Tailscale.
- Stuck / unsure:
  - Run `teleport-back.sh` once, then try again.
