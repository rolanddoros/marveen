#!/usr/bin/env bash
# daily-log.sh -- append a daily-log entry whose "## HH:MM -- <topic>" header comes from `date`.
#
# WHY: agents wrote the header time from memory and it drifted (measured 2026-10-17, dennis:
# 19:20 for a real 18:50, 20:05 for 20:02, 20:35 for 20:07), each needing a correction entry.
# The written rule did not stop it, so the time is no longer typed by the model at all.
#
# Usage:  bash scripts/daily-log.sh <agent_id> "<topic>" "<body>"
#         echo "<multi-line body>" | bash scripts/daily-log.sh <agent_id> "<topic>" -
#   The body is JSON-encoded with json.dumps, so backticks, $(...) and quotes stay literal.
# Output: "OK HH:MM" on success; "FAIL <reason>" + exit 1 otherwise (HTTP status and {"ok":true} checked).
# Env: MARVEEN_WEB_PORT (default 3420), MARVEEN_TOKEN_FILE (default <repo>/store/.dashboard-token).
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
[ $# -eq 3 ] || { echo "usage: $0 <agent_id> <topic> <body|->" >&2; exit 2; }
AGENT="$1"; TOPIC="$2"; BODY="$3"
[ "$BODY" = "-" ] && BODY="$(cat)"
TOKEN_FILE="${MARVEEN_TOKEN_FILE:-$REPO/store/.dashboard-token}"
PORT="${MARVEEN_WEB_PORT:-3420}"
HHMM="$(date +%H:%M)"  # host local time = install zone (no hardcoded zone, ISSUE1895)
TMP="$(mktemp)"; trap 'rm -f "$TMP" "$TMP.out"' EXIT
python3 -I -c 'import json,sys; json.dump({"agent_id":sys.argv[1],"content":"## "+sys.argv[2]+" -- "+sys.argv[3]+"\n"+sys.argv[4]}, open(sys.argv[5],"w"), ensure_ascii=False)' \
  "$AGENT" "$HHMM" "$TOPIC" "$BODY" "$TMP" || { echo "FAIL json"; exit 1; }
CODE="$(curl -s -o "$TMP.out" -w '%{http_code}' -X POST "http://localhost:$PORT/api/daily-log" \
  -H "Content-Type: application/json" -H "Authorization: Bearer $(cat "$TOKEN_FILE")" --data-binary @"$TMP")"
if [ "$CODE" = "200" ] && grep -q '"ok":true' "$TMP.out"; then echo "OK $HHMM"; else echo "FAIL http=$CODE resp=$(head -c 200 "$TMP.out")"; exit 1; fi
