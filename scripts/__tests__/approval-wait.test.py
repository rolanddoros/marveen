#!/usr/bin/env python3
"""C2 PR5: `marveen-api.sh approval-wait <id> [--timeout s]` (scripts/lib/marveen_api.py, Kevin 11795, Johnny 11800).

What is pinned:
  - the exit codes Johnny decided (11800): 0 ONLY for approved; 8 for decided but not approved (rejected, or the
    server-side timeout); 3 when still pending at the end of --timeout; 2 for an unknown id (404) and usage errors;
  - it polls at once, then every APPROVAL_POLL_S seconds, and a last time at the deadline;
  - a 5xx or a dropped connection is transient (the next poll decides); 401/403 stops at once (exit 1);
  - it NEVER consumes: every request is a GET on /api/approvals/<id>, never /consume;
  - the defaults: 540 s (under the Bash tool's 600 s), poll 60 s; --help names the verb and code 8.

The polling runs in-process with APPROVAL_POLL_S patched small, from a sandbox copy of the install, against a stub API
on 127.0.0.1; one run goes through marveen-api.sh itself. Nothing reaches a real dashboard.

Run:  python3 scripts/__tests__/approval-wait.test.py
"""
import http.server
import importlib.util
import io
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from contextlib import redirect_stderr, redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
FAILS = []

# Each GET takes the next (status, body) from STATE['answers']; the last one repeats once the list runs out.
STATE = {'answers': [(200, '{"status":"pending"}')]}
REQS = []


class Stub(http.server.BaseHTTPRequestHandler):
    def _answer(self):
        n = int(self.headers.get('Content-Length', '0'))
        if n:
            self.rfile.read(n)
        REQS.append({'method': self.command, 'path': self.path, 't': time.monotonic()})
        answers = STATE['answers']
        status, body = answers.pop(0) if len(answers) > 1 else answers[0]
        out = body.encode()
        try:
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(out)))
            self.end_headers()
            self.wfile.write(out)
        except OSError:
            pass

    do_GET = do_POST = do_PUT = _answer

    def log_message(self, *a):
        pass


def check(name, cond, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + (('  -- ' + str(detail)) if detail and not cond else ''))
    if not cond:
        FAILS.append(name)


def reset(*answers):
    STATE['answers'] = [(s, json.dumps(b) if isinstance(b, dict) else b) for s, b in answers]
    del REQS[:]


def make_install():
    inst = tempfile.mkdtemp(prefix='approval-wait-')
    os.makedirs(os.path.join(inst, 'scripts', 'lib'))
    os.makedirs(os.path.join(inst, 'store'))
    shutil.copy(os.path.join(ROOT, 'scripts', 'marveen-api.sh'), os.path.join(inst, 'scripts', 'marveen-api.sh'))
    for f in ('marveen_api.py', 'env_gate.py', 'homoglyph.py', 'mixed_script.py'):
        shutil.copy(os.path.join(ROOT, 'scripts', 'lib', f), os.path.join(inst, 'scripts', 'lib', f))
    with open(os.path.join(inst, 'store', '.dashboard-token'), 'w') as f:
        f.write('test-token\n')
    return inst


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    p = s.getsockname()[1]
    s.close()
    return p


def main():
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Stub)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    api = 'http://127.0.0.1:%d' % srv.server_address[1]
    inst = make_install()
    for k in ('MARVEEN_TOKEN_FILE', 'MARVEEN_WEB_PORT', 'WEB_PORT', 'MARVEEN_AGENT_ID'):
        os.environ.pop(k, None)
    os.environ['MARVEEN_API_BASE'] = api

    spec = importlib.util.spec_from_file_location('marveen_api_sandbox',
                                                  os.path.join(inst, 'scripts', 'lib', 'marveen_api.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    def wait(args, poll=0.05):
        mod.APPROVAL_POLL_S = poll
        out, err = io.StringIO(), io.StringIO()
        t0 = time.monotonic()
        with redirect_stdout(out), redirect_stderr(err):
            rc = mod.main(['approval-wait'] + args)
        return rc, out.getvalue().strip(), err.getvalue().strip(), time.monotonic() - t0

    def only_gets(aid):
        return all(r['method'] == 'GET' and r['path'] == '/api/approvals/%s' % aid for r in REQS)

    all_reqs = []
    try:
        # --- decided ---------------------------------------------------------------------------------------------
        reset((200, {'id': 'a1', 'status': 'approved'}))
        rc, out, err, dt = wait(['a1'], poll=30)
        check('approved at once: exit 0, one GET, the final status line', rc == 0 and len(REQS) == 1
              and out == 'status=approved id=a1' and only_gets('a1'), (rc, out, err, REQS))
        check('  ...the first poll is immediate (poll 30 s, answered in well under that)', dt < 5, dt)
        all_reqs += REQS

        reset((200, {'status': 'pending'}), (200, {'status': 'pending'}), (200, {'status': 'approved'}))
        rc, out, err, dt = wait(['a2'])
        check('pending, pending, approved: exit 0 after three GETs', rc == 0 and len(REQS) == 3
              and out == 'status=approved id=a2' and only_gets('a2'), (rc, out, err, REQS))
        all_reqs += REQS

        for state in ('rejected', 'timeout'):
            reset((200, {'status': 'pending'}), (200, {'status': state}))
            rc, out, err, dt = wait(['a3'])
            check('%s: exit 8 (decided, NOT approved), "do not act" on stdout' % state,
                  rc == 8 and out.startswith('status=%s id=a3' % state) and 'do not act' in out and len(REQS) == 2,
                  (rc, out, err, REQS))
            all_reqs += REQS

        # --- still pending at the deadline -------------------------------------------------------------------------
        reset((200, {'status': 'pending'}))
        rc, out, err, dt = wait(['a4', '--timeout', '1'], poll=0.2)
        check('pending past --timeout 1: exit 3, "call approval-wait again"', rc == 3
              and out.startswith('status=pending id=a4') and 'call approval-wait again' in out, (rc, out, err))
        check('  ...it polled repeatedly and stopped near the deadline', 4 <= len(REQS) <= 8 and 0.9 <= dt < 3,
              (len(REQS), dt))
        all_reqs += REQS

        reset((200, {'status': 'pending'}))
        rc, out, err, dt = wait(['a5', '--timeout', '1'], poll=30)
        check('a poll interval longer than --timeout: one poll at once and one last poll at the deadline',
              rc == 3 and len(REQS) == 2 and 0.9 <= REQS[1]['t'] - REQS[0]['t'] < 2, (rc, len(REQS), dt))
        all_reqs += REQS

        # --- transient problems: the next poll decides -------------------------------------------------------------
        reset((500, '{"error":"x"}'), (503, '{"error":"y"}'), (200, {'status': 'approved'}))
        rc, out, err, dt = wait(['a6'])
        check('a 500 and a 503, then approved: exit 0', rc == 0 and len(REQS) == 3 and out == 'status=approved id=a6',
              (rc, out, err, REQS))
        all_reqs += REQS

        reset((502, '{"error":"bad gateway"}'))
        rc, out, err, dt = wait(['a7', '--timeout', '1'], poll=0.2)
        check('5xx until the deadline: exit 3, the last problem is named', rc == 3 and 'HTTP 502' in out, (rc, out))
        all_reqs += REQS

        dead = 'http://127.0.0.1:%d' % free_port()
        os.environ['MARVEEN_API_BASE'] = dead
        rc, out, err, dt = wait(['a8', '--timeout', '1'], poll=0.2)
        os.environ['MARVEEN_API_BASE'] = api
        check('nothing answering until the deadline: exit 3, "could not be reached" named',
              rc == 3 and 'could not be reached' in out, (rc, out, err))

        # --- stops at once -----------------------------------------------------------------------------------------
        reset((404, '{"error":"not found"}'))
        rc, out, err, dt = wait(['nope'])
        check('unknown id (404): exit 2, one request, "nothing to wait for"', rc == 2 and len(REQS) == 1
              and 'nothing to wait for' in err, (rc, out, err, REQS))
        all_reqs += REQS
        for code in (401, 403):
            reset((code, '{"error":"auth"}'))
            rc, out, err, dt = wait(['a9'])
            check('HTTP %d: exit 1 at once, one request' % code, rc == 1 and len(REQS) == 1, (rc, err, REQS))
            all_reqs += REQS
        reset((200, {'status': 'weird'}))
        rc, out, err, dt = wait(['a10'])
        check('an unknown status word: exit 1, named', rc == 1 and "'weird'" in err and len(REQS) == 1, (rc, err))
        all_reqs += REQS
        reset((200, 'not json'))
        rc, out, err, dt = wait(['a11'])
        check('a body that is not JSON: exit 1, not taken as pending', rc == 1 and len(REQS) == 1, (rc, err))
        all_reqs += REQS

        # --- usage: nothing is requested ---------------------------------------------------------------------------
        for name, args in [
            ('--timeout abc', ['a1', '--timeout', 'abc']),
            ('--timeout 0', ['a1', '--timeout', '0']),
            ('--timeout -5', ['a1', '--timeout', '-5']),
            ('--timeout over the maximum', ['a1', '--timeout', str(mod.APPROVAL_WAIT_MAX_S + 1)]),
            ('--timeout without a value', ['a1', '--timeout']),
            ('no id', []),
            ('two ids', ['a1', 'a2']),
            ('an id with a slash', ['../consume']),
        ]:
            reset((200, {'status': 'approved'}))
            rc, out, err, dt = wait(args)
            check('usage error, exit 2, nothing requested: ' + name, rc == 2 and not REQS and err.startswith('FAIL'),
                  (rc, out, err, REQS))

        # --- it never consumes -------------------------------------------------------------------------------------
        check('across every case: only GETs, never a /consume request',
              all_reqs and all(r['method'] == 'GET' and '/consume' not in r['path'] for r in all_reqs),
              [r for r in all_reqs if r['method'] != 'GET' or '/consume' in r['path']])

        # --- defaults and --help -----------------------------------------------------------------------------------
        check('defaults: wait 540 s (under the Bash tool\'s 600 s), poll every 60 s',
              mod.APPROVAL_WAIT_DEFAULT_S == 540 and mod.APPROVAL_WAIT_DEFAULT_S < 600, mod.APPROVAL_WAIT_DEFAULT_S)
        src = open(os.path.join(ROOT, 'scripts', 'lib', 'marveen_api.py'), encoding='utf-8').read()
        check('  ...the shipped poll interval is 60 s', 'APPROVAL_POLL_S = 60\n' in src)

        # --- through marveen-api.sh ----------------------------------------------------------------------------------
        env = dict(os.environ, MARVEEN_API_BASE=api)
        for state, code in (('approved', 0), ('rejected', 8)):
            reset((200, {'status': state}))
            r = subprocess.run(['bash', os.path.join(inst, 'scripts', 'marveen-api.sh'), 'approval-wait', 'b1'],
                               capture_output=True, text=True, env=env, timeout=60, stdin=subprocess.DEVNULL)
            check('marveen-api.sh approval-wait, %s: exit %d' % (state, code), r.returncode == code
                  and r.stdout.startswith('status=%s id=b1' % state) and only_gets('b1'),
                  (r.returncode, r.stdout, r.stderr, REQS))
        r = subprocess.run(['bash', os.path.join(inst, 'scripts', 'marveen-api.sh'), '--help'],
                           capture_output=True, text=True, env=env, timeout=60)
        check('--help lists approval-wait and code 8', r.returncode == 0 and 'approval-wait <approval-id>' in r.stdout
              and '  8  ' in r.stdout, r.stdout[-400:])
        row3 = [line for line in r.stdout.splitlines() if line.startswith('  3  ')]
        check('  ...and row 3 says what it means for approval-wait (Kevin 11827, Johnny 11798)',
              len(row3) == 1 and 'approval-wait: no decision before --timeout, call again' in row3[0], row3)
    finally:
        srv.shutdown()
        shutil.rmtree(inst, ignore_errors=True)

    print('%d check(s) failed: %s' % (len(FAILS), FAILS) if FAILS else 'all checks passed')
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main())
