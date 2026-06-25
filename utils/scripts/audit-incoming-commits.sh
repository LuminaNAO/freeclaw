#!/usr/bin/env bash
# llama-launcher incoming commit audit
# Run before any tag or push to catch issues from external machines
# Reads config from scripts/audit-config.env (gitignored, not committed)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/audit-config.env"

if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "ERROR: Config file not found: $CONFIG_FILE" >&2
    echo "Copy audit-config.env.example and fill in your values." >&2
    exit 1
fi
# shellcheck disable=SC1091
source "$CONFIG_FILE"

REPO_DIR="${1:-.}"
cd "$REPO_DIR"

# Find last tag
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")

if [ -z "$LAST_TAG" ]; then
    echo "ERROR: No tags found in repository"
    exit 1
fi

echo "=== AUDITING COMMITS SINCE $LAST_TAG ==="
echo ""

# Get commits since last tag
COMMITS=$(git log "$LAST_TAG"..HEAD --format="%h" 2>/dev/null || echo "")

if [ -z "$COMMITS" ]; then
    echo "OK: No new commits since $LAST_TAG"
    exit 0
fi

echo "Checking $(echo "$COMMITS" | wc -l) commits..."
echo ""

FAILED=0

# 1. Author identity check
echo "--- Author Identity ---"
BAD_AUTHORS=$(git log "$LAST_TAG"..HEAD --format="%h %an <%ae>" | grep -v "$AUDIT_AUTHOR_EMAIL" || true)
if [ -n "$BAD_AUTHORS" ]; then
    echo "FAIL: Commits with wrong author:"
    echo "$BAD_AUTHORS" | sed 's/^/  /'
    FAILED=1
else
    echo "OK: All commits have correct author"
fi
echo ""

# 2. GPG signature check
echo "--- GPG Signatures ---"
UNSIGNED=$(git log "$LAST_TAG"..HEAD --format="%h %G? %s" | grep -v "^[^ ]* G " || true)
if [ -n "$UNSIGNED" ]; then
    echo "WARN: Unsigned commits (may be expected):"
    echo "$UNSIGNED" | sed 's/^/  /'
else
    echo "OK: All commits signed"
fi
echo ""

# 3. Private info leak scan
echo "--- Private Info Scan ---"
LEAKS=$(git log "$LAST_TAG"..HEAD --format="%B" | grep -iE "(password|secret|key|token|private|internal)" || true)
if [ -n "$LEAKS" ]; then
    echo "WARN: Possible sensitive data in commit messages:"
    echo "$LEAKS" | sed 's/^/  /'
    FAILED=1
fi

# Check for internal IPs and infrastructure references
INFRA_LEAKS=$(git diff "$LAST_TAG"..HEAD | grep -iE "($AUDIT_INFRA_PATTERNS)" || true)
if [ -n "$INFRA_LEAKS" ]; then
    echo "WARN: Possible infrastructure references in diff:"
    echo "$INFRA_LEAKS" | sed 's/^/  /'
    FAILED=1
fi
echo ""

# 4. Timestamp sanity
echo "--- Timestamps ---"
TIMESTAMPS=$(git log "$LAST_TAG"..HEAD --format="%h %ai" | tail -5)
echo "$TIMESTAMPS" | sed 's/^/  /'
# Check for future dates
FUTURE=$(git log "$LAST_TAG"..HEAD --format="%ai" | while read -r ts; do
    if [ "$ts" \> "$(date -u +%Y-%m-%dT%H:%M:%S)" ]; then
        echo "$ts"
    fi
done || true)
if [ -n "$FUTURE" ]; then
    echo "WARN: Future timestamps detected:"
    echo "$FUTURE" | sed 's/^/  /'
fi
echo ""

# 5. Suspicious file additions
echo "--- Suspicious Files ---"
SUSPICIOUS=$(git diff "$LAST_TAG"..HEAD --name-only --diff-filter=AM | grep -iE "(private|secret|\.env|\.config|\.ssh|\.key|id_rsa)" || true)
if [ -n "$SUSPICIOUS" ]; then
    echo "WARN: Suspicious files added:"
    echo "$SUSPICIOUS" | sed 's/^/  /'
    FAILED=1
else
    echo "OK: No suspicious files"
fi
echo ""

# Summary
echo "=== AUDIT SUMMARY ==="
if [ $FAILED -eq 1 ]; then
    echo "FAIL: Issues found. Fix before publishing."
    exit 1
else
    echo "PASS: All checks passed."
    exit 0
fi
