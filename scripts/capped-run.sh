#!/bin/bash
# Run a heavy command (test suite, build, local gate) in its OWN transient
# systemd scope, outside the agent's tmux session scope.
# Why (2026-10-19): systemd-oomd kills a whole cgroup under host memory
# pressure. A test run inside the session scope makes the SESSION the victim
# (dennis 10:46 and 18:20, 5.9G each: the agent lost its turn and idled for
# hours). In its own scope the test run is the victim instead, and the session
# survives and sees a failed command. dev_memcap.sh marks every session scope
# with user.oomd_avoid, so oomd prefers these run scopes.
# One heavy run at a time (2026-10-23): two full suites side by side (stuart +
# dennis, 17:31-17:48) pushed user@0 memory pressure to 97% and oomd killed
# dennis's scope three times, although neither run was over its own cap. A
# fleet-wide flock now queues the runs; the waiting one says so on stderr.
# Usage: bash scripts/capped-run.sh <command> [args...]
#        CAPPED_RUN_MAX=4G bash scripts/capped-run.sh pnpm test
#        CAPPED_RUN_WAIT=600  -> give up after 10 min in the queue (default 45 min, exit 75)
#        CAPPED_RUN_NOLOCK=1  -> skip the queue (small, short commands only)
set -u
[ "$#" -gt 0 ] || { echo "usage: capped-run.sh <command> [args...]" >&2; exit 2; }
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
if [ "${CAPPED_RUN_NOLOCK:-0}" != "1" ]; then
  LOCK="$XDG_RUNTIME_DIR/capped-run.lock"
  exec 9>"$LOCK"
  if ! flock -n 9; then
    echo "capped-run: another heavy run holds the queue ($(cat "$LOCK.owner" 2>/dev/null || echo unknown)); waiting up to ${CAPPED_RUN_WAIT:-2700}s" >&2
    flock -w "${CAPPED_RUN_WAIT:-2700}" 9 || { echo "capped-run: still busy after ${CAPPED_RUN_WAIT:-2700}s, not started" >&2; exit 75; }
  fi
  echo "pid $$ $(basename "$(pwd)") $(date +%H:%M) $*" | cut -c1-200 > "$LOCK.owner"
fi
exec systemd-run --user --scope --quiet --collect \
  -p MemoryMax="${CAPPED_RUN_MAX:-5G}" -p MemorySwapMax="${CAPPED_RUN_SWAP_MAX:-1G}" \
  -- "$@"
