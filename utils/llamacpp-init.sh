#!/usr/bin/env bash
# llamacpp-init.sh
# Configures a fresh OpenClaw install to use a local llama.cpp server.
# Run this after: build-switch.sh <branch> --no-restart
# (--no-restart skips build-switch's gateway restart; this script restarts the
# gateway itself after committing the config, so the extra boot is wasted.)
#
# Usage: llamacpp-init.sh [agent-name] [--force]
#
# When an agent name is provided, targets that agent's state dir (~/.agent-name)
# instead of the default ~/.openclaw.
#
# Flags:
#   --force    Overwrite existing config even if it has non-llama.cpp providers
#
# Non-interactive use (stdin not a TTY): prompts are skipped. Required env:
#   LLAMA_CPP_HOST + LLAMA_CPP_PORT (or LLAMA_CPP_BASE_URL)
#   MODEL_CONTEXT_WINDOW
#   GATEWAY_BIND (loopback|lan)
# Optional: SUBAGENT_HOST/SUBAGENT_PORT (default: same server as main agent).
#
# All openclaw.json edits are staged on a private copy and committed with a
# single atomic rename before the gateway (re)install/restart phase. A failure
# at any point before the commit leaves the previous config fully intact, and
# any failure prints exactly which state was applied and how to recover.
set -euo pipefail
set -E  # ERR trap fires inside functions/subshells too

# ─── Failure reporting ──────────────────────────────────────────────────────
# State flags consumed by the exit trap so a mid-run death says precisely what
# was and wasn't applied instead of leaving the operator guessing.
CONFIG_COMMITTED=0
GATEWAY_RESTARTED=0
CONFIG_STAGING=""
FAIL_LINE=""
FAIL_CMD=""

on_error() {
    FAIL_LINE="$1"
    FAIL_CMD="$2"
}
trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR

on_exit() {
    local code=$?
    # NOTE: plain `if` statements only in here — a failing `cond && cmd` list
    # would trip errexit inside the trap and silently skip the report.
    # Remove staging litter regardless of outcome; commit uses mv, so a
    # surviving staging file is always garbage.
    if [[ -n "$CONFIG_STAGING" && -f "$CONFIG_STAGING" ]]; then
        rm -f "$CONFIG_STAGING" "$CONFIG_STAGING.tmp" 2>/dev/null || true
    fi
    if [[ $code -eq 0 ]]; then
        return 0
    fi
    printf '\e[31m[ERROR]\e[0m llamacpp-init FAILED (exit %s)%s\n' "$code" \
        "${FAIL_LINE:+ at line $FAIL_LINE: $FAIL_CMD}" >&2
    if [[ "$CONFIG_COMMITTED" -eq 1 ]]; then
        printf '\e[31m[ERROR]\e[0m Config committed: YES — %s was updated with the new provider settings.\n' "${OPENCLAW_CONFIG:-openclaw.json}" >&2
    else
        printf '\e[31m[ERROR]\e[0m Config committed: NO — %s is UNCHANGED; the previous provider settings (endpoint/context window) are still in place.\n' "${OPENCLAW_CONFIG:-openclaw.json}" >&2
    fi
    if [[ "$GATEWAY_RESTARTED" -eq 1 ]]; then
        printf '\e[31m[ERROR]\e[0m Gateway restarted: YES — but verification did not complete; check: journalctl --user -u %s.service -n 30\n' "${AGENT_SERVICE_NAME:-openclaw-gateway}" >&2
    else
        printf '\e[31m[ERROR]\e[0m Gateway restarted: NO — any running gateway still uses the OLD config. After fixing the error re-run this script, or restart manually: systemctl --user restart %s.service\n' "${AGENT_SERVICE_NAME:-openclaw-gateway}" >&2
    fi
    printf '\e[31m[ERROR]\e[0m Fix the cause above, then re-run: bash %s %s\n' "${BASH_SOURCE[0]}" "${SCRIPT_ARGS:-}" >&2
}
trap on_exit EXIT

SCRIPT_ARGS="$*"

FORCE=0
AGENT_NAME=""
for arg in "$@"; do
    case "$arg" in
        --force) FORCE=1 ;;
        -*) echo "Unknown flag: $arg"; exit 1 ;;
        *)
            if [[ -z "$AGENT_NAME" ]]; then
                AGENT_NAME="$arg"
            else
                echo "Unknown argument: $arg"; exit 1
            fi
            ;;
    esac
done

# ─── Configuration ──────────────────────────────────────────────────────────

# Record which endpoint values were explicitly provided BEFORE defaults apply —
# the non-interactive guard below must distinguish "user chose localhost:40801"
# from "nothing was provided and the default silently won".
ENV_HOST_SET="${LLAMA_CPP_HOST+yes}"
ENV_PORT_SET="${LLAMA_CPP_PORT+yes}"

LLAMA_CPP_HOST="${LLAMA_CPP_HOST:-localhost}"
LLAMA_CPP_PORT="${LLAMA_CPP_PORT:-40801}"
LLAMA_CPP_API_KEY="${LLAMA_CPP_API_KEY:-ollama-local}"
LLAMA_CPP_BASE_URL="${LLAMA_CPP_BASE_URL:-}"  # constructed after interactive prompts
# Gateway port range constants come from lib-gateway.sh (sourced below).

MODEL_PROVIDER="llama.cpp"
# All of these are auto-detected from the running server. Set env vars to override.
MODEL_ID="${MODEL_ID:-}"                      # auto: /v1/models
MODEL_CONTEXT_WINDOW="${MODEL_CONTEXT_WINDOW:-}"  # auto: /slots[0].n_ctx
MODEL_MAX_TOKENS="${MODEL_MAX_TOKENS:-}"  # auto: derived from context window
MODEL_THINKING_FORMAT="${MODEL_THINKING_FORMAT:-}" # auto: /slots[0].reasoning_format
MODEL_REASONING="${MODEL_REASONING:-}"         # auto: /slots[0].reasoning_format
THINKING_DEFAULT="high"  # off | minimal | low | medium | high | xhigh | adaptive
GATEWAY_BIND="${GATEWAY_BIND:-}"   # loopback | lan
GATEWAY_PASSWORD="${GATEWAY_PASSWORD:-}" # optional fixed password for LAN/VPN gateway auth
LLAMACPP_INIT_HISTORY="${LLAMACPP_INIT_HISTORY:-$HOME/.llamacpp-init-history}" # past runs, offered as presets
SESSION_IDLE_MINUTES="${SESSION_IDLE_MINUTES:-129600}" # 90 days; avoids daily session reset

# ─── Helpers ────────────────────────────────────────────────────────────────
info()  { printf '\e[32m[INFO]\e[0m  %s\n' "$*"; }
warn()  { printf '\e[33m[WARN]\e[0m  %s\n' "$*"; }
error() { printf '\e[31m[ERROR]\e[0m %s\n' "$*" >&2; exit 1; }

# Shared gateway/service helpers (port policy, systemd unit generator,
# process/lock cleanup) — single source of truth, also used by build-switch.sh.
LIB_GATEWAY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib-gateway.sh"
if [[ ! -f "$LIB_GATEWAY" ]]; then
    error "Missing $LIB_GATEWAY — this script ships with lib-gateway.sh; restore it from the repo."
fi
source "$LIB_GATEWAY"

normalize_gateway_bind() {
    local value
    value=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')

    case "$value" in
        1|local|localhost|loopback|machine)
            echo "loopback"
            ;;
        2|lan|network)
            echo "lan"
            ;;
        *)
            return 1
            ;;
    esac
}

detect_lan_ip() {
    local ip
    ip=$(ip -o -4 addr show scope global 2>/dev/null \
        | awk '$2 !~ /^(lo|docker|br-|veth|cni|flannel|virbr|podman)/ { split($4, a, "/"); print a[1]; exit }')
    if [[ -n "$ip" ]]; then
        echo "$ip"
        return 0
    fi

    hostname -I 2>/dev/null | awk '{ print $1 }'
}

detect_lan_cidr() {
    ip -o -4 addr show scope global 2>/dev/null \
        | awk '$2 !~ /^(lo|docker|br-|veth|cni|flannel|virbr|podman)/ { print $4; exit }'
}

detect_gateway_origin_hosts() {
    local hosts
    hosts=$(ip -o -4 addr show scope global 2>/dev/null \
        | awk '
            $2 !~ /^(lo|docker|br-|veth|cni|flannel|virbr|podman)/ {
                split($4, a, "/");
                if (a[1] != "" && a[1] !~ /^127\./ && !seen[a[1]]++) print a[1];
            }
        ')
    if [[ -n "$hosts" ]]; then
        printf '%s\n' "$hosts"
        return 0
    fi

    hostname -I 2>/dev/null \
        | tr ' ' '\n' \
        | awk '$1 != "" && $1 !~ /^127\./ && !seen[$1]++ { print $1 }'
}

join_lines() {
    awk 'NF { out = out ? out ", " $0 : $0 } END { print out }'
}

config_string_or_empty() {
    local path="$1"
    local file="$2"

    jq -r "${path} | strings" "$file" 2>/dev/null || true
}

# systemd_set_env comes from lib-gateway.sh.

# Derive state dir from agent name
if [[ -n "$AGENT_NAME" ]]; then
    OPENCLAW_STATE_DIR="$HOME/.$AGENT_NAME"
    AGENT_SERVICE_NAME="${AGENT_NAME}-gateway"
    AGENT_CMD_NAME="$AGENT_NAME"
    info "Agent mode: $AGENT_NAME (state: $OPENCLAW_STATE_DIR)"
else
    OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
    AGENT_SERVICE_NAME="openclaw-gateway"
    AGENT_CMD_NAME="openclaw"
fi
export OPENCLAW_STATE_DIR
# Resolved here (not at first use) so failure reports can always name the file.
OPENCLAW_CONFIG="$OPENCLAW_STATE_DIR/openclaw.json"
AGENT_DIR="$OPENCLAW_STATE_DIR/agents/main/agent"

# Resolve the openclaw entrypoint BEFORE any prompts so a missing install
# fails immediately, not after the user answered everything. Call node
# directly instead of relying on the pnpm shim which can break
# (self-referencing wrapper on pnpm v10+). Supports dev checkouts and the
# packaged install (/usr/lib/freeclaw), in that order; FREECLAW_DIR overrides.
OPENCLAW_ENTRYPOINT=""
for _freeclaw_dir in "${FREECLAW_DIR:-}" "$HOME/code/freeclaw" /usr/lib/freeclaw; do
    [[ -n "$_freeclaw_dir" && -f "$_freeclaw_dir/dist/index.js" ]] || continue
    FREECLAW_DIR="$_freeclaw_dir"
    OPENCLAW_ENTRYPOINT="$_freeclaw_dir/dist/index.js"
    break
done
unset _freeclaw_dir
OPENCLAW_NODE=$(which node)
if [[ -z "$OPENCLAW_ENTRYPOINT" ]]; then
    error "Freeclaw entrypoint not found. Looked in: ${FREECLAW_DIR:-\$FREECLAW_DIR unset}, $HOME/code/freeclaw, /usr/lib/freeclaw. Install the freeclaw package, or run build-switch.sh for a dev checkout."
fi

# ─── Non-interactive guard ──────────────────────────────────────────────────
# Without a TTY, `read` dies on EOF partway through the run (set -e), leaving
# whatever was applied so far. Decide everything up front instead: required
# values must come from env, optional ones get announced defaults, and ALL
# missing values are reported in one prescriptive message before anything runs.
NONINTERACTIVE=0
if [[ ! -t 0 ]]; then
    NONINTERACTIVE=1
    missing=()
    if [[ -z "$LLAMA_CPP_BASE_URL" && -z "$ENV_HOST_SET" && -z "$ENV_PORT_SET" ]]; then
        missing+=("LLAMA_CPP_HOST and LLAMA_CPP_PORT (or LLAMA_CPP_BASE_URL)")
    fi
    [[ -z "$MODEL_CONTEXT_WINDOW" ]] && missing+=("MODEL_CONTEXT_WINDOW (tokens, e.g. 262144)")
    [[ -z "$GATEWAY_BIND" ]] && missing+=("GATEWAY_BIND (loopback|lan)")
    if [[ ${#missing[@]} -gt 0 ]]; then
        printf '\e[31m[ERROR]\e[0m Non-interactive run (stdin is not a TTY) and required values are missing:\n' >&2
        printf '\e[31m[ERROR]\e[0m   - %s\n' "${missing[@]}" >&2
        printf '\e[31m[ERROR]\e[0m Set them as environment variables and re-run, e.g.:\n' >&2
        printf '\e[31m[ERROR]\e[0m   LLAMA_CPP_HOST=127.0.0.1 LLAMA_CPP_PORT=40800 MODEL_CONTEXT_WINDOW=262144 GATEWAY_BIND=lan bash %s %s\n' "${BASH_SOURCE[0]}" "$SCRIPT_ARGS" >&2
        exit 1
    fi
    if [[ -z "$LLAMA_CPP_BASE_URL" ]]; then
        LLAMA_CPP_BASE_URL="http://${LLAMA_CPP_HOST}:${LLAMA_CPP_PORT}"
    fi
    if [[ -z "${SUBAGENT_BASE_URL:-}" && -z "${SUBAGENT_HOST:-}" && -z "${SUBAGENT_PORT:-}" ]]; then
        info "Non-interactive: subagent server defaults to the main server."
    fi
fi

# When only LLAMA_CPP_BASE_URL was provided, derive host/port from it so the
# provider JSON, the summary, and the launch-history record stay consistent
# (otherwise history would record the localhost:40801 defaults).
if [[ -n "$LLAMA_CPP_BASE_URL" ]]; then
    _url_hostport="${LLAMA_CPP_BASE_URL#*://}"; _url_hostport="${_url_hostport%%/*}"
    if [[ "$_url_hostport" == *:* ]]; then
        LLAMA_CPP_HOST="${_url_hostport%:*}"
        LLAMA_CPP_PORT="${_url_hostport##*:}"
    else
        LLAMA_CPP_HOST="$_url_hostport"
    fi
    unset _url_hostport
fi

# Context window must be a positive integer wherever it came from — a typo here
# otherwise only explodes hundreds of lines later inside a jq --argjson.
if [[ -n "$MODEL_CONTEXT_WINDOW" ]] && ! [[ "$MODEL_CONTEXT_WINDOW" =~ ^[1-9][0-9]*$ ]]; then
    error "MODEL_CONTEXT_WINDOW must be a positive integer, got: '$MODEL_CONTEXT_WINDOW'"
fi

# ─── Launch history: quick re-setup ─────────────────────────────────────────
# Mirrors llama-launcher's .launch-history: successful runs record their
# ports, context size, subagent endpoint, and gateway bind, and are offered
# here as presets before the interactive prompts. Selecting one pre-seeds
# the prompt variables (which the prompts below then skip); the agent /
# state dir always comes from the CLI argument, never from history.
if [[ -t 0 && -z "$LLAMA_CPP_BASE_URL" && -s "$LLAMACPP_INIT_HISTORY" ]]; then
    hist_key=(); hist_agent=(); hist_host=(); hist_port=(); hist_ctx=()
    hist_sub_host=(); hist_sub_port=(); hist_gw=()
    while IFS=$'\t' read -r h_ts h_agent h_host h_port h_ctx h_sub_host h_sub_port h_gw; do
        [[ -n "$h_host" && -n "$h_port" ]] || continue
        entry="${h_host}:${h_port}|${h_ctx}|${h_sub_host}:${h_sub_port}|${h_gw}"
        dup=0
        for k in "${hist_key[@]}"; do [[ "$k" == "$entry" ]] && { dup=1; break; }; done
        [[ "$dup" -eq 1 ]] && continue
        hist_key+=("$entry"); hist_agent+=("${h_agent:--}")
        hist_host+=("$h_host"); hist_port+=("$h_port"); hist_ctx+=("$h_ctx")
        hist_sub_host+=("$h_sub_host"); hist_sub_port+=("$h_sub_port"); hist_gw+=("$h_gw")
        [[ ${#hist_key[@]} -ge 5 ]] && break
    done < <(tac "$LLAMACPP_INIT_HISTORY")

    if [[ ${#hist_key[@]} -gt 0 ]]; then
        echo "🕐 Recent setups:"
        for i in "${!hist_key[@]}"; do
            printf '  %d) %-10s  %s:%s  ctx=%s  sub=%s:%s  gw=%s\n' $((i+1)) \
                "${hist_agent[$i]}" "${hist_host[$i]}" "${hist_port[$i]}" "${hist_ctx[$i]:-?}" \
                "${hist_sub_host[$i]}" "${hist_sub_port[$i]}" "${hist_gw[$i]:-?}"
        done
        echo "  0) New setup"
        printf '\e[36m[INPUT]\e[0m Reuse a recent setup? [0=new, default=1]: '
        read -r hist_sel
        hist_sel="${hist_sel:-1}"
        if [[ "$hist_sel" =~ ^[1-9]$ ]] && [[ "$hist_sel" -le ${#hist_key[@]} ]]; then
            idx=$((hist_sel - 1))
            LLAMA_CPP_HOST="${hist_host[$idx]}"
            LLAMA_CPP_PORT="${hist_port[$idx]}"
            LLAMA_CPP_BASE_URL="http://${LLAMA_CPP_HOST}:${LLAMA_CPP_PORT}"
            [[ -n "${hist_ctx[$idx]}" ]] && MODEL_CONTEXT_WINDOW="${hist_ctx[$idx]}"
            SUBAGENT_HOST="${hist_sub_host[$idx]}"
            SUBAGENT_PORT="${hist_sub_port[$idx]}"
            SUBAGENT_BASE_URL="http://${SUBAGENT_HOST}:${SUBAGENT_PORT}"
            [[ -z "$GATEWAY_BIND" && -n "${hist_gw[$idx]}" ]] && GATEWAY_BIND="${hist_gw[$idx]}"
            info "Using recent setup: ${LLAMA_CPP_BASE_URL}  ctx=${MODEL_CONTEXT_WINDOW:-auto}  sub=${SUBAGENT_BASE_URL}  gw=${GATEWAY_BIND:-prompt}"
        fi
    fi
fi

# ─── Interactive prompts ────────────────────────────────────────────────────
if [[ -z "$LLAMA_CPP_BASE_URL" ]]; then
    printf '\e[36m[INPUT]\e[0m Inference server address [%s]: ' "$LLAMA_CPP_HOST"
    read -r user_host
    [[ -n "$user_host" ]] && LLAMA_CPP_HOST="$user_host"

    printf '\e[36m[INPUT]\e[0m Inference server port [%s]: ' "$LLAMA_CPP_PORT"
    read -r user_port
    [[ -n "$user_port" ]] && LLAMA_CPP_PORT="$user_port"

    LLAMA_CPP_BASE_URL="http://${LLAMA_CPP_HOST}:${LLAMA_CPP_PORT}"
    info "Inference URL: ${LLAMA_CPP_BASE_URL}"
fi

DEFAULT_CONTEXT=131072
if [[ -z "$MODEL_CONTEXT_WINDOW" ]]; then
    printf '\e[36m[INPUT]\e[0m Max context window in tokens [%s]: ' "$DEFAULT_CONTEXT"
    read -r user_ctx
    if [[ -n "$user_ctx" ]]; then
        [[ "$user_ctx" =~ ^[1-9][0-9]*$ ]] \
            || error "Context window must be a positive integer, got: '$user_ctx'"
        MODEL_CONTEXT_WINDOW="$user_ctx"
        info "Context window set to: ${MODEL_CONTEXT_WINDOW}"
    else
        MODEL_CONTEXT_WINDOW="$DEFAULT_CONTEXT"
        info "Context window set to: ${MODEL_CONTEXT_WINDOW} (default)"
    fi
fi

# ─── Subagent server prompts ───────────────────────────────────────────────
# Subagents can optionally be routed to a separate llama-server instance.
# Default: same host/port as the main server (subagent provider still gets
# written so the agent can see the full config).
SUBAGENT_HOST="${SUBAGENT_HOST:-$LLAMA_CPP_HOST}"
SUBAGENT_PORT="${SUBAGENT_PORT:-$LLAMA_CPP_PORT}"
SUBAGENT_API_KEY="${SUBAGENT_API_KEY:-$LLAMA_CPP_API_KEY}"
SUBAGENT_BASE_URL="${SUBAGENT_BASE_URL:-}"
SUBAGENT_MODEL_ID="${SUBAGENT_MODEL_ID:-}"
SUBAGENT_CONTEXT_WINDOW="${SUBAGENT_CONTEXT_WINDOW:-$MODEL_CONTEXT_WINDOW}"
SUBAGENT_MAX_TOKENS="${SUBAGENT_MAX_TOKENS:-}"
SUBAGENT_PROVIDER="llama.cpp-subagent"

if [[ -z "$SUBAGENT_BASE_URL" ]]; then
    if [[ "$NONINTERACTIVE" -eq 1 ]]; then
        # No TTY: never prompt — SUBAGENT_HOST/PORT env or the main-server
        # defaults above decide, deterministically.
        SUBAGENT_BASE_URL="http://${SUBAGENT_HOST}:${SUBAGENT_PORT}"
        info "Subagent inference URL: ${SUBAGENT_BASE_URL} (non-interactive)"
    else
        printf '\n'
        info "── Subagent inference server ──"
        info "Subagents can use a separate llama-server. Press Enter to use the same server."
        printf '\e[36m[INPUT]\e[0m Subagent server address [%s]: ' "$SUBAGENT_HOST"
        read -r user_sub_host
        [[ -n "$user_sub_host" ]] && SUBAGENT_HOST="$user_sub_host"

        printf '\e[36m[INPUT]\e[0m Subagent server port [%s]: ' "$SUBAGENT_PORT"
        read -r user_sub_port
        [[ -n "$user_sub_port" ]] && SUBAGENT_PORT="$user_sub_port"

        SUBAGENT_BASE_URL="http://${SUBAGENT_HOST}:${SUBAGENT_PORT}"
        info "Subagent inference URL: ${SUBAGENT_BASE_URL}"
    fi
fi

# If subagent points to same endpoint as main, reuse provider name to avoid duplication
if [[ "$SUBAGENT_BASE_URL" == "$LLAMA_CPP_BASE_URL" ]]; then
    SUBAGENT_SAME_SERVER=1
    info "Subagent uses same server as main agent."
else
    SUBAGENT_SAME_SERVER=0
    info "Subagent uses separate server: ${SUBAGENT_BASE_URL}"
fi

# Clean up litter from previously interrupted runs. Real files are only ever
# produced by atomic rename, so anything matching these patterns is garbage.
rm -f "$OPENCLAW_CONFIG".tmp "$OPENCLAW_CONFIG".tmp.* "$OPENCLAW_CONFIG".staging.* \
      "$AGENT_DIR"/models.json.tmp "$AGENT_DIR"/models.json.*.tmp \
      "$AGENT_DIR"/models.json.tmp.* "$AGENT_DIR"/auth-profiles.json.tmp.* \
      "$OPENCLAW_STATE_DIR"/agents/main/subagent/auth-profiles.json.tmp.* 2>/dev/null || true

# ─── Staged config editing ──────────────────────────────────────────────────
# Every openclaw.json edit below goes through cfg() against a private staging
# copy; commit_staged_config() publishes it with a single atomic rename. Any
# failure before the commit leaves the real config byte-identical.
stage_config() {
    CONFIG_STAGING="${OPENCLAW_CONFIG}.staging.$$"
    cp "$OPENCLAW_CONFIG" "$CONFIG_STAGING"
}

cfg() {  # cfg <jq args...> — apply a jq program to the staged config
    local tmp="${CONFIG_STAGING}.tmp"
    jq "$@" "$CONFIG_STAGING" > "$tmp" && mv "$tmp" "$CONFIG_STAGING"
}

commit_staged_config() {
    mv "$CONFIG_STAGING" "$OPENCLAW_CONFIG"
    CONFIG_STAGING=""
    CONFIG_COMMITTED=1
    info "Config committed atomically to $OPENCLAW_CONFIG"
}

# ─── Environment setup ───────────────────────────────────────────────────────
# Source nvm so node/openclaw are on PATH regardless of how this script is run
if [ -f "$HOME/.nvm/nvm.sh" ]; then
    source "$HOME/.nvm/nvm.sh"
elif [ -f /usr/share/nvm/init-nvm.sh ]; then
    source /usr/share/nvm/init-nvm.sh
fi

export PNPM_HOME="$HOME/.local/share/pnpm"
case ":$PATH:" in
    *":$PNPM_HOME:"*) ;;
    *) export PATH="$PNPM_HOME:$PATH" ;;
esac

# ─── Pre-flight checks ───────────────────────────────────────────────────────
if ! command -v jq &>/dev/null; then
    error "'jq' is required. Install: sudo pacman -S jq  (or your distro's equivalent)"
fi

if ! command -v curl &>/dev/null; then
    error "'curl' is required. Install: sudo pacman -S curl"
fi

openclaw_cmd() { OPENCLAW_STATE_DIR="$OPENCLAW_STATE_DIR" "$OPENCLAW_NODE" "$OPENCLAW_ENTRYPOINT" "$@"; }

# Check for existing config
if [[ -f "$OPENCLAW_CONFIG" ]]; then
    if grep -q '"llama.cpp"' "$OPENCLAW_CONFIG" 2>/dev/null; then
        warn "llama.cpp provider already configured — re-applying..."
    elif [[ "$FORCE" -eq 1 ]]; then
        warn "--force set: overwriting existing config at $OPENCLAW_CONFIG"
    else
        error "$OPENCLAW_CONFIG exists with other config. Use --force to overwrite, or remove manually: rm -rf $OPENCLAW_STATE_DIR"
    fi
fi

# ─── Gateway access prompt ───────────────────────────────────────────────────
if [[ -n "$GATEWAY_BIND" ]]; then
    GATEWAY_BIND_NORMALIZED=$(normalize_gateway_bind "$GATEWAY_BIND") \
        || error "Invalid GATEWAY_BIND='$GATEWAY_BIND' (use loopback or lan)"
    GATEWAY_BIND="$GATEWAY_BIND_NORMALIZED"
else
    EXISTING_GATEWAY_BIND=""
    if [[ -f "$OPENCLAW_CONFIG" ]]; then
        EXISTING_GATEWAY_BIND=$(jq -r '.gateway.bind // empty' "$OPENCLAW_CONFIG" 2>/dev/null || echo "")
    fi
    if ! DEFAULT_GATEWAY_BIND=$(normalize_gateway_bind "${EXISTING_GATEWAY_BIND:-lan}" 2>/dev/null); then
        DEFAULT_GATEWAY_BIND="lan"
    fi

    printf '\n'
    info "── Gateway TUI access ──"
    info "1) Local machine only (127.0.0.1)"
    info "2) Any machine on the LAN"
    printf '\e[36m[INPUT]\e[0m Gateway access [1=local, 2=LAN; default %s]: ' "$DEFAULT_GATEWAY_BIND"
    read -r user_gateway_access
    if [[ -z "$user_gateway_access" ]]; then
        GATEWAY_BIND="$DEFAULT_GATEWAY_BIND"
    elif GATEWAY_BIND_NORMALIZED=$(normalize_gateway_bind "$user_gateway_access"); then
        GATEWAY_BIND="$GATEWAY_BIND_NORMALIZED"
    else
        error "Invalid gateway access choice: $user_gateway_access"
    fi
fi
if [[ "$GATEWAY_BIND" == "loopback" ]]; then
    info "Gateway TUI access: local machine only"
else
    info "Gateway TUI access: any machine on the LAN"
fi

# ─── Connect to llama.cpp ────────────────────────────────────────────────────
info "Checking llama.cpp server at ${LLAMA_CPP_BASE_URL}..."
MODELS_RESPONSE=$(curl -sf "${LLAMA_CPP_BASE_URL}/v1/models" \
    -H "Authorization: Bearer ${LLAMA_CPP_API_KEY}") \
    || error "Cannot reach llama.cpp at ${LLAMA_CPP_BASE_URL}. Is the server running?"
info "llama.cpp server is reachable."

# Auto-detect model ID from the server if not explicitly set
if [[ -z "$MODEL_ID" ]]; then
    MODEL_ID=$(echo "$MODELS_RESPONSE" | jq -r '.data[0].id // empty')
    if [[ -z "$MODEL_ID" ]]; then
        error "Could not detect a model from llama.cpp. Set MODEL_ID explicitly."
    fi
    info "Auto-detected model: ${MODEL_ID}"
else
    info "Using configured model: ${MODEL_ID}"
fi

# Compact the picker ref: a full gguf path makes an unreadable provider/<path>
# ref in the TUI. llama.cpp serves the loaded model regardless of the requested
# model name (verified), so a short family+size slug is safe as the id, while the
# full descriptive basename is kept as the display name. Set MODEL_ID to override.
if [[ "$MODEL_ID" == *.gguf ]]; then
    _mn="${MODEL_ID##*/}"; _mn="${_mn%.gguf}"
    MODEL_NAME="${MODEL_NAME:-$_mn}"
    _low="$(printf "%s" "$_mn" | tr "[:upper:]" "[:lower:]")"
    if [[ "$_low" =~ ^([a-z][a-z0-9.]*-[0-9]+b) ]]; then
        MODEL_ID="${BASH_REMATCH[1]}"
    elif [[ "$_low" =~ ^([a-z][a-z0-9.]*) ]]; then
        MODEL_ID="${BASH_REMATCH[1]}"
    fi
    info "Compact model id: ${MODEL_ID} (display name: ${MODEL_NAME})"
elif [[ "$MODEL_ID" == */* ]]; then
    MODEL_NAME="${MODEL_NAME:-${MODEL_ID##*/}}"
    MODEL_ID="${MODEL_ID##*/}"
    info "Compact model id: ${MODEL_ID}"
fi
MODEL_NAME="${MODEL_NAME:-${MODEL_ID}}"
MODEL_REF="${MODEL_PROVIDER}/${MODEL_ID}"

# ─── Auto-detect server capabilities ────────────────────────────────────────
# Poll /slots and /props to detect context window, reasoning format, and caps.
SLOTS_RESPONSE=$(curl -sf "${LLAMA_CPP_BASE_URL}/slots" \
    -H "Authorization: Bearer ${LLAMA_CPP_API_KEY}" 2>/dev/null || echo "[]")
PROPS_RESPONSE=$(curl -sf "${LLAMA_CPP_BASE_URL}/props" \
    -H "Authorization: Bearer ${LLAMA_CPP_API_KEY}" 2>/dev/null || echo "{}")

# Context window — already set by interactive prompt or env var
info "Using context window: ${MODEL_CONTEXT_WINDOW}"

# Max output tokens — derive from context window for local inference (no cost concern).
# Use half the context window, capped at 65536, so there's room for prompt + history.
if [[ -z "$MODEL_MAX_TOKENS" ]]; then
    # 16K gives ample room for thinking + output without VRAM pressure.
    # Thinking tokens count against maxTokens, so 8K was too tight.
    MODEL_MAX_TOKENS=16384
    info "Auto-detected max output tokens: ${MODEL_MAX_TOKENS} (from ${MODEL_CONTEXT_WINDOW} ctx)"
else
    info "Using configured max output tokens: ${MODEL_MAX_TOKENS}"
fi

# Reasoning format detection — check both /slots and /props since the response
# structure varies by llama.cpp version and JINJA setting.
# With JINJA=0, /slots returns minimal data (no reasoning_format field) and /props
# reports reasoning_format="none" in default_generation_settings even when the PEG
# parser handles reasoning natively. The reliable indicator is
# chat_template_caps.supports_preserve_reasoning from /props.
SLOT_REASONING=$(echo "$SLOTS_RESPONSE" | jq -r '.[0].reasoning_format // "none"' 2>/dev/null)
SLOT_REASONING="${SLOT_REASONING:-none}"
PROPS_REASONING=$(echo "$PROPS_RESPONSE" | jq -r '.default_generation_settings.params.reasoning_format // "none"' 2>/dev/null)
PROPS_REASONING="${PROPS_REASONING:-none}"
SUPPORTS_REASONING=$(echo "$PROPS_RESPONSE" | jq -r '.chat_template_caps.supports_preserve_reasoning // false' 2>/dev/null)

# Use whichever source reports a non-none reasoning format
DETECTED_REASONING="none"
if [[ "$SLOT_REASONING" != "none" ]]; then
    DETECTED_REASONING="$SLOT_REASONING"
elif [[ "$PROPS_REASONING" != "none" ]]; then
    DETECTED_REASONING="$PROPS_REASONING"
fi

if [[ -z "$MODEL_REASONING" ]]; then
    if [[ "$DETECTED_REASONING" != "none" ]]; then
        MODEL_REASONING=true
        info "Auto-detected reasoning: enabled (format: ${DETECTED_REASONING})"
    elif [[ "$SUPPORTS_REASONING" == "true" ]]; then
        MODEL_REASONING=true
        info "Auto-detected reasoning: enabled (template supports reasoning)"
    else
        MODEL_REASONING=false
        info "Auto-detected reasoning: disabled"
    fi
fi

# Detect model family from model ID for thinking format selection
MODEL_ID_LOWER=$(echo "$MODEL_ID" | tr '[:upper:]' '[:lower:]')
if [[ "$MODEL_ID_LOWER" == *gemma-4* ]] || [[ "$MODEL_ID_LOWER" == *gemma4* ]]; then
    MODEL_FAMILY="gemma4"
elif [[ "$MODEL_ID_LOWER" == *qwen* ]]; then
    MODEL_FAMILY="qwen"
else
    MODEL_FAMILY="unknown"
fi

if [[ -z "$MODEL_THINKING_FORMAT" ]]; then
    if [[ "$DETECTED_REASONING" != "none" ]]; then
        # Server handles thinking natively via reasoning_format — don't double-parse
        MODEL_THINKING_FORMAT=""
        info "Thinking format: server-native (${DETECTED_REASONING}), no client-side parsing"
    elif [[ "$MODEL_FAMILY" == "gemma4" ]] && [[ "$SUPPORTS_REASONING" == "true" ]]; then
        # Gemma 4 with JINJA=0: PEG parser (peg-gemma4) handles thinking natively
        # via <|channel>thought...<channel|> tags. The /props reasoning_format may
        # report "none" but the PEG parser extracts reasoning regardless.
        MODEL_THINKING_FORMAT=""
        info "Thinking format: server-native (peg-gemma4 parser), no client-side parsing"
    elif [[ "$MODEL_FAMILY" == "gemma4" ]]; then
        # Gemma 4 but template doesn't support reasoning — likely an older llama.cpp build
        MODEL_THINKING_FORMAT=""
        warn "Gemma 4 detected but server may not support reasoning!"
        warn "Ensure llama.cpp build supports Gemma 4 PEG parser (b8000+)."
        warn "Add REASONING=on to the model config or pass --reasoning on."
    elif [[ "$MODEL_FAMILY" == "qwen" ]]; then
        # Qwen uses <think>...</think> tags — openclaw can parse these client-side
        MODEL_THINKING_FORMAT="qwen"
        info "Thinking format: client-side qwen (server reasoning not active)"
    else
        # Unknown model — try qwen format as a safe fallback (most common tag format)
        MODEL_THINKING_FORMAT="qwen"
        info "Thinking format: client-side qwen (fallback for unknown model family)"
    fi
fi
info "Model family: ${MODEL_FAMILY}"

# ─── Subagent server auto-detection ─────────────────────────────────────────
if [[ "$SUBAGENT_SAME_SERVER" -eq 1 ]]; then
    # Same server — reuse main model settings, provider name stays llama.cpp
    SUBAGENT_PROVIDER="$MODEL_PROVIDER"
    SUBAGENT_MODEL_ID="$MODEL_ID"
    SUBAGENT_MODEL_NAME="$MODEL_NAME"
    SUBAGENT_CONTEXT_WINDOW="$MODEL_CONTEXT_WINDOW"
    SUBAGENT_MAX_TOKENS="$MODEL_MAX_TOKENS"
    SUBAGENT_REASONING="$MODEL_REASONING"
    SUBAGENT_THINKING_FORMAT="$MODEL_THINKING_FORMAT"
    SUBAGENT_FAMILY="$MODEL_FAMILY"
    info "Subagent model: ${SUBAGENT_MODEL_ID} (same as main)"
else
    info "Checking subagent llama.cpp server at ${SUBAGENT_BASE_URL}..."
    SUBAGENT_MODELS_RESPONSE=$(curl -sf --connect-timeout 10 "${SUBAGENT_BASE_URL}/v1/models" \
        -H "Authorization: Bearer ${SUBAGENT_API_KEY}" 2>/dev/null) \
        || { warn "Cannot reach subagent server at ${SUBAGENT_BASE_URL} — it may be busy."; \
             warn "Continuing with config anyway (server can come online later)."; \
             SUBAGENT_MODELS_RESPONSE=""; }

    if [[ -z "$SUBAGENT_MODEL_ID" ]] && [[ -n "$SUBAGENT_MODELS_RESPONSE" ]]; then
        SUBAGENT_MODEL_ID=$(echo "$SUBAGENT_MODELS_RESPONSE" | jq -r '.data[0].id // empty')
    fi
    if [[ -z "$SUBAGENT_MODEL_ID" ]]; then
        warn "Could not auto-detect subagent model. Using main model ID as placeholder."
        SUBAGENT_MODEL_ID="$MODEL_ID"
    else
        info "Subagent auto-detected model: ${SUBAGENT_MODEL_ID}"
    fi
    SUBAGENT_MODEL_NAME="${SUBAGENT_MODEL_ID}"

    # Auto-detect subagent server capabilities
    SUBAGENT_SLOTS=$(curl -sf --connect-timeout 10 "${SUBAGENT_BASE_URL}/slots" \
        -H "Authorization: Bearer ${SUBAGENT_API_KEY}" 2>/dev/null || echo "[]")
    SUBAGENT_PROPS=$(curl -sf --connect-timeout 10 "${SUBAGENT_BASE_URL}/props" \
        -H "Authorization: Bearer ${SUBAGENT_API_KEY}" 2>/dev/null || echo "{}")

    # Subagent max tokens
    if [[ -z "$SUBAGENT_MAX_TOKENS" ]]; then
        SUBAGENT_MAX_TOKENS=16384
    fi

    # Subagent reasoning detection (same logic as main)
    SUB_SLOT_REASONING=$(echo "$SUBAGENT_SLOTS" | jq -r '.[0].reasoning_format // "none"' 2>/dev/null)
    SUB_PROPS_REASONING=$(echo "$SUBAGENT_PROPS" | jq -r '.default_generation_settings.params.reasoning_format // "none"' 2>/dev/null)
    SUB_SUPPORTS_REASONING=$(echo "$SUBAGENT_PROPS" | jq -r '.chat_template_caps.supports_preserve_reasoning // false' 2>/dev/null)

    SUB_DETECTED_REASONING="none"
    [[ "$SUB_SLOT_REASONING" != "none" ]] && SUB_DETECTED_REASONING="$SUB_SLOT_REASONING"
    [[ "$SUB_DETECTED_REASONING" == "none" ]] && [[ "$SUB_PROPS_REASONING" != "none" ]] && SUB_DETECTED_REASONING="$SUB_PROPS_REASONING"

    SUBAGENT_REASONING=false
    if [[ "$SUB_DETECTED_REASONING" != "none" ]]; then
        SUBAGENT_REASONING=true
    elif [[ "$SUB_SUPPORTS_REASONING" == "true" ]]; then
        SUBAGENT_REASONING=true
    fi

    # Subagent model family + thinking format
    SUB_ID_LOWER=$(echo "$SUBAGENT_MODEL_ID" | tr '[:upper:]' '[:lower:]')
    if [[ "$SUB_ID_LOWER" == *gemma-4* ]] || [[ "$SUB_ID_LOWER" == *gemma4* ]]; then
        SUBAGENT_FAMILY="gemma4"
    elif [[ "$SUB_ID_LOWER" == *qwen* ]]; then
        SUBAGENT_FAMILY="qwen"
    else
        SUBAGENT_FAMILY="unknown"
    fi

    SUBAGENT_THINKING_FORMAT=""
    if [[ "$SUB_DETECTED_REASONING" != "none" ]]; then
        SUBAGENT_THINKING_FORMAT=""
    elif [[ "$SUBAGENT_FAMILY" == "gemma4" ]] && [[ "$SUB_SUPPORTS_REASONING" == "true" ]]; then
        SUBAGENT_THINKING_FORMAT=""
    elif [[ "$SUBAGENT_FAMILY" == "qwen" ]]; then
        SUBAGENT_THINKING_FORMAT="qwen"
    else
        SUBAGENT_THINKING_FORMAT="qwen"
    fi

    info "Subagent reasoning: ${SUBAGENT_REASONING}, family: ${SUBAGENT_FAMILY}"
fi

SUBAGENT_MODEL_REF="${SUBAGENT_PROVIDER}/${SUBAGENT_MODEL_ID}"
info "Primary model ref: ${MODEL_REF}"
info "Subagent model ref: ${SUBAGENT_MODEL_REF}"

# ─── Gateway port ────────────────────────────────────────────────────────────
# The systemd service (written by build-switch.sh) hardcodes the gateway port.
# Use that as the source of truth to avoid config/service port mismatches.
# If the chosen port is held by another user's process, pick a free one instead.
GATEWAY_SERVICE_FILE="$HOME/.config/systemd/user/${AGENT_SERVICE_NAME}.service"
GATEWAY_PORT=$(gw_resolve_port "$GATEWAY_SERVICE_FILE" "$OPENCLAW_CONFIG")
info "Gateway port: ${GATEWAY_PORT}"

# Verify chosen port isn't held by another user's process
if gw_port_in_use "$GATEWAY_PORT"; then
    # Port is in use — check if it's ours (our systemd service) or someone else's
    systemctl --user stop "$AGENT_SERVICE_NAME" 2>/dev/null || true
    sleep 1
    if gw_port_in_use "$GATEWAY_PORT"; then
        # Still in use after stopping our service — another user holds it
        OLD_PORT="$GATEWAY_PORT"
        GATEWAY_PORT=$(gw_find_free_port "$GATEWAY_PORT" "$GATEWAY_PORT_START" "$GATEWAY_PORT_END") \
            || error "No free gateway port found in ${GATEWAY_PORT_START}-${GATEWAY_PORT_END}"
        if [[ "$GATEWAY_PORT" != "$OLD_PORT" ]]; then
            warn "Port ${OLD_PORT} held by another process — switching to ${GATEWAY_PORT}"
        fi
    fi
fi

if [[ "$GATEWAY_BIND" == "lan" ]]; then
    if systemctl is-active --quiet ufw 2>/dev/null; then
        warn "ufw is active; LAN clients may time out unless the local service range is allowed."
        warn "Run: sudo ufw allow from <your-lan-cidr> to any port 40700:40900 proto tcp"
        warn "Example: sudo ufw allow from <your-network>/24 to any port 40700:40900 proto tcp"
    fi
fi

# ─── Step 1: Base gateway config ────────────────────────────────────────────
# Write directly via jq instead of 4 separate `openclaw config set` calls,
# each of which spawns a full Node.js process (~2-3s each).
mkdir -p "$OPENCLAW_STATE_DIR"
[[ -f "$OPENCLAW_CONFIG" ]] || echo '{}' > "$OPENCLAW_CONFIG"
stage_config
info "Configuring gateway (mode=local, bind=${GATEWAY_BIND}, port=${GATEWAY_PORT}, tls=enabled)..."
if [[ "$GATEWAY_BIND" == "lan" ]]; then
    GATEWAY_ORIGIN_HOSTS_JSON=$(detect_gateway_origin_hosts \
        | jq -R -s -c 'split("\n") | map(select(length > 0)) | unique')
else
    GATEWAY_ORIGIN_HOSTS_JSON="[]"
fi
CONTROL_UI_ALLOWED_ORIGINS=$(jq -c -n \
    --arg port "$GATEWAY_PORT" \
    --argjson hosts "$GATEWAY_ORIGIN_HOSTS_JSON" \
    '[
        "https://localhost:\($port)",
        "https://127.0.0.1:\($port)"
    ] + ($hosts | map("https://\(.)" + ":\($port)") )')
cfg --arg mode "local" \
   --arg bind "$GATEWAY_BIND" \
   --argjson port "$GATEWAY_PORT" \
   --arg thinkDefault "$THINKING_DEFAULT" \
   --argjson sessionIdleMinutes "$SESSION_IDLE_MINUTES" \
   --argjson controlUiOrigins "$CONTROL_UI_ALLOWED_ORIGINS" \
   --arg authMode "$(if [[ "$GATEWAY_BIND" == "lan" ]]; then echo "token-password"; else echo "token"; fi)" \
   '.gateway.mode = $mode |
    .gateway.bind = $bind |
    .gateway.port = $port |
    .gateway.auth.mode = $authMode |
    .gateway.tls.enabled = true |
    .gateway.tls.autoGenerate = true |
    del(.gateway.tailscale) |
    .gateway.controlUi.allowedOrigins = (
        reduce ($controlUiOrigins[]) as $origin
            ([]; if any(.[]; ascii_downcase == ($origin | ascii_downcase)) then . else . + [$origin] end)
    ) |
    .gateway.controlUi.dangerouslyDisableDeviceAuth = true |
    .gateway.controlUi.allowInsecureAuth = false |
    .session.reset.mode = "idle" |
    .session.reset.idleMinutes = $sessionIdleMinutes |
    .agents.defaults.thinkingDefault = $thinkDefault'
info "Control UI origins: $(echo "$CONTROL_UI_ALLOWED_ORIGINS" | jq -r 'join(", ")')"
if [[ "$GATEWAY_BIND" == "lan" ]]; then
    info "LAN Control UI device pairing is disabled; remote clients must provide both gateway token and password."
fi
info "Default thinking level: ${THINKING_DEFAULT}"
info "Session reset: idle after ${SESSION_IDLE_MINUTES} minutes (~90 days)"

GATEWAY_TOKEN=$(config_string_or_empty '.gateway.auth.token // empty' "$CONFIG_STAGING")
GATEWAY_AUTH_PASSWORD=$(config_string_or_empty '.gateway.auth.password // empty' "$CONFIG_STAGING")
if [[ -z "$GATEWAY_TOKEN" ]]; then
    GATEWAY_TOKEN=$(openssl rand -hex 24)
    cfg --arg token "$GATEWAY_TOKEN" '.gateway.auth.token = $token'
    info "Generated gateway auth token."
fi
if [[ "$GATEWAY_BIND" == "lan" ]]; then
    if [[ -n "$GATEWAY_PASSWORD" ]]; then
        GATEWAY_AUTH_PASSWORD="$GATEWAY_PASSWORD"
    fi
    if [[ -z "$GATEWAY_AUTH_PASSWORD" ]]; then
        GATEWAY_AUTH_PASSWORD=$(openssl rand -hex 24)
        info "Generated gateway auth password."
    fi
    cfg --arg password "$GATEWAY_AUTH_PASSWORD" '.gateway.auth.password = $password'
fi

# ─── Step 2: Register llama.cpp provider ─────────────────────────────────────
# Write directly to config via jq — `openclaw config set` with bracket notation
# (models.providers["llama.cpp"]) stores the brackets as part of the key name,
# producing a broken key in the JSON.
info "Registering provider '${MODEL_PROVIDER}' with model '${MODEL_ID}'..."

PROVIDER_JSON=$(jq -n \
    --arg baseUrl    "$LLAMA_CPP_BASE_URL" \
    --arg apiKey     "$LLAMA_CPP_API_KEY" \
    --arg modelId    "$MODEL_ID" \
    --arg modelName  "$MODEL_NAME" \
    --argjson ctxWin "$MODEL_CONTEXT_WINDOW" \
    --argjson maxTok "$MODEL_MAX_TOKENS" \
    --arg thinkFmt   "$MODEL_THINKING_FORMAT" \
    --argjson reasoning "$MODEL_REASONING" \
    '{
        baseUrl: $baseUrl,
        apiKey:  $apiKey,
        api:     "anthropic-messages",
        models: [{
            id:        $modelId,
            name:      $modelName,
            reasoning: $reasoning,
            input:     ["text"],
            cost:      {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
            contextWindow: $ctxWin,
            maxTokens:     $maxTok,
            compat: (
                if $thinkFmt != "" then {thinkingFormat: $thinkFmt} else {} end
            )
        }]
    }')

cfg --arg provider "$MODEL_PROVIDER" \
   --argjson entry "$PROVIDER_JSON" \
   '.models.providers[$provider] = $entry'

# Set the selected local model as the primary agent model. Preserve existing
# model fallbacks and allowlist entries, but make this init run authoritative
# for the default model selection.
info "Setting primary default model: ${MODEL_REF}"
cfg --arg modelRef "$MODEL_REF" \
   '.agents.defaults.model = (
        (if (.agents.defaults.model | type) == "object" then .agents.defaults.model else {} end)
        + { primary: $modelRef }
    ) |
    .agents.defaults.models = (
        (if (.agents.defaults.models | type) == "object" then .agents.defaults.models else {} end)
        + { ($modelRef): ((.agents.defaults.models[$modelRef] // {}) | if type == "object" then . else {} end) }
    )'

# Register subagent provider (separate entry when using a different server)
if [[ "$SUBAGENT_SAME_SERVER" -eq 0 ]]; then
    info "Registering subagent provider '${SUBAGENT_PROVIDER}' with model '${SUBAGENT_MODEL_ID}'..."
    SUBAGENT_PROVIDER_JSON=$(jq -n \
        --arg baseUrl    "$SUBAGENT_BASE_URL" \
        --arg apiKey     "$SUBAGENT_API_KEY" \
        --arg modelId    "$SUBAGENT_MODEL_ID" \
        --arg modelName  "$SUBAGENT_MODEL_NAME" \
        --argjson ctxWin "$SUBAGENT_CONTEXT_WINDOW" \
        --argjson maxTok "$SUBAGENT_MAX_TOKENS" \
        --arg thinkFmt   "$SUBAGENT_THINKING_FORMAT" \
        --argjson reasoning "$SUBAGENT_REASONING" \
        '{
            baseUrl: $baseUrl,
            apiKey:  $apiKey,
            api:     "anthropic-messages",
            models: [{
                id:        $modelId,
                name:      $modelName,
                reasoning: $reasoning,
                input:     ["text"],
                cost:      {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
                contextWindow: $ctxWin,
                maxTokens:     $maxTok,
                compat: (
                    if $thinkFmt != "" then {thinkingFormat: $thinkFmt} else {} end
                )
            }]
        }')

    cfg --arg provider "$SUBAGENT_PROVIDER" \
       --argjson entry "$SUBAGENT_PROVIDER_JSON" \
       '.models.providers[$provider] = $entry'
fi

# Set the global subagent default model
info "Setting subagent default model: ${SUBAGENT_MODEL_REF}"
cfg --arg subModel "$SUBAGENT_MODEL_REF" \
   '.agents.defaults.subagents.model = $subModel |
    .agents.defaults.models[$subModel] = {}'

# ─── Step 2b: Isolate signal-cli HTTP daemon ──────────────────────────────────
# A local httpUrl (especially the signal-cli default 127.0.0.1:8080) can attach
# this gateway to another user's already-running signal-cli daemon. If Signal is
# configured locally, make FreeClaw spawn its own daemon on a free port instead.
SIGNAL_CONFIGURED=$(jq -r '
    if (.channels.signal? | type) == "object" and (.channels.signal.enabled // true) != false then
        "yes"
    else
        "no"
    end
' "$CONFIG_STAGING" 2>/dev/null || echo "no")

if [[ "$SIGNAL_CONFIGURED" == "yes" ]]; then
    SIGNAL_EXTERNAL=$(jq -r '
        def external:
            (.httpEndpointFile? // "") != "" or (.archiveRaw? != null);
        def any_account_external:
            (.accounts? // {} | to_entries | any(.value | type == "object" and external));
        if (.channels.signal | external) or (.channels.signal | any_account_external) then
            "yes"
        else
            "no"
        end
    ' "$CONFIG_STAGING" 2>/dev/null || echo "no")

    SIGNAL_LOCAL_HTTP=$(jq -r '
        def local_url:
            type == "string" and test("^http://(127\\.0\\.0\\.1|localhost|\\[::1\\])(:[0-9]+)?/?$");
        def local_config:
            ((.httpUrl? | local_url) or ((.httpUrl? // "") == ""));
        def any_account_local:
            (.accounts? // {} | to_entries | any(.value | type == "object" and local_config));
        if (.channels.signal | local_config) or (.channels.signal | any_account_local) then
            "yes"
        else
            "no"
        end
    ' "$CONFIG_STAGING" 2>/dev/null || echo "no")

    SIGNAL_CLI_PATH=$(jq -r '.channels.signal.cliPath // "signal-cli"' "$CONFIG_STAGING" 2>/dev/null || echo "signal-cli")
    if [[ "$SIGNAL_EXTERNAL" == "yes" ]]; then
        info "Signal uses an external endpoint/supervisor; leaving Signal daemon config unchanged."
    elif [[ "$SIGNAL_LOCAL_HTTP" == "yes" ]] && command -v "$SIGNAL_CLI_PATH" &>/dev/null; then
        EXISTING_SIGNAL_PORT=$(jq -r '
            .channels.signal.httpPort //
            (.channels.signal.httpUrl // "" | try capture(":(?<port>[0-9]+)(/)?$").port? catch null | tonumber?) //
            8080
        ' "$CONFIG_STAGING" 2>/dev/null || echo "8080")
        SIGNAL_HTTP_PORT=$(gw_find_free_port "$EXISTING_SIGNAL_PORT" 18080 18180) \
            || error "No free signal-cli HTTP port found in 18080-18180"
        SIGNAL_HTTP_HOST="127.0.0.1"

        if [[ "$SIGNAL_HTTP_PORT" != "$EXISTING_SIGNAL_PORT" ]]; then
            warn "Signal HTTP port ${EXISTING_SIGNAL_PORT} is already in use — switching to ${SIGNAL_HTTP_PORT}"
        else
            info "Signal HTTP port: ${SIGNAL_HTTP_PORT}"
        fi

        cfg --arg host "$SIGNAL_HTTP_HOST" --argjson port "$SIGNAL_HTTP_PORT" '
            def local_url:
                type == "string" and test("^http://(127\\.0\\.0\\.1|localhost|\\[::1\\])(:[0-9]+)?/?$");
            def should_patch:
                ((.httpEndpointFile? // "") == "") and
                (.archiveRaw? == null) and
                ((.httpUrl? | local_url) or ((.httpUrl? // "") == ""));
            def patch_signal:
                if type == "object" and should_patch then
                    .httpHost = $host |
                    .httpPort = $port |
                    .autoStart = true |
                    del(.httpUrl)
                else
                    .
                end;
            .channels.signal |= (
                patch_signal |
                if (.accounts? | type) == "object" then
                    .accounts |= with_entries(.value |= patch_signal)
                else
                    .
                end
            )
        '
        info "Configured Signal to auto-start its own signal-cli daemon at ${SIGNAL_HTTP_HOST}:${SIGNAL_HTTP_PORT}"
    elif [[ "$SIGNAL_LOCAL_HTTP" == "yes" ]]; then
        warn "Signal is configured locally but '$SIGNAL_CLI_PATH' was not found; leaving Signal daemon config unchanged."
    fi
fi

# ─── Step 2c: Configure local embedding provider ─────────────────────────────
# node-llama-cpp is installed as an optionalDependency. Point memory search at
# it so semantic recall works without any cloud API keys. (Staged here so it
# rides the same atomic commit as the rest of the config.)
CURRENT_MEM_PROVIDER=$(jq -r '.agents.defaults.memorySearch.provider // empty' "$CONFIG_STAGING" 2>/dev/null || true)
if [[ -z "$CURRENT_MEM_PROVIDER" ]] || [[ "$FORCE" -eq 1 ]]; then
    cfg '.agents.defaults.memorySearch.provider = "local"'
    info "Memory search provider set to: local (node-llama-cpp)"
    info "Embedding model will be downloaded on first use (~600MB)"
else
    info "Memory search provider already set to: $CURRENT_MEM_PROVIDER (skipping — use --force to override)"
fi

# ─── Commit point ────────────────────────────────────────────────────────────
# Everything config-content-related is staged; publish it in one rename. The
# steps below (service install, token embedding, restart) need the real file.
commit_staged_config

# ─── Step 3: Gateway service & auth token ────────────────────────────────────
# build-switch.sh owns the systemd unit; this script only patches env values
# (token, port, NODE_COMPILE_CACHE) into it. If no unit exists (an install
# that never ran build-switch), generate one with the shared lib generator —
# the SAME generator build-switch uses, so default and named agents get
# identical units. `openclaw gateway install --force` is intentionally gone:
# it overwrote build-switch's unit with a third-party variant (different node
# binary, no compile cache) on every init run.
info "Setting up gateway service..."
gw_stop_service "$AGENT_SERVICE_NAME"
gw_kill_stale_gateways
mkdir -p "$HOME/.config/systemd/user"

# Token normally exists in config already (staged phase ensures one); this
# also covers configs whose token is an unresolved SecretRef marker.
GATEWAY_TOKEN=$(config_string_or_empty '.gateway.auth.token // empty' "$OPENCLAW_CONFIG")
if [[ -z "$GATEWAY_TOKEN" ]]; then
    GATEWAY_TOKEN=$(openssl rand -hex 32)
    jq --arg token "$GATEWAY_TOKEN" '.gateway.auth.token = $token' \
        "$OPENCLAW_CONFIG" > "$OPENCLAW_CONFIG.tmp.$$" && mv "$OPENCLAW_CONFIG.tmp.$$" "$OPENCLAW_CONFIG"
    info "Generated gateway auth token."
fi

if [[ ! -f "$GATEWAY_SERVICE_FILE" ]]; then
    if [[ -n "$AGENT_NAME" ]]; then
        error "Service file not found: $GATEWAY_SERVICE_FILE — run build-switch.sh first"
    fi
    warn "No gateway service unit found — generating one (build-switch.sh normally owns this)."
    PKG_VERSION=$(jq -r '.version // "unknown"' "$FREECLAW_DIR/package.json" 2>/dev/null || echo "unknown")
    REPO_BRANCH=$(git -C "$FREECLAW_DIR" branch --show-current 2>/dev/null || echo "")
    GW_SERVICE_FILE="$GATEWAY_SERVICE_FILE" \
    GW_SERVICE_NAME="$AGENT_SERVICE_NAME" \
    GW_NODE_PATH="$OPENCLAW_NODE" \
    GW_ENTRYPOINT="$OPENCLAW_ENTRYPOINT" \
    GW_STATE_DIR="$OPENCLAW_STATE_DIR" \
    GW_PORT="$GATEWAY_PORT" \
    GW_VERSION_STRING="$(gw_version_for_branch "$REPO_BRANCH" "$PKG_VERSION")" \
    GW_CMD_NAME="$AGENT_CMD_NAME" \
    GW_TOKEN="$GATEWAY_TOKEN" \
    GW_AGENT_NAME="$AGENT_NAME" \
        gw_write_service_unit
else
    systemd_set_env "$GATEWAY_SERVICE_FILE" "OPENCLAW_GATEWAY_TOKEN" "$GATEWAY_TOKEN" "OPENCLAW_GATEWAY_PORT"
    info "Embedded gateway token in existing service unit (unit preserved — build-switch.sh owns it)."
fi

# Ensure service file port matches the resolved GATEWAY_PORT (may have changed
# if the original port was held by another user).
if [[ -f "$GATEWAY_SERVICE_FILE" ]]; then
    sed -i "s|--port [0-9]*|--port ${GATEWAY_PORT}|" "$GATEWAY_SERVICE_FILE"
    sed -i "s|OPENCLAW_GATEWAY_PORT=[0-9]*|OPENCLAW_GATEWAY_PORT=${GATEWAY_PORT}|" "$GATEWAY_SERVICE_FILE"
fi

# ─── V8 compile cache ─────────────────────────────────────────────────────
# The 5.8MB reply bundle causes a 40+ second event loop block on first load
# because V8 has to parse/compile it. NODE_COMPILE_CACHE persists compiled
# bytecode across runs, eliminating the block after the first invocation.
# Without this, the gateway WS handshake times out because the client can't
# process messages while V8 is compiling.
V8_CACHE_DIR="$HOME/.openclaw/v8-compile-cache"
mkdir -p "$V8_CACHE_DIR"

# Add to systemd service
if [[ -f "$GATEWAY_SERVICE_FILE" ]]; then
    systemd_set_env "$GATEWAY_SERVICE_FILE" "NODE_COMPILE_CACHE" "$V8_CACHE_DIR" "OPENCLAW_GATEWAY_PORT"
fi

# Add to user profile so CLI invocations also use the cache
PROFILE_FILE="$HOME/.profile"
if [[ -f "$PROFILE_FILE" ]] && ! grep -q "NODE_COMPILE_CACHE" "$PROFILE_FILE"; then
    printf '\n# V8 compile cache for openclaw (speeds up startup)\nexport NODE_COMPILE_CACHE="%s"\n' \
        "$V8_CACHE_DIR" >> "$PROFILE_FILE"
    info "Added NODE_COMPILE_CACHE to ~/.profile"
fi
# Also export for the current session
export NODE_COMPILE_CACHE="$V8_CACHE_DIR"

# Pre-warm the V8 compile cache by loading the heavy module once.
# This takes ~3s for the initial parse + ~40s for deferred compilation.
# After this, subsequent loads complete in <3s with no event loop block.
OPENCLAW_BIN=$(command -v openclaw_cmd 2>/dev/null || command -v openclaw 2>/dev/null || true)
if [[ -n "$OPENCLAW_BIN" ]]; then
    OPENCLAW_DIST_DIR=$(dirname "$(readlink -f "$OPENCLAW_BIN")")/../dist
    if [[ -d "$OPENCLAW_DIST_DIR" ]]; then
        # Find the reply chunk (the 5.8MB bundle that causes the block)
        REPLY_CHUNK=$(ls "$OPENCLAW_DIST_DIR"/reply-*.js 2>/dev/null | head -1)
        if [[ -n "$REPLY_CHUNK" ]]; then
            info "Pre-warming V8 compile cache (this takes ~45s on first run)..."
            # Use dynamic import() to match how the bundle is loaded (ESM)
            timeout 90 node --input-type=module -e "await import('$REPLY_CHUNK')" 2>/dev/null || true
            info "V8 compile cache warmed."
        fi
    fi
fi

# ─── Step 4: Write agent auth-profiles.json ──────────────────────────────────
mkdir -p "$AGENT_DIR"
SUBAGENT_DIR="$OPENCLAW_STATE_DIR/agents/main/subagent"
info "Writing auth-profiles.json..."
if [[ "$SUBAGENT_SAME_SERVER" -eq 0 ]]; then
    # Main agent gets both providers
    jq -n \
        --arg provider    "$MODEL_PROVIDER" \
        --arg key         "$LLAMA_CPP_API_KEY" \
        --arg subProvider "$SUBAGENT_PROVIDER" \
        --arg subKey      "$SUBAGENT_API_KEY" \
        '{
            version: 1,
            profiles: {
                (($provider) + ":default"): {
                    type:     "api_key",
                    provider: $provider,
                    key:      $key
                },
                (($subProvider) + ":default"): {
                    type:     "api_key",
                    provider: $subProvider,
                    key:      $subKey
                }
            }
        }' > "$AGENT_DIR/auth-profiles.json.tmp.$$" && mv "$AGENT_DIR/auth-profiles.json.tmp.$$" "$AGENT_DIR/auth-profiles.json"

    # Subagent needs its own auth-profiles.json with the subagent provider
    mkdir -p "$SUBAGENT_DIR"
    info "Writing subagent auth-profiles.json..."
    jq -n \
        --arg provider    "$MODEL_PROVIDER" \
        --arg key         "$LLAMA_CPP_API_KEY" \
        --arg subProvider "$SUBAGENT_PROVIDER" \
        --arg subKey      "$SUBAGENT_API_KEY" \
        '{
            version: 1,
            profiles: {
                (($provider) + ":default"): {
                    type:     "api_key",
                    provider: $provider,
                    key:      $key
                },
                (($subProvider) + ":default"): {
                    type:     "api_key",
                    provider: $subProvider,
                    key:      $subKey
                }
            }
        }' > "$SUBAGENT_DIR/auth-profiles.json.tmp.$$" && mv "$SUBAGENT_DIR/auth-profiles.json.tmp.$$" "$SUBAGENT_DIR/auth-profiles.json"
else
    jq -n \
        --arg provider "$MODEL_PROVIDER" \
        --arg key      "$LLAMA_CPP_API_KEY" \
        '{
            version: 1,
            profiles: {
                (($provider) + ":default"): {
                    type:     "api_key",
                    provider: $provider,
                    key:      $key
                }
            }
        }' > "$AGENT_DIR/auth-profiles.json.tmp.$$" && mv "$AGENT_DIR/auth-profiles.json.tmp.$$" "$AGENT_DIR/auth-profiles.json"
fi

# ─── Step 5: Merge llama.cpp into agent models.json ──────────────────────────
info "Updating agent models.json..."
MODELS_JSON="$AGENT_DIR/models.json"

MODEL_ENTRY=$(jq -n \
    --arg baseUrl    "$LLAMA_CPP_BASE_URL" \
    --arg apiKey     "$LLAMA_CPP_API_KEY" \
    --arg modelId    "$MODEL_ID" \
    --arg modelName  "$MODEL_NAME" \
    --argjson ctxWin "$MODEL_CONTEXT_WINDOW" \
    --argjson maxTok "$MODEL_MAX_TOKENS" \
    --arg thinkFmt   "$MODEL_THINKING_FORMAT" \
    --argjson reasoning "$MODEL_REASONING" \
    '{
        baseUrl: $baseUrl,
        apiKey:  $apiKey,
        api:     "anthropic-messages",
        models: [{
            id:        $modelId,
            name:      $modelName,
            reasoning: $reasoning,
            input:     ["text"],
            cost:      {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
            contextWindow: $ctxWin,
            maxTokens:     $maxTok,
            compat: (
                if $thinkFmt != "" then {thinkingFormat: $thinkFmt} else {} end
            )
        }]
    }')

# Build the optional subagent entry first so both providers land in ONE atomic
# write — the old two-pass update could die between passes and leave the file
# with only half the providers.
SUBAGENT_MODEL_ENTRY="null"
if [[ "$SUBAGENT_SAME_SERVER" -eq 0 ]]; then
    info "Adding subagent provider to agent models.json..."
    SUBAGENT_MODEL_ENTRY=$(jq -n \
        --arg baseUrl    "$SUBAGENT_BASE_URL" \
        --arg apiKey     "$SUBAGENT_API_KEY" \
        --arg modelId    "$SUBAGENT_MODEL_ID" \
        --arg modelName  "$SUBAGENT_MODEL_NAME" \
        --argjson ctxWin "$SUBAGENT_CONTEXT_WINDOW" \
        --argjson maxTok "$SUBAGENT_MAX_TOKENS" \
        --arg thinkFmt   "$SUBAGENT_THINKING_FORMAT" \
        --argjson reasoning "$SUBAGENT_REASONING" \
        '{
            baseUrl: $baseUrl,
            apiKey:  $apiKey,
            api:     "anthropic-messages",
            models: [{
                id:        $modelId,
                name:      $modelName,
                reasoning: $reasoning,
                input:     ["text"],
                cost:      {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
                contextWindow: $ctxWin,
                maxTokens:     $maxTok,
                compat: (
                    if $thinkFmt != "" then {thinkingFormat: $thinkFmt} else {} end
                )
            }]
        }')
fi

# Single-pass atomic update: merge into the existing file when present.
MODELS_BASE='{}'
[[ -f "$MODELS_JSON" ]] && MODELS_BASE=$(cat "$MODELS_JSON")
printf '%s' "$MODELS_BASE" | jq \
    --arg provider    "$MODEL_PROVIDER" \
    --argjson entry   "$MODEL_ENTRY" \
    --arg subProvider "$SUBAGENT_PROVIDER" \
    --argjson subEntry "$SUBAGENT_MODEL_ENTRY" \
    '.providers[$provider] = $entry
     | (if $subEntry != null then .providers[$subProvider] = $subEntry else . end)' \
    > "$MODELS_JSON.tmp.$$" && mv "$MODELS_JSON.tmp.$$" "$MODELS_JSON"

# Note: node_modules patches (scripts/patch-*.sh) are applied at build time
# (Makefile apply-node-modules-patches, also run by build-switch.sh) and ship
# inside the package. This script only swaps inference endpoints/models and
# must not touch node_modules - on packaged installs that tree is root-owned
# and pacman-managed.

# ─── Step 5c: Clean up orphaned agents and stale locks ───────────────────────
gw_cleanup_agent_orphans "$OPENCLAW_STATE_DIR"

# ─── Step 6: Start gateway ───────────────────────────────────────────────────
info "Starting gateway service..."
systemctl --user daemon-reload
# Enable for boot autostart — `openclaw gateway install` used to do this;
# idempotent, and required now that we generate/patch the unit ourselves.
systemctl --user enable "${AGENT_SERVICE_NAME}.service" 2>/dev/null || true
systemctl --user restart "${AGENT_SERVICE_NAME}.service"
GATEWAY_RESTARTED=1

# ─── Step 7: Verify ──────────────────────────────────────────────────────────
info "Waiting for gateway to come up..."
sleep 5

if ! systemctl --user is-active "${AGENT_SERVICE_NAME}.service" &>/dev/null; then
    error "Gateway failed to start. Logs: journalctl --user -u ${AGENT_SERVICE_NAME}.service -n 30"
fi

info "Gateway is running."
if [[ -n "$AGENT_NAME" ]]; then
    "$HOME/.local/bin/$AGENT_CMD_NAME" gateway status --deep 2>&1 | grep -E "RPC probe|Runtime:|Gateway:" || true
else
    openclaw_cmd gateway status --deep 2>&1 | grep -E "RPC probe|Runtime:|Gateway:" || true
fi

# ─── Step 7b: Verify the active config matches what was requested ────────────
# The gateway loads openclaw.json at startup, so after the restart above the
# on-disk values ARE the active values. Assert them so a silently-lost setting
# (the historical failure mode) becomes a loud error instead.
verify_config_value() {
    local label="$1" expected="$2" actual="$3"
    if [[ "$actual" != "$expected" ]]; then
        error "VERIFY FAILED: ${label} is '${actual}' but this run requested '${expected}'. The gateway is running with WRONG settings — re-run this script and watch for earlier errors."
    fi
}
ACTIVE_BASE_URL=$(jq -r --arg p "$MODEL_PROVIDER" '.models.providers[$p].baseUrl // empty' "$OPENCLAW_CONFIG")
ACTIVE_CTX=$(jq -r --arg p "$MODEL_PROVIDER" --arg id "$MODEL_ID" \
    '.models.providers[$p].models[]? | select(.id == $id) | .contextWindow // empty' "$OPENCLAW_CONFIG")
ACTIVE_PRIMARY=$(jq -r '.agents.defaults.model.primary // empty' "$OPENCLAW_CONFIG")
verify_config_value "provider baseUrl"        "$LLAMA_CPP_BASE_URL"    "$ACTIVE_BASE_URL"
verify_config_value "model contextWindow"     "$MODEL_CONTEXT_WINDOW"  "$ACTIVE_CTX"
verify_config_value "primary model"           "$MODEL_REF"             "$ACTIVE_PRIMARY"
if [[ "$SUBAGENT_SAME_SERVER" -eq 0 ]]; then
    ACTIVE_SUB_CTX=$(jq -r --arg p "$SUBAGENT_PROVIDER" --arg id "$SUBAGENT_MODEL_ID" \
        '.models.providers[$p].models[]? | select(.id == $id) | .contextWindow // empty' "$OPENCLAW_CONFIG")
    verify_config_value "subagent contextWindow" "$SUBAGENT_CONTEXT_WINDOW" "$ACTIVE_SUB_CTX"
fi
info "VERIFIED: contextWindow=${ACTIVE_CTX} active on ${ACTIVE_BASE_URL} (${MODEL_PROVIDER}), primary=${ACTIVE_PRIMARY}"

info ""
info "=== Setup complete ==="
info "Provider        : ${MODEL_PROVIDER}"
info "Model           : ${MODEL_ID}"
info "Endpoint        : ${LLAMA_CPP_BASE_URL}"
info "Gateway port    : ${GATEWAY_PORT}"
if [[ "$GATEWAY_BIND" == "loopback" ]]; then
    info "Gateway URL     : https://127.0.0.1:${GATEWAY_PORT}/"
else
    GATEWAY_URL_HOSTS=$(detect_gateway_origin_hosts)
    if [[ -n "$GATEWAY_URL_HOSTS" ]]; then
        while IFS= read -r gateway_url_host; do
            [[ -n "$gateway_url_host" ]] && info "Gateway URL     : https://${gateway_url_host}:${GATEWAY_PORT}/"
        done <<< "$GATEWAY_URL_HOSTS"
    fi
fi
info ""
info "Subagent provider : ${SUBAGENT_PROVIDER}"
info "Subagent model    : ${SUBAGENT_MODEL_ID}"
info "Subagent endpoint : ${SUBAGENT_BASE_URL}"
info "Subagent ref      : ${SUBAGENT_MODEL_REF}"
info ""
info "Run '$AGENT_CMD_NAME tui' to start chatting."

# ─── Record launch history ───────────────────────────────────────────────────
# Only reached on success (set -e). Read back by the preset menu up top.
printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -Iseconds)" "${AGENT_NAME:--}" \
    "$LLAMA_CPP_HOST" "$LLAMA_CPP_PORT" "${MODEL_CONTEXT_WINDOW:-}" \
    "$SUBAGENT_HOST" "$SUBAGENT_PORT" "$GATEWAY_BIND" >> "$LLAMACPP_INIT_HISTORY"
