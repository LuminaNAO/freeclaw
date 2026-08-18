#!/usr/bin/env bash
#
# build-switch - Build and switch between freeclaw branches
# Usage: build-switch.sh [branch|status] [agent-name]
#
# Branch is any local branch in the freeclaw repo. With no args, launches
# an interactive picker listing available branches. Use `status` to show
# gateway/build state.
#
# When an agent name is provided (e.g. "bob"), the install is isolated:
#   - State dir:  ~/.bob  (instead of ~/.openclaw)
#   - Command:    bob     (instead of openclaw)
#   - Service:    bob-gateway.service
#   - Port:       randomised (no adjacent repeated digits)
#

set -e

# ============================================================================
# CONFIGURATION
# ============================================================================

OPENCLAW_BASE="$HOME/code/freeclaw"

# Node.js major version required by openclaw
NODE_MAJOR=24


# Agent config — set by init_agent(), called from main after args are resolved.
AGENT_NAME=""
AGENT_STATE_DIR=""
AGENT_SERVICE_NAME=""
AGENT_CMD_NAME=""
OPENCLAW_SERVICE=""
PNPM_BIN_DIR=""

init_agent() {
    AGENT_NAME="${1:-}"
    if [[ -n "$AGENT_NAME" ]]; then
        AGENT_STATE_DIR="$HOME/.$AGENT_NAME"
        AGENT_SERVICE_NAME="${AGENT_NAME}-gateway"
        AGENT_CMD_NAME="$AGENT_NAME"
    else
        AGENT_STATE_DIR="$HOME/.openclaw"
        AGENT_SERVICE_NAME="openclaw-gateway"
        AGENT_CMD_NAME="openclaw"
    fi
    OPENCLAW_SERVICE="$HOME/.config/systemd/user/${AGENT_SERVICE_NAME}.service"
}

# ============================================================================
# COLORS & LOGGING
# ============================================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()   { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }
info()  { echo -e "${BLUE}[INFO]${NC} $1"; }

# Shared gateway/service helpers (single owner of the systemd unit generator,
# port policy, and process/lock cleanup — also sourced by llamacpp-init.sh).
LIB_GATEWAY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib-gateway.sh"
if [[ ! -f "$LIB_GATEWAY" ]]; then
    error "Missing $LIB_GATEWAY — this script ships with lib-gateway.sh; restore it from the repo."
    exit 1
fi
source "$LIB_GATEWAY"

# ============================================================================
# BRANCH HELPERS
# ============================================================================

# List local branch names in the repo (one per line, sorted).
list_branches() {
    git -C "$OPENCLAW_BASE" branch --format='%(refname:short)' | sort
}

# Check that a branch exists locally.
branch_exists() {
    git -C "$OPENCLAW_BASE" show-ref --verify --quiet "refs/heads/$1" 2>/dev/null
}

# ============================================================================
# INTERACTIVE SELECTION
# ============================================================================

select_branch() {
    local branches=()
    while IFS= read -r b; do
        [[ -n "$b" ]] && branches+=("$b")
    done < <(list_branches)

    if [[ ${#branches[@]} -eq 0 ]]; then
        error "No branches found in $OPENCLAW_BASE"
        exit 1
    fi

    echo "" >&2
    echo "Available branches:" >&2
    local i
    for i in "${!branches[@]}"; do
        printf "  %2d) %s\n" $((i + 1)) "${branches[$i]}" >&2
    done
    echo "" >&2
    read -rp "Select branch [1-${#branches[@]}]: " choice

    if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#branches[@]} )); then
        echo "${branches[$((choice - 1))]}"
    else
        error "Invalid selection: $choice"
        exit 1
    fi
}

select_agent() {
    echo "" >&2
    read -rp "Agent name (leave empty for default openclaw): " name
    echo "$name"
}

# ============================================================================
# USAGE
# ============================================================================

usage() {
    cat <<EOF
Usage: $(basename "$0") [branch] [agent-name] [--no-restart]

  branch       - any local branch in $OPENCLAW_BASE
  status       - show current build and gateway status
  --no-restart - build + write service, but skip the final gateway restart.
                 Use in the two-script procedure (build-switch + llamacpp-init):
                 llamacpp-init restarts the gateway anyway, so restarting here
                 just boots it once on the old config for nothing.

If no arguments are given, branch and agent name are selected interactively.

Agent Name (optional):
  When provided, creates an isolated install with its own state dir,
  shell command, systemd service, and gateway port.

Examples:
  $(basename "$0")                       # Interactive mode
  $(basename "$0") freeclaw              # Build freeclaw branch
  $(basename "$0") freeclaw-dev          # Build freeclaw-dev branch
  $(basename "$0") main                  # Build vanilla upstream
  $(basename "$0") freeclaw bob          # Build as agent "bob" (~/.bob)
  $(basename "$0") status                # Check default openclaw status
  $(basename "$0") status bob            # Check agent "bob" status

Available branches:
EOF
    if [[ -d "$OPENCLAW_BASE/.git" ]]; then
        list_branches | sed 's/^/  /'
    else
        echo "  (repo not found at $OPENCLAW_BASE)"
    fi
    echo ""
    exit 1
}

# ============================================================================
# ENVIRONMENT SETUP
# ============================================================================

setup_env() {
    # Some shells can inherit a stale NVM_DIR from another account. Normalize it
    # before sourcing nvm so installs and lookups stay inside the current home.
    if [[ -n "${NVM_DIR:-}" && "$NVM_DIR" != "$HOME/.nvm" && "$NVM_DIR" != "$HOME"/.config/nvm ]]; then
        export NVM_DIR="$HOME/.nvm"
    fi

    # Source nvm so we can use it in this script
    if [ -f "$HOME/.nvm/nvm.sh" ]; then
        source "$HOME/.nvm/nvm.sh"
    elif [ -f /usr/share/nvm/init-nvm.sh ]; then
        source /usr/share/nvm/init-nvm.sh
    fi

    # Always use current user's home for pnpm paths — never hardcode usernames.
    # pnpm v11 uses $PNPM_HOME/bin as its configured global bin directory.
    export PNPM_HOME="$HOME/.local/share/pnpm"
    export PNPM_BIN_DIR="$PNPM_HOME/bin"
    mkdir -p "$PNPM_HOME" "$PNPM_BIN_DIR"
    case ":$PATH:" in
        *":$PNPM_BIN_DIR:"*) ;;
        *) export PATH="$PNPM_BIN_DIR:$PATH" ;;
    esac
    case ":$PATH:" in
        *":$PNPM_HOME:"*) ;;
        *) export PATH="$PNPM_HOME:$PATH" ;;
    esac

    # Ensure systemd user dir exists before we try to write the service file
    mkdir -p "$HOME/.config/systemd/user"
}

# Port generation/validation lives in lib-gateway.sh (gw_generate_port,
# gw_is_gateway_port_range, gw_resolve_port).

ensure_node() {
    # Check if the correct major version is already active
    local current_major
    current_major=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1 || echo "0")

    if [ "$current_major" = "$NODE_MAJOR" ]; then
        log "Node.js v${NODE_MAJOR} active: $(node -v)"
        return 0
    fi

    # Need to switch — nvm required
    if ! command -v nvm &>/dev/null; then
        error "Node.js v${NODE_MAJOR} required but active is $(node -v 2>/dev/null || echo 'none'). nvm not found — install nvm first."
        exit 1
    fi

    # Install v24 if not present, then switch
    if ! nvm ls "$NODE_MAJOR" 2>/dev/null | grep -q "v${NODE_MAJOR}"; then
        log "Node.js v${NODE_MAJOR} not installed — installing via nvm..."
        nvm install "$NODE_MAJOR"
    fi

    log "Switching to Node.js v${NODE_MAJOR}..."
    nvm use "$NODE_MAJOR"
    nvm alias default "$NODE_MAJOR"
    log "Node.js active: $(node -v)"
}

check_pnpm() {
    if ! command -v pnpm &>/dev/null; then
        error "pnpm not found. Install it: npm install -g pnpm"
        exit 1
    fi
    log "pnpm: $(pnpm --version)"
}

# Ensure pnpm shim dirs are on the user's interactive-shell PATH.
# build-switch exports them within its own process, so without this
# the freshly-installed `openclaw` shim isn't found in a new terminal.
# Supports bash, zsh, fish.
ensure_pnpm_on_path() {
    local rc_files=("$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile" "$HOME/.bash_profile")
    local found=false
    for rc in "${rc_files[@]}"; do
        [[ -f "$rc" ]] \
            && grep -q 'PNPM_HOME' "$rc" 2>/dev/null \
            && grep -q 'PNPM_HOME/bin' "$rc" 2>/dev/null \
            && { found=true; break; }
    done

    if $found; then
        return 0
    fi

    local target_rc="$HOME/.bashrc"
    log "Adding pnpm shim paths to $target_rc"
    {
        echo ""
        echo "# pnpm shims for OpenClaw/FreeClaw"
        echo "export PNPM_HOME=\"$PNPM_HOME\""
        echo "export PNPM_BIN_DIR=\"\$PNPM_HOME/bin\""
        echo "case \":\$PATH:\" in *\":\$PNPM_BIN_DIR:\"*) ;; *) export PATH=\"\$PNPM_BIN_DIR:\$PATH\" ;; esac"
        echo "case \":\$PATH:\" in *\":\$PNPM_HOME:\"*) ;; *) export PATH=\"\$PNPM_HOME:\$PATH\" ;; esac"
    } >> "$target_rc"
    log "pnpm shim paths added — open a new shell (or 'source ~/.bashrc') before running $AGENT_CMD_NAME"

    # Also bind to fish if it is installed
    if command -v fish &>/dev/null; then
        local fish_conf="$HOME/.config/fish/config.fish"
        mkdir -p "$HOME/.config/fish"
        if grep -q 'PNPM_HOME' "$fish_conf" 2>/dev/null && grep -q 'PNPM_HOME/bin' "$fish_conf" 2>/dev/null; then
            log "fish config already has pnpm shim paths"
        else
            log "Adding pnpm shim paths to fish config: $fish_conf"
            {
                echo ""
                echo "# pnpm shims for OpenClaw/FreeClaw (added by build-switch)"
                echo "set -gx PNPM_HOME \"$PNPM_HOME\""
                echo "set -gx PNPM_BIN_DIR \"\$PNPM_HOME/bin\""
                echo "if not string match -q -- \"\$PNPM_BIN_DIR\" \$PATH"
                echo "  set -gx PATH \"\$PNPM_BIN_DIR\" \$PATH"
                echo "end"
                echo "if not string match -q -- \"\$PNPM_HOME\" \$PATH"
                echo "  set -gx PATH \"\$PNPM_HOME\" \$PATH"
                echo "end"
            } >> "$fish_conf"
        fi
    fi
}

# ============================================================================
# GATEWAY CONTROL
# ============================================================================

stop_gateway() {
    gw_stop_service "$AGENT_SERVICE_NAME"
    gw_cleanup_agent_orphans "$AGENT_STATE_DIR"
}

restart_gateway() {
    log "Restarting gateway ($AGENT_SERVICE_NAME)..."
    if ! systemctl --user daemon-reload 2>/dev/null; then
        warn "systemd user bus is unavailable; installed shims and service file, skipped gateway restart."
        return 0
    fi
    systemctl --user restart "$AGENT_SERVICE_NAME"
    sleep 3
    if systemctl --user is-active --quiet "$AGENT_SERVICE_NAME"; then
        log "Gateway running (PID $(systemctl --user show --property=MainPID --value "${AGENT_SERVICE_NAME}.service"))"
    else
        error "Gateway failed to start!"
        systemctl --user status "${AGENT_SERVICE_NAME}.service" --no-pager -l
        return 1
    fi
}

# ============================================================================
# CONFIGURATION MANAGEMENT
# ============================================================================

get_current_token() {
    local config="$AGENT_STATE_DIR/openclaw.json"
    if [ -f "$config" ] && command -v jq &>/dev/null; then
        jq -r '.gateway.auth.token // empty | strings' "$config" 2>/dev/null || echo ""
    else
        echo ""
    fi
}

update_service() {
    local branch="$1"
    # Resolve node path dynamically — never hardcode nvm paths
    local node_path
    node_path=$(which node)

    local version
    version=$(node -e "console.log(require('$OPENCLAW_BASE/package.json').version)")

    # Reuse the port from the existing service file (source of truth) or
    # config; generate a fresh one in the FreeClaw gateway block otherwise so
    # one firewall rule covers local gateways while leaving 40801 for llama.cpp.
    local gw_port
    gw_port=$(gw_resolve_port "$OPENCLAW_SERVICE" "$AGENT_STATE_DIR/openclaw.json")

    GW_SERVICE_FILE="$OPENCLAW_SERVICE" \
    GW_SERVICE_NAME="$AGENT_SERVICE_NAME" \
    GW_NODE_PATH="$node_path" \
    GW_ENTRYPOINT="$OPENCLAW_BASE/dist/index.js" \
    GW_STATE_DIR="$AGENT_STATE_DIR" \
    GW_PORT="$gw_port" \
    GW_VERSION_STRING="$(gw_version_for_branch "$branch" "$version")" \
    GW_CMD_NAME="$AGENT_CMD_NAME" \
    GW_TOKEN="$(get_current_token)" \
    GW_AGENT_NAME="$AGENT_NAME" \
        gw_write_service_unit
}

# ============================================================================
# SOFT DEPENDENCY CHECKS
# ============================================================================

check_soft_deps() {
    local missing=()

    # Audio transcription — needed for voice note understanding
    if ! command -v whisper &>/dev/null \
        && ! command -v whisper-cli &>/dev/null \
        && ! command -v sherpa-onnx-offline &>/dev/null; then
        missing+=("  whisper (voice note transcription) — install: paru -S python-openai-whisper")
    fi

    # ffmpeg — needed by whisper and media processing
    if ! command -v ffmpeg &>/dev/null; then
        missing+=("  ffmpeg (media processing) — install: sudo pacman -S ffmpeg")
    fi

    if [ ${#missing[@]} -gt 0 ]; then
        warn "Optional dependencies not found:"
        for dep in "${missing[@]}"; do
            echo -e "  ${YELLOW}→${NC} $dep"
        done
    fi
}

# ============================================================================
# SHIM INSTALLATION
# ============================================================================

# Write a shell wrapper shim to both pnpm and local bin dirs.
write_shim() {
    local name="$1" node_bin="$2" entrypoint="$3"
    shift 3
    # Remaining args are extra env exports for the shim body
    local env_lines=("$@")

    for shim_dir in "$PNPM_BIN_DIR" "$PNPM_HOME" "$HOME/.local/bin"; do
        mkdir -p "$shim_dir"
        # Remove the name before writing it. A previous install can leave the
        # shim as a symlink whose target no longer exists; `>` follows the link
        # to the missing target and fails with "No such file or directory",
        # aborting the install.
        rm -f "$shim_dir/$name"
        {
            echo "#!/bin/sh"
            for line in "${env_lines[@]}"; do
                echo "export $line"
            done
            echo "exec \"$node_bin\" \"$entrypoint\" \"\$@\""
        } > "$shim_dir/$name"
        chmod +x "$shim_dir/$name"
    done
}

install_shims() {
    local node_bin="$1" entrypoint="$2"

    # Bake the V8 compile cache path into every shim so CLI startup is fast
    # even in non-login shells where ~/.profile hasn't been sourced.
    local v8_cache_dir="$HOME/.openclaw/v8-compile-cache"
    mkdir -p "$v8_cache_dir"

    # Pick a directory already on the *invoking shell's* PATH so the shim
    # works immediately, with no rc-file sourcing. write_shim still writes
    # to pnpm shim dirs and ~/.local/bin for future shells; this is just an
    # extra "current-shell" landing pad.
    SHIM_CURRENT_SHELL_DIR=""
    local candidate
    while IFS= read -r candidate; do
        [[ -z "$candidate" ]] && continue
        case "$candidate" in
            /usr/*|/bin|/sbin) continue ;;  # skip system dirs (need sudo)
        esac
        if [[ -d "$candidate" && -w "$candidate" ]]; then
            SHIM_CURRENT_SHELL_DIR="$candidate"
            break
        fi
    done < <(echo "$PATH" | tr ':' '\n')

    if [[ -n "$AGENT_NAME" ]]; then
        log "Installing agent command: $AGENT_CMD_NAME"
        mkdir -p "$AGENT_STATE_DIR"
        write_shim "$AGENT_CMD_NAME" "$node_bin" "$entrypoint" \
            "OPENCLAW_STATE_DIR=$AGENT_STATE_DIR" \
            "OPENCLAW_SYSTEMD_UNIT=${AGENT_SERVICE_NAME}" \
            "NODE_COMPILE_CACHE=$v8_cache_dir"
        # Ensure the base openclaw shim exists too (needed for pnpm link)
        if [[ ! -f "$PNPM_BIN_DIR/openclaw" ]]; then
            write_shim "openclaw" "$node_bin" "$entrypoint" \
                "NODE_COMPILE_CACHE=$v8_cache_dir"
        fi
    else
        write_shim "openclaw" "$node_bin" "$entrypoint" \
            "NODE_COMPILE_CACHE=$v8_cache_dir"
    fi

    # Drop a symlink in the on-PATH dir for the current shell.
    if [[ -n "$SHIM_CURRENT_SHELL_DIR" \
          && "$SHIM_CURRENT_SHELL_DIR" != "$PNPM_HOME" \
          && "$SHIM_CURRENT_SHELL_DIR" != "$PNPM_BIN_DIR" \
          && "$SHIM_CURRENT_SHELL_DIR" != "$HOME/.local/bin" ]]; then
        ln -sf "$PNPM_BIN_DIR/$AGENT_CMD_NAME" "$SHIM_CURRENT_SHELL_DIR/$AGENT_CMD_NAME"
        log "Symlinked $AGENT_CMD_NAME into $SHIM_CURRENT_SHELL_DIR (already on PATH)"
    fi

    # Verify the shim works
    if ! timeout 10 "$PNPM_BIN_DIR/$AGENT_CMD_NAME" --version &>/dev/null; then
        warn "$AGENT_CMD_NAME shim may not work — check $PNPM_BIN_DIR/$AGENT_CMD_NAME"
    fi
}

# Install the utils/*.sh|*.py suite as commands, matching `make install`
# (basename minus extension, underscores -> dashes). Without this a build-switch
# install has `openclaw` but NOT llamacpp-init, trustgraph, lib-gateway, etc. —
# the gap versus an AUR/`make install`. The util scripts reference sibling utils
# by their own directory, so all siblings must land in the same dir together
# (they do here). Skipped for isolated agent installs (they share the base
# commands) — util commands are per-repo, not per-agent.
install_util_commands() {
    local utils_dir="$OPENCLAW_BASE/utils" name base f shim_dir
    [[ -d "$utils_dir" ]] || return 0
    for shim_dir in "$PNPM_BIN_DIR" "$PNPM_HOME" "$HOME/.local/bin"; do
        [[ -n "$shim_dir" ]] || continue
        mkdir -p "$shim_dir"
        for f in "$utils_dir"/*.sh "$utils_dir"/*.py; do
            [[ -f "$f" ]] || continue
            base="$(basename "$f")"
            name="$(printf '%s' "${base%.*}" | tr '_' '-')"
            [[ "$name" == "openclaw" ]] && continue
            ln -sfn "$f" "$shim_dir/$name"
        done
    done
    log "Installed util commands (llamacpp-init, trustgraph, diagnose-gateway-hang, lib-gateway, ...) — matches make install"
}

# ============================================================================
# BUILD & INSTALL
# ============================================================================

build_freeclaw() {
    local branch="$1"

    log "=== Building freeclaw ==="
    cd "$OPENCLAW_BASE"

    local current_branch
    current_branch=$(git branch --show-current)

    log "Checking out branch: $branch"
    git checkout "$branch"

    # Always clean build artifacts to avoid stale cache issues.
    # node_modules is only wiped on branch change (lockfile may differ).
    local branch_changed=false
    if [ "$current_branch" != "$branch" ]; then
        branch_changed=true
        log "Branch changed ($current_branch → $branch), full clean..."
        rm -rf node_modules dist dist-runtime ui/dist skills/.cache 2>/dev/null || true
    else
        log "Same branch, cleaning build artifacts..."
        rm -rf dist dist-runtime ui/dist skills/.cache 2>/dev/null || true
    fi

    log "Installing dependencies (Node $(node -v))..."
    pnpm install

    # Patches modify files inside node_modules — must run after every pnpm install
    for patch in "$OPENCLAW_BASE"/scripts/patch-*.sh; do
        if [[ -x "$patch" ]]; then
            log "Applying patch: $(basename "$patch")"
            bash "$patch"
        fi
    done

    log "Building..."
    pnpm build || { error "Build failed!"; return 1; }

    log "Building UI..."
    pnpm ui:build || { error "UI build failed!"; return 1; }

    log "Installing command shims..."
    pnpm uninstall -g openclaw >/dev/null 2>&1 || true
    # pnpm link --global behavior differs across pnpm releases and can prompt
    # to purge node_modules. Install deterministic wrappers instead.
    local node_bin
    node_bin=$(which node)
    local entrypoint="$OPENCLAW_BASE/dist/index.js"
    if [[ ! -f "$entrypoint" ]]; then
        error "Entrypoint not found: $entrypoint"
        return 1
    fi

    install_shims "$node_bin" "$entrypoint"
    install_util_commands

    log "=== Build complete! ==="

    # Soft dependency checks — warn about optional packages that unlock features
    check_soft_deps
}

# ============================================================================
# STATUS
# ============================================================================

show_status() {
    local label="OpenClaw"
    if [[ -n "$AGENT_NAME" ]]; then
        label="Agent: $AGENT_NAME"
    fi

    echo "=== $label Build Status ==="
    echo ""
    echo "State:   $AGENT_STATE_DIR"
    echo "Command: $AGENT_CMD_NAME"
    cd "$OPENCLAW_BASE" 2>/dev/null \
        && echo "Branch:  $(git branch --show-current)" \
        || echo "Branch:  N/A (not in repo)"
    [ -f "$OPENCLAW_BASE/package.json" ] \
        && echo "Version: $(node -e "console.log(require('$OPENCLAW_BASE/package.json').version)")"
    echo "Node.js: $(node -v)"

    echo ""
    echo "Gateway ($AGENT_SERVICE_NAME):"
    if systemctl --user is-active --quiet "$AGENT_SERVICE_NAME" 2>/dev/null; then
        local svc_version svc_port
        svc_version=$(grep "OPENCLAW_SERVICE_VERSION" "$OPENCLAW_SERVICE" 2>/dev/null \
            | sed 's/.*OPENCLAW_SERVICE_VERSION=//' || echo "unknown")
        svc_port=$(grep -oP 'OPENCLAW_GATEWAY_PORT=\K[0-9]+' "$OPENCLAW_SERVICE" 2>/dev/null || echo "unknown")
        echo "  Status:  ● Running"
        echo "  PID:     $(systemctl --user show --property=MainPID --value "${AGENT_SERVICE_NAME}.service")"
        echo "  Version: $svc_version"
        echo "  Port:    $svc_port"
    else
        echo "  Status:  ● Not running"
    fi

    echo ""
    echo "Tokens:"
    local config_token service_token
    config_token=$(get_current_token)
    service_token=$(grep "OPENCLAW_GATEWAY_TOKEN" "$OPENCLAW_SERVICE" 2>/dev/null \
        | sed 's/.*OPENCLAW_GATEWAY_TOKEN=//' || echo "")

    if [ -n "$config_token" ] && [ -n "$service_token" ]; then
        if [ "$config_token" = "$service_token" ]; then
            echo "  Match: ${config_token:0:16}..."
        else
            echo "  Mismatch!"
            echo "     Config:  ${config_token:0:16}..."
            echo "     Service: ${service_token:0:16}..."
        fi
    else
        echo "  Managed by openclaw gateway install (expected)"
    fi
}

# ============================================================================
# MAIN
# ============================================================================

NO_RESTART=0
POSITIONAL=()
for arg in "$@"; do
    case "$arg" in
        --no-restart) NO_RESTART=1 ;;
        *) POSITIONAL+=("$arg") ;;
    esac
done
BRANCH="${POSITIONAL[0]:-}"
ARG_AGENT="${POSITIONAL[1]:-}"

case "$BRANCH" in
    --help|-h)
        init_agent ""
        usage
        ;;
    status)
        init_agent "$ARG_AGENT"
        setup_env
        show_status
        ;;
    "")
        # Interactive mode
        BRANCH=$(select_branch)
        ARG_AGENT=$(select_agent)
        init_agent "$ARG_AGENT"
        ;;&
    *)
        # Validate branch (skip if we just came from interactive — already valid)
        if [[ -z "${AGENT_STATE_DIR}" ]]; then
            init_agent "$ARG_AGENT"
        fi
        if ! branch_exists "$BRANCH"; then
            error "Branch not found: $BRANCH"
            echo ""
            echo "Available branches:"
            list_branches | sed 's/^/  /'
            echo ""
            exit 1
        fi
        setup_env
        ensure_node
        check_pnpm
        ensure_pnpm_on_path
        if [[ -n "$AGENT_NAME" ]]; then
            log "=== Agent mode: $AGENT_NAME ==="
            log "State dir: $AGENT_STATE_DIR"
            log "Command:   $AGENT_CMD_NAME"
        fi
        stop_gateway
        build_freeclaw "$BRANCH"
        update_service "$BRANCH"
        if [[ "$NO_RESTART" -eq 1 ]]; then
            log "Skipping gateway restart (--no-restart) — gateway is STOPPED until llamacpp-init (or systemctl --user restart $AGENT_SERVICE_NAME) starts it."
        else
            restart_gateway
        fi
        log "=== Switch complete! ==="
        show_status
        ;;
esac
