#!/usr/bin/env bash
# Thin wrapper — the canonical build-switch lives in utils/ (alongside
# lib-gateway.sh and llamacpp-init.sh). This top-level copy exists only so the
# documented `~/code/freeclaw/build-switch.sh <branch>` invocation keeps
# working; never edit build logic here.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/utils/build-switch.sh" "$@"
