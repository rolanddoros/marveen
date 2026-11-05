#!/usr/bin/env bash
# marveen-admin.sh -- the MAIN agent's schedule writes (C2 PR5). Not for sub-agents.
#
# scripts/marveen-api.sh only READS schedules (schedules-list): every schedule write is the main agent's, and the
# helper refuses one before it is sent. This separate entry point is the main agent's way to create or change a
# schedule without a curl recipe. Sub-agents cannot use it: the self-pace gate denies both this name and
# lib/marveen_admin.py, no permission profile allow-lists it, and the tool itself refuses when MARVEEN_AGENT_ID
# names another agent (an accident guard, not a security boundary: the value is self-declared).
#
# Usage: bash scripts/marveen-admin.sh <verb> [args]   (bash scripts/marveen-admin.sh --help lists them)
# Env: MARVEEN_API_BASE, MARVEEN_WEB_PORT, WEB_PORT, MARVEEN_TOKEN_FILE, MARVEEN_AGENT_ID (same gate as the helper).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec python3 "$DIR/lib/marveen_admin.py" "$@"
