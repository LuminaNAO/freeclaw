#!/usr/bin/env bash
# signal-group-toggle.sh — interactively configure Signal group engagement
# in openclaw.json.
#
# Modes (matches what freeclaw actually supports for Signal):
#   1) open        — bot engages with every group (groupPolicy: "open",
#                     no group overrides)
#   2) disabled    — bot ignores all group messages (groupPolicy: "disabled")
#   3) mention-only-by-default — bot lurks in groups unless @mentioned
#                     (groupPolicy: "open", groups["*"].requireMention: true).
#                     You can then opt SPECIFIC groups into auto-engage.
#
# Notes:
#   - Signal in freeclaw has NO mechanism to whitelist groups by group_id;
#     groupPolicy="allowlist" is sender-based. Closest binary on/off per
#     group is requireMention:true (lurk) vs requireMention:false (engage).
#   - Writes are atomic (jq to tempfile, then mv) and a timestamped backup
#     of openclaw.json is created on first config write.

set -euo pipefail

OPENCLAW_JSON="${OPENCLAW_JSON:-$HOME/.openclaw/openclaw.json}"
SIGNAL_CLI="${SIGNAL_CLI:-signal-cli}"
ACCOUNTS_FILE="${SIGNAL_CLI_DATA:-$HOME/.local/share/signal-cli/data}/accounts.json"
ACCOUNT_PATH="${ACCOUNT_PATH:-channels.signal}"   # set to "channels.signal.accounts.default" for per-account
BACKUP_DONE=0

# ── prereqs ───────────────────────────────────────────────────────────────
[[ -r "$OPENCLAW_JSON" ]] || { echo "❌ cannot read $OPENCLAW_JSON" >&2; exit 1; }
command -v jq >/dev/null   || { echo "❌ jq is required" >&2; exit 1; }

# ── helpers ───────────────────────────────────────────────────────────────
backup_once() {
    if [[ "$BACKUP_DONE" -eq 0 ]]; then
        local bak="$OPENCLAW_JSON.bak.$(date +%Y%m%d-%H%M%S)"
        cp "$OPENCLAW_JSON" "$bak"
        echo "🗂  backup: $bak"
        BACKUP_DONE=1
    fi
}

# Atomic jq write to OPENCLAW_JSON. Last arg is the jq filter; preceding
# args are passed verbatim to jq (e.g. --arg, --argjson).
jq_write() {
    local args=("$@")
    local last_idx=$((${#args[@]} - 1))
    local filter="${args[$last_idx]}"
    unset 'args[last_idx]'
    local tf
    tf=$(mktemp)
    jq "${args[@]}" "$filter" "$OPENCLAW_JSON" > "$tf"
    backup_once
    mv "$tf" "$OPENCLAW_JSON"
}

current_policy() {
    jq -r --arg p "$ACCOUNT_PATH" '
      ($p | split(".")) as $path
      | getpath($path).groupPolicy // "open"
    ' "$OPENCLAW_JSON"
}

current_default_require_mention() {
    jq -r --arg p "$ACCOUNT_PATH" '
      ($p | split(".")) as $path
      | (getpath($path).groups["*"].requireMention) // false
    ' "$OPENCLAW_JSON"
}

current_group_require_mention() {
    # jq's `//` returns alt for false OR null, so it can't distinguish a stored
    # false from a missing key. Use has() for true existence checks.
    # Note: `(EXPR // {}) as $x` requires parens — otherwise `as` binds inside the //.
    local gid="$1"
    jq -r --arg p "$ACCOUNT_PATH" --arg gid "$gid" '
      ($p | split(".")) as $path
      | (getpath($path).groups // {}) as $groups
      | def has_rm($key):
          ($groups | has($key))
          and ($groups[$key] | type) == "object"
          and ($groups[$key] | has("requireMention"));
        if   has_rm($gid) then $groups[$gid].requireMention
        elif has_rm("*")  then $groups["*"].requireMention
        else false
        end
    ' "$OPENCLAW_JSON"
}

set_group_policy() {
    local policy="$1"
    jq_write \
        --arg p "$ACCOUNT_PATH" --arg policy "$policy" \
        '($p | split(".")) as $path
         | setpath($path + ["groupPolicy"]; $policy)'
}

# Sets groups["*"].requireMention = bool. Creates the map if missing.
set_default_require_mention() {
    local val="$1"   # "true" or "false"
    jq_write \
        --arg p "$ACCOUNT_PATH" --argjson val "$val" \
        '($p | split(".")) as $path
         | setpath($path + ["groups", "*", "requireMention"]; $val)'
}

# Sets groups[<gid>].requireMention = bool.
set_group_require_mention() {
    local gid="$1" val="$2"
    jq_write \
        --arg p "$ACCOUNT_PATH" --arg gid "$gid" --argjson val "$val" \
        '($p | split(".")) as $path
         | setpath($path + ["groups", $gid, "requireMention"]; $val)'
}

# Removes the entry groups[<gid>] entirely (so it inherits from "*").
unset_group_entry() {
    local gid="$1"
    jq_write \
        --arg p "$ACCOUNT_PATH" --arg gid "$gid" \
        '($p | split(".")) as $path
         | setpath($path; getpath($path) | .groups |= (. // {}) | del(.groups[$gid]))'
}

# ── non-interactive flag mode ─────────────────────────────────────────────
# Usage: signal-group-toggle.sh [--policy <open|disabled|allowlist>] [--help]
# With --policy, the script sets channels.signal.groupPolicy and exits without
# touching signal-cli (so it works offline / in scripts / cron).
usage() {
    cat <<EOF
usage: $(basename "$0") [--policy <open|disabled|allowlist>] [--help]

  --policy <val>   set channels.signal.groupPolicy non-interactively and exit:
                     open       — engage with every group
                     disabled   — ignore all group messages
                     allowlist  — engage only groups with explicit entries
                                  (does not touch existing per-group entries)
  --help, -h       show this help

With no flags, runs the interactive group-management menu.

Env: OPENCLAW_JSON, ACCOUNT_PATH, SIGNAL_ACCOUNT, SIGNAL_CLI, SIGNAL_CLI_DATA
EOF
}

case "${1:-}" in
    --help|-h) usage; exit 0 ;;
    --policy)
        policy="${2:-}"
        case "$policy" in
            open|disabled|allowlist)
                set_group_policy "$policy"
                echo "✅ groupPolicy=$policy (channels.signal at $OPENCLAW_JSON)"
                exit 0 ;;
            "") echo "❌ --policy requires a value" >&2; usage >&2; exit 2 ;;
            *)  echo "❌ invalid policy: $policy (want open|disabled|allowlist)" >&2; exit 2 ;;
        esac ;;
    "") : ;;  # no args → interactive
    *)  echo "❌ unknown argument: $1" >&2; usage >&2; exit 2 ;;
esac

# ── load groups via signal-cli ────────────────────────────────────────────
clean_signal_json() {
    grep -vE '^(INFO|DEBUG|WARN|ERROR)\s|^[0-9-]+T[0-9:.+-]+\s'
}

resolve_account() {
    [[ -n "${SIGNAL_ACCOUNT:-}" ]] && { echo "$SIGNAL_ACCOUNT"; return; }
    [[ -r "$ACCOUNTS_FILE" ]] && jq -r '.accounts[0].number // empty' "$ACCOUNTS_FILE"
}

echo "🔄 loading Signal groups…"
ACCOUNT_NUMBER=$(resolve_account)
if [[ -z "$ACCOUNT_NUMBER" ]]; then
    echo "⚠  no signal-cli account auto-detected; pass via SIGNAL_ACCOUNT env." >&2
fi

set +e
GROUPS_JSON=$(timeout 180 "$SIGNAL_CLI" ${ACCOUNT_NUMBER:+-a "$ACCOUNT_NUMBER"} \
              --output=json listGroups 2>&1 | clean_signal_json | tail -1)
SIGNAL_RC=$?
set -e
if [[ $SIGNAL_RC -ne 0 || -z "$GROUPS_JSON" ]]; then
    echo "❌ signal-cli listGroups failed (exit=$SIGNAL_RC)" >&2
    exit 1
fi

GROUP_COUNT=$(echo "$GROUPS_JSON" | jq 'length')
echo "✅ found $GROUP_COUNT group(s) for $ACCOUNT_NUMBER"
echo ""

# Cache id|name pairs in arrays for menu indexing.
mapfile -t GROUP_IDS   < <(echo "$GROUPS_JSON" | jq -r '.[].id')
mapfile -t GROUP_NAMES < <(echo "$GROUPS_JSON" | jq -r '.[].name // "(no name)"')

# ── mode selection ────────────────────────────────────────────────────────
echo "════════════════════════════════════════════"
echo "  Signal group engagement mode"
echo "════════════════════════════════════════════"
echo "  current policy:                  $(current_policy)"
echo "  current default requireMention:  $(current_default_require_mention)"
echo ""
echo "  1) open              — engage with every group"
echo "  2) disabled          — ignore all group messages"
echo "  3) manage per group  — choose individually (default = lurk unless @mentioned;"
echo "                          you opt specific groups into auto-engage)"
echo "  q) quit"
echo ""
read -rp "select mode [1/2/3/q]: " MODE

case "$MODE" in
    1)
        set_group_policy "open"
        echo "✅ groupPolicy=open — bot will engage with every Signal group."
        echo "   per-group overrides (requireMention, etc.) preserved if any exist."
        exit 0
        ;;
    2)
        set_group_policy "disabled"
        echo "✅ groupPolicy=disabled — bot will ignore all group messages."
        exit 0
        ;;
    3)
        # groupPolicy=allowlist + per-group entries gives true 3-state control
        # (see freeclaw config/group-policy.ts: a group is allowed only if
        # groups[<id>] exists OR groups["*"] exists).
        set_group_policy "allowlist"
        # Drop the wildcard if it lingered from prior runs — we want explicit
        # per-group entries only, so absence-of-entry == disabled.
        jq_write \
            --arg p "$ACCOUNT_PATH" \
            '($p | split(".")) as $path
             | setpath($path; getpath($path)
                 | .groups |= (. // {})
                 | del(.groups["*"]))'
        echo "✅ groupPolicy=allowlist — only groups you opt in will engage."
        echo ""
        ;;
    q|Q) echo "👋"; exit 0 ;;
    *)   echo "❌ invalid selection"; exit 1 ;;
esac

# ── per-group state resolution + helpers (mode 3 only) ────────────────────
echo "════════════════════════════════════════════"
echo "  Per-group settings"
echo "════════════════════════════════════════════"
echo "  [a] auto-engage   bot replies to all messages       (requireMention: false)"
echo "  [m] mention-only  bot replies only when @mentioned  (requireMention: true)"
echo "  [d] disabled      bot ignores the group entirely    (no entry in groups map)"
echo ""

# Returns 'a' / 'm' / 'd' for a given gid based on current openclaw.json.
current_group_state() {
    local gid="$1"
    jq -r --arg p "$ACCOUNT_PATH" --arg gid "$gid" '
      ($p | split(".")) as $path
      | (getpath($path).groups // {}) as $groups
      | if   ($groups | has($gid) | not) then "d"
        elif ($groups[$gid] | type) != "object" then "d"
        elif ($groups[$gid].requireMention == true) then "m"
        else "a"
        end
    ' "$OPENCLAW_JSON"
}

set_group_state() {
    local gid="$1" state="$2"
    case "$state" in
        a) set_group_require_mention "$gid" false ;;
        m) set_group_require_mention "$gid" true  ;;
        d) unset_group_entry "$gid" ;;
        *) echo "❌ invalid state: $state" >&2; return 1 ;;
    esac
}

render_list() {
    local i=0
    while (( i < GROUP_COUNT )); do
        local gid="${GROUP_IDS[$i]}" name="${GROUP_NAMES[$i]}"
        local st; st=$(current_group_state "$gid")
        local name_short="${name:0:40}"
        printf "  %2d. [%s]  %-40s\n" "$i" "$st" "$name_short"
        ((i++)) || true
    done
}

render_list
echo ""
echo "Each change saves instantly — no separate confirm step."
echo "Commands:"
echo "  <num> <a|m|d>   set one group:"
echo "                     a = auto-engage  (bot replies to all messages)"
echo "                     m = mention-only (bot replies only when @mentioned)"
echo "                     d = disabled     (bot ignores the group)"
echo "                   example: '2 m'"
echo "  a | m | d       set ALL groups to that state"
echo "  l               redraw list"
echo "  <enter> or done exit (changes already saved)"
echo "  q               quit"
echo ""

while true; do
    read -rp "> " CMD
    # normalize whitespace and lowercase the action token
    set -- $CMD
    case "$#" in
        0) echo "✅ done — config saved."; exit 0 ;;
        1)
            tok="$1"
            case "$tok" in
                done|DONE) echo "✅ done — config saved."; exit 0 ;;
                q|Q)       echo "👋"; exit 0 ;;
                l|L)       render_list ;;
                a|A)
                    for gid in "${GROUP_IDS[@]}"; do set_group_state "$gid" a; done
                    echo "✅ all groups → auto-engage"
                    render_list ;;
                m|M)
                    for gid in "${GROUP_IDS[@]}"; do set_group_state "$gid" m; done
                    echo "✅ all groups → mention-only"
                    render_list ;;
                d|D)
                    for gid in "${GROUP_IDS[@]}"; do set_group_state "$gid" d; done
                    echo "✅ all groups → disabled"
                    render_list ;;
                *[!0-9]*) echo "❌ unknown command (try '<num> <a|m|d>', 'a', 'm', 'd', 'l', or enter)" ;;
                *) echo "❌ missing action (use '$tok a' / '$tok m' / '$tok d')" ;;
            esac ;;
        2)
            num="$1"; action="$2"
            if [[ "$num" =~ ^[0-9]+$ ]] && (( num < GROUP_COUNT )); then
                action_lc=$(echo "$action" | tr '[:upper:]' '[:lower:]')
                case "$action_lc" in
                    a|m|d)
                        gid="${GROUP_IDS[$num]}"
                        name="${GROUP_NAMES[$num]}"
                        set_group_state "$gid" "$action_lc"
                        case "$action_lc" in
                            a) echo "🔊 '$name' → auto-engage" ;;
                            m) echo "🔉 '$name' → mention-only" ;;
                            d) echo "🔇 '$name' → disabled" ;;
                        esac
                        render_list ;;
                    *) echo "❌ action must be 'a', 'm', or 'd'" ;;
                esac
            else
                echo "❌ first token must be a group number 0..$((GROUP_COUNT-1))"
            fi ;;
        *) echo "❌ too many tokens; use '<num> <a|m|d>'" ;;
    esac
    echo ""
done
