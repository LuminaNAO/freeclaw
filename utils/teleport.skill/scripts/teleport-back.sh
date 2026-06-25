#!/usr/bin/env bash
# teleport-back.sh — Teleport gateway FROM this (remote) machine BACK to home
# Usage: teleport-back.sh <home-host>

set -euo pipefail

HOME_HOST="${1:?Usage: teleport-back.sh <home-host>}"
WORKSPACE_DIR="$HOME/.openclaw/workspace"

echo "✈️  Teleporting back to ${HOME_HOST}..."

# 1. Stop local gateway
echo "⏹  Stopping local gateway..."
openclaw gateway stop 2>/dev/null || echo "⚠️  Local gateway may already be stopped"

# 2. Unmount workspace
if mountpoint -q "${WORKSPACE_DIR}" 2>/dev/null; then
    echo "📦 Unmounting workspace..."
    fusermount -u "${WORKSPACE_DIR}" 2>/dev/null || umount "${WORKSPACE_DIR}" 2>/dev/null
    echo "   Unmounted"
else
    echo "⚠️  Workspace not mounted (already clean?)"
fi

# 3. Kill SSH tunnel
TUNNEL_PID_FILE="${HOME}/.openclaw/.tunnel-pid"
if [ -f "${TUNNEL_PID_FILE}" ]; then
    TUNNEL_PID=$(cat "${TUNNEL_PID_FILE}")
    if kill -0 "$TUNNEL_PID" 2>/dev/null; then
        echo "🔧 Killing SSH tunnel (PID: ${TUNNEL_PID})..."
        kill "$TUNNEL_PID" 2>/dev/null
    fi
    rm -f "${TUNNEL_PID_FILE}"
fi
# Cleanup any stragglers
pkill -f "ssh.*-L.*40801.*${HOME_HOST}" 2>/dev/null || true

# 4. Start home gateway
echo "🚀 Starting home gateway..."
ssh "${HOME_HOST}" "openclaw gateway start"

echo ""
echo "✅ Teleported back! Gateway running on ${HOME_HOST}"
