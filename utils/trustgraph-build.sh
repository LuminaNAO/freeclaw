#!/usr/bin/env bash
# trustgraph-build.sh — wrapper that calls trustgraph.py
#
# Usage:
#   ./trustgraph-build.sh <workspace> [--dump <path>] [--dry-run]
#
#   <workspace>    Path to the OpenClaw workspace (contains trustgraph.yaml)
#   --dump <path>  Path to signal identity dump (default: ./signal-identity-dumps/current.json)
#   --dry-run      Preview changes without writing

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_SCRIPT="$SCRIPT_DIR/trustgraph.py"

if [[ ! -f "$PYTHON_SCRIPT" ]]; then
    echo "❌ trustgraph.py not found in $SCRIPT_DIR" >&2
    exit 1
fi

exec python3 "$PYTHON_SCRIPT" "$@"