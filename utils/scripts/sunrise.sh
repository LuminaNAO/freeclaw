#!/usr/bin/env bash
# sunrise.sh — Exit night mode (re-enable Signal channel)
#
# Lifecycle:
#   1. Restore Signal channel via config hot-reload
#   2. Clear sleep state
#
# Usage:
#   ./sunrise.sh

set -euo pipefail

WORKSPACE="${WORKSPACE:-$HOME/.openclaw/workspace}"
SLEEP_STATE="$WORKSPACE/sleep-state.json"

echo "[sunrise] starting at $(date -Iseconds)"

# ── 1. Re-enable Signal channel ────────────────────────────────────────────
echo "[sunrise] re-enabling Signal channel…"
openclaw config set channels.signal.enabled true
echo "[sunrise] Signal re-enabled. Waiting for channel to start…"
sleep 3

# ── 2. Clear sleep state ───────────────────────────────────────────────────
echo "[sunrise] clearing sleep state…"
cat > "$SLEEP_STATE" <<EOF
{
  "state": "awake",
  "woke_at": "$(date -Iseconds)",
  "night_protocol_version": "v1"
}
EOF

echo "[sunrise] done at $(date -Iseconds)"
echo "[sunrise] Day mode active. Signal channel is receiving again."
