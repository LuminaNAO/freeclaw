#!/usr/bin/env bash
# freeclaw_heartbeat_toggle.sh — durable + runtime FreeClaw/OpenClaw heartbeat toggle.
#
# Why this exists:
#   `openclaw system heartbeat disable` can toggle the running gateway, but it
#   does not reliably persist across restarts. This script edits openclaw.json
#   directly and also attempts the runtime gateway toggle.

set -euo pipefail

OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"
OPENCLAW_JSON="${OPENCLAW_JSON:-$HOME/.openclaw/openclaw.json}"
RUNTIME_TIMEOUT="${RUNTIME_TIMEOUT:-5}"
DEFAULT_ENABLE_EVERY="${DEFAULT_ENABLE_EVERY:-30m}"
DO_RUNTIME=1
SHOW_DETAILS=0
BACKUP_DONE=0

usage() {
    cat <<EOF
usage: $(basename "$0") <status|disable|enable> [options]

Durably enable/disable OpenClaw agent heartbeats and optionally toggle the
running gateway state.

Commands:
  status              Show durable config state and recent runtime heartbeat
  disable             Set every configured heartbeat interval to "0m"
  enable              Set default heartbeat interval to --every (default 30m)

Options:
  --every <interval>  Enable interval, e.g. 30m, 1h, 2h (enable only)
  --config <path>     openclaw.json path (default: ~/.openclaw/openclaw.json)
  --openclaw <cmd>    OpenClaw CLI command (default: openclaw)
  --runtime-timeout N Seconds to wait for gateway runtime calls (default: 5)
  --no-runtime        Do not call "openclaw system heartbeat enable/disable"
  --details           Print full per-agent heartbeat config in status
  -h, --help          Show this help

Env:
  OPENCLAW_JSON, OPENCLAW_BIN, RUNTIME_TIMEOUT, DEFAULT_ENABLE_EVERY

Notes:
  - disable writes agents.defaults.heartbeat.every="0m".
  - disable also sets every existing agents.list[].heartbeat.every to "0m".
  - enable writes agents.defaults.heartbeat.every to --every.
  - enable converts per-agent heartbeat.every="0m" to --every, but leaves other
    per-agent heartbeat intervals untouched.
  - All config writes are atomic and create one timestamped backup.
EOF
}

die() {
    echo "ERROR: $*" >&2
    exit 1
}

have() {
    command -v "$1" >/dev/null 2>&1
}

backup_once() {
    if [[ "$BACKUP_DONE" -eq 0 ]]; then
        local base bak n
        base="$OPENCLAW_JSON.bak.$(date +%Y%m%d-%H%M%S)"
        bak="$base"
        n=1
        while [[ -e "$bak" ]]; do
            bak="$base.$n"
            n=$((n + 1))
        done
        cp "$OPENCLAW_JSON" "$bak"
        echo "backup: $bak"
        BACKUP_DONE=1
    fi
}

jq_write() {
    local filter="$1"
    local tf
    tf="$(mktemp)"
    jq "$filter" "$OPENCLAW_JSON" > "$tf"
    backup_once
    mv "$tf" "$OPENCLAW_JSON"
}

json_get() {
    jq -r "$1" "$OPENCLAW_JSON"
}

runtime_call() {
    local action="$1"
    [[ "$DO_RUNTIME" -eq 1 ]] || return 0
    have timeout || { echo "runtime: skipped (timeout command not found)"; return 0; }
    have "$OPENCLAW_BIN" || { echo "runtime: skipped ($OPENCLAW_BIN not found)"; return 0; }

    local output rc
    set +e
    output="$(timeout "$RUNTIME_TIMEOUT" "$OPENCLAW_BIN" system heartbeat "$action" --json 2>&1)"
    rc=$?
    set -e
    if [[ "$rc" -eq 0 ]]; then
        echo "runtime $action: $output"
    elif [[ "$rc" -eq 124 ]]; then
        echo "runtime $action: timed out after ${RUNTIME_TIMEOUT}s"
    else
        echo "runtime $action: failed (exit $rc): $output"
    fi
}

runtime_last() {
    [[ "$DO_RUNTIME" -eq 1 ]] || return 0
    have timeout || { echo "runtime last: skipped (timeout command not found)"; return 0; }
    have "$OPENCLAW_BIN" || { echo "runtime last: skipped ($OPENCLAW_BIN not found)"; return 0; }

    local output rc
    set +e
    output="$(timeout "$RUNTIME_TIMEOUT" "$OPENCLAW_BIN" system heartbeat last --json 2>&1)"
    rc=$?
    set -e
    if [[ "$rc" -eq 0 ]]; then
        echo "runtime last: $output"
    elif [[ "$rc" -eq 124 ]]; then
        echo "runtime last: timed out after ${RUNTIME_TIMEOUT}s"
    else
        echo "runtime last: failed (exit $rc): $output"
    fi
}

config_summary() {
    echo "config: $OPENCLAW_JSON"
    echo "defaults.every: $(json_get '.agents.defaults.heartbeat.every // "(unset)"')"
    echo "defaults.heartbeat: $(json_get 'if .agents.defaults.heartbeat then "present" else "absent" end')"

    local count enabled disabled unset
    count="$(json_get '(.agents.list // []) | length')"
    enabled="$(json_get '(.agents.list // []) | map(select(.heartbeat? and ((.heartbeat.every // "") != "0m"))) | length')"
    disabled="$(json_get '(.agents.list // []) | map(select(.heartbeat? and (.heartbeat.every // "") == "0m")) | length')"
    unset="$(json_get '(.agents.list // []) | map(select(.heartbeat? | not)) | length')"
    echo "agents.list: ${count} total, ${enabled} heartbeat-enabled/override, ${disabled} heartbeat-disabled, ${unset} no heartbeat block"

    if [[ "$SHOW_DETAILS" -eq 1 ]]; then
        jq -r '
          (.agents.list // [])
          | to_entries[]
          | "agent[\(.key)] \(.value.name // .value.id // "(unnamed)") heartbeat.every=\(.value.heartbeat.every // "(unset)") heartbeat=\(if .value.heartbeat then "present" else "absent" end)"
        ' "$OPENCLAW_JSON"
    fi

    local effective
    effective="$(json_get '
      def default_on: (.agents.defaults.heartbeat.every // "") != "0m";
      def agent_on: ((.heartbeat.every // "") != "0m");
      if ((.agents.list // []) | map(select(.heartbeat?)) | length) > 0 then
        ((.agents.list // []) | map(select(.heartbeat? and agent_on)) | length) as $n
        | if $n > 0 then "enabled via \($n) per-agent heartbeat block(s)" else "disabled (all per-agent heartbeat blocks every=0m)" end
      else
        if default_on then "enabled via agents.defaults.heartbeat.every" else "disabled via agents.defaults.heartbeat.every=0m" end
      end
    ')"
    echo "effective durable state: $effective"
}

disable_heartbeat() {
    jq_write '
      .agents = (.agents // {})
      | .agents.defaults = (.agents.defaults // {})
      | .agents.defaults.heartbeat = (.agents.defaults.heartbeat // {})
      | .agents.defaults.heartbeat.every = "0m"
      | if (.agents.list | type) == "array" then
          .agents.list |= map(
            if .heartbeat? then
              .heartbeat = (.heartbeat // {}) | .heartbeat.every = "0m"
            else
              .
            end
          )
        else
          .
        end
      | .channels.defaults.heartbeat.showOk = false
      | .channels.defaults.heartbeat.showAlerts = false
      | .channels.defaults.heartbeat.useIndicator = false
    '
    echo "durable disable: agents.defaults.heartbeat.every=0m"
    echo "durable disable: existing per-agent heartbeat blocks set to every=0m"
    echo "durable disable: channels.defaults.heartbeat visibility disabled"
    runtime_call disable
}

enable_heartbeat() {
    local every="$1"
    [[ "$every" =~ ^[0-9]+[smhd]$ ]] || die "--every must look like 30m, 1h, 2h"
    EVERY="$every" jq_write '
      .agents = (.agents // {})
      | .agents.defaults = (.agents.defaults // {})
      | .agents.defaults.heartbeat = (.agents.defaults.heartbeat // {})
      | .agents.defaults.heartbeat.every = env.EVERY
      | if (.agents.list | type) == "array" then
          .agents.list |= map(
            if .heartbeat? and (.heartbeat.every // "") == "0m" then
              .heartbeat.every = env.EVERY
            else
              .
            end
          )
        else
          .
        end
      | .channels.defaults.heartbeat.showOk = true
      | .channels.defaults.heartbeat.showAlerts = true
      | .channels.defaults.heartbeat.useIndicator = true
    '
    echo "durable enable: agents.defaults.heartbeat.every=$every"
    echo "durable enable: per-agent heartbeat.every=0m entries changed to $every"
    echo "durable enable: channels.defaults.heartbeat visibility enabled"
    runtime_call enable
}

cmd="${1:-}"
[[ -n "$cmd" ]] || { usage >&2; exit 2; }
shift || true

every="$DEFAULT_ENABLE_EVERY"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --every)
            every="${2:-}"
            [[ -n "$every" ]] || die "--every requires a value"
            shift 2
            ;;
        --config)
            OPENCLAW_JSON="${2:-}"
            [[ -n "$OPENCLAW_JSON" ]] || die "--config requires a value"
            shift 2
            ;;
        --openclaw)
            OPENCLAW_BIN="${2:-}"
            [[ -n "$OPENCLAW_BIN" ]] || die "--openclaw requires a value"
            shift 2
            ;;
        --no-runtime)
            DO_RUNTIME=0
            shift
            ;;
        --runtime-timeout)
            RUNTIME_TIMEOUT="${2:-}"
            [[ "$RUNTIME_TIMEOUT" =~ ^[0-9]+$ ]] || die "--runtime-timeout requires an integer number of seconds"
            shift 2
            ;;
        --details)
            SHOW_DETAILS=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            die "unknown argument: $1"
            ;;
    esac
done

[[ "$cmd" == "status" || "$cmd" == "disable" || "$cmd" == "enable" ]] || {
    usage >&2
    exit 2
}
[[ -r "$OPENCLAW_JSON" ]] || die "cannot read $OPENCLAW_JSON"
[[ -w "$OPENCLAW_JSON" || "$cmd" == "status" ]] || die "cannot write $OPENCLAW_JSON"
have jq || die "jq is required"

case "$cmd" in
    status)
        config_summary
        runtime_last
        ;;
    disable)
        disable_heartbeat
        config_summary
        ;;
    enable)
        enable_heartbeat "$every"
        config_summary
        ;;
esac
