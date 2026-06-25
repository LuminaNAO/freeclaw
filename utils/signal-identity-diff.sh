#!/usr/bin/env bash
# signal-identity-diff.sh — capture a fresh signal-identity-dump and diff it
# against the previously stored "current" dump.
#
# Workflow per run:
#   1. Run signal-identity-dump.sh into a temp file.
#   2. If $DUMP_DIR/current.json exists, archive it as <timestamp>.json.
#   3. Move the new dump into current.json.
#   4. Diff archive vs current (key-sorted via jq -S) → <timestamp>.diff.
#   5. Mirror that diff to current.diff (stable endpoint for agents/tools).
#
# Layout in $DUMP_DIR after a few runs:
#   current.json     latest dump (canonical)
#   current.diff     diff produced by the most recent run (always present)
#   <TS>.json        archived previous dump
#   <TS>.diff        unified diff archive vs current at that TS
#
# The first run still creates current.diff — it just contains a marker
# header noting "no previous dump to diff against".
#
# Usage:
#   ./signal-identity-diff.sh                # auto-detect account
#   ./signal-identity-diff.sh +6283167492405 # explicit account, passed through
#
# Env:
#   SIGNAL_DUMP_DIR — output directory (default: ./signal-identity-dumps next
#                     to this script, gitignored).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DUMPER="$SCRIPT_DIR/signal-identity-dump.sh"
DUMP_DIR="${SIGNAL_DUMP_DIR:-$SCRIPT_DIR/signal-identity-dumps}"

[[ -x "$DUMPER" ]] || { echo "❌ cannot exec $DUMPER" >&2; exit 1; }
command -v jq >/dev/null || { echo "❌ jq is required" >&2; exit 1; }

# Best-effort detector for openclaw processes (any user). Returns matching
# pid lines on stdout, or nothing. Self-filters because pgrep -f matches our
# own command line too (script path contains "openclaw"). Used as a HINT on
# failure — never as a pre-flight block, since other users may legitimately
# be running their own gateways while ours is stopped.
detect_openclaw() {
    pgrep -af 'openclaw' 2>/dev/null | awk -v self="$$" '$1 != self' || true
}

mkdir -p "$DUMP_DIR"

CURRENT="$DUMP_DIR/current.json"
CURRENT_DIFF="$DUMP_DIR/current.diff"   # static endpoint — always the latest
TS="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="$DUMP_DIR/$TS.json"
DIFF_FILE="$DUMP_DIR/$TS.diff"

# 1. Fresh dump → tempfile inside DUMP_DIR (keeps everything under one
#    folder; also makes the eventual mv to current.json a same-filesystem
#    rename instead of a cross-fs copy).
TMP="$(mktemp "$DUMP_DIR/.tmp.XXXXXX")"
trap 'rm -f "$TMP"' EXIT

echo "📥 capturing new identity dump (30s timeout)…"
rc=0
timeout 30 "$DUMPER" "$@" > "$TMP" || rc=$?
if [[ $rc -ne 0 ]]; then
    # tempfile cleanup + current.json being untouched are both already
    # guaranteed by the EXIT trap and the "promote on success" ordering
    # below — so a timeout here naturally reverts everything.
    if [[ $rc -eq 124 ]]; then
        echo "❌ dump timed out after 30s; current.json untouched" >&2
    else
        echo "❌ signal-identity-dump.sh failed (exit=$rc); current.json untouched" >&2
    fi
    # Hint: a running openclaw on this host (any user) holds the signal-cli
    # account lock and blocks listContacts/listGroups until it releases.
    oc_procs=$(detect_openclaw)
    if [[ -n "$oc_procs" ]]; then
        echo "" >&2
        echo "   hint: openclaw appears to be running on this host." >&2
        echo "   signal-cli can't acquire the account lock while another" >&2
        echo "   process holds it. matching processes:" >&2
        echo "$oc_procs" | sed 's/^/     /' >&2
        echo "   if any of those is your gateway, stop it and re-run." >&2
    fi
    exit 1
fi

# Sanity-check it's valid JSON before we trust it.
jq empty "$TMP" 2>/dev/null || {
    echo "❌ new dump is not valid JSON; current.json untouched" >&2
    exit 1
}

# Always emit a diff file so consumers can rely on its presence; for
# first-run / no-change cases we put a marker header in it instead of
# leaving an empty file (or no file at all).
write_diff_marker() {
    local status="$1"
    {
        echo "# signal-identity-diff: $status"
        echo "# generated: $(date -Iseconds)"
        echo "# current:   $CURRENT"
        # NOTE: an `[[ -n ... ]] && echo ...` here would silently kill the
        # script under set -e on first run (ARCHIVE_REF unset → block ends
        # in non-zero exit → propagates out of the function). Use an
        # if/fi so the block always ends 0-exit.
        if [[ -n "${ARCHIVE_REF:-}" ]]; then
            echo "# previous:  $ARCHIVE_REF"
        fi
    } > "$DIFF_FILE"
}

# 2 + 3. Promote new dump; archive old.
if [[ -f "$CURRENT" ]]; then
    mv "$CURRENT" "$ARCHIVE"
    mv "$TMP" "$CURRENT"
    trap - EXIT  # tempfile is now current.json — don't delete
    ARCHIVE_REF="$ARCHIVE"

    # 4. Diff (key-sorted so we only see real changes, not jq output ordering)
    if diff -u \
        --label "$ARCHIVE" \
        --label "$CURRENT" \
        <(jq -S . "$ARCHIVE") <(jq -S . "$CURRENT") > "$DIFF_FILE"
    then
        # diff exits 0 when files are identical → overwrite the empty
        # output with an explicit marker so the file isn't ambiguous.
        write_diff_marker "no changes since previous dump"
        echo "✅ no changes since previous dump"
        echo "   archived: $ARCHIVE"
        echo "   current:  $CURRENT"
        echo "   diff:     $DIFF_FILE  (marker only — no changes)"
        echo "   latest:   $CURRENT_DIFF  (stable endpoint)"
    else
        # diff exits 1 when there ARE differences — that's the success path here
        added=$(grep -c '^+[^+]' "$DIFF_FILE" || true)
        removed=$(grep -c '^-[^-]' "$DIFF_FILE" || true)
        echo "✅ diff captured: +$added / -$removed lines"
        echo "   archived: $ARCHIVE"
        echo "   current:  $CURRENT"
        echo "   diff:     $DIFF_FILE"
        echo "   latest:   $CURRENT_DIFF  (stable endpoint)"
    fi
else
    mv "$TMP" "$CURRENT"
    trap - EXIT
    write_diff_marker "first capture — no previous dump to diff against"
    echo "✅ first dump captured (no previous to diff against)"
    echo "   current: $CURRENT"
    echo "   diff:    $DIFF_FILE  (marker only — first capture)"
    echo "   latest:  $CURRENT_DIFF  (stable endpoint)"
fi

# Mirror the just-written timestamped diff to a stable filename so agents
# and other consumers can read $DUMP_DIR/current.diff without globbing for
# the latest TS. Done atomically: write to a sibling .tmp then rename, so a
# concurrent reader never sees a half-written file.
cp "$DIFF_FILE" "$CURRENT_DIFF.tmp"
mv "$CURRENT_DIFF.tmp" "$CURRENT_DIFF"
