#!/usr/bin/env python3
"""C2 PR4e: the bash Telegram path (scripts/lib/send-telegram.sh) obeys the same env gate as the python senders.

send-telegram.sh puts the bot token into <base>/bot<token>/<method>; about ten bash scripts source it, and
uptime-monitor.py sends through it. Before PR4e it used TELEGRAM_API_BASE as given. Now (Kevin 11959, plan A):
  - unset or blank: the real Bot API, and python3 is not needed (pinned with no python3 on PATH);
  - set: `python3 -I <its own lib dir>/env_gate.py --telegram-base` decides, the same telegram_api_base() rule as the
    python senders (https://api.telegram.org or loopback only); the URL is built from the base the gate RETURNS;
  - a refusal, no python3, no env_gate.py next to the file, or a gate that answers no URL: return 1, nothing sent;
  - the gate is the file next to send-telegram.sh, never one found through the environment or the working directory.

"Nothing sent" is measured on a REACHABLE stub (127.0.0.2), so a refusal is told apart from an unreachable host; the
allowed loopback stub (127.0.0.1) receiving the same call is the control. The unset case cannot reach the real Bot
API from a test, so a recording curl stub on PATH shows the URL it was given.

Run:  python3 scripts/__tests__/send-telegram-gate.test.py
"""
import http.server
import os
import shutil
import subprocess
import tempfile
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
FAILS = []
TOKEN = 'TESTBOTTOKEN-pr4e'
SECRET = 'pw-s3cr3t'


def check(name, cond, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + (('  -- ' + str(detail)) if detail and not cond else ''))
    if not cond:
        FAILS.append(name)


def make_stub(host):
    reqs = []

    class Stub(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            n = int(self.headers.get('Content-Length', '0'))
            if n:
                self.rfile.read(n)
            reqs.append(self.path)
            out = b'{"ok":true,"result":{}}'
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(out)))
            self.end_headers()
            self.wfile.write(out)

        def log_message(self, *a):
            pass

    srv = http.server.ThreadingHTTPServer((host, 0), Stub)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, 'http://%s:%d' % (host, srv.server_address[1]), reqs


def make_lib(with_gate=True):
    lib = os.path.join(tempfile.mkdtemp(prefix='send-telegram-gate-'), 'scripts', 'lib')
    os.makedirs(lib)
    shutil.copy(os.path.join(ROOT, 'scripts', 'lib', 'send-telegram.sh'), lib)
    if with_gate:
        shutil.copy(os.path.join(ROOT, 'scripts', 'lib', 'env_gate.py'), lib)
    return lib


def tool_dir(names, extra=None):
    """A PATH dir with only the named tools (symlinks to the real ones), plus optional scripts {name: body}."""
    d = tempfile.mkdtemp(prefix='send-telegram-path-')
    for n in names:
        real = shutil.which(n)
        if real:
            os.symlink(real, os.path.join(d, n))
    for n, body in (extra or {}).items():
        p = os.path.join(d, n)
        with open(p, 'w') as f:
            f.write(body)
        os.chmod(p, 0o755)
    return d


def run(lib, base, path=None, cwd=None, env_extra=None):
    env = {k: v for k, v in os.environ.items() if k != 'TELEGRAM_API_BASE'}
    if base is not None:
        env['TELEGRAM_API_BASE'] = base
    if path is not None:
        env['PATH'] = path
    env.update(env_extra or {})
    bash = shutil.which('bash')
    r = subprocess.run([bash, '-c', '. "$1" && send_telegram_message "$2" 1 szia', '_',
                        os.path.join(lib, 'send-telegram.sh'), TOKEN],
                       capture_output=True, text=True, timeout=60, env=env, cwd=cwd, stdin=subprocess.DEVNULL)
    return r.returncode, r.stdout + r.stderr


def main():
    local, local_api, local_reqs = make_stub('127.0.0.1')
    other, other_api, other_reqs = make_stub('127.0.0.2')
    lib = make_lib()
    want = '/bot%s/sendMessage' % TOKEN
    try:
        # --- allowed: loopback (control) ------------------------------------------------------------------------------
        rc, out = run(lib, local_api)
        check('loopback base: sent, exit 0 (control)', rc == 0 and local_reqs == [want], (rc, out, local_reqs))
        del local_reqs[:]
        rc, out = run(lib, ' %s/ ' % local_api)
        check('the URL is built from the base the gate returns: " <loopback>/ " -> exactly %s' % want,
              rc == 0 and local_reqs == [want], (rc, out, local_reqs))
        del local_reqs[:]

        # --- refused: nothing reaches either stub -----------------------------------------------------------------
        for name, base, why in [
            ('another loopback-looking host 127.0.0.2 (reachable)', other_api, 'neither https://api.telegram.org'),
            ('a foreign host', 'https://evil.example', 'neither https://api.telegram.org'),
            ('the Bot API over http', 'http://api.telegram.org', 'neither https://api.telegram.org'),
            ('user:password@ on loopback', 'http://u:%s@%s' % (SECRET, local_api[len('http://'):]), 'user information'),
            ('a path', local_api + '/bot', 'origin only'),
            ('an @ in the path', '%s/%s@x' % (local_api, SECRET), 'not shown: it contains @'),
            ('another scheme', 'ftp://127.0.0.1', 'http:// or https://'),
            ('a malformed URL', 'http://[', 'valid origin'),
        ]:
            rc, out = run(lib, base)
            check('refused, exit 1, nothing sent: %s' % name,
                  rc == 1 and why in out and 'nothing was sent' in out and not local_reqs and not other_reqs,
                  (rc, out, local_reqs, other_reqs))
            check('  ...no token and no secret in the output', TOKEN not in out and SECRET not in out, out)
            del local_reqs[:], other_reqs[:]

        # --- the gate cannot run: fail closed, even on loopback ---------------------------------------------------
        bare = make_lib(with_gate=False)
        rc, out = run(bare, local_api)
        check('no env_gate.py next to send-telegram.sh: exit 1, "cannot run", nothing sent',
              rc == 1 and 'cannot run' in out and not local_reqs, (rc, out, local_reqs))
        no_py = tool_dir(['curl', 'dirname'])
        rc, out = run(lib, local_api, path=no_py)
        check('no python3 on PATH: exit 1, "cannot run", nothing sent', rc == 1 and 'cannot run' in out
              and not local_reqs, (rc, out, local_reqs))
        broken = make_lib()
        with open(os.path.join(broken, 'env_gate.py'), 'w') as f:
            f.write("print('garbage')\n")
        rc, out = run(broken, local_api)
        check('a gate that answers no URL (exit 0, "garbage"): exit 1, nothing sent',
              rc == 1 and 'no usable base' in out and not local_reqs, (rc, out, local_reqs))

        # --- the gate is the file next to send-telegram.sh, not one from cwd or the environment ------------------
        evil = tempfile.mkdtemp(prefix='send-telegram-evil-')
        for n in ('env_gate.py', 'sitecustomize.py', 'usercustomize.py'):
            with open(os.path.join(evil, n), 'w') as f:
                # os._exit: a SystemExit inside sitecustomize is fatal (exit 1), which would hide the hijack
                f.write("import os\nprint('%s', flush=True)\nos._exit(0)\n" % other_api)
        rc, out = run(lib, other_api, cwd=evil, env_extra={'PYTHONPATH': evil, 'PYTHONSTARTUP': os.path.join(evil, 'env_gate.py'),
                                                           'PYTHONUSERBASE': evil})
        check('an allow-everything env_gate.py in cwd / PYTHONPATH changes nothing: 127.0.0.2 still refused',
              rc == 1 and not other_reqs, (rc, out, other_reqs))
        del other_reqs[:]

        # --- unset or blank: the real Bot API, and python3 is not needed -----------------------------------------
        rec = tempfile.mkdtemp(prefix='send-telegram-rec-')
        fake_curl = ('#!/bin/sh\ncat > "%s/config"\nprintf \'{"ok":true}\'\n' % rec)
        for name, base in (('unset', None), ('blank', '   ')):
            path = tool_dir(['dirname', 'cat'] + (['python3'] if base is not None else []), {'curl': fake_curl})
            rc, out = run(lib, base, path=path)
            cfg = open(os.path.join(rec, 'config')).read() if os.path.exists(os.path.join(rec, 'config')) else ''
            check('%s TELEGRAM_API_BASE: the URL goes to https://api.telegram.org%s' % (
                name, ', with no python3 on PATH' if base is None else ''),
                  rc == 0 and cfg.strip() == 'url = "https://api.telegram.org%s"' % want, (rc, out, cfg))
            if os.path.exists(os.path.join(rec, 'config')):
                os.remove(os.path.join(rec, 'config'))
    finally:
        local.shutdown()
        other.shutdown()

    print('%d check(s) failed: %s' % (len(FAILS), FAILS) if FAILS else 'all checks passed')
    return 1 if FAILS else 0


if __name__ == '__main__':
    raise SystemExit(main())
