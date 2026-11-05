#!/usr/bin/env python3
"""C2 PR5: scripts/marveen-admin.sh (scripts/lib/marveen_admin.py), the MAIN agent's schedule writes.

What is pinned:
  - schedule-create: POST /api/schedules with the body built from files (prompt, description: never argv text),
    --once / --skip-if-busy as JSON booleans and absent when not given; 409 -> exit 4 ("use schedule-update");
  - schedule-update: PUT /api/schedules/<name> with only the changes given, --enabled as a JSON boolean; no change ->
    exit 2, nothing sent; 404 -> exit 2;
  - the accident guard: MARVEEN_AGENT_ID other than the install's .env MAIN_AGENT_ID -> exit 2, nothing sent (the
    environment's MAIN_AGENT_ID cannot override the .env one);
  - the token env gate runs first: a non-loopback MARVEEN_API_BASE -> exit 2, nothing sent;
  - usage errors (bad cron, type, name, empty or missing file, unknown verb/option) -> exit 2, nothing sent;
  - the exit codes are the helper's table; the one literal (the load failure) equals its 'usage' row;
  - marveen-api.sh itself still has no schedule write (the helper's refusal stays).

Everything runs from a sandbox copy of the install against a stub API on 127.0.0.1; nothing reaches a real dashboard.

Run:  python3 scripts/__tests__/marveen-admin.test.py
"""
import http.server
import importlib.util
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
FAILS = []

STATE = {'statuses': [], 'body': '{"ok":true}'}
REQS = []


class Stub(http.server.BaseHTTPRequestHandler):
    def _answer(self):
        n = int(self.headers.get('Content-Length', '0'))
        raw = self.rfile.read(n).decode('utf-8') if n else ''
        REQS.append({'method': self.command, 'path': self.path, 'body': json.loads(raw) if raw else None,
                     'auth': self.headers.get('Authorization')})
        status = STATE['statuses'].pop(0) if STATE['statuses'] else 200
        out = STATE['body'].encode()
        try:
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(out)))
            self.end_headers()
            self.wfile.write(out)
        except OSError:
            pass

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _answer

    def log_message(self, *a):
        pass


def check(name, cond, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + (('  -- ' + str(detail)) if detail and not cond else ''))
    if not cond:
        FAILS.append(name)


def reset(statuses=(), body='{"ok":true}'):
    STATE.update(statuses=list(statuses), body=body)
    del REQS[:]


def make_install(main_id='johnny', with_api=True):
    inst = tempfile.mkdtemp(prefix='marveen-admin-')
    os.makedirs(os.path.join(inst, 'scripts', 'lib'))
    os.makedirs(os.path.join(inst, 'store'))
    for f in ('marveen-admin.sh', 'marveen-api.sh'):
        shutil.copy(os.path.join(ROOT, 'scripts', f), os.path.join(inst, 'scripts', f))
    libs = ['marveen_admin.py', 'env_gate.py', 'homoglyph.py', 'mixed_script.py']
    if with_api:
        libs.append('marveen_api.py')
    for f in libs:
        shutil.copy(os.path.join(ROOT, 'scripts', 'lib', f), os.path.join(inst, 'scripts', 'lib', f))
    with open(os.path.join(inst, 'store', '.dashboard-token'), 'w') as f:
        f.write('test-token\n')
    with open(os.path.join(inst, '.env'), 'w') as f:
        f.write('MAIN_AGENT_ID=%s\n' % main_id)
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
    port = srv.server_address[1]
    api = 'http://127.0.0.1:%d' % port
    inst = make_install()
    bare = make_install(with_api=False)
    env = {k: v for k, v in os.environ.items()
           if k not in ('MARVEEN_TOKEN_FILE', 'MARVEEN_WEB_PORT', 'WEB_PORT', 'MARVEEN_AGENT_ID', 'MAIN_AGENT_ID')}
    env['MARVEEN_API_BASE'] = api

    def admin(args, stdin=None, ident=None, base=None, extra=None, install=None):
        e = dict(env, MARVEEN_API_BASE=base or api)
        if ident is not None:
            e['MARVEEN_AGENT_ID'] = ident
        e.update(extra or {})
        io_ = {'input': stdin} if stdin is not None else {'stdin': subprocess.DEVNULL}
        r = subprocess.run(['bash', os.path.join(install or inst, 'scripts', 'marveen-admin.sh')] + args,
                           capture_output=True, text=True, env=e, timeout=60, **io_)
        return r.returncode, r.stdout.strip(), r.stderr.strip()

    def payload(name, text):
        p = os.path.join(inst, name)
        with open(p, 'w', encoding='utf-8') as f:
            f.write(text)
        return p

    prompt = payload('prompt.txt', 'Nézd meg a "naptárt" és `jelezz`, ha $(baj) van.\n\n')
    desc = payload('desc.txt', 'Reggeli ellenőrzés\n')
    try:
        # --- schedule-create -----------------------------------------------------------------------------------
        reset()
        rc, out, err = admin(['schedule-create', 'reggeli-check', '0 8 * * *', 'heartbeat', 'johnny', prompt,
                              '--description-file', desc])
        check('create: OK line, one POST /api/schedules with the bearer token', rc == 0
              and out == 'OK schedule-create reggeli-check' and len(REQS) == 1 and REQS[0]['method'] == 'POST'
              and REQS[0]['path'] == '/api/schedules' and REQS[0]['auth'] == 'Bearer test-token', (rc, out, err, REQS))
        check('  ...the body from the files, text verbatim minus trailing newlines, no once/skipIfBusy keys',
              REQS and REQS[0]['body'] == {'name': 'reggeli-check', 'schedule': '0 8 * * *', 'type': 'heartbeat',
                                           'agent': 'johnny',
                                           'prompt': 'Nézd meg a "naptárt" és `jelezz`, ha $(baj) van.',
                                           'description': 'Reggeli ellenőrzés'}, REQS)
        reset()
        rc, out, err = admin(['schedule-create', 'egyszeri', '30 14 5 11 *', 'task', 'johnny', '-', '--once',
                              '--skip-if-busy'], stdin='stdin prompt\n')
        body = REQS[0]['body'] if REQS else {}
        check('create from stdin with --once --skip-if-busy: both JSON true, prompt from stdin, no description',
              rc == 0 and body.get('once') is True and body.get('skipIfBusy') is True
              and body.get('prompt') == 'stdin prompt' and 'description' not in body, (rc, err, body))
        reset(statuses=[409], body='{"error":"Schedule already exists"}')
        rc, out, err = admin(['schedule-create', 'reggeli-check', '0 8 * * *', 'task', 'johnny', prompt])
        check('create on an existing name (409): exit 4, "use schedule-update", one request',
              rc == 4 and 'use schedule-update' in err and len(REQS) == 1, (rc, err, REQS))
        reset(statuses=[500], body='{"error":"boom"}')
        rc, out, err = admin(['schedule-create', 'x', '0 8 * * *', 'task', 'johnny', prompt])
        check('create, a 500: exit 1, the body on stderr', rc == 1 and 'HTTP 500' in err and 'boom' in err, (rc, err))

        # --- schedule-update -----------------------------------------------------------------------------------
        reset()
        rc, out, err = admin(['schedule-update', 'reggeli-check', '--enabled', 'false', '--schedule', '0 9 * * 1-5',
                              '--prompt-file', prompt, '--type', 'task', '--agent', 'johnny',
                              '--description-file', desc])
        check('update: one PUT /api/schedules/<name>, every change given, --enabled a JSON false',
              rc == 0 and out == 'OK schedule-update reggeli-check' and len(REQS) == 1 and REQS[0]['method'] == 'PUT'
              and REQS[0]['path'] == '/api/schedules/reggeli-check'
              and REQS[0]['body'] == {'enabled': False, 'schedule': '0 9 * * 1-5', 'type': 'task', 'agent': 'johnny',
                                      'prompt': 'Nézd meg a "naptárt" és `jelezz`, ha $(baj) van.',
                                      'description': 'Reggeli ellenőrzés'}, (rc, err, REQS))
        reset()
        rc, out, err = admin(['schedule-update', 'reggeli-check', '--enabled', 'true'])
        check('update: only the change given is sent', rc == 0 and REQS and REQS[0]['body'] == {'enabled': True},
              (rc, err, REQS))
        reset(statuses=[404], body='{"error":"Schedule not found"}')
        rc, out, err = admin(['schedule-update', 'nincs-ilyen', '--enabled', 'false'])
        check('update on an unknown name (404): exit 2, "nothing changed"', rc == 2 and 'nothing changed' in err
              and len(REQS) == 1, (rc, err, REQS))

        # --- usage errors: nothing sent ------------------------------------------------------------------------
        empty = payload('empty.txt', '\n\n')
        for name, args in [
            ('update with no change', ['schedule-update', 'reggeli-check']),
            ('update, --enabled maybe', ['schedule-update', 'reggeli-check', '--enabled', 'maybe']),
            ('update, an option twice', ['schedule-update', 'r', '--enabled', 'true', '--enabled', 'false']),
            ('update, an option without a value', ['schedule-update', 'r', '--schedule']),
            ('update, an option first', ['schedule-update', '--enabled', 'true']),
            ('update, a bad cron', ['schedule-update', 'r', '--schedule', 'every day']),
            ('create, a four-field cron', ['schedule-create', 'x', '0 8 * *', 'task', 'johnny', prompt]),
            ('create, a cron with a shell character', ['schedule-create', 'x', '0 8 * * *;id', 'task', 'johnny', prompt]),
            ('create, an unknown type', ['schedule-create', 'x', '0 8 * * *', 'cron', 'johnny', prompt]),
            # any word other than the two (Ron's A8 mutant added one to the list and no test failed)
            ('create, type x', ['schedule-create', 'x', '0 8 * * *', 'x', 'johnny', prompt]),
            ('create, type Task (case)', ['schedule-create', 'x', '0 8 * * *', 'Task', 'johnny', prompt]),
            ('update, --type x', ['schedule-update', 'r', '--type', 'x']),
            ('create, an invalid name', ['schedule-create', 'Bad_Name', '0 8 * * *', 'task', 'johnny', prompt]),
            ('create, an invalid agent', ['schedule-create', 'x', '0 8 * * *', 'task', '../tom', prompt]),
            ('create, an empty prompt file', ['schedule-create', 'x', '0 8 * * *', 'task', 'johnny', empty]),
            ('create, a missing prompt file', ['schedule-create', 'x', '0 8 * * *', 'task', 'johnny',
                                               os.path.join(inst, 'nincs.txt')]),
            ('create, four positionals', ['schedule-create', 'x', '0 8 * * *', 'task', prompt]),
            ('create, an unknown option', ['schedule-create', 'x', '0 8 * * *', 'task', 'johnny', prompt, '--loud']),
            ('an unknown verb', ['schedule-delete', 'x']),
            ('no arguments', []),
        ]:
            reset()
            rc, out, err = admin(args)
            check('refused, exit 2, nothing sent: ' + name, rc == 2 and not REQS and 'FAIL' in (out + err)
                  or (name == 'no arguments' and rc == 2 and not REQS and 'usage' in out), (rc, out, err, REQS))
        rc, out, err = admin(['--help'])
        check('--help: exit 0, both verbs, "main agent only"', rc == 0 and 'schedule-create <name>' in out
              and 'schedule-update <name>' in out and 'main agent only' in out, out)

        # --- the accident guard (MARVEEN_AGENT_ID) -------------------------------------------------------------
        reset()
        rc, out, err = admin(['schedule-update', 'r', '--enabled', 'false'], ident='tom')
        check('MARVEEN_AGENT_ID=tom on an install whose .env MAIN_AGENT_ID is johnny: exit 2, nothing sent, names johnny',
              rc == 2 and not REQS and 'johnny' in err and 'Nothing was sent' in err, (rc, err, REQS))
        reset()
        rc, out, err = admin(['schedule-update', 'r', '--enabled', 'false'], ident='tom', extra={'MAIN_AGENT_ID': 'tom'})
        check('  ...the environment\'s MAIN_AGENT_ID=tom does not override the .env one', rc == 2 and not REQS,
              (rc, err, REQS))
        reset()
        rc, out, err = admin(['schedule-update', 'r', '--enabled', 'false'], ident='johnny')
        check('MARVEEN_AGENT_ID equal to the main agent: sent', rc == 0 and len(REQS) == 1, (rc, err))
        reset()
        rc, out, err = admin(['schedule-update', 'r', '--enabled', 'false'], ident='')
        check('MARVEEN_AGENT_ID unset/empty (the main agent\'s own session): sent', rc == 0 and len(REQS) == 1, (rc, err))

        # --- the token env gate --------------------------------------------------------------------------------
        reset()
        rc, out, err = admin(['schedule-update', 'r', '--enabled', 'false'], base='http://127.0.0.2:%d' % port)
        check('a non-loopback MARVEEN_API_BASE (127.0.0.2): exit 2, nothing sent', rc == 2 and not REQS
              and 'MARVEEN_API_BASE' in err, (rc, err, REQS))
        rc, out, err = admin(['schedule-update', 'r', '--enabled', 'false'], base='http://127.0.0.1:%d' % free_port())
        check('nothing answering: exit 3', rc == 3 and 'could not be reached' in err, (rc, err))

        # --- exit codes and the helper's own refusal -----------------------------------------------------------
        spec = importlib.util.spec_from_file_location('marveen_api_t', os.path.join(inst, 'scripts', 'lib', 'marveen_api.py'))
        api_mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(api_mod)
        src = open(os.path.join(ROOT, 'scripts', 'lib', 'marveen_admin.py'), encoding='utf-8').read()
        literal = re.findall(r'(?:return|sys\.exit\()\s*([0-9]+)\b', src)
        check('one literal exit code (the load failure), equal to the table\'s usage row',
              literal == [str(api_mod.EXIT['usage'])], literal)
        rc, out, err = admin(['schedule-update', 'r', '--enabled', 'false'], install=bare)
        check('  ...and the load failure itself: no marveen_api.py next to it -> exit 2, "cannot load"',
              rc == 2 and 'cannot load' in err, (rc, err))
        for args in (['schedule-create', 'x', '0 8 * * *', 'task', 'johnny', prompt],
                     ['schedule-update', 'x', '--enabled', 'false']):
            reset()
            r = subprocess.run(['bash', os.path.join(inst, 'scripts', 'marveen-api.sh')] + args, capture_output=True,
                               text=True, env=env, timeout=60, stdin=subprocess.DEVNULL)
            check('marveen-api.sh %s: still refused by the helper, nothing sent' % args[0],
                  r.returncode == 2 and not REQS, (r.returncode, r.stderr[-300:], REQS))
    finally:
        srv.shutdown()
        shutil.rmtree(inst, ignore_errors=True)
        shutil.rmtree(bare, ignore_errors=True)

    print('%d check(s) failed: %s' % (len(FAILS), FAILS) if FAILS else 'all checks passed')
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main())
