#!/usr/bin/env python3
"""C2 PR4b: agent-msg.sh applies the helper's env gate (check_env) before the token is read.

The token goes to MARVEEN_API_BASE and comes from MARVEEN_TOKEN_FILE, both plain environment. Until PR4b,
agent-msg.sh run directly accepted any value of either, so whoever could set the environment could send the
dashboard token to any host (Johnny 11641). Now, as for every other helper verb:
  - allowed: a loopback base, or exactly this install's own AGENT_API_ORIGIN / DASHBOARD_PUBLIC_URL from its .env;
  - refused, exit 2, nothing sent: any other host, a base with a path / query / fragment, a token file that is not
    named .dashboard-token.

The proof that nothing is sent is a SECOND stub on 127.0.0.2: it is reachable, so a refused request would arrive
there, and it must stay empty. The same stub becomes allowed when the sandbox install's .env names it.

Everything runs from a sandbox copy of the install against stubs on 127.0.0.1 / 127.0.0.2.

Run:  python3 scripts/__tests__/agent-msg-env-gate.test.py
"""
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
FAILS = []


def make_stub(host):
    reqs = []

    class Stub(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            n = int(self.headers.get('Content-Length', '0'))
            raw = self.rfile.read(n).decode('utf-8')
            reqs.append({'path': self.path, 'auth': self.headers.get('Authorization'),
                         'body': json.loads(raw) if raw else None})
            out = b'{"id":77}'
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


def check(name, cond, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + (('  -- ' + str(detail)) if detail and not cond else ''))
    if not cond:
        FAILS.append(name)


def make_install():
    inst = tempfile.mkdtemp(prefix='agent-msg-env-gate-')
    os.makedirs(os.path.join(inst, 'scripts', 'lib'))
    os.makedirs(os.path.join(inst, 'store'))
    shutil.copy(os.path.join(ROOT, 'scripts', 'agent-msg.sh'), os.path.join(inst, 'scripts', 'agent-msg.sh'))
    for f in ('marveen_api.py', 'env_gate.py', 'homoglyph.py', 'mixed_script.py'):
        shutil.copy(os.path.join(ROOT, 'scripts', 'lib', f), os.path.join(inst, 'scripts', 'lib', f))
    with open(os.path.join(inst, 'store', '.dashboard-token'), 'w') as f:
        f.write('gate-test-token\n')
    return inst


def main():
    local, local_api, local_reqs = make_stub('127.0.0.1')
    other, other_api, other_reqs = make_stub('127.0.0.2')
    inst = make_install()
    log = os.path.join(inst, 'store', 'agent-msg-failures.log')
    env = {k: v for k, v in os.environ.items()
           if k not in ('MARVEEN_TOKEN_FILE', 'MARVEEN_API_BASE', 'MARVEEN_WEB_PORT', 'WEB_PORT', 'MARVEEN_AGENT_ID')}

    def send(base, token_file=None, content='hello'):
        e = dict(env, MARVEEN_API_BASE=base)
        if token_file:
            e['MARVEEN_TOKEN_FILE'] = token_file
        try:
            r = subprocess.run(['bash', os.path.join(inst, 'scripts', 'agent-msg.sh'), 'dani', 'samu', content],
                               capture_output=True, text=True, env=e, timeout=20, stdin=subprocess.DEVNULL)
        except subprocess.TimeoutExpired:
            # e.g. a non-http scheme let through: urllib speaks FTP to the HTTP stub and hangs. A result, not a crash.
            return None, 'TIMEOUT (20 s)', ''
        return r.returncode, r.stdout.strip(), r.stderr.strip()

    def write_env(text):
        with open(os.path.join(inst, '.env'), 'w') as f:
            f.write(text)

    def reset():
        del local_reqs[:]
        del other_reqs[:]

    try:
        # control: loopback is allowed, the token arrives in the header
        reset()
        rc, out, err = send(local_api)
        check('loopback base: sent', rc == 0 and out.startswith('OK id=77') and len(local_reqs) == 1, (rc, out, err))
        check('loopback base: the token is in the Authorization header',
              local_reqs and local_reqs[0]['auth'] == 'Bearer gate-test-token', local_reqs)

        # a reachable host that is not loopback and not in .env: refused before anything is read or sent
        refused = [
            ('a non-loopback host (reachable stub on 127.0.0.2)', other_api),
            ('a foreign name', 'http://example.invalid:%d' % other.server_address[1]),
            ('loopback with a path and a query', local_api + '/api/schedules?x='),
            ('loopback with a fragment', local_api + '/#x'),
        ]
        for name, base in refused:
            reset()
            rc, out, err = send(base)
            check('refused, exit 2: ' + name, rc == 2 and out.startswith('FAIL: MARVEEN_API_BASE='), (rc, out, err))
            check('refused, nothing reached either stub: ' + name, not local_reqs and not other_reqs,
                  (local_reqs, other_reqs))
        check('a refusal is a usage error, not a send failure: no line in the failure log', not os.path.exists(log))

        # the install's own .env origin is allowed (a remote agent's route), and only the exact origin
        for key in ('AGENT_API_ORIGIN', 'DASHBOARD_PUBLIC_URL'):
            write_env('%s=%s/\n' % (key, other_api))
            reset()
            rc, out, err = send(other_api)
            check('.env %s origin: sent there' % key, rc == 0 and len(other_reqs) == 1 and not local_reqs,
                  (rc, out, err, other_reqs))
            reset()
            rc, out, err = send('http://127.0.0.2:%d' % (other.server_address[1] + 1))
            check('.env %s: another port on the same host is still refused' % key,
                  rc == 2 and not other_reqs and not local_reqs, (rc, out, err))
        os.remove(os.path.join(inst, '.env'))

        # the token file must be named .dashboard-token
        tmp = tempfile.mkdtemp(prefix='agent-msg-env-gate-tok-')
        wrong = os.path.join(tmp, 'token')
        right = os.path.join(tmp, '.dashboard-token')
        for p in (wrong, right):
            with open(p, 'w') as f:
                f.write('other-token\n')
        reset()
        rc, out, err = send(local_api, token_file=wrong)
        check('a token file not named .dashboard-token: exit 2, nothing sent',
              rc == 2 and out.startswith('FAIL: MARVEEN_TOKEN_FILE') and not local_reqs, (rc, out, err))
        reset()
        rc, out, err = send(local_api, token_file=right)
        check('a .dashboard-token elsewhere: sent with that token',
              rc == 0 and local_reqs and local_reqs[0]['auth'] == 'Bearer other-token', (rc, out, err, local_reqs))
        shutil.rmtree(tmp, ignore_errors=True)

        # the stdin form ('-') is refused the same way, and the refusal echoes neither the token nor the text
        reset()
        e = dict(env, MARVEEN_API_BASE=other_api)
        r = subprocess.run(['bash', os.path.join(inst, 'scripts', 'agent-msg.sh'), 'dani', 'samu', '-'],
                           capture_output=True, text=True, env=e, timeout=60, input='secret text')
        check('stdin form refused the same way', r.returncode == 2 and not other_reqs and not local_reqs,
              (r.returncode, r.stdout))
        check('the refusal names neither the token nor the text',
              'gate-test-token' not in r.stdout + r.stderr and 'secret text' not in r.stdout + r.stderr,
              r.stdout + r.stderr)
        # --- Ron's PR4b items (G2, G8, G14, point 7), pinned in PR4c ---------------------------------------------
        local_port = str(local.server_address[1])

        # G8: the token-file rule runs with NO MARVEEN_API_BASE too. The port chain is pointed at the local stub,
        # so a broken gate would show up there, never on a real dashboard.
        tmp = tempfile.mkdtemp(prefix='agent-msg-env-gate-g8-')
        wrong = os.path.join(tmp, 'notes.txt')
        with open(wrong, 'w') as f:
            f.write('first line of another file\n')
        reset()
        e = dict(env, MARVEEN_WEB_PORT=local_port, MARVEEN_TOKEN_FILE=wrong)
        r = subprocess.run(['bash', os.path.join(inst, 'scripts', 'agent-msg.sh'), 'dani', 'samu', 'x'],
                           capture_output=True, text=True, env=e, timeout=60, stdin=subprocess.DEVNULL)
        check('G8: no MARVEEN_API_BASE, a token file not named .dashboard-token: exit 2, nothing sent',
              r.returncode == 2 and 'MARVEEN_TOKEN_FILE' in r.stdout and not local_reqs, (r.returncode, r.stdout))
        reset()
        e = dict(env, MARVEEN_WEB_PORT=local_port)
        r = subprocess.run(['bash', os.path.join(inst, 'scripts', 'agent-msg.sh'), 'dani', 'samu', 'x'],
                           capture_output=True, text=True, env=e, timeout=60, stdin=subprocess.DEVNULL)
        check('G8 control: no MARVEEN_API_BASE, the port chain reaches the stub', r.returncode == 0 and local_reqs,
              (r.returncode, r.stdout))
        shutil.rmtree(tmp, ignore_errors=True)

        # G14: a loopback host under any scheme but http(s) is not the dashboard
        for base in ('ftp://127.0.0.1:%s' % local_port, 'gopher://localhost:%s' % local_port,
                     'file://localhost/etc', 'ws://127.0.0.1:%s' % local_port):
            reset()
            rc, out, err = send(base)
            check('G14: refused, exit 2: ' + base, rc == 2 and 'must be http:// or https://' in out and not local_reqs,
                  (rc, out))

        # point 7: the gate and the request read the base the same way (spaces and trailing slashes)
        reset()
        rc, out, err = send('  %s/  ' % local_api)
        check('point 7: a base with surrounding spaces and a trailing slash is sent, to the right URL',
              rc == 0 and out.startswith('OK id=') and local_reqs and local_reqs[0]['path'] == '/api/messages',
              (rc, out, local_reqs))

        # G2: the gate runs before stdin is read and before the token file is opened. The token file is a FIFO with
        # no writer (an open() blocks) and stdin is a pipe nobody writes to (a read blocks): a refused run must come
        # back at once, and the allowed control must block, which proves the method can see a read (Ron's method).
        fifo_dir = tempfile.mkdtemp(prefix='agent-msg-env-gate-fifo-')
        fifo = os.path.join(fifo_dir, '.dashboard-token')
        os.mkfifo(fifo)

        def blocked(base, content):
            e = dict(env, MARVEEN_API_BASE=base, MARVEEN_TOKEN_FILE=fifo)
            sleeper = subprocess.Popen(['sleep', '20'], stdout=subprocess.PIPE)
            t0 = time.time()
            try:
                p = subprocess.run(['bash', os.path.join(inst, 'scripts', 'agent-msg.sh'), 'dani', 'samu', content],
                                   capture_output=True, text=True, env=e, timeout=4, stdin=sleeper.stdout)
                return False, p.returncode, time.time() - t0
            except subprocess.TimeoutExpired:
                return True, None, time.time() - t0
            finally:
                sleeper.kill()
                sleeper.wait()

        for content in ('-', 'text as an argument'):
            reset()
            is_blocked, rc, took = blocked(other_api, content)
            check('G2: refused base, content %r: exit 2 at once, neither stdin nor the token file read' % content,
                  not is_blocked and rc == 2 and not other_reqs, (is_blocked, rc, round(took, 1)))
            is_blocked, rc, took = blocked(local_api, content)
            check('G2 control: allowed base, content %r: blocks on the read (the method sees a read)' % content,
                  is_blocked, (is_blocked, rc, round(took, 1)))
        shutil.rmtree(fifo_dir, ignore_errors=True)
    finally:
        local.shutdown()
        other.shutdown()
        shutil.rmtree(inst, ignore_errors=True)

    print('%d check(s) failed: %s' % (len(FAILS), FAILS) if FAILS else 'all checks passed')
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main())
