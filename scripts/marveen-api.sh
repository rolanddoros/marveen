#!/usr/bin/env bash
# marveen-api.sh -- the dashboard-API calls a sub-agent's CLAUDE.md prescribes, with no `$(cat token)`.
#
# WHY (#2232): a strict-profile agent runs under `defaultMode: dontAsk`, where a command
# substitution never matches the allow-list, so every `curl ... -H "Authorization: Bearer
# $(cat <token>)"` recipe was auto-denied. This one allow-listed entry point reads the token
# itself (scripts/lib/marveen_api.py, never in an argv) and takes every payload from a file.
#
# Usage: bash scripts/marveen-api.sh <verb> [args]   (bash scripts/marveen-api.sh --help lists them)
#   message [<from>] <to> <content-file> [--priority high|normal]   (<from> defaults to $MARVEEN_AGENT_ID)
#   every verb, message included, is scripts/lib/marveen_api.py (C2 PR4: the message verb's send, which
#   agent-msg.sh used to do, is there too, with the same checks, retries and failure log).
# Env: MARVEEN_API_BASE, MARVEEN_WEB_PORT, WEB_PORT, MARVEEN_TOKEN_FILE, MARVEEN_AGENT_ID.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec python3 "$DIR/lib/marveen_api.py" "$@"
