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
"""
import os
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


def check_env(root, environ=None):
    """None when the environment may be used; otherwise the refusal, one line ending in "nothing was sent."."""
    env = os.environ if environ is None else environ
    base = env.get('MARVEEN_API_BASE')
    if base:
        b = normalise_base(base)
        u = urllib.parse.urlsplit(b)
        # http(s) only, for EVERY accepted base, the .env origins included (Ron, PR4b G14: a loopback host under
        # another scheme is not the dashboard).
        if u.scheme not in ('http', 'https'):
            return f'MARVEEN_API_BASE={b} must be http:// or https://; nothing was sent.'
        on_loopback = u.hostname in LOOPBACK_HOSTS
        configured = {normalise_base(v) for v in env_file_values(root, *ORIGIN_KEYS).values() if v}
        if not on_loopback and b not in configured:
            return (f'MARVEEN_API_BASE={b} is neither loopback nor this install\'s AGENT_API_ORIGIN or '
                    'DASHBOARD_PUBLIC_URL (.env); nothing was sent.')
        if u.path not in ('', '/') or u.query or u.fragment or '?' in b or '#' in b or not u.netloc:
            return (f'MARVEEN_API_BASE={b} must be an origin only (scheme://host[:port]), with no path, query or '
                    'fragment; nothing was sent.')
    # unconditional: this rule holds with or without MARVEEN_API_BASE (Ron, PR4b G8)
    token_file = env.get('MARVEEN_TOKEN_FILE')
    if token_file and os.path.basename(token_file) != TOKEN_FILE_NAME:
        return f'MARVEEN_TOKEN_FILE must name a {TOKEN_FILE_NAME} file; nothing was sent.'
    return None

