#!/bin/sh
# write-main-config-root.sh <mode> <dir> <writer> [node-binary]
#
# Records which config root the main agent's pane exported, for the deploy helper's caller check
# (scripts/hooks/agent-identity.mjs; fork deploy-gate plan v3 addendum A1-1, Ron 17165 C2/C3).
# It is called INSIDE the pane command every launcher hands tmux, right before claude starts:
# channels.sh, channel-watchdog.sh, stuck-modal-guard.sh. So the record changes only when a pane
# really starts; a failed tmux spawn never runs this and leaves the old record. (Never name the tmux
# respawn subcommand here: main-config-dir-parity.test.ts counts every scripts/*.sh that contains it.)
#
# The old record is removed FIRST, here in sh, so that even a missing node or a refused argument
# leaves no record rather than a stale one: no record means no MAIN, the gate denies (fail-closed).
# The launchers call it as `{ ... || true; }`, so nothing here can stop the agent from starting.
# Validation and the JSON write live in agent-identity.mjs, next to the rule that reads the record.
here=$(dirname "$0")
inst=$(dirname "$here")
rm -f "$inst/store/main-agent-config-root.json" 2>/dev/null
node_bin=${4:-$(command -v node 2>/dev/null)}
if [ -z "$node_bin" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') write-main-config-root: NO record (no node binary)" >> "$inst/store/channels-failures.log" 2>/dev/null
  exit 1
fi
exec "$node_bin" "$here/hooks/agent-identity.mjs" --write-record "$1" "$2" "$3" 2>> "$inst/store/channels-failures.log"
