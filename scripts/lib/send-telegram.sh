#!/bin/bash
# send-telegram.sh -- the fleet's ONE honest Telegram send primitive.
#
# NOTIFYVAKSWEEP826: 13 scripts sent to the Bot API; only notify.sh (after
# NOTIFYVAK826/#1081) and telegram_fallback_send.py checked the outcome. Every
# bash sender either swallowed the curl exit, ignored the response body, or
# both -- an HTTP 200 with {"ok":false} (bad chat_id, blocked bot, mangled
# .env) was invisible everywhere, and several loggers printed unconditional
# "sent" on failure. This library IS the proven notify.sh contract, extracted
# so there is exactly one truth:
#
#   send_telegram_message TOKEN CHAT_ID TEXT [extra curl args...]
#
#   returns 0  ONLY when curl exited 0 AND the Bot API answered "ok":true
#   returns 1  on transport failure, API rejection, or misuse (empty args),
#              with the reason on stderr and the bot token redacted (some curl
#              errors quote the request URL).
#
# The caller decides what a failure means for its own exit code (an OnFailure
# unit must still exit 0; notify.sh exits 1) -- but it can no longer NOT KNOW.
# State stamps (dedupe hashes, cooldowns, baselines) must be written only
# after this returns 0: a failed alert buried by its own suppression stamp is
# lost forever (the limit-monitor failure mode).
#
# Bash 3.2 compatible (macOS system bash). Source it, do not execute it:
#   . "$(dirname "$0")/lib/send-telegram.sh"
#
# Source it by its real path. Through a SYMLINK, with TELEGRAM_API_BASE set, it
# fails closed: the env gate is looked up next to ${BASH_SOURCE[0]}, which is
# the link's directory, finds no env_gate.py there, and nothing is sent (C2
# PR4f, Ron 12030). Unset or blank TELEGRAM_API_BASE (production) is not
# affected. The link is deliberately not followed: readlink -f is missing on
# the BSD readlink of older macOS, and a hand-written resolve loop is more code
# on the token path than this test seam is worth.

# telegram_api_call TOKEN METHOD [curl args...] -- the same contract for ANY
# Bot API method (setMyCommands, sendPhoto, ...): success only on curl exit 0
# AND "ok":true, loud stderr otherwise, token redacted.
telegram_api_call() {
  if [ "$#" -lt 2 ]; then
    echo "telegram_api_call: usage: telegram_api_call TOKEN METHOD [curl args...]" >&2
    return 1
  fi
  local token="$1" method="$2"
  shift 2
  if [ -z "$token" ] || [ -z "$method" ]; then
    echo "telegram_api_call: empty token/method -- refusing (nothing would be delivered)" >&2
    return 1
  fi

  local response curl_exit base gate_dir
  # TELEGRAM_API_BASE: test seam only (a local Bot API stub), the same variable
  # the python senders honour; unset in production. The URL below carries the
  # bot token, so when the variable is set the shared env gate decides where it
  # may go (C2 PR4e): https://api.telegram.org or loopback, nothing else, the
  # same rule as the python senders. The gate runs as `python3 -I` from its
  # exact path next to this file (resolved from this file's own location, never
  # from the environment), and the URL is built from the base the gate returns,
  # not from the raw variable. No python3, no gate file, or a refusal: nothing
  # is sent. Unset (or blank): the real Bot API, python3 not needed.
  base="https://api.telegram.org"
  case "${TELEGRAM_API_BASE:-}" in
    *[![:space:]]*)
      gate_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)
      if [ -z "$gate_dir" ] || [ ! -f "$gate_dir/env_gate.py" ] || ! command -v python3 >/dev/null 2>&1; then
        echo "telegram_api_call(${method}): TELEGRAM_API_BASE is set, but the env gate (python3 and lib/env_gate.py) cannot run; nothing was sent." >&2
        return 1
      fi
      if ! base=$(python3 -I "$gate_dir/env_gate.py" --telegram-base 2>&1); then
        echo "telegram_api_call(${method}): ${base}" >&2
        return 1
      fi
      case "$base" in
        http://?*|https://?*) ;;
        *)
          echo "telegram_api_call(${method}): the env gate gave no usable base; nothing was sent." >&2
          return 1
          ;;
      esac
      ;;
  esac
  # The URL carries the token, so it must never sit in curl's ARGV (ps -ww,
  # /proc/<pid>/cmdline). Same trick as lib/curl-tok.sh: a curl config line on
  # stdin (-K -), written by the printf builtin, so no other process carries it
  # either. The URL is a QUOTED config value: a quote, backslash or newline in
  # the token, the method or the base would break out of it, and any other
  # control character (CR, TAB, ...) makes curl reject the URL (exit 3) -- refuse
  # them all, because such a call could not deliver anything anyway (C2 PR4f:
  # CR and TAB used to pass this line). The callers strip a trailing CR of a
  # CRLF .env BEFORE they call (or curl already refused it), so this only meets
  # one that is still there. The message names no value: not the token, not
  # the base, not the method (the offending one could be any of them).
  case "$token$method$base" in
    *\"*|*\\*|*$'\n'*|*[[:cntrl:]]*)
      echo "telegram_api_call: the token, method or API base contains a quote, backslash or control character (not shown) -- refusing; nothing was sent." >&2
      return 1
      ;;
  esac
  response=$(printf 'url = "%s"\n' "${base}/bot${token}/${method}" | curl -sS -m 15 -K - "$@" 2>&1)
  # curl is the last command of the pipe, so $? is its exit code, not printf's.
  curl_exit=$?
  # Never let the token reach a log/journal: redact before any echo.
  response="${response//${token}/<token>}"

  if [ "$curl_exit" -ne 0 ]; then
    echo "telegram_api_call(${method}): transport failure (curl exit ${curl_exit}): ${response}" >&2
    return 1
  fi
  case "$response" in
    *'"ok":true'*)
      return 0
      ;;
    *)
      echo "telegram_api_call(${method}): Bot API rejected the call: ${response}" >&2
      return 1
      ;;
  esac
}

send_telegram_message() {
  if [ "$#" -lt 3 ]; then
    echo "send_telegram_message: usage: send_telegram_message TOKEN CHAT_ID TEXT [curl args...]" >&2
    return 1
  fi
  local token="$1" chat_id="$2" text="$3"
  shift 3
  if [ -z "$token" ] || [ -z "$chat_id" ] || [ -z "$text" ]; then
    echo "send_telegram_message: empty token/chat_id/text -- refusing (nothing would be delivered)" >&2
    return 1
  fi
  telegram_api_call "$token" "sendMessage" \
    --data-urlencode "chat_id=${chat_id}" \
    --data-urlencode "text=${text}" \
    "$@"
}
