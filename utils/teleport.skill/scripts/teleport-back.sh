#!/usr/bin/env bash
# teleport-back.sh — Teleport gateway FROM this (remote) machine BACK to home
# Usage: teleport-back.sh <home-host>

set -euo pipefail

HOME_HOST="${1:?Usage: teleport-back.sh <home-host>}"
WORKSPACE_DIR="$HOME/.openclaw/workspace"
TUNNEL_PORT=40801
TUNNEL_PID_FILE="${HOME}/.openclaw/.tunnel-pid"

echo "Teleporting back to ${HOME_HOST}..."

cleanup_on_error() {
    echo ""
    echo "Teleport-back failed. Cleaning up..."

    if [ -f "$TUNNEL_PID_FILE" ]; then
        T=$(cat "$TUNNEL_PID_FILE" 2>/dev/null || true)
        [ -n "$T" ] && kill -0 "$T" 2>/dev/null && kill "$T" 2>/dev/null || true
        rm -f "$TUNNEL_PID_FILE"
    fi
    pkill -f "ssh.*-L.*${TUNNEL_PORT}.*${HOME_HOST}" 2>/dev/null || true

    if mountpoint -q "$WORKSPACE_DIR" 2>/dev/null; then
        fusermount -u "$WORKSPACE_DIR" 2>/dev/null || umount "$WORKSPACE_DIR" 2>/dev/null || true
    fi

    echo "Teleport-back incomplete. You may need to:"
    echo "- On this machine: ensure gateway is stopped and workspace unmounted"
    echo "- On ${HOME_HOST}: run 'openclaw gateway start'"
    exit 1
}

trap cleanup_on_error ERR

# 1. Stop local gateway
echo "Stopping local gateway..."
if command -v openclaw >/dev/null 2>&1; then
    openclaw gateway stop 2>/dev/null || echo "Note: local gateway may already be stopped"
else
    echo "Warning: openclaw not found; skipping local gateway stop."
fi

# 2. Unmount workspace
if mountpoint -q "${WORKSPACE_DIR}" 2>/dev/null; then
    echo "Unmounting workspace..."
    fusermount -u "${WORKSPACE_DIR}" 2>/dev/null || umount "${WORKSPACE_DIR}" 2>/dev/null || true
    echo "Unmounted."
else
    echo "Workspace not mounted (already clean?)"
fi

# 3. Kill SSH tunnel
if [ -f "${TUNNEL_PID_FILE}" ]; then
    TUNNEL_PID=$(cat "${TUNNEL_PID_FILE}" 2>/dev/null || true)
    if [ -n "$TUNNEL_PID" ] && kill -0 "$TUNNEL_PID" 2>/dev/null; then
        echo "Killing SSH tunnel..."
        kill "$TUNNEL_PID" 2>/dev/null || true
    fi
    rm -f "${TUNNEL_PID_FILE}"
fi

# Cleanup any stragglers for this host
pkill -f "ssh.*-L.*${TUNNEL_PORT}.*${HOME_HOST}" 2>/dev/null || true

# 4. Start home gateway
echo "Starting home gateway..."
if ssh "${HOME_HOST}" "openclaw gateway start"; then
    echo ""
    echo "Teleported back. Gateway running on ${HOME_HOST}"
else
    echo ""
    echo "Failed to start home gateway via SSH."
    echo "On ${HOME_HOST}, run:"
    echo "openclaw gateway start"
    # Local cleanup is done; this is a remote issue.
fi
