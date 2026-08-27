#!/usr/bin/env bash
# lib-gateway.sh — shared gateway/service helpers for build-switch.sh and
# llamacpp-init.sh. Source this file; do not execute it.
#
# Both scripts historically carried private copies of this logic and they
# drifted: two different systemd unit generators (plus `openclaw gateway
# install --force` as a third), duplicated port policy, and repeated
# stop/orphan/lock cleanup. This file is the single owner of all of it.
# build-switch.sh writes the unit on every build; llamacpp-init.sh only
# patches it (or falls back to generating one on installs that never ran
# build-switch).

GATEWAY_PORT_START=40701
GATEWAY_PORT_END=40798

# Log through whichever logger the sourcing script defines (build-switch has
# log(), llamacpp-init has info()); fall back to plain echo.
gw_log() {
    if declare -f log >/dev/null 2>&1; then log "$*";
    elif declare -f info >/dev/null 2>&1; then info "$*";
    else echo "[INFO] $*"; fi
}

gw_warn() {
    if declare -f warn >/dev/null 2>&1; then warn "$*"; else echo "[WARN] $*" >&2; fi
}

# ─── Port policy ────────────────────────────────────────────────────────────

gw_port_in_use() {
    ss -H -ltn "sport = :${1}" 2>/dev/null | grep -q .
}

gw_is_gateway_port_range() {
    [[ "$1" =~ ^[0-9]+$ ]] && [[ "$1" -ge "$GATEWAY_PORT_START" ]] && [[ "$1" -le "$GATEWAY_PORT_END" ]]
}

gw_generate_port() {
    local port
    while true; do
        port=$(shuf -i "${GATEWAY_PORT_START}-${GATEWAY_PORT_END}" -n 1)
        if ! gw_port_in_use "$port"; then
            echo "$port"
            return
        fi
    done
}

gw_find_free_port() {
    local preferred="$1" start="$2" end="$3" p
    if ! gw_port_in_use "$preferred"; then
        echo "$preferred"
        return 0
    fi
    for p in $(seq "$start" "$end"); do
        if ! gw_port_in_use "$p"; then
            echo "$p"
            return 0
        fi
    done
    return 1
}

# Resolve the gateway port: the service file is the source of truth (it is
# what systemd actually runs), then the config file, then generate a free one.
gw_resolve_port() {
    local service_file="$1" config_file="${2:-}"
    local port=""
    if [[ -f "$service_file" ]]; then
        port=$(grep -oP 'OPENCLAW_GATEWAY_PORT=\K[0-9]+' "$service_file" 2>/dev/null || echo "")
        if gw_is_gateway_port_range "$port"; then
            echo "$port"
            return 0
        fi
        [[ -n "$port" ]] && gw_warn "Service gateway port ${port} is outside ${GATEWAY_PORT_START}-${GATEWAY_PORT_END}; assigning a new port"
    fi
    if [[ -n "$config_file" && -f "$config_file" ]] && command -v jq &>/dev/null; then
        port=$(jq -r '.gateway.port // empty' "$config_file" 2>/dev/null || echo "")
        if gw_is_gateway_port_range "$port"; then
            echo "$port"
            return 0
        fi
    fi
    gw_generate_port
}

# ─── Version strings ────────────────────────────────────────────────────────

# Derive a version string from a branch name + base version.
#   main / master     → $version  (vanilla)
#   freeclaw          → f$version
#   freeclaw-*        → f$version-<suffix>
#   anything else     → $version-<branch>
gw_version_for_branch() {
    local branch="$1" version="$2"
    case "$branch" in
        main|master)  echo "$version" ;;
        freeclaw)     echo "f$version" ;;
        freeclaw-*)   echo "f${version}-${branch#freeclaw-}" ;;
        "")           echo "$version" ;;
        *)            echo "$version-$branch" ;;
    esac
}

# ─── Process / lock cleanup ─────────────────────────────────────────────────

gw_stop_service() {
    local service_name="$1"
    gw_log "Stopping gateway ($service_name)..."
    systemctl --user stop "$service_name" 2>/dev/null || true
    sleep 2
    if systemctl --user is-active --quiet "$service_name" 2>/dev/null; then
        gw_warn "Gateway didn't stop cleanly, force-killing..."
        systemctl --user kill "$service_name" --signal=9 2>/dev/null || true
        sleep 1
    fi
}

# Kill any gateway process left over from previous installs — orphans hold the
# port and make the fresh gateway crash-loop.
gw_kill_stale_gateways() {
    # Scope the sweep to the target gateway port when given, so a named/isolated
    # agent never kills OTHER agents gateways (all share the same process name).
    local port="${1:-}"
    local pids
    if [[ -n "$port" ]]; then
        pids=$(ss -ltnHp "sport = :$port" 2>/dev/null | grep -oE "pid=[0-9]+" | cut -d= -f2 | sort -u)
    else
        pids=$(pgrep -f "openclaw.*gateway|openclaw-gatewa" 2>/dev/null || true)
    fi
    if [[ -n "$pids" ]]; then
        gw_warn "Killing stale gateway processes: $(echo $pids | tr '\n' ' ')"
        kill -9 $pids 2>/dev/null || true
        sleep 1
    fi
}

# Kill orphaned openclaw-agent processes and sweep stale session locks — both
# survive gateway restarts and block new inference attempts.
gw_cleanup_agent_orphans() {
    local state_dir="$1"
    local orphans locks
    orphans=$(pgrep -f "openclaw-agent" 2>/dev/null || true)
    if [[ -n "$orphans" ]]; then
        gw_warn "Killing orphaned openclaw-agent processes: $orphans"
        kill -9 $orphans 2>/dev/null || true
        sleep 1
    fi
    locks=$(find "$state_dir/agents" -name "*.lock" 2>/dev/null || true)
    if [[ -n "$locks" ]]; then
        gw_warn "Removing stale session locks..."
        rm -f $locks
    fi
}

# ─── systemd unit management ────────────────────────────────────────────────

# Set (or replace) an Environment= line in a systemd unit file.
systemd_set_env() {
    local file="$1" key="$2" value="$3" after_key="${4:-}"
    local tmp="${file}.tmp.$$"

    if grep -q "^Environment=${key}=" "$file"; then
        awk -v key="$key" -v value="$value" '
            $0 ~ "^Environment=" key "=" {
                print "Environment=" key "=" value
                next
            }
            { print }
        ' "$file" > "$tmp" && mv "$tmp" "$file"
        return
    fi

    if [[ -n "$after_key" ]] && grep -q "^Environment=${after_key}=" "$file"; then
        awk -v key="$key" -v value="$value" -v after_key="$after_key" '
            { print }
            $0 ~ "^Environment=" after_key "=" {
                print "Environment=" key "=" value
            }
        ' "$file" > "$tmp" && mv "$tmp" "$file"
        return
    fi

    awk -v key="$key" -v value="$value" '
        /^\[Install\]/ && !inserted {
            print "Environment=" key "=" value
            inserted = 1
        }
        { print }
        END {
            if (!inserted) print "Environment=" key "=" value
        }
    ' "$file" > "$tmp" && mv "$tmp" "$file"
}

# THE single generator for the gateway systemd unit. Parameters via env vars:
#   GW_SERVICE_FILE     (required) unit file path
#   GW_SERVICE_NAME     (required) e.g. openclaw-gateway
#   GW_NODE_PATH        (required) node binary the gateway runs on
#   GW_ENTRYPOINT       (required) path to dist/index.js
#   GW_STATE_DIR        (required) OPENCLAW_STATE_DIR for the unit
#   GW_PORT             (required) gateway port
#   GW_VERSION_STRING   (required) informational version label
#   GW_CMD_NAME         (required) CLI/service marker name
#   GW_TOKEN            (optional) gateway auth token to embed
#   GW_AGENT_NAME       (optional) named-agent label for the description
gw_write_service_unit() {
    local node_dir v8_cache_dir svc_path svc_description
    node_dir=$(dirname "$GW_NODE_PATH")
    v8_cache_dir="$HOME/.openclaw/v8-compile-cache"
    mkdir -p "$v8_cache_dir" "$(dirname "$GW_SERVICE_FILE")"
    svc_path="${PNPM_BIN_DIR:-$HOME/.local/share/pnpm/bin}:${PNPM_HOME:-$HOME/.local/share/pnpm}:$node_dir:$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/bin:/usr/local/bin:/usr/bin:/bin"
    svc_description="OpenClaw Gateway ($GW_VERSION_STRING)"
    if [[ -n "${GW_AGENT_NAME:-}" ]]; then
        svc_description="OpenClaw Gateway - $GW_AGENT_NAME ($GW_VERSION_STRING)"
    fi

    cat > "$GW_SERVICE_FILE" <<EOF
[Unit]
Description=$svc_description
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$GW_NODE_PATH $GW_ENTRYPOINT gateway --port $GW_PORT
Restart=always
RestartSec=5
KillMode=process
Environment=HOME=$HOME
Environment=TMPDIR=/tmp
Environment=PATH=$svc_path
Environment=OPENCLAW_STATE_DIR=$GW_STATE_DIR
Environment=OPENCLAW_GATEWAY_PORT=$GW_PORT
$([ -n "${GW_TOKEN:-}" ] && echo "Environment=OPENCLAW_GATEWAY_TOKEN=$GW_TOKEN")
Environment=NODE_COMPILE_CACHE=$v8_cache_dir
Environment=OPENCLAW_SYSTEMD_UNIT=${GW_SERVICE_NAME}.service
Environment=OPENCLAW_SERVICE_MARKER=$GW_CMD_NAME
Environment=OPENCLAW_SERVICE_KIND=gateway
Environment=OPENCLAW_SERVICE_VERSION=$GW_VERSION_STRING

[Install]
WantedBy=default.target
EOF
    gw_log "Wrote systemd service (version: $GW_VERSION_STRING, node: $GW_NODE_PATH, port: $GW_PORT)"
}
