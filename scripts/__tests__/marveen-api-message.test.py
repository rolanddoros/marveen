#!/usr/bin/env python3
"""C2 PR4: the message verb in python (scripts/lib/marveen_api.py), and message-close --report / exit 4.

agent-msg.sh's send moved into the helper. Its own cases (the queue line, the homoglyph gate, the port chain,
--priority, the token off every argv) stay in agent-msg-queue.test.sh, agent-msg-homoglyph.test.sh,
agent-msg-port.test.sh, agent-msg-priority.test.py and src/__tests__/agent-msg-token-argv.test.ts, now against the
python code. This file pins what those do not:
  - `marveen-api.sh message`: the file and stdin forms, trailing newlines dropped as the shell's $(cat) did, the
    recipe payload file (api-*.txt) emptied after a send and kept after a failure, and its usage errors;
  - three tries: a 500 then an id is one message; three failures are one FAIL line and one log line;
  - nothing answering: http=000; no answer in time: ONE request, no retry, "read back before re-sending";
  - message-close: --report and the old --no-notify send notify:false, a 409 exits 4 and keeps the payload file.

Everything runs from a sandbox copy of the install (the failure log is <install>/store/agent-msg-failures.log) against
a stub API on 127.0.0.1; nothing reaches a real dashboard.

Run:  python3 scripts/__tests__/marveen-api-message.test.py
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
from contextlib import redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
FAILS = []

STATE = {'statuses': [], 'body': '{"id":51}', 'sleep': 0.0}
REQS = []


class Stub(http.server.BaseHTTPRequestHandler):
    def _answer(self):
        n = int(self.headers.get('Content-Length', '0'))
        raw = self.rfile.read(n).decode('utf-8')
        REQS.append({'method': self.command, 'path': self.path, 'body': json.loads(raw) if raw else None})
        if STATE['sleep']:
            time.sleep(STATE['sleep'])
        status = STATE['statuses'].pop(0) if STATE['statuses'] else 200
        out = STATE['body'].encode()
        try:
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(out)))
            self.end_headers()
            self.wfile.write(out)
        except OSError:
            pass  # the client gave up (the timeout case)

    do_POST = do_PUT = _answer

    def log_message(self, *a):
        pass


def check(name, cond, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + (('  -- ' + str(detail)) if detail and not cond else ''))
    if not cond:
        FAILS.append(name)


def reset(statuses=(), body='{"id":51}', sleep=0.0):
    STATE.update(statuses=list(statuses), body=body, sleep=sleep)
    del REQS[:]


def make_install():
    inst = tempfile.mkdtemp(prefix='marveen-api-message-')
    os.makedirs(os.path.join(inst, 'scripts', 'lib'))
    os.makedirs(os.path.join(inst, 'store'))
    for f in ('marveen-api.sh', 'agent-msg.sh'):
        shutil.copy(os.path.join(ROOT, 'scripts', f), os.path.join(inst, 'scripts', f))
    for f in ('marveen_api.py', 'homoglyph.py', 'mixed_script.py'):
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
    log = os.path.join(inst, 'store', 'agent-msg-failures.log')
    env = {k: v for k, v in os.environ.items() if k not in ('MARVEEN_TOKEN_FILE', 'MARVEEN_WEB_PORT', 'WEB_PORT')}
    env['MARVEEN_API_BASE'] = api

    def helper(args, stdin=None, base=None):
        e = dict(env, MARVEEN_API_BASE=base or api)
        io_ = {'input': stdin} if stdin is not None else {'stdin': subprocess.DEVNULL}
        r = subprocess.run(['bash', os.path.join(inst, 'scripts', 'marveen-api.sh')] + args, capture_output=True,
                           text=True, env=e, timeout=60, **io_)
        return r.returncode, r.stdout.strip(), r.stderr.strip()

    def payload(name, text):
        p = os.path.join(inst, name)
        with open(p, 'w', encoding='utf-8') as f:
            f.write(text)
        return p

    def read(p):
        with open(p, encoding='utf-8') as f:
            return f.read()

    def log_lines():
        return read(log).splitlines() if os.path.exists(log) else []

    try:
        # --- marveen-api.sh message ---------------------------------------------------------------------------
        reset()
        rc, out, err = helper(['message', 'dani', 'samu', payload('m.txt', 'Szia, "idézet" és `kód`\n\n')])
        check('message <file>: OK line, one request, the text verbatim minus the trailing newlines',
              rc == 0 and out == 'OK id=51' and len(REQS) == 1
              and REQS[0]['body'] == {'from': 'dani', 'to': 'samu', 'content': 'Szia, "idézet" és `kód`'},
              (rc, out, err, REQS))
        reset()
        rc, out, err = helper(['message', 'dani', 'samu', '-'], stdin='stdin szöveg\nmásodik sor\n')
        check('message -: the text from stdin', rc == 0 and REQS[0]['body']['content'] == 'stdin szöveg\nmásodik sor',
              (rc, out, err, REQS))
        reset()
        rc, out, err = helper(['message', 'dani', 'samu', payload('p.txt', 'x'), '--priority', 'high'])
        check('message: --priority after the positionals is the helper form, sent high',
              rc == 0 and REQS[0]['body'].get('priority') == 'high', (rc, out, err, REQS))

        reset()
        p = payload('api-uzenet.txt', 'egyszer menjen ki')
        rc, out, err = helper(['message', 'dani', 'samu', p])
        check('a recipe payload file (api-*.txt) is emptied after the send', rc == 0 and read(p) == '', (rc, read(p)))
        reset()
        rc, out, err = helper(['message', 'dani', 'samu', p])
        check('  ...and the empty one exits 2 and sends nothing', rc == 2 and 'is empty' in err and not REQS,
              (rc, err, REQS))
        reset(body='{"error":"nope"}')
        p = payload('api-uzenet.txt', 'marad a hibánál')
        before = len(log_lines())
        rc, out, err = helper(['message', 'dani', 'samu', p])
        lines = log_lines()[before:]
        check('a failed send keeps the payload file for the retry, exit 1', rc == 1 and read(p) == 'marad a hibánál',
              (rc, out, read(p)))
        check('  ...after three tries, one FAIL line on stdout',
              len(REQS) == 3 and out.startswith('FAIL from=dani to=samu url=%s/api/messages http=200' % api)
              and out.endswith('(after 3 tries)'), (len(REQS), out))
        check('  ...and one log line with the key=value fields',
              len(lines) == 1 and lines[0].split('\t')[1:6] == ['FAIL', 'from=dani', 'to=samu',
                                                               'url=%s/api/messages' % api, 'http=200']
              and lines[0].split('\t')[6] == 'resp={"error":"nope"}', lines)

        for name, args, code in [
            ('an unreadable file', ['message', 'dani', 'samu', os.path.join(inst, 'nincs.txt')], 2),
            ('an unknown option', ['message', 'dani', 'samu', payload('u.txt', 'x'), '--loud'], 2),
            ('two positionals', ['message', 'dani', payload('v.txt', 'x')], 2),
            ('--priority without a value', ['message', 'dani', 'samu', payload('w.txt', 'x'), '--priority'], 2),
            ('--priority with another word (agent-msg.sh\'s check, its code)',
             ['message', '--priority', 'urgent', 'dani', 'samu', payload('y.txt', 'x')], 1),
        ]:
            reset()
            rc, out, err = helper(args)
            check('refused, nothing sent: ' + name, rc == code and not REQS and (out + err).startswith('FAIL'),
                  (rc, out, err, REQS))

        # --- tries, nothing answering ----------------------------------------------------------------------------
        reset(statuses=[500, 503], body='{"id":52}')
        rc, out, err = helper(['message', 'dani', 'samu', payload('t.txt', 'x')])
        check('a 500, a 503, then an id: one message, sent on the third try', rc == 0 and out == 'OK id=52'
              and len(REQS) == 3, (rc, out, len(REQS)))
        dead = 'http://127.0.0.1:%d' % free_port()
        before = len(log_lines())
        rc, out, err = helper(['message', 'dani', 'samu', payload('d.txt', 'x')], base=dead)
        lines = log_lines()[before:]
        check('nothing answering: FAIL with http=000, exit 1, logged',
              rc == 1 and 'http=000' in out and len(lines) == 1 and '\thttp=000\t' in lines[0], (rc, out, lines))

        # --- no answer in time: one request, no retry (in-process, with a 1 s limit) ----------------------------
        spec = importlib.util.spec_from_file_location('marveen_api_sandbox',
                                                      os.path.join(inst, 'scripts', 'lib', 'marveen_api.py'))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        mod.MESSAGE_TIMEOUT_S = 1
        os.environ['MARVEEN_API_BASE'] = api
        reset(sleep=2.5)
        before = len(log_lines())
        buf = io.StringIO()
        with redirect_stdout(buf):
            outcome = mod.send_message('dani', 'samu', 'lassu', '', 'test-token')
        time.sleep(1.8)  # let the stub finish its answer before the next case
        lines = log_lines()[before:]
        check('a timeout is ONE request, not three: the row may exist', outcome == 'send_failed' and len(REQS) == 1,
              (outcome, len(REQS)))
        check('  ...the FAIL line says to read back before re-sending',
              'http=timeout' in buf.getvalue() and 'read back before re-sending' in buf.getvalue(), buf.getvalue())
        check('  ...and the log line says http=timeout', len(lines) == 1 and '\thttp=timeout\t' in lines[0], lines)
        check('the exit code of a timeout is the send-failed one, from MESSAGE_EXIT',
              mod.MESSAGE_EXIT[outcome] == mod.MESSAGE_EXIT['send_failed'] == 1, mod.MESSAGE_EXIT)

        # --- message-close ---------------------------------------------------------------------------------------
        for flag, expect in (('--report', False), ('--no-notify', False), (None, None)):
            reset(body='{"ok":true}')
            rc, out, err = helper(['message-close', '7'] + ([flag] if flag else []))
            body = REQS[0]['body'] if REQS else {}
            check('message-close %s: notify %s' % (flag or '(no flag)', 'false' if expect is False else 'not sent'),
                  rc == 0 and REQS[0]['method'] == 'PUT' and REQS[0]['path'] == '/api/messages/7'
                  and body.get('notify', None) is expect and ('notify' in body) == (expect is not None), (rc, REQS))
        reset(statuses=[409], body='{"error":"Message already closed"}')
        p = payload('api-eredmeny.txt', 'kész')
        rc, out, err = helper(['message-close', '7', '--report', '--result-file', p])
        check('message-close on a closed message (409): exit 4, "not an error, do not retry", one request',
              rc == 4 and 'ALREADY CLOSED' in err and 'do not retry' in err and len(REQS) == 1, (rc, err, REQS))
        check('  ...and the payload file is kept (nothing changed)', read(p) == 'kész', read(p))
        reset(statuses=[500], body='{"error":"x"}')
        rc, out, err = helper(['message-close', '7'])
        check('message-close, another non-2xx: still exit 1', rc == 1, (rc, err))
    finally:
        srv.shutdown()
        shutil.rmtree(inst, ignore_errors=True)

    print('%d check(s) failed: %s' % (len(FAILS), FAILS) if FAILS else 'all checks passed')
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main())
