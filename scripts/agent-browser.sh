#!/usr/bin/env bash
# Persistent, viewable Chrome per agent: Xvfb + Chrome (CDP on localhost) + x11vnc (localhost) + noVNC (LAN).
# The owner logs in once through noVNC; the agent drives the same browser via Playwright MCP --cdp-endpoint.
# Usage: agent-browser.sh <agent> run        (foreground supervisor, used by systemd)
#        agent-browser.sh <agent> info       (print ports)
#        agent-browser.sh <agent> up [sec]   (systemctl start, then wait until CDP answers; default 60 s)
#        agent-browser.sh <agent> down       (systemctl stop)
set -euo pipefail
AGENT="${1:?agent}"; CMD="${2:-run}"
ROOT=/root/marveen; CFG="$ROOT/store/browser/agents.json"
N="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))[sys.argv[2]])" "$CFG" "$AGENT")"
DISP=":$N"; CDP=$((9300+N)); VNC=$((5900+N)); WEB=$((6070+N))
if [ "$AGENT" = johnny ]; then PROFILE="$ROOT/store/browser/johnny-profile"; else PROFILE="$ROOT/agents/$AGENT/browser-profile"; fi
PASS="$ROOT/store/browser/$AGENT.vncpass"
# Optional per-agent extra Chrome flags, one per line (e.g. software WebGL for Figma on Xvfb).
EXTRA=(); FLAGS="$ROOT/store/browser/$AGENT.chrome-flags"
[ -f "$FLAGS" ] && mapfile -t EXTRA < <(grep -v '^\s*\(#\|$\)' "$FLAGS")

if [ "$CMD" = info ]; then
  echo "agent=$AGENT display=$DISP cdp=http://127.0.0.1:$CDP novnc=http://192.168.0.118:$WEB/vnc.html profile=$PROFILE"; exit 0
fi
# `systemctl start` returns while Chrome is still loading: the unit shows
# `active` ~30 s before /json/version answers (margot, 2026-10-25).
if [ "$CMD" = up ]; then
  LIMIT="${3:-60}"
  if curl -s -m 2 -o /dev/null "http://127.0.0.1:$CDP/json/version"; then
    echo "already up: cdp=http://127.0.0.1:$CDP novnc=http://192.168.0.118:$WEB/vnc.html"; exit 0
  fi
  systemctl start "agent-browser@$AGENT"
  for i in $(seq 1 "$LIMIT"); do
    if curl -s -m 2 -o /dev/null "http://127.0.0.1:$CDP/json/version"; then
      echo "up after ${i}s: cdp=http://127.0.0.1:$CDP novnc=http://192.168.0.118:$WEB/vnc.html"; exit 0
    fi
    systemctl is-failed -q "agent-browser@$AGENT" && break
    sleep 1
  done
  echo "CDP $CDP did not answer within ${LIMIT}s (unit: $(systemctl is-active "agent-browser@$AGENT"))" >&2
  journalctl -u "agent-browser@$AGENT" -n 10 --no-pager >&2 || true
  exit 1
fi
if [ "$CMD" = down ]; then
  systemctl stop "agent-browser@$AGENT"; echo "stopped agent-browser@$AGENT"; exit 0
fi
# Anything but run/info used to fall through to `run` and start a SECOND
# instance: it deleted the live Xvfb socket and its Chrome could kill the
# first one on the shared profile (2026-10-19, `... kevin status`).
[ "$CMD" = run ] || { echo "unknown command: $CMD (use: run | info | up | down; status: systemctl status agent-browser@$AGENT)" >&2; exit 2; }
if curl -s -m 2 -o /dev/null "http://127.0.0.1:$CDP/json/version"; then
  echo "agent-browser $AGENT already running (CDP $CDP answers) -- refusing a second instance; restart with: systemctl restart agent-browser@$AGENT" >&2; exit 3
fi
[ -f "$PASS" ] || { echo "missing $PASS (x11vnc -storepasswd)"; exit 1; }
mkdir -p "$PROFILE"; chmod 700 "$PROFILE"
rm -f "/tmp/.X$N-lock" "/tmp/.X11-unix/X$N"

Xvfb "$DISP" -screen 0 1440x900x24 -nolisten tcp &
for _ in $(seq 1 50); do [ -S "/tmp/.X11-unix/X$N" ] && break; sleep 0.1; done
DISPLAY="$DISP" google-chrome --user-data-dir="$PROFILE" --no-sandbox --no-first-run --no-default-browser-check \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port="$CDP" --window-position=0,0 --window-size=1440,900 \
  --disable-dev-shm-usage "${EXTRA[@]}" about:blank >/dev/null 2>&1 &
x11vnc -display "$DISP" -rfbauth "$PASS" -localhost -rfbport "$VNC" -forever -shared -quiet -noxdamage >/dev/null 2>&1 &
websockify --web /usr/share/novnc "0.0.0.0:$WEB" "127.0.0.1:$VNC" >/dev/null 2>&1 &
wait -n
echo "a component exited, stopping the rest"; kill $(jobs -p) 2>/dev/null || true; exit 1
