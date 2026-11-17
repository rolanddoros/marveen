#!/bin/bash
# Contract tests for scripts/watchdog.sh's gate-wiring step (Fork C settings-protect plan v2 point 3, Ron D2-REL-2):
# a sub-agent is started only when scripts/hooks/verify-gate-wiring.mjs exits 0; exit 1 (enforce), 127 (no node /
# missing file) and a killed verifier all mean no start; the verifier's line lands in the log, and only a NEW
# problem set goes to the owner through notify.sh.
#
# Driven through `watchdog.sh --gate-wiring <agent-id>`, which runs the same gate_wiring_ok function the restart
# loop calls and exits before tmux, the dashboard or the main agent. First with a stub verifier, then with the real
# one copied into a fixture install. A static check pins the call right before the loop's `tmux new-session`.
# Run: bash scripts/__tests__/watchdog-gate-wiring.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- got: $2"; }

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
WATCHDOG="${WATCHDOG_BIN:-$REPO_DIR/scripts/watchdog.sh}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

command -v node >/dev/null 2>&1 || { echo "  FAIL: node is needed for this suite"; exit 1; }

INST="$TMP/install"
mkdir -p "$INST/scripts/hooks" "$INST/store" "$INST/logs" "$INST/agents/alpha"
cp "$WATCHDOG" "$INST/scripts/watchdog.sh"
WD="$INST/scripts/watchdog.sh"
LOG="$INST/logs/watchdog.log"
NOTIFIED="$TMP/notified"
MODE="$TMP/mode"

cat > "$INST/scripts/notify.sh" <<'SH'
#!/bin/bash
printf '%s\n' "$1" >> "$NOTIFIED_FILE"
SH
export NOTIFIED_FILE="$NOTIFIED"

# The stub verifier: behaves as the mode file says, and records its arguments.
cat > "$INST/scripts/hooks/verify-gate-wiring.mjs" <<'JS'
import { readFileSync, appendFileSync } from 'node:fs'
const mode = readFileSync(process.env.GW_MODE_FILE, 'utf8').trim()
appendFileSync(process.env.GW_ARGS_FILE, process.argv.slice(2).join(' ') + '\n')
if (mode === 'ok') process.exit(0)
if (mode === 'report-new') { process.stderr.write('[GATE-WIRING] alpha report NEW: x: broken\n'); process.exit(0) }
if (mode === 'report-same') { process.stderr.write('[GATE-WIRING] alpha report: x: broken\n'); process.exit(0) }
if (mode === 'enforce') { process.stderr.write('[GATE-WIRING] alpha enforce NOT STARTED NEW: x: broken\n'); process.exit(1) }
if (mode === 'stdout-only') { process.stdout.write('noise\n'); process.exit(0) }
if (mode === 'killed') process.kill(process.pid, 'SIGKILL')
process.exit(3)
JS
export GW_MODE_FILE="$MODE" GW_ARGS_FILE="$TMP/args"

# $1 label, $2 mode, $3 expected decision, $4 expected NEW alerts after the call (count)
expect_gate() {
  echo "$2" > "$MODE"
  local got
  got="$(bash "$WD" --gate-wiring alpha 2>&1)"
  if [ "$got" = "$3" ]; then pass "$1"; else fail "$1" "$got"; fi
  local n=0
  [ -f "$NOTIFIED" ] && n="$(wc -l < "$NOTIFIED" | tr -d ' ')"
  if [ "$n" = "$4" ]; then pass "$1: owner alerts so far = $4"; else fail "$1: owner alerts so far = $4" "$n"; fi
}

echo "watchdog gate-wiring step (stub verifier):"
expect_gate "verifier exit 0, no output: start" ok "start=yes" 0
expect_gate "report mode, a NEW problem: start, one alert" report-new "start=yes" 1
expect_gate "report mode, the same problem again: start, no second alert" report-same "start=yes" 1
expect_gate "enforce, a problem: no start, alert" enforce "start=no" 2
expect_gate "a killed verifier: no start" killed "start=no" 2
expect_gate "any other exit status: no start" other "start=no" 2
expect_gate "stdout is not taken as a verdict" stdout-only "start=yes" 2

case "$(cat "$TMP/args")" in
  "--agent alpha"*) pass "the verifier gets --agent <id>" ;;
  *) fail "the verifier gets --agent <id>" "$(head -1 "$TMP/args")" ;;
esac
grep -qF '[GATE-WIRING] alpha enforce NOT STARTED NEW: x: broken' "$LOG" && pass "the verifier line is logged" || fail "the verifier line is logged" "$(tail -3 "$LOG")"
grep -qF '[GATE-WIRING] alpha: not started (verifier exit 1)' "$LOG" && pass "a no-start is logged with the exit status" || fail "a no-start is logged with the exit status" "$(tail -3 "$LOG")"

rm -f "$INST/scripts/hooks/verify-gate-wiring.mjs"
got="$(bash "$WD" --gate-wiring alpha 2>&1)"
[ "$got" = "start=no" ] && pass "a missing verifier file: no start" || fail "a missing verifier file: no start" "$got"

echo "watchdog gate-wiring step (the real verifier, no baseline entry):"
for f in verify-gate-wiring.mjs sub-hooks-lock.mjs settings-validator.mjs agent-settings-baseline.mjs sub-hooks.lock.json; do
  cp "$REPO_DIR/scripts/hooks/$f" "$INST/scripts/hooks/$f"
done
got="$(HOME="$TMP/home" bash "$WD" --gate-wiring alpha 2>&1)"
[ "$got" = "start=yes" ] && pass "no .env switch: report mode, the agent starts" || fail "no .env switch: report mode, the agent starts" "$got"
grep -qF '[GATE-WIRING] alpha report NEW: baseline: missing' "$LOG" && pass "report mode logs the finding" || fail "report mode logs the finding" "$(tail -2 "$LOG")"
printf 'GATE_WIRING_ENFORCE=1\n' > "$INST/.env"
got="$(HOME="$TMP/home" bash "$WD" --gate-wiring alpha 2>&1)"
[ "$got" = "start=no" ] && pass "GATE_WIRING_ENFORCE=1 in .env: no start" || fail "GATE_WIRING_ENFORCE=1 in .env: no start" "$got"
rm -f "$INST/.env"
got="$(GATE_WIRING_ENFORCE=1 HOME="$TMP/home" bash "$WD" --gate-wiring alpha 2>&1)"
[ "$got" = "start=yes" ] && pass "the switch in the caller's environment is ignored" || fail "the switch in the caller's environment is ignored" "$got"

echo "watchdog gate-wiring step (wiring in the restart loop):"
prev="$(grep -B1 -F 'tmux new-session -d -s "$SESSION_NAME" "$CMD"' "$WATCHDOG" | head -1 | sed 's/^ *//')"
[ "$prev" = 'gate_wiring_ok "$AGENT_ID" || continue' ] && pass "the loop calls gate_wiring_ok right before tmux new-session" || fail "the loop calls gate_wiring_ok right before tmux new-session" "$prev"
n="$(grep -v '^[[:space:]]*#' "$WATCHDOG" | grep -c 'tmux new-session')"
[ "$n" = "1" ] && pass "the sub-agent start is the only tmux new-session in watchdog.sh" || fail "the sub-agent start is the only tmux new-session in watchdog.sh" "$n"

echo
echo "watchdog-gate-wiring: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
