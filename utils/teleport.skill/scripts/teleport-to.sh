#!/usr/bin/env bash
# teleport-to.sh — Teleport gateway FROM home TO this (remote) machine
# Usage: teleport-to.sh <home-host>
#   home-host: SSH address of home machine (e.g., lumina@framed)

set -euo pipefail

HOME_HOST="${1:?Usage: teleport-to.sh <home-host>}"
WORKSPACE_DIR="$HOME/.openclaw/workspace"
TUNNEL_PORT=40801
TUNNEL_PID_FILE="${HOME}/.openclaw/.tunnel-pid"

mkdir -p "$HOME/.openclaw"

cleanup_on_error() {
    echo ""
    echo "Teleport failed. Cleaning up..."

    if [ -f "$TUNNEL_PID_FILE" ]; then
        T=$(cat "$TUNNEL_PID_FILE" 2>/dev/null || true)
        [ -n "$T" ] && kill -0 "$T" 2>/dev/null && kill "$T" 2>/dev/null || true
        rm -f "$TUNNEL_PID_FILE"
    fi
    pkill -f "ssh.*-L.*${TUNNEL_PORT}.*${HOME_HOST}" 2>/dev/null || true

    if mountpoint -q "$WORKSPACE_DIR" 2>/dev/null; then
        fusermount -u "$WORKSPACE_DIR" 2>/dev/null || umount "$WORKSPACE_DIR" 2>/dev/null || true
    fi

    echo "Teleport incomplete. Run: ./teleport-back.sh ${HOME_HOST}"
    exit 1
}

trap cleanup_on_error ERR

echo "Teleporting to this machine from ${HOME_HOST}..."

if ! command -v sshfs >/dev/null 2>&1; then
    echo "Error: sshfs not found on this machine. Install it first."
    exit 1
fi

if ! command -v openclaw >/dev/null 2>&1; then
    echo "Error: openclaw not found on this machine. Install it first."
    exit 1
fi

# 1. Stop home gateway
echo "Stopping home gateway..."
ssh "${HOME_HOST}" "openclaw gateway stop" 2>/dev/null || echo "Note: home gateway may already be stopped"

# 2. Kill any existing tunnel for this home
pkill -f "ssh.*-L.*${TUNNEL_PORT}.*${HOME_HOST}" 2>/dev/null || true

# 3. Unmount existing workspace if present
if mountpoint -q "${WORKSPACE_DIR}" 2>/dev/null; then
    echo "Workspace already mounted, unmounting..."
    fusermount -u "${WORKSPACE_DIR}" 2>/dev/null || umount "${WORKSPACE_DIR}" 2>/dev/null || true
fi

# 4. Discover home workspace path
echo "Detecting home workspace path..."
HOME_WORKSPACE=$(ssh "${HOME_HOST}" "realpath ~/.openclaw/workspace 2>/dev/null || echo ''")

if [ -z "$HOME_WORKSPACE" ]; then
    echo "Error: ~/.openclaw/workspace not found on ${HOME_HOST}."
    exit 1
fi
echo "Home workspace: ${HOME_WORKSPACE}"

# 5. Start SSH tunnel (inference)
echo "Starting SSH tunnel (inference)..."
ssh -N -L "${TUNNEL_PORT}:localhost:${TUNNEL_PORT}" \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 \
    "${HOME_HOST}" &
TUNNEL_PID=$!
echo "${TUNNEL_PID}" > "${TUNNEL_PID_FILE}"

sleep 2
if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    echo "Error: tunnel failed to start"
    exit 1
fi

# 6. Mount workspace via SSHFS
echo "Mounting workspace via SSHFS..."
mkdir -p "${WORKSPACE_DIR}"

sshfs "${HOME_HOST}:${HOME_WORKSPACE}" \
    "${WORKSPACE_DIR}" \
    -o allow_other,reconnect,ServerAliveInterval=30

if ! mountpoint -q "${WORKSPACE_DIR}"; then
    echo "Error: SSHFS mount failed"
    exit 1
fi
echo "Mounted at ${WORKSPACE_DIR}"

# 7. Quick health check on mounted workspace
HEALTH_FILE="${WORKSPACE_DIR}/.teleport-health-check"
if ! touch "${HEALTH_FILE}" 2>/dev/null || ! rm -f "${HEALTH_FILE}" 2>/dev/null; then
    echo "Error: workspace mount looks stale or read-only."
    exit 1
fi

# 8. Configure llama.cpp base URL (via tunnel)
echo "Configuring model provider (llama.cpp) via tunnel..."
openclaw config set models.providers.llama.cpp.baseUrl "http://localhost:${TUNNEL_PORT}" || {
    echo "Warning: failed to set llama.cpp baseUrl via openclaw config set."
    echo "You may need to set it manually on this machine."
}

# 9. Start local gateway
echo "Starting local gateway..."
openclaw gateway start

echo ""
echo "Teleported. Gateway running locally, inference via tunnel to ${HOME_HOST}"
echo "To return:"
echo "./teleport-back.sh ${HOME_HOST}"
