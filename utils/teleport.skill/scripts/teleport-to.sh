#!/usr/bin/env bash
# teleport-to.sh — Teleport gateway FROM home TO this (remote) machine
# Usage: teleport-to.sh <home-host>
#   home-host: SSH address of home machine (e.g., lumina@framed)

set -euo pipefail

HOME_HOST="${1:?Usage: teleport-to.sh <home-host>}"
WORKSPACE_DIR="$HOME/.openclaw/workspace"
TUNNEL_PORT=40801

echo "✈️  Teleporting to this machine from ${HOME_HOST}..."

# 1. Stop home gateway
echo "⏹  Stopping home gateway..."
ssh "${HOME_HOST}" "openclaw gateway stop" || echo "⚠️  Home gateway may already be stopped"

# 2. Kill any existing tunnel
pkill -f "ssh.*-L.*${TUNNEL_PORT}.*${HOME_HOST}" 2>/dev/null || true

# 3. Kill any existing SSHFS mount
if mountpoint -q "${WORKSPACE_DIR}" 2>/dev/null; then
    echo "⚠️  Workspace already mounted, unmounting..."
    fusermount -u "${WORKSPACE_DIR}" 2>/dev/null || umount "${WORKSPACE_DIR}" 2>/dev/null
fi

# 4. Start SSH tunnel (inference)
echo "🔧 Starting SSH tunnel (inference)..."
ssh -N -L "${TUNNEL_PORT}:localhost:${TUNNEL_PORT}" \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 \
    "${HOME_HOST}" &
TUNNEL_PID=$!
echo "${TUNNEL_PID}" > "${HOME}/.openclaw/.tunnel-pid"
echo "   Tunnel PID: ${TUNNEL_PID}"

# Wait for tunnel to establish
sleep 2
if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    echo "❌ Tunnel failed to start"
    exit 1
fi

# 5. Mount workspace via SSHFS
echo "📦 Mounting workspace via SSHFS..."
mkdir -p "${WORKSPACE_DIR}"
sshfs "$(cut -d'@' -f1 <<< "${HOME_HOST}")@$(cut -d'@' -f2 <<< "${HOME_HOST}")":<home-user-home>/.openclaw/workspace \
    "${WORKSPACE_DIR}" \
    -o allow_other,reconnect,ServerAliveInterval=30

if ! mountpoint -q "${WORKSPACE_DIR}"; then
    echo "❌ SSHFS mount failed"
    kill "$TUNNEL_PID" 2>/dev/null
    exit 1
fi
echo "   Mounted at ${WORKSPACE_DIR}"

# 6. Start local gateway
echo "🚀 Starting local gateway..."
openclaw gateway start

echo ""
echo "✅ Teleported! Gateway running locally, inference via tunnel to ${HOME_HOST}"
echo "   Return: ./teleport-back.sh ${HOME_HOST}"
