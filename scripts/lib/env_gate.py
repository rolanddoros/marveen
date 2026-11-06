"""The dashboard-token env gate, shared by every script that sends the token (C2 PR4c, Johnny 11720).

The token goes to MARVEEN_API_BASE and comes from MARVEEN_TOKEN_FILE, and both are plain environment: whoever can
set the environment could otherwise send the dashboard token to any host, or send another file's first line as the
Bearer header. check_env() refuses that, BEFORE the token is read:

  - MARVEEN_API_BASE (when set) must be on loopback, or exactly one of the install's own AGENT_API_ORIGIN /
    DASHBOARD_PUBLIC_URL from its .env (a remote agent's route), and an origin only: scheme://host[:port], no path,
    query or fragment (VOICETOKENLEAK1101 PR-B: a path would turn every endpoint into a query or a fragment);
  - MARVEEN_TOKEN_FILE (when set) must be named .dashboard-token.

The install root is an ARGUMENT, and the caller computes it from its own __file__, never from the environment
(Kevin 11741): a gate must not ask the environment whether to trust the environment. A root taken from
MARVEEN_INSTALL_DIR or REVIEW_GATE_INSTALL_ROOT would let the same environment name a .env that allows any origin.

Callers load this file by its exact path (importlib.util.spec_from_file_location), not through sys.path:
`python3 -I` does not put the script's directory on sys.path, and a module looked up by name could be someone
else's. A caller that cannot load it must not send the token (fail closed).

Users: scripts/lib/marveen_api.py (every helper verb and agent-msg.sh), scripts/jegyzetek.py,
scripts/hooks/marveen-commands.py, scripts/git-hooks/pre-push-review-gate.py.

telegram_api_base() is the same gate for the Telegram BOT token (C2 PR4d): its users are the five python senders
that read TELEGRAM_API_BASE (scripts/hooks/marveen-commands.py, telegram_fallback_send.py, telegram_progress.py,
telegram_progress_clear.py, telegram_progress_watchdog.py). The bash path (scripts/lib/send-telegram.sh) runs the
same rule through the command line entry at the end of this file (`--telegram-base`, C2 PR4e); scripts/uptime-monitor.py
calls telegram_api_base() itself before it opens the token file, then sends through send-telegram.sh.
"""
import os
import sys
import urllib.parse

LOOPBACK_HOSTS = ('localhost', '127.0.0.1', '::1')
TOKEN_FILE_NAME = '.dashboard-token'
ORIGIN_KEYS = ('AGENT_API_ORIGIN', 'DASHBOARD_PUBLIC_URL')


def env_file_values(root, *keys):
    """The install's own .env values for these keys (an agent's environment cannot change them)."""
    out = {}
    try:
        with open(os.path.join(root, '.env'), encoding='utf-8') as f:
            for line in f:
                k, sep, v = line.partition('=')
                if sep and k.strip() in keys and k.strip() not in out:
                    out[k.strip()] = v.strip().strip('"\'')
    except OSError:
        pass
    return out


def normalise_base(raw):
    """THE one reading of MARVEEN_API_BASE, for the check AND for the request (Ron, PR4b point 7): surrounding
    whitespace and trailing slashes dropped. Before, the check stripped spaces and some senders did not, so
    ' http://127.0.0.1:3420/ ' passed the gate and then failed on the wire (http=000)."""
    return raw.strip().rstrip('/')


def parse_base(b):
    """urlsplit + the parts that raise on a malformed URL (an unclosed IPv6 bracket, a non-numeric port), or None.
    Before C2 PR4d, MARVEEN_API_BASE='http://[' made check_env() raise ValueError instead of refusing (Ron 11828)."""
    try:
        u = urllib.parse.urlsplit(b)
        u.hostname, u.port  # noqa: B018 -- evaluated for their ValueError
        return u
    except ValueError:
        return None


def shown(name, b):
    """How a refusal names a base: NAME=<base> with any user:password@ masked; an unparseable one is not shown at all
    (its text could hold anything). A refusal line can end up in a log or a chat reply (Ron 11828, Kevin 11853)."""
    u = parse_base(b)
    if u is None:
        return f'{name} (not shown: not a valid URL)'
    if '@' in u.netloc:
        b = urllib.parse.urlunsplit(u._replace(netloc='***@' + u.netloc.rsplit('@', 1)[1]))
    if '@' in b.replace('***@', '', 1):
        # an '@' outside the netloc: a password with an unencoded / ? or # ends up in the path, query or fragment
        return f'{name} (not shown: it contains @)'
    return f'{name}={b}'


def has_userinfo(u):
    return '@' in u.netloc


def check_env(root, environ=None):
    """None when the environment may be used; otherwise the refusal, one line ending in "nothing was sent."."""
    env = os.environ if environ is None else environ
    base = env.get('MARVEEN_API_BASE')
    if base:
        b = normalise_base(base)
        u = parse_base(b)
        if u is None:
            return f'{shown("MARVEEN_API_BASE", b)} must be a valid origin; nothing was sent.'
        # user:password@ is not an origin, and it is never printed (C2 PR4d, Kevin 11853)
        if has_userinfo(u):
            return (f'{shown("MARVEEN_API_BASE", b)} carries user information (user:password@), which is not an '
                    'origin; nothing was sent.')
        # http(s) only, for EVERY accepted base, the .env origins included (Ron, PR4b G14: a loopback host under
        # another scheme is not the dashboard).
        name = shown('MARVEEN_API_BASE', b)
        if u.scheme not in ('http', 'https'):
            return f'{name} must be http:// or https://; nothing was sent.'
        on_loopback = u.hostname in LOOPBACK_HOSTS
        configured = {normalise_base(v) for v in env_file_values(root, *ORIGIN_KEYS).values() if v}
        if not on_loopback and b not in configured:
            return (f'{name} is neither loopback nor this install\'s AGENT_API_ORIGIN or '
                    'DASHBOARD_PUBLIC_URL (.env); nothing was sent.')
        if u.path not in ('', '/') or u.query or u.fragment or '?' in b or '#' in b or not u.netloc:
            return (f'{name} must be an origin only (scheme://host[:port]), with no path, query or '
                    'fragment; nothing was sent.')
    # unconditional: this rule holds with or without MARVEEN_API_BASE (Ron, PR4b G8)
    token_file = env.get('MARVEEN_TOKEN_FILE')
    if token_file and os.path.basename(token_file) != TOKEN_FILE_NAME:
        return f'MARVEEN_TOKEN_FILE must name a {TOKEN_FILE_NAME} file; nothing was sent.'
    return None


# --- the Telegram bot token (C2 PR4d, Johnny 11833, Kevin 11853) -------------------------------------------------
# The same class as the dashboard token: the python senders put the BOT token into the URL path of
# <TELEGRAM_API_BASE>/bot<token>/<method>, and TELEGRAM_API_BASE is plain environment. Allowed: the real Bot API, and
# loopback, because the tests point it at a local stub (a stated limit: whoever can listen on a loopback port and set
# the environment still receives the token). Unset or empty: the real Bot API.
TELEGRAM_DEFAULT_BASE = 'https://api.telegram.org'


def has_control_char(raw):
    """True when the RAW value holds a control character (Unicode Cc: U+0000-U+001F, U+007F-U+009F), wherever it is,
    a trailing newline included. Checked BEFORE normalise_base(), because urlsplit() silently drops tab, CR and LF
    (C2 PR4f, Ron 12030 S10): 'http://127.0.0.1\n:8081' parsed as a clean loopback origin, and the base handed back
    still held the LF, which the curl config line of send-telegram.sh then carried (CR and TAB unguarded)."""
    return any(ord(c) < 0x20 or 0x7f <= ord(c) <= 0x9f for c in raw)


def telegram_api_base(environ=None):
    """(base, None) for the Bot API base the bot token may be sent to, or (None, refusal) -- the refusal is one line
    ending in "nothing was sent.", and it never shows user information. Call it BEFORE the bot token is read."""
    env = os.environ if environ is None else environ
    raw = env.get('TELEGRAM_API_BASE')
    if raw is None or not raw.strip():
        return TELEGRAM_DEFAULT_BASE, None
    # The refusal does not show the value: a control character would reach stderr and the logs as it is.
    if has_control_char(raw):
        return None, 'TELEGRAM_API_BASE contains a control character (not shown); nothing was sent.'
    b = normalise_base(raw)
    u = parse_base(b)
    name = shown('TELEGRAM_API_BASE', b)
    if u is None:
        return None, f'{name} must be a valid origin; nothing was sent.'
    if has_userinfo(u):
        return None, f'{name} carries user information (user:password@), which is not an origin; nothing was sent.'
    if u.scheme not in ('http', 'https'):
        return None, f'{name} must be http:// or https://; nothing was sent.'
    if u.path not in ('', '/') or u.query or u.fragment or '?' in b or '#' in b or not u.netloc:
        return None, (f'{name} must be an origin only (scheme://host[:port]), with no path, query or fragment; '
                      'nothing was sent.')
    if b != TELEGRAM_DEFAULT_BASE and u.hostname not in LOOPBACK_HOSTS:
        return None, f'{name} is neither {TELEGRAM_DEFAULT_BASE} nor loopback; nothing was sent.'
    return b, None


# --- the bash senders' entry (C2 PR4e, Kevin 11959) --------------------------------------------------------------
# scripts/lib/send-telegram.sh runs `python3 -I <its own lib dir>/env_gate.py --telegram-base` when TELEGRAM_API_BASE
# is set, so the bash path and the python senders obey ONE rule. Prints the base the bot token may go to (exit 0), or
# the refusal line on stderr (exit 2); the refusal never shows user information (shown()).
def _main(argv):
    if argv != ['--telegram-base']:
        print('usage: env_gate.py --telegram-base', file=sys.stderr)
        return 2
    base, refused = telegram_api_base()
    if refused:
        print(refused, file=sys.stderr)
        return 2
    print(base)
    return 0


if __name__ == '__main__':
    sys.exit(_main(sys.argv[1:]))
