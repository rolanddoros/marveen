#!/usr/bin/env bash
# agent-msg.sh -- reliable inter-agent message send. Usage, output, exit codes and the failure log are unchanged:
#   bash scripts/agent-msg.sh [--priority high|normal] <from> <to> "<content>"      (or - to read it from STDIN)
# C2 PR4: the logic (status + id check, 3 tries, homoglyph gate, queue line, store/agent-msg-failures.log) lives in
# scripts/lib/marveen_api.py, send_message; read its header there. This file only hands its argv over.
exec python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/marveen_api.py" --agent-msg "$@"
