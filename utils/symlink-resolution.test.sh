#!/usr/bin/env bash
# symlink-resolution.test.sh
# Regression test: utils scripts must resolve sibling files when invoked
# through the /usr/bin symlinks installed by `make install` (AUR layout).
#
# Layout under test (mirrors Makefile `install`):
#   <tmp>/lib/freeclaw/utils/*.sh|*.py   real files
#   <tmp>/bin/<name>                      symlinks -> ../lib/freeclaw/utils/<base>
#
# Assertion: llamacpp-init and build-switch invoked via those symlinks get
# PAST lib-gateway resolution. They must NOT die with
# "Missing ... lib-gateway.sh"; failing later on missing env/TTY guards is
# the expected, passing outcome.
#
# Standalone (no Makefile test target exists). Run from the repo root:
#   bash utils/symlink-resolution.test.sh
# Exit 0 = pass, 1 = fail.

set -u

REPO_ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"

TMP="$(mktemp -d /tmp/freeclaw-symlink-test.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

LIBDIR="$TMP/lib/freeclaw"
BINDIR="$TMP/bin"
mkdir -p "$LIBDIR/utils" "$BINDIR"

# Copy real files (including non-executable .sh/.py like lib-gateway.sh;
# `make install` chmods them, we keep them real files either way).
cp -a "$REPO_ROOT/utils/." "$LIBDIR/utils/"

# Recreate the Makefile install symlink loop: basename minus extension,
# underscores -> dashes, symlinked into BINDIR.
for f in "$LIBDIR"/utils/*.sh "$LIBDIR"/utils/*.py; do
    [[ -f "$f" ]] || continue
    chmod 755 "$f"
    base="$(basename "$f")"
    name="$(printf '%s' "${base%.*}" | tr '_' '-')"
    ln -sfn "../lib/freeclaw/utils/$base" "$BINDIR/$name"
done

failures=0

# run_past_lib_gateway <display-name> <command...>
# Pass: output contains NO "Missing ... lib-gateway.sh" (exit code irrelevant —
# missing env/TTY guards are expected to fail the run later).
run_past_lib_gateway() {
    local name="$1"; shift
    local out rc
    out="$("$@" </dev/null 2>&1)"
    rc=$?
    if printf '%s' "$out" | grep -q 'Missing .*lib-gateway\.sh'; then
        printf 'FAIL  %s: died on lib-gateway resolution (exit %d)\n' "$name" "$rc"
        printf '%s\n' "$out" | grep 'Missing .*lib-gateway\.sh' | sed 's/^/      /'
        failures=$((failures + 1))
    else
        printf 'PASS  %s: got past lib-gateway resolution (exit %d)\n' "$name" "$rc"
        printf '%s\n' "$out" | tail -n 2 | sed 's/^/      /'
    fi
}

echo "== AUR symlink layout: $BINDIR -> $LIBDIR/utils =="

# llamacpp-init via symlink, non-interactive with no env: must reach the
# non-interactive env guard, not the lib-gateway error.
run_past_lib_gateway "llamacpp-init (via symlink, no env)" \
    env -i HOME="$TMP/fakehome" PATH="$PATH" bash "$BINDIR/llamacpp-init"
mkdir -p "$TMP/fakehome"

# build-switch via symlink with a syntactically valid-but-missing branch:
# must fail later (repo/branch guards), not on lib-gateway.
run_past_lib_gateway "build-switch (via symlink, bogus branch)" \
    env -i HOME="$TMP/fakehome" PATH="$PATH" bash "$BINDIR/build-switch" __symlink_test_no_such_branch__

# trustgraph.py via symlink: with no args argparse exits 2 (usage) before the
# dump-path check; assert it does not crash on a wrong /usr/bin-based path and
# that with a workspace arg the "dump not found" path points into LIBDIR.
tg_out="$(env -i HOME="$TMP/fakehome" PATH="$PATH" python3 "$BINDIR/trustgraph" "$TMP/fakehome/ws" </dev/null 2>&1)"
tg_rc=$?
if printf '%s' "$tg_out" | grep -q "$BINDIR/signal-identity-dumps"; then
    printf 'FAIL  trustgraph (via symlink): looked for dump next to symlink (exit %d)\n' "$tg_rc"
    printf '%s\n' "$tg_out" | tail -n 2 | sed 's/^/      /'
    failures=$((failures + 1))
elif printf '%s' "$tg_out" | grep -q "$LIBDIR/utils/signal-identity-dumps"; then
    printf 'PASS  trustgraph (via symlink): default dump resolved into real utils dir (exit %d)\n' "$tg_rc"
else
    printf 'FAIL  trustgraph (via symlink): unexpected output (exit %d)\n' "$tg_rc"
    printf '%s\n' "$tg_out" | tail -n 4 | sed 's/^/      /'
    failures=$((failures + 1))
fi

echo
if [[ $failures -gt 0 ]]; then
    echo "RESULT: FAIL ($failures assertion(s) failed)"
    exit 1
fi
echo "RESULT: PASS"
exit 0
