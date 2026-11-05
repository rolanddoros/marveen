#!/usr/bin/env python3
"""C2 PR4d: the Telegram BOT token gate (scripts/lib/env_gate.py telegram_api_base(); Johnny 11833, Kevin 11853).

The five python senders that read TELEGRAM_API_BASE put the bot token into the URL path (<base>/bot<token>/<method>).
TELEGRAM_API_BASE is plain environment, so before PR4d whoever could set it received the token. Now:
  - telegram_api_base(): unset or empty -> https://api.telegram.org; allowed: exactly that, or loopback http(s) (the
    tests' stub, a stated limit); refused: any other host, another scheme, a path/query/fragment, user:password@ (and
    the refusal never shows it), a malformed URL;
  - each sender (marveen-commands, telegram_fallback_send, telegram_progress, telegram_progress_clear,
    telegram_progress_watchdog) asks the gate BEFORE it reads the token: with a refused base the token file is not
    even opened (pinned with a writerless FIFO as the .env: opened, the call would hang), and a REACHABLE stub on
    127.0.0.2 receives nothing; with a loopback base the same calls reach the 127.0.0.1 stub (control);
  - env_gate.py missing next to a sender: nothing is sent (fail closed).

Everything runs from a sandbox copy of scripts/hooks + scripts/lib/env_gate.py against local stubs.

Run:  python3 scripts/__tests__/telegram-bot-token-gate.test.py
"""
import http.server
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from contextlib import redirect_stderr

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
FAILS = []
SENDERS = ('marveen-commands', 'telegram_fallback_send', 'telegram_progress', 'telegram_progress_clear',
           'telegram_progress_watchdog')
BOT_TOKEN = 'TESTBOTTOKEN-pr4d'


def check(name, cond, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + (('  -- ' + str(detail)) if detail and not cond else ''))
    if not cond:
        FAILS.append(name)


def make_stub(host):
    reqs = []

    class Stub(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            n = int(self.headers.get('Content-Length', '0'))
            self.rfile.read(n)
            reqs.append(self.path)
            out = json.dumps({'ok': True, 'result': {'message_id': 7}}).encode()
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


def make_install():
    inst = tempfile.mkdtemp(prefix='bot-token-gate-')
    os.makedirs(os.path.join(inst, 'scripts', 'lib'))
    shutil.copytree(os.path.join(ROOT, 'scripts', 'hooks'), os.path.join(inst, 'scripts', 'hooks'),
                    ignore=shutil.ignore_patterns('__pycache__'))
    shutil.copy(os.path.join(ROOT, 'scripts', 'lib', 'env_gate.py'), os.path.join(inst, 'scripts', 'lib', 'env_gate.py'))
    return inst


def load(inst, name, n=[0]):
    n[0] += 1  # a fresh module each time: the gated base is computed once per process / module
    spec = importlib.util.spec_from_file_location('sender_%s_%d' % (name.replace('-', '_'), n[0]),
                                                  os.path.join(inst, 'scripts', 'hooks', name + '.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def read_token(mod, sd):
    if hasattr(mod, 'bot_token'):
        return mod.bot_token(sd)
    if hasattr(mod, 'token'):
        return mod.token(sd)
    # marveen-commands before PR4d read the token inline at its two call sites; the same read, so a run of this
    # test against the old code measures the old behaviour instead of stopping on a missing name
    return mod.env_value(os.path.join(sd, '.env'), 'TELEGRAM_BOT_TOKEN')


def send(mod, tok):
    if hasattr(mod, 'tg'):
        return mod.tg(tok, 'sendMessage', {'chat_id': 1, 'text': 'x'})
    return mod.api(tok, 'sendMessage', {'chat_id': 1, 'text': 'x'})


def main():
    gate_spec = importlib.util.spec_from_file_location('env_gate_t', os.path.join(ROOT, 'scripts', 'lib', 'env_gate.py'))
    gate = importlib.util.module_from_spec(gate_spec)
    gate_spec.loader.exec_module(gate)

    # --- telegram_api_base() ----------------------------------------------------------------------------------------
    def tab(value):
        return gate.telegram_api_base({} if value is None else {'TELEGRAM_API_BASE': value})

    for value, want in [(None, 'https://api.telegram.org'), ('', 'https://api.telegram.org'),
                        ('   ', 'https://api.telegram.org'), ('https://api.telegram.org', 'https://api.telegram.org'),
                        (' https://api.telegram.org/ ', 'https://api.telegram.org'),
                        ('http://127.0.0.1:8081', 'http://127.0.0.1:8081'), ('http://localhost:9', 'http://localhost:9'),
                        ('https://[::1]:8443/', 'https://[::1]:8443')]:
        base, refused = tab(value)
        check('allowed: %r -> %s' % (value, want), base == want and refused is None, (base, refused))
    secret = 'pw-s3cr3t'
    for value, why in [
        ('https://evil.example', 'neither https://api.telegram.org nor loopback'),
        ('http://api.telegram.org', 'neither https://api.telegram.org nor loopback'),
        ('https://api.telegram.org.evil.example', 'neither https://api.telegram.org nor loopback'),
        ('https://api.telegram.org:8443', 'neither https://api.telegram.org nor loopback'),
        ('http://127.0.0.2:8081', 'neither https://api.telegram.org nor loopback'),
        ('https://api.telegram.org/bot', 'origin only'),
        ('http://127.0.0.1:8081?x=1', 'origin only'),
        ('ftp://127.0.0.1', 'http:// or https://'),
        ('http://[', 'valid origin'),
        ('http://127.0.0.1:abc', 'valid origin'),
        ('https://u:%s@api.telegram.org' % secret, 'user information'),
        ('http://u:%s@127.0.0.1:8081' % secret, 'user information'),
        ('http://u:%s/x@127.0.0.1:8081' % secret, None),
    ]:
        base, refused = tab(value)
        check('refused: %r' % value, base is None and refused and refused.endswith('nothing was sent.')
              and (why is None or why in refused), (base, refused))
        check('  ...the refusal does not show the secret part', secret not in (refused or ''), refused)

    # U1 (Ron 11906): an '@' OUTSIDE the netloc. The cases above with u:pw/x@host stop at "not a valid URL" (the
    # password parses as a bad port), so they never reach shown()'s second branch; these parse, and do.
    root = tempfile.mkdtemp(prefix='bot-token-gate-root-')
    for value in ('http://127.0.0.1/%s@x' % secret, 'http://127.0.0.1?k=%s@x' % secret,
                  'http://127.0.0.1#%s@x' % secret, 'https://api.telegram.org/%s@x' % secret):
        base, refused = tab(value)
        check('U1 telegram: %r refused, "(not shown: it contains @)", no secret' % value,
              base is None and '(not shown: it contains @)' in (refused or '') and secret not in (refused or ''),
              refused)
        refused = gate.check_env(root, {'MARVEEN_API_BASE': value})
        check('U1 dashboard: %r refused, "(not shown: it contains @)", no secret' % value,
              refused is not None and '(not shown: it contains @)' in refused and secret not in refused, refused)
    shutil.rmtree(root, ignore_errors=True)

    # --- the five senders --------------------------------------------------------------------------------------------
    local, local_api, local_reqs = make_stub('127.0.0.1')
    other, other_api, other_reqs = make_stub('127.0.0.2')
    inst = make_install()
    sd = tempfile.mkdtemp(prefix='bot-token-gate-sd-')
    with open(os.path.join(sd, '.env'), 'w') as f:
        f.write('TELEGRAM_BOT_TOKEN=%s\n' % BOT_TOKEN)
    fifo_sd = tempfile.mkdtemp(prefix='bot-token-gate-fifo-')
    os.mkfifo(os.path.join(fifo_sd, '.env'))  # a writerless FIFO: opening it for reading blocks
    saved = os.environ.get('TELEGRAM_API_BASE')
    try:
        for name in SENDERS:
            # control: loopback reaches the stub with the token in the path
            os.environ['TELEGRAM_API_BASE'] = local_api
            del local_reqs[:]
            mod = load(inst, name)
            tok = read_token(mod, sd)
            err = None
            try:
                send(mod, tok)
            except Exception as e:
                err = e
            check('%s control: loopback base, the token is read and the call reaches the stub' % name,
                  tok == BOT_TOKEN and err is None and local_reqs == ['/bot%s/sendMessage' % BOT_TOKEN],
                  (tok, err, local_reqs))

            # a reachable host that is neither the Bot API nor loopback
            os.environ['TELEGRAM_API_BASE'] = other_api
            del other_reqs[:]
            mod = load(inst, name)
            buf = io.StringIO()
            result = {}

            def gated_read():
                with redirect_stderr(buf):
                    result['tok'] = read_token(mod, fifo_sd)
            t = threading.Thread(target=gated_read, daemon=True)
            t.start()
            t.join(10)
            if t.is_alive():
                try:
                    os.close(os.open(os.path.join(fifo_sd, '.env'), os.O_WRONLY | os.O_NONBLOCK))
                except OSError:
                    pass
            check('%s: 127.0.0.2 refused BEFORE the token file is opened (the FIFO .env does not hang it)' % name,
                  not t.is_alive() and result.get('tok') is None, ('hung' if t.is_alive() else result))
            raised = None
            try:
                with redirect_stderr(buf):
                    send(mod, BOT_TOKEN)
            except Exception as e:
                raised = e
            check('%s: a send with a refused base raises, and the reachable 127.0.0.2 stub receives nothing' % name,
                  isinstance(raised, RuntimeError) and not other_reqs, (raised, other_reqs))

            # env_gate.py missing next to the sender: fail closed
            os.environ['TELEGRAM_API_BASE'] = local_api
            os.rename(os.path.join(inst, 'scripts', 'lib', 'env_gate.py'), os.path.join(inst, 'scripts', 'lib', 'off.py'))
            del local_reqs[:]
            try:
                mod = load(inst, name)
                with redirect_stderr(io.StringIO()):
                    tok = read_token(mod, sd)
                    try:
                        send(mod, BOT_TOKEN)
                        sent = True
                    except Exception:
                        sent = False
                check('%s: env_gate.py missing: no token read, nothing sent, even on loopback' % name,
                      tok is None and not sent and not local_reqs, (tok, sent, local_reqs))
            finally:
                os.rename(os.path.join(inst, 'scripts', 'lib', 'off.py'), os.path.join(inst, 'scripts', 'lib', 'env_gate.py'))

            # env_gate.py present but raising at load with something other than the import/OS errors (Ron 11906:
            # marveen-commands caught only (OSError, ImportError, SyntaxError, AttributeError), so a ValueError
            # escaped as an unhandled exception): a clean refusal, no token read, nothing sent, nothing raised
            gate_path = os.path.join(inst, 'scripts', 'lib', 'env_gate.py')
            os.rename(gate_path, os.path.join(inst, 'scripts', 'lib', 'off.py'))
            with open(gate_path, 'w') as f:
                f.write("raise ValueError('the gate module itself is broken')\n")
            del local_reqs[:]
            try:
                mod = load(inst, name)
                err = io.StringIO()
                with redirect_stderr(err):
                    try:
                        tok, escaped = read_token(mod, sd), None
                    except Exception as e:
                        tok, escaped = None, e
                    try:
                        send(mod, BOT_TOKEN)
                        sent = True
                    except Exception:
                        sent = False
                check('%s: env_gate.py raising ValueError at load: no exception escapes the token read, no token, '
                      'nothing sent' % name, escaped is None and tok is None and not sent and not local_reqs,
                      (escaped, tok, sent, local_reqs))
                if hasattr(mod, 'env_gate_check'):
                    try:
                        mod.env_gate_check()
                        got = None
                    except Exception as e:
                        got = e
                    check('%s: env_gate_check() with that module: EnvGateRefused "cannot be loaded (ValueError)"' % name,
                          type(got).__name__ == 'EnvGateRefused' and 'cannot be loaded (ValueError)' in str(got),
                          repr(got))
            finally:
                os.remove(gate_path)
                os.rename(os.path.join(inst, 'scripts', 'lib', 'off.py'), gate_path)

        # end to end, the CLI sender: exit 2, the reason on stderr, the reachable stub gets nothing, the token unshown
        env = {k: v for k, v in os.environ.items() if k != 'TELEGRAM_API_BASE'}
        del other_reqs[:]
        r = subprocess.run([sys.executable, os.path.join(inst, 'scripts', 'hooks', 'telegram_fallback_send.py'), '1',
                            'szia', '--state-dir', sd], capture_output=True, text=True, timeout=60,
                           env=dict(env, TELEGRAM_API_BASE=other_api), stdin=subprocess.DEVNULL)
        check('telegram_fallback_send CLI, 127.0.0.2: exit 2, the refusal on stderr, nothing arrives',
              r.returncode == 2 and 'neither https://api.telegram.org nor loopback' in r.stderr and not other_reqs
              and 'no TELEGRAM_BOT_TOKEN' not in r.stderr, (r.returncode, r.stderr, other_reqs))
        check('  ...and the bot token is in no output', BOT_TOKEN not in r.stdout + r.stderr)
    finally:
        if saved is None:
            os.environ.pop('TELEGRAM_API_BASE', None)
        else:
            os.environ['TELEGRAM_API_BASE'] = saved
        local.shutdown()
        other.shutdown()
        shutil.rmtree(inst, ignore_errors=True)
        shutil.rmtree(sd, ignore_errors=True)
        shutil.rmtree(fifo_sd, ignore_errors=True)

    print('%d check(s) failed: %s' % (len(FAILS), FAILS) if FAILS else 'all checks passed')
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main())
