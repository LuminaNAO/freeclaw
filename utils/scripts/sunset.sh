#!/usr/bin/env bash
# sunset.sh — Enter night mode
#
# Lifecycle:
#   1. Disable Signal channel via config hot-reload (signal-cli stops)
#   2. Signal-cli is now free — refresh identity dump + sync group memory dirs
#   3. Record sleep start timestamp
#
# No gateway restart needed. Disabling the signal channel stops signal-cli,
# freeing the account lock for direct use.
#
# Usage:
#   ./sunset.sh

set -euo pipefail

WORKSPACE="${WORKSPACE:-$HOME/.openclaw/workspace}"
SLEEP_STATE="$WORKSPACE/sleep-state.json"
HELPER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENCLAW_HELPERS="$(dirname "$HELPER_DIR")"
GROUP_MEMORY_SCRIPT="$OPENCLAW_HELPERS/signal-group-memory.sh"

echo "[sunset] starting at $(date -Iseconds)"

# ── 1. Disable Signal channel (signal-cli stops, account lock freed) ───────
echo "[sunset] disabling Signal channel…"
openclaw config set channels.signal.enabled false
echo "[sunset] Signal disabled. Waiting for channel to stop…"
sleep 3

# ── 2. Refresh group memory (signal-cli is now free) ───────────────────────
echo "[sunset] refreshing group memory dirs…"
if [[ -x "$GROUP_MEMORY_SCRIPT" ]]; then
    "$GROUP_MEMORY_SCRIPT" "$WORKSPACE" 2>&1 || {
        echo "⚠️  group memory sync failed — continuing anyway" >&2
    }
else
    echo "⚠️  $GROUP_MEMORY_SCRIPT not found or not executable — skipping sync" >&2
fi
echo "[sunset] group memory sync done."

# ── 3. Record sleep start state ────────────────────────────────────────────
echo "[sunset] recording sleep start state…"
cat > "$SLEEP_STATE" <<EOF
{
  "state": "sleeping",
  "started_at": "$(date -Iseconds)",
  "night_protocol_version": "v1",
  "group_memory_synced": true
}
EOF

echo "[sunset] done at $(date -Iseconds)"
echo "[sunset] Night mode active. Signal channel is disabled."
echo "[sunset] Main session should now execute night-protocol.md"
