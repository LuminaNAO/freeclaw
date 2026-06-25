#!/usr/bin/env bash
# diagnose-gateway-hang.sh — Diagnose why openclaw hangs
# Run on the remote machine, paste full output back.
# NO openclaw commands are invoked directly — all checks are passive.
set -uo pipefail

SEP="════════════════════════════════════════════════════════════════"
section() { printf '\n%s\n  %s\n%s\n' "$SEP" "$1" "$SEP"; }

OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
OPENCLAW_CONFIG="$OPENCLAW_STATE_DIR/openclaw.json"
LLAMA_PORT=40801
GATEWAY_PORT=""

# Source nvm if available
[ -f "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh" 2>/dev/null
export PNPM_HOME="$HOME/.local/share/pnpm"
export PATH="$PNPM_HOME:$PATH"

# ─── 1. Basics ──────────────────────────────────────────────────────────────
section "1. System / Node versions"
uname -a
echo "---"
node --version 2>&1 || echo "node: NOT FOUND"
npm --version 2>&1 || echo "npm: NOT FOUND"
pnpm --version 2>&1 || echo "pnpm: NOT FOUND"
OPENCLAW_BIN=$(which openclaw 2>/dev/null || echo "")
echo "openclaw bin: ${OPENCLAW_BIN:-NOT FOUND}"
if [[ -n "$OPENCLAW_BIN" ]]; then
    echo "openclaw binary type:"
    file "$OPENCLAW_BIN" 2>&1
    echo "---"
    # If it's a script/wrapper, show what it does
    if file "$OPENCLAW_BIN" 2>/dev/null | grep -qi "text\|script"; then
        echo "openclaw wrapper contents:"
        cat "$OPENCLAW_BIN" 2>&1
    fi
    echo "---"
    # Find the actual JS entrypoint
    echo "Resolved openclaw entrypoint:"
    readlink -f "$OPENCLAW_BIN" 2>&1
    RESOLVED=$(readlink -f "$OPENCLAW_BIN" 2>/dev/null)
    if [[ -n "$RESOLVED" ]] && file "$RESOLVED" 2>/dev/null | grep -qi "text\|script"; then
        head -5 "$RESOLVED" 2>&1
    fi
fi

# ─── 2. Config ──────────────────────────────────────────────────────────────
section "2. OpenClaw config"
if [[ -f "$OPENCLAW_CONFIG" ]]; then
    echo "Config exists: $OPENCLAW_CONFIG ($(stat -c%s "$OPENCLAW_CONFIG") bytes)"
    jq '{gateway: .gateway, models_providers_keys: (.models.providers | keys)}' "$OPENCLAW_CONFIG" 2>&1 \
        | sed 's/"token": "[^"]*"/"token": "***MASKED***"/g'
    GATEWAY_PORT=$(jq -r '.gateway.port // empty' "$OPENCLAW_CONFIG" 2>/dev/null)
else
    echo "Config NOT FOUND at $OPENCLAW_CONFIG"
fi

# ─── 3. Systemd service state ───────────────────────────────────────────────
section "3. Gateway systemd service"
systemctl --user status openclaw-gateway.service 2>&1 | head -30
echo "---"
echo "Service file:"
SVCFILE="$HOME/.config/systemd/user/openclaw-gateway.service"
if [[ -f "$SVCFILE" ]]; then
    sed 's/OPENCLAW_GATEWAY_TOKEN=.*/OPENCLAW_GATEWAY_TOKEN=***MASKED***/g' "$SVCFILE"
else
    echo "NOT FOUND at $SVCFILE"
fi

# ─── 4. Recent gateway logs ────────────────────────────────────────────────
section "4. Gateway journal logs (last 50 lines)"
journalctl --user -u openclaw-gateway.service -n 50 --no-pager 2>&1 || echo "journalctl failed"

# ─── 5. Port usage ──────────────────────────────────────────────────────────
section "5. Port usage"
echo "llama.cpp port ($LLAMA_PORT):"
ss -tlnp 2>/dev/null | grep ":${LLAMA_PORT}" || echo "  nothing listening on :${LLAMA_PORT}"
if [[ -n "$GATEWAY_PORT" ]]; then
    echo "Gateway port ($GATEWAY_PORT):"
    ss -tlnp 2>/dev/null | grep ":${GATEWAY_PORT}" || echo "  nothing listening on :${GATEWAY_PORT}"
fi
echo "---"
echo "All openclaw-related listeners:"
ss -tlnp 2>/dev/null | grep -i -E "openclaw|node" | head -10 || echo "  none found"

# ─── 6. OpenClaw processes ──────────────────────────────────────────────────
section "6. OpenClaw / Node processes"
ps aux | grep -E "[o]penclaw|[n]ode.*openclaw|[n]ode.*gateway" | head -20 || echo "  none running"
echo "---"
echo "All node processes:"
ps aux | grep "[n]ode" | head -20 || echo "  none"

# ─── 7. Locks and agent state ───────────────────────────────────────────────
section "7. Locks and agent state"
echo "Lock files:"
find "$OPENCLAW_STATE_DIR" -name "*.lock" -ls 2>/dev/null || echo "  none"
echo "---"
echo "Agent dir contents:"
ls -la "$OPENCLAW_STATE_DIR/agents/main/agent/" 2>/dev/null || echo "  dir not found"
echo "---"
echo "PID files:"
find "$OPENCLAW_STATE_DIR" -name "*.pid" -ls 2>/dev/null || echo "  none"
echo "---"
echo "Socket files:"
find "$OPENCLAW_STATE_DIR" -name "*.sock" -ls 2>/dev/null || echo "  none"
find /tmp -maxdepth 2 -name "*openclaw*" -ls 2>/dev/null || echo "  none in /tmp"

# ─── 8. llama.cpp server reachability ───────────────────────────────────────
section "8. llama.cpp server connectivity"
echo "Health check:"
timeout 5 curl -sf "http://localhost:${LLAMA_PORT}/health" 2>&1 || echo "  FAILED or unreachable"
echo ""
echo "/v1/models:"
timeout 5 curl -sf "http://localhost:${LLAMA_PORT}/v1/models" 2>&1 | jq -r '.data[0].id // "no model"' 2>&1 || echo "  FAILED"
echo ""
echo "Slots (is server busy?):"
timeout 5 curl -sf -H "Authorization: Bearer ollama-local" "http://localhost:${LLAMA_PORT}/slots" 2>&1 \
    | jq '[.[] | {id, state, n_past, n_predict, is_processing}]' 2>&1 || echo "  /slots unavailable or auth required"

# ─── 9. DNS / network ───────────────────────────────────────────────────────
section "9. DNS and network"
echo "Resolving localhost:"
getent hosts localhost 2>&1
echo "---"
echo "Can reach 127.0.0.1:${LLAMA_PORT}?"
timeout 3 bash -c "echo > /dev/tcp/127.0.0.1/${LLAMA_PORT}" 2>&1 && echo "  YES" || echo "  NO"
if [[ -n "$GATEWAY_PORT" ]]; then
    echo "Can reach 127.0.0.1:${GATEWAY_PORT}?"
    timeout 3 bash -c "echo > /dev/tcp/127.0.0.1/${GATEWAY_PORT}" 2>&1 && echo "  YES" || echo "  NO"
fi

# ─── 10. Disk / memory ────────────────────────────────────────────────────
section "10. Resources"
echo "Disk (state dir):"
df -h "$OPENCLAW_STATE_DIR" 2>/dev/null | tail -1
echo "---"
echo "Memory:"
free -h | head -2
echo "---"
echo "OpenClaw state dir size:"
du -sh "$OPENCLAW_STATE_DIR" 2>/dev/null || echo "  N/A"

# ─── 11. Node.js startup test ───────────────────────────────────────────────
section "11. Node.js startup probe (10s timeout)"
echo "Testing if 'node -e process.exit(0)' works:"
timeout 10 node -e "process.exit(0)" 2>&1 && echo "  OK" || echo "  FAILED/HUNG"

if [[ -n "$OPENCLAW_BIN" ]]; then
    # Find the JS entrypoint openclaw invokes
    RESOLVED=$(readlink -f "$OPENCLAW_BIN" 2>/dev/null || echo "$OPENCLAW_BIN")
    OPENCLAW_DIR=$(dirname "$RESOLVED")

    echo "---"
    echo "Testing openclaw entrypoint with NODE_DEBUG=module (5s, first 40 lines):"
    timeout 5 env NODE_DEBUG=module node "$RESOLVED" --version 2>&1 | head -40
    echo "..."
    echo "(truncated)"

    echo "---"
    echo "Testing bare 'openclaw --version' with 10s timeout:"
    timeout 10 openclaw --version 2>&1
    RC=$?
    if [[ $RC -eq 124 ]]; then
        echo "  TIMED OUT after 10s"
    elif [[ $RC -ne 0 ]]; then
        echo "  FAILED (exit=$RC)"
    fi

    echo "---"
    echo "Checking for telemetry/update config that might cause network waits:"
    for f in "$OPENCLAW_STATE_DIR/settings.json" "$OPENCLAW_STATE_DIR/openclaw.json" "$HOME/.config/openclaw/settings.json"; do
        if [[ -f "$f" ]]; then
            echo "$f:"
            jq '{telemetry, updates, autoUpdate, checkForUpdates, analytics}' "$f" 2>/dev/null || echo "  (not JSON or no matching keys)"
        fi
    done

    echo "---"
    echo "Environment variables that may affect openclaw:"
    env | grep -iE "openclaw|anthropic|proxy|http_proxy|https_proxy|no_proxy|node_options|node_extra" 2>/dev/null || echo "  none"
fi

section "DONE"
echo "Paste everything above back to the conversation."
