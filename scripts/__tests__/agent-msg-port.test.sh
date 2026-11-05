#!/usr/bin/env bash
# agent-msg.sh and agent-msg-get.sh call the install's dashboard port (#1869).
#
# WHAT THIS GUARDS. Both helpers used to know only MARVEEN_WEB_PORT (or nothing
# at all) and fell back to 3420. An agent's tmux session sets neither
# MARVEEN_WEB_PORT nor WEB_PORT, so on an install whose .env says WEB_PORT=3520
# every message went to 3420: connection refused, or another install's
# dashboard if one listens there. The chain is now the doctor.sh one:
# MARVEEN_WEB_PORT, WEB_PORT, this install's .env, 3420.
#
# Nothing leaves the machine: for agent-msg-get.sh a curl stub records the URL
# it was given; agent-msg.sh (python since C2 PR4) talks to a stub API on
# 127.0.0.1. The helpers run from a sandbox copy of the install tree, so the
# .env they read is the sandbox's, never the real one.
#
# Run:  bash scripts/__tests__/agent-msg-port.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
FAILS=0; N=0
ok() { N=$((N+1)); if [ "$2" = "0" ]; then echo "PASS  $1"; else echo "FAIL  $1${3:+  -- $3}"; FAILS=$((FAILS+1)); fi; }

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/msgport.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT
INST="$SANDBOX/install"; BIN="$SANDBOX/bin"
mkdir -p "$INST/scripts/lib" "$INST/store" "$BIN"
cp "$ROOT/scripts/agent-msg.sh" "$ROOT/scripts/agent-msg-get.sh" "$INST/scripts/"
# C2 PR4: agent-msg.sh is a shim over the python helper; it sends with urllib, not curl.
cp "$ROOT/scripts/lib/marveen_api.py" "$INST/scripts/lib/"
printf 'test-token\n' > "$INST/store/.dashboard-token"

# curl stub (agent-msg-get.sh still uses curl): logs every argument that looks like a URL, answers 200 with an id.
# agent-msg-get.sh writes the body to the file after -o, so honour -o too.
cat > "$BIN/curl" <<'STUB'
#!/usr/bin/env bash
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2; continue ;;
    http://*|https://*) printf '%s\n' "$1" >> "$CURL_LOG" ;;
  esac
  shift
done
body='{"id":1,"status":"pending","content":"x","from_agent":"a","to_agent":"b"}'
if [ -n "$out" ]; then printf '%s' "$body" > "$out"; printf '200'; else printf '%s\n200' "$body"; fi
STUB
chmod +x "$BIN/curl"
printf '#!/usr/bin/env bash\nexit 0\n' > "$BIN/sleep"; chmod +x "$BIN/sleep"

# run <helper> [VAR=value ...]: a clean environment except the given variables.
run() {
  local helper="$1"; shift
  : > "$SANDBOX/curl.log"
  env -u MARVEEN_WEB_PORT -u WEB_PORT -u MARVEEN_API_BASE \
      PATH="$BIN:$PATH" CURL_LOG="$SANDBOX/curl.log" "$@" \
      /bin/bash "$INST/scripts/$helper" $( [ "$helper" = agent-msg.sh ] && echo 'igor hex tiszta' || echo 1 ) \
      >"$SANDBOX/out.txt" 2>"$SANDBOX/err.txt"
  URL="$(head -1 "$SANDBOX/curl.log")"
}
port_is() { case "$URL" in "http://localhost:$1/"*) echo 0 ;; *) echo 1 ;; esac; }

for helper in agent-msg-get.sh; do
  printf 'WEB_PORT=3521\n' > "$INST/.env"
  run "$helper"
  ok "$helper: .env WEB_PORT=3521, no env -> 3521 (the #1869 case)" "$(port_is 3521)" "url=$URL err=$(head -c 200 "$SANDBOX/err.txt")"

  run "$helper" WEB_PORT=3522
  ok "$helper: WEB_PORT in the environment wins over .env" "$(port_is 3522)" "url=$URL"

  run "$helper" WEB_PORT=3522 MARVEEN_WEB_PORT=3523
  ok "$helper: MARVEEN_WEB_PORT wins over both" "$(port_is 3523)" "url=$URL"

  printf 'OTHER=1\nWEB_PORT="3524"\n' > "$INST/.env"
  run "$helper"
  ok "$helper: a quoted .env value is read without the quotes" "$(port_is 3524)" "url=$URL"

  rm -f "$INST/.env"
  run "$helper"
  ok "$helper: no .env and no env -> the 3420 default" "$(port_is 3420)" "url=$URL"
done

# agent-msg.sh sends with python now (C2 PR4), so a stub API on 127.0.0.1 on a free port P stands in for the
# dashboard and records each request; DEAD is a port nothing listens on. A case passes when the request REACHED P.
python3 "$HERE/lib/msg-stub-server.py" "$SANDBOX/port" "$SANDBOX/calls.txt" "$SANDBOX/no-reply-file" &
SRV=$!
trap 'kill "$SRV" 2>/dev/null; rm -rf "$SANDBOX"' EXIT
for _ in $(seq 50); do [ -s "$SANDBOX/port" ] && break; sleep 0.1; done
[ -s "$SANDBOX/port" ] || { echo "FATAL: the stub API did not start" >&2; exit 2; }
P="$(cat "$SANDBOX/port")"
DEAD="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
send() {  # send [VAR=value ...]: agent-msg.sh in a clean environment except the given variables
  : > "$SANDBOX/calls.txt"
  env -u MARVEEN_WEB_PORT -u WEB_PORT -u MARVEEN_API_BASE "$@" \
      /bin/bash "$INST/scripts/agent-msg.sh" igor hex tiszta >"$SANDBOX/out.txt" 2>"$SANDBOX/err.txt"
  REACHED="$([ -s "$SANDBOX/calls.txt" ] && echo 0 || echo 1)"
}
printf 'WEB_PORT=%s\n' "$P" > "$INST/.env"
send
ok "agent-msg.sh: .env WEB_PORT, no env -> that port (the #1869 case)" "$REACHED" "out=$(cat "$SANDBOX/out.txt")"
printf 'WEB_PORT=%s\n' "$DEAD" > "$INST/.env"
send WEB_PORT="$P"
ok "agent-msg.sh: WEB_PORT in the environment wins over .env" "$REACHED" "out=$(cat "$SANDBOX/out.txt")"
send WEB_PORT="$DEAD" MARVEEN_WEB_PORT="$P"
ok "agent-msg.sh: MARVEEN_WEB_PORT wins over both" "$REACHED" "out=$(cat "$SANDBOX/out.txt")"
printf 'OTHER=1\nWEB_PORT="%s"\n' "$P" > "$INST/.env"
send
ok "agent-msg.sh: a quoted .env value is read without the quotes" "$REACHED" "out=$(cat "$SANDBOX/out.txt")"
# The 3420 default is read, not sent: on a host where a dashboard listens on 3420 a request would reach it.
rm -f "$INST/.env"
BASE_URL="$(env -u MARVEEN_WEB_PORT -u WEB_PORT -u MARVEEN_API_BASE python3 -c \
  'import sys; sys.path.insert(0, sys.argv[1]); import marveen_api; print(marveen_api.message_api_base())' "$INST/scripts/lib")"
ok "agent-msg.sh: no .env and no env -> the 3420 default" "$([ "$BASE_URL" = "http://localhost:3420" ] && echo 0 || echo 1)" "base=$BASE_URL"

# The seeded memoria-heartbeat uses the {{WEB_PORT}} placeholder the installers
# and update.sh substitute, like dream-engine; the verbatim seed skills read .env.
SKILL="$ROOT/scheduled-tasks/memoria-heartbeat/SKILL.md"
ok "memoria-heartbeat: no literal localhost:3420" "$(grep -q 'localhost:3420' "$SKILL" && echo 1 || echo 0)"
ok "memoria-heartbeat: the memory POST uses {{WEB_PORT}}" "$(grep -q 'http://localhost:{{WEB_PORT}}/api/memories' "$SKILL" && echo 0 || echo 1)"
for s in retrospective approval-request-handling; do
  F="$ROOT/seed-skills/$s/SKILL.md"
  ok "seed-skills/$s: no literal localhost:3420" "$(grep -q 'localhost:3420' "$F" && echo 1 || echo 0)"
  ok "seed-skills/$s: reads WEB_PORT from .env" "$(grep -q "s/^WEB_PORT=//p" "$F" && echo 0 || echo 1)"
done

echo "---- $((N-FAILS))/$N passed"
[ "$FAILS" = "0" ]
