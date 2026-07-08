#!/usr/bin/env bash
# signal-group-memory.sh — sync a signal-identity dump into per-group
# memory directories under an openclaw workspace.
#
# Layout produced (keyed on the harness-canonical chat_id `group:<id>`):
#
#   <workspace>/group-memory/signal/
#     index.json                      chat_id ("group:<id>") → {path, name, status}
#     <internal-dirname>/             slugified id, NEVER agent-facing
#       meta.json                     group meta + members[] (uuid list)
#       history.md                    narrative (script never writes content; touched if missing)
#
# Lookup recipe for agents:
#   chat_id from inbound system meta  →  index.json[chat_id]  →  open .path
#   No string transforms, no dirname comparisons.
#
# Non-destructive merge rules:
#   - meta.json: script-managed fields are overwritten; others preserved.
#   - Members:
#       - meta.json.members is a simple list of current member UUIDs.
#       - If a UUID disappears from the dump, the group is still tracked;
#         the agent can treat them as “left” via trustgraph.yaml/history.md.
#   - Groups whose `active` flag is false → status="left" (we left / were kicked
#     but signal-cli still tracks the group).
#   - Groups whose directory exists but no longer appear in the dump at
#     all → status="removed" (signal-cli purged it; directory stays).
#   - history.md is only stubbed if missing; never overwritten.
#
# Usage:
#   ./signal-group-memory.sh <workspace> [--dump <path>] [--no-refresh] [--dry-run]
#
# By default, refreshes the dump first by running signal-identity-diff.sh
# (which itself runs signal-identity-dump.sh). Pass --no-refresh to skip,
# or --dump <path> to consume a specific file (auto-disables refresh).
#
# Defaults:
#   --dump   $SCRIPT_DIR/signal-identity-dumps/current.json

set -euo pipefail

usage() {
    sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
}

# readlink -f: resolve /usr/bin symlinks from packaged installs
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
if [[ -w "$SCRIPT_DIR" ]]; then
    DEFAULT_DUMP="$SCRIPT_DIR/signal-identity-dumps/current.json"
else
    DEFAULT_DUMP="${XDG_STATE_HOME:-$HOME/.local/state}/freeclaw/signal-identity-dumps/current.json"
fi
DIFF_SCRIPT="$SCRIPT_DIR/signal-identity-diff.sh"

WORKSPACE=""
DUMP_PATH=""
DUMP_EXPLICIT=0
REFRESH=1
DRY_RUN=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --dump)        DUMP_PATH="$2"; DUMP_EXPLICIT=1; shift 2 ;;
        --no-refresh)  REFRESH=0; shift ;;
        --refresh)     REFRESH=1; shift ;;
        --dry-run)     DRY_RUN=1; shift ;;
        --help|-h)     usage; exit 0 ;;
        --)            shift; break ;;
        -*)            echo "❌ unknown flag: $1" >&2; usage >&2; exit 2 ;;
        *)
            if [[ -z "$WORKSPACE" ]]; then WORKSPACE="$1"; shift
            else echo "❌ extra positional: $1" >&2; exit 2; fi ;;
    esac
done

# Explicit --dump overrides refresh: that's the file you want, as-is.
if (( DUMP_EXPLICIT )); then
    REFRESH=0
else
    DUMP_PATH="$DEFAULT_DUMP"
fi

[[ -n "$WORKSPACE" ]] || { usage >&2; exit 2; }
[[ -d "$WORKSPACE" ]] || { echo "❌ workspace not a directory: $WORKSPACE" >&2; exit 1; }
command -v jq >/dev/null || { echo "❌ jq required" >&2; exit 1; }

# Refresh first if requested. In dry-run we don't mutate the dump dir
# either; we just consume whatever current.json already exists.
if (( REFRESH )); then
    [[ -x "$DIFF_SCRIPT" ]] || { echo "❌ cannot exec $DIFF_SCRIPT" >&2; exit 1; }
    if (( DRY_RUN )); then
        echo "🔄 [dry-run] would refresh dump via $(basename "$DIFF_SCRIPT")"
        echo ""
    else
        echo "🔄 refreshing dump via $(basename "$DIFF_SCRIPT")..."
        "$DIFF_SCRIPT" || { echo "❌ refresh failed" >&2; exit 1; }
        echo ""
    fi
fi

[[ -r "$DUMP_PATH" ]] || { echo "❌ dump not readable: $DUMP_PATH" >&2; exit 1; }
jq empty "$DUMP_PATH" 2>/dev/null || { echo "❌ dump is not valid JSON: $DUMP_PATH" >&2; exit 1; }

NOW="$(date -Iseconds)"
BASE_DIR="$WORKSPACE/group-memory/signal"
INDEX_PATH="$BASE_DIR/index.json"

mkdir -p "$BASE_DIR"

# ── helpers ──────────────────────────────────────────────────────────────
# URL-encode a string: slashes become %2F, plus becomes %2B, etc.
# This keeps folder names a clean 1:1 representation of the signal group ID
# so agents can construct paths with a trivial find-and-replace.
urlencode() {
    local str="$1"
    local encoded=""
    local i c
    for (( i=1; i<=${#str}; i++ )); do
        c="${str:i-1:1}"
        case "$c" in
            [a-zA-Z0-9._~-]) encoded+="$c" ;;
            '/')             encoded+="%2F" ;;
            '+')             encoded+="%2B" ;;
            *)               encoded+=$(printf '%%%02X' "'$c") ;;
        esac
    done
    printf '%s' "$encoded"
}

# Atomic JSON write (or dry-run preview).
write_json() {
    local content="$1" target="$2"
    if [[ $DRY_RUN -eq 1 ]]; then
        echo "  [dry-run] would write $target"
    else
        local tmp="$target.tmp.$$"
        printf '%s\n' "$content" > "$tmp"
        mv "$tmp" "$target"
    fi
}

# Read a JSON file or echo a fallback object if missing/empty.
read_or() {
    local path="$1" fallback="$2"
    if [[ -f "$path" && -s "$path" ]]; then cat "$path"
    else printf '%s' "$fallback"
    fi
}

# Build a fresh meta.json content for a group, merging dump fields onto
# whatever's already on disk. signal_id is the harness-canonical form
# `group:<raw-id>` — same string the agent sees in inbound chat_id, so
# lookups are zero-transformation.
#
# members is now a simple list of UUIDs. Agents should:
#  - use trustgraph.yaml for profile info (names, trust, history)
#  - use history.md for group narrative
merge_meta() {
    local group_json="$1" existing_json="$2"
    local raw_active status
    raw_active=$(printf '%s' "$group_json" | jq -r '.active')
    if [[ "$raw_active" == "true" ]]; then status="active"; else status="left"; fi

    jq -n \
        --argjson existing "$existing_json" \
        --argjson dump     "$group_json" \
        --arg     now      "$NOW" \
        --arg     status   "$status" '
        # Collect all member UUIDs from the dump.
        (
            [
              ($dump.members            // [] | .[].uuid),
              ($dump.pending_members    // [] | .[].uuid),
              ($dump.requesting_members // [] | .[].uuid),
              ($dump.banned_members     // [] | .[].uuid)
            ] | unique
        ) as $member_uuids |

        # Preserve any non-script fields the agent may have added.
        ($existing | del(.dirname, .members, .member_count)) + {
            signal_id:                  ("group:" + $dump.id),
            name:                       $dump.name,
            description:                $dump.description,
            group_invite_link:          $dump.group_invite_link,
            message_expiration_seconds: $dump.message_expiration_seconds,
            blocked:                    $dump.blocked,
            members:                    $member_uuids,
            status:                     $status,
            agent_active:               ($status == "active"),
            first_seen_at:              ($existing.first_seen_at // $now),
            last_seen_at:               $now,
            left_at: (
                if $status != "active" then ($existing.left_at // $now)
                else $existing.left_at
                end
            )
        }
    '
}

# Mark a group as removed (was on disk, no longer in the dump at all).
mark_removed_meta() {
    local existing_json="$1"
    jq -n --argjson existing "$existing_json" --arg now "$NOW" '
        $existing + {
            status:        "removed",
            agent_active:  false,
            left_at:       ($existing.left_at // $now),
            last_seen_at:  ($existing.last_seen_at // $now)
        }
    '
}

# Simple diff of members[] arrays (old vs new) for stats.
member_delta() {
    local before="$1" after="$2"
    jq -n --argjson before "$before" --argjson after "$after" '
        ($before | unique) as $B | ($after | unique) as $A |
        {
            joined:  ([$A[] | select(. as $x | ($B | index($x)) | not)] | length),
            left:    ([$B[] | select(. as $x | ($A | index($x)) | not)] | length)
        }
    '
}

# ── main loop ────────────────────────────────────────────────────────────

# Cache the dump's groups array as a single JSON string we can split.
DUMP_GROUPS_JSON="$(jq -c '.groups // []' "$DUMP_PATH")"
DUMP_GROUP_COUNT=$(printf '%s' "$DUMP_GROUPS_JSON" | jq 'length')

declare -A SEEN_DIRS  # dirnames touched this run (for "removed" detection)

stat_created=0
stat_updated=0
stat_left=0
stat_removed=0
stat_joined=0
stat_departed=0
stat_banned=0

echo "📂 syncing $DUMP_GROUP_COUNT group(s) from $DUMP_PATH"
echo "   into $BASE_DIR"
[[ $DRY_RUN -eq 1 ]] && echo "   (--dry-run: no files will change)"
echo ""

i=0
while (( i < DUMP_GROUP_COUNT )); do
    group_json=$(printf '%s' "$DUMP_GROUPS_JSON" | jq -c ".[$i]")
    signal_id=$(printf '%s' "$group_json" | jq -r '.id')
    dirname=$(urlencode "$signal_id")
    group_dir="$BASE_DIR/$dirname"
    SEEN_DIRS["$dirname"]=1

    is_new=0
    [[ -d "$group_dir" ]] || is_new=1

    if [[ $DRY_RUN -eq 0 ]]; then
        mkdir -p "$group_dir"
    fi

    # Merge meta
    existing_meta=$(read_or "$group_dir/meta.json" '{}')
    new_meta=$(merge_meta "$group_json" "$existing_meta")
    write_json "$new_meta" "$group_dir/meta.json"

    # Deltas for stats based on members[] in meta.json
    old_members=$(printf '%s' "$existing_meta" | jq -c '.members // []')
    new_members=$(printf '%s' "$new_meta"     | jq -c '.members // []')
    delta=$(member_delta "$old_members" "$new_members")
    j=$(printf '%s' "$delta" | jq -r '.joined')
    l=$(printf '%s' "$delta" | jq -r '.left')
    stat_joined=$(( stat_joined + j ))
    stat_departed=$(( stat_departed + l ))

    # history.md stub (only if missing)
    if [[ ! -f "$group_dir/history.md" ]]; then
        if [[ $DRY_RUN -eq 1 ]]; then
            echo "  [dry-run] would create $group_dir/history.md"
        else
            : > "$group_dir/history.md"
        fi
    fi

    new_status=$(printf '%s' "$new_meta" | jq -r '.status')
    name=$(printf '%s' "$new_meta" | jq -r '.name // "(unnamed)"')
    if (( is_new )); then
        stat_created=$(( stat_created + 1 ))
        echo "  + new      $dirname  [$new_status]  $name"
    else
        stat_updated=$(( stat_updated + 1 ))
        if [[ "$new_status" == "left" ]]; then
            old_status=$(printf '%s' "$existing_meta" | jq -r '.status // "active"')
            if [[ "$old_status" != "left" ]]; then
                stat_left=$(( stat_left + 1 ))
                echo "  ~ updated  $dirname  [active → left]  $name"
            else
                echo "  ~ updated  $dirname  [$new_status]  $name"
            fi
        else
            echo "  ~ updated  $dirname  [$new_status]  $name"
        fi
    fi

    i=$(( i + 1 ))
done

# Removed: dirs that exist on disk but weren't in the dump.
for d in "$BASE_DIR"/*/; do
    [[ -d "$d" ]] || continue
    dirname=$(basename "$d")
    [[ -n "${SEEN_DIRS[$dirname]:-}" ]] && continue

    meta_path="$d/meta.json"
    [[ -f "$meta_path" ]] || continue

    existing_meta=$(cat "$meta_path")
    old_status=$(printf '%s' "$existing_meta" | jq -r '.status // "active"')
    [[ "$old_status" == "removed" ]] && continue   # already marked

    new_meta=$(mark_removed_meta "$existing_meta")
    write_json "$new_meta" "$meta_path"
    stat_removed=$(( stat_removed + 1 ))
    name=$(printf '%s' "$new_meta" | jq -r '.name // "(unnamed)"')
    echo "  - removed  $dirname  [$old_status → removed]  $name"
done

# index.json: rebuild from the on-disk meta.json files (single source of truth).
# Keys are meta.signal_id verbatim (`group:<raw-id>`), matching the agent's
# inbound chat_id. Value `path` is workspace-relative — agent never has to
# construct or compare dirnames.
build_index() {
    local out='{}'
    for d in "$BASE_DIR"/*/; do
        [[ -d "$d" ]] || continue
        local meta="$d/meta.json"
        [[ -f "$meta" ]] || continue
        local id; id=$(jq -r '.signal_id // empty' "$meta")
        [[ -n "$id" ]] || continue
        local dirname; dirname=$(basename "$d")
        local path="group-memory/signal/$dirname"
        local name; name=$(jq -r '.name // ""' "$meta")
        local status; status=$(jq -r '.status // "unknown"' "$meta")
        out=$(printf '%s' "$out" | jq \
            --arg id "$id" --arg path "$path" \
            --arg name "$name" --arg status "$status" \
            '. + {($id): {path: $path, name: $name, status: $status}}')
    done
    printf '%s' "$out"
}
# Index is always rebuilt from disk for consistency. In dry-run we just print.
if [[ $DRY_RUN -eq 1 ]]; then
    echo ""
    echo "  [dry-run] would rebuild $INDEX_PATH"
else
    new_index=$(build_index)
    write_json "$new_index" "$INDEX_PATH"
fi

echo ""
echo "✅ done"
echo "   groups: +$stat_created created, ~$stat_updated updated, →$stat_left left, ✗$stat_removed removed"
echo "   members: +$stat_joined joined, →$stat_departed left, ✗$stat_banned banned"
if [[ $DRY_RUN -eq 1 ]]; then
    echo "   (--dry-run: nothing was written)"
fi
exit 0
