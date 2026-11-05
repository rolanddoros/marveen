#!/usr/bin/env python3
"""C2 PR4c: the shared token env gate (scripts/lib/env_gate.py) in jegyzetek.py and the marveen-commands hook.

Both send the dashboard token to MARVEEN_API_BASE. Before PR4c neither checked it, so whoever could set the
environment could send the token to any host. Now both run the shared gate BEFORE the token is read:
  - a reachable stub on 127.0.0.2 (not loopback, not in .env) receives nothing;
  - the same stub is allowed once the install's own .env names it as AGENT_API_ORIGIN;
  - MARVEEN_INSTALL_DIR (the hook's test override for the store) pointing at a root whose .env allows that stub does
    NOT open the gate: the gate's .env comes from the script's own location (Kevin 11741);
  - env_gate.py missing: refused, nothing sent (fail closed).

Everything runs from sandbox copies of the install against stubs on 127.0.0.1 / 127.0.0.2.

Run:  python3 scripts/__tests__/env-gate-callers.test.py
"""
import http.server
import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
FAILS = []
GATE_VARS = ('MARVEEN_API_BASE', 'MARVEEN_TOKEN_FILE', 'MARVEEN_INSTALL_DIR', 'MARVEEN_WEB_PORT', 'WEB_PORT')


def make_stub(host):
    reqs = []

    class Stub(http.server.BaseHTTPRequestHandler):
        def _answer(self, body):
            n = int(self.headers.get('Content-Length', '0'))
            self.rfile.read(n)
            reqs.append({'method': self.command, 'path': self.path, 'auth': self.headers.get('Authorization')})
            out = json.dumps(body).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(out)))
            self.end_headers()
            self.wfile.write(out)

        def do_GET(self):
            self._answer({'commands': [{'command': '/stub'}]} if self.path.startswith('/api/commands') else [])

        def do_POST(self):
            self._answer({'id': 5, 'ok': True})

        def log_message(self, *a):
            pass

    srv = http.server.ThreadingHTTPServer((host, 0), Stub)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, 'http://%s:%d' % (host, srv.server_address[1]), reqs


def check(name, cond, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + (('  -- ' + str(detail)) if detail and not cond else ''))
    if not cond:
        FAILS.append(name)


def make_install(prefix, token='gate-token'):
    inst = tempfile.mkdtemp(prefix=prefix)
    os.makedirs(os.path.join(inst, 'scripts', 'lib'))
    os.makedirs(os.path.join(inst, 'store'))
    shutil.copy(os.path.join(ROOT, 'scripts', 'jegyzetek.py'), os.path.join(inst, 'scripts', 'jegyzetek.py'))
    shutil.copy(os.path.join(ROOT, 'scripts', 'agent-msg.sh'), os.path.join(inst, 'scripts', 'agent-msg.sh'))
    for f in ('marveen_api.py', 'env_gate.py', 'homoglyph.py', 'mixed_script.py'):
        shutil.copy(os.path.join(ROOT, 'scripts', 'lib', f), os.path.join(inst, 'scripts', 'lib', f))
    shutil.copytree(os.path.join(ROOT, 'scripts', 'hooks'), os.path.join(inst, 'scripts', 'hooks'),
                    ignore=shutil.ignore_patterns('__pycache__'))
    with open(os.path.join(inst, 'store', '.dashboard-token'), 'w') as f:
        f.write(token + '\n')
    return inst


def load_gate(inst):
    spec = importlib.util.spec_from_file_location('env_gate_t', os.path.join(inst, 'scripts', 'lib', 'env_gate.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def write_env(inst, text):
    with open(os.path.join(inst, '.env'), 'w') as f:
        f.write(text)


def main():
    local, local_api, local_reqs = make_stub('127.0.0.1')
    other, other_api, other_reqs = make_stub('127.0.0.2')
    inst = make_install('env-gate-callers-')
    fake = make_install('env-gate-callers-fake-', token='fake-root-token')
    write_env(fake, 'AGENT_API_ORIGIN=%s\n' % other_api)  # a root whose .env WOULD allow the stub on 127.0.0.2
    base_env = {k: v for k, v in os.environ.items() if k not in GATE_VARS}

    def reset():
        del local_reqs[:]
        del other_reqs[:]

    # --- jegyzetek.py ------------------------------------------------------------------------------------------
    def jegyzetek(base, token_file=None):
        e = dict(base_env, MARVEEN_API_BASE=base)
        if token_file:
            e['MARVEEN_TOKEN_FILE'] = token_file
        r = subprocess.run([sys.executable, os.path.join(inst, 'scripts', 'jegyzetek.py'), 'lista'],
                           capture_output=True, text=True, env=e, timeout=60, stdin=subprocess.DEVNULL)
        return r.returncode, (r.stdout + r.stderr).strip()

    # --- marveen-commands.py, in-process from the sandbox copy (its GATE_ROOT is the sandbox) --------------------
    def hook(base, install_dir=None):
        saved = {k: os.environ.get(k) for k in GATE_VARS}
        for k in GATE_VARS:
            os.environ.pop(k, None)
        os.environ['MARVEEN_API_BASE'] = base
        if install_dir:
            os.environ['MARVEEN_INSTALL_DIR'] = install_dir
        try:
            spec = importlib.util.spec_from_file_location(
                'marveen_commands_sandbox', os.path.join(inst, 'scripts', 'hooks', 'marveen-commands.py'))
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            return mod.dispatch('/stub', '1', True), mod.command_names()
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

    try:
        # control: loopback works for both
        reset()
        rc, out = jegyzetek(local_api)
        check('jegyzetek, loopback: asked the API with the token', rc == 0 and len(local_reqs) == 1
              and local_reqs[0]['auth'] == 'Bearer gate-token', (rc, out, local_reqs))
        reset()
        (res, err), (names, note) = hook(local_api)
        check('hook, loopback: the menu came from the API (control for the fallback check)', 'stub' in names and
              note is None, (names, note))
        check('hook, loopback: dispatch and the menu reached the API with the token', err is None and
              len(local_reqs) == 2 and all(r['auth'] == 'Bearer gate-token' for r in local_reqs), (err, local_reqs))

        # a reachable non-loopback host: refused before the token is read
        reset()
        rc, out = jegyzetek(other_api)
        check('jegyzetek, 127.0.0.2: FAIL, exit 1, nothing arrives', rc == 1 and 'neither loopback' in out
              and not other_reqs and not local_reqs, (rc, out, other_reqs))
        reset()
        (res, err), (names, note) = hook(other_api)
        check('hook, 127.0.0.2: dispatch refused by the env gate, nothing arrives',
              res is None and err and err.startswith('env-kapu:') and not other_reqs and not local_reqs,
              (res, err, other_reqs))
        check('hook, 127.0.0.2: the menu falls back to the builtin names, not asked',
              note == 'EnvGateRefused' and 'stub' not in names, (names, note))
        check('hook: the refusal names neither token', 'gate-token' not in (err or '') and 'fake-root' not in (err or ''))

        # point 7 (Ron, PR4b): the request reads the base the way the gate did (spaces, trailing slashes)
        reset()
        rc, out = jegyzetek('  %s//  ' % local_api)
        check('jegyzetek, a base with spaces and trailing slashes: sent, to the right path',
              rc == 0 and local_reqs and local_reqs[0]['path'] == '/api/notes', (rc, out, local_reqs))
        reset()
        (res, err), _ = hook('  %s/  ' % local_api)
        check('hook, a base with spaces and a trailing slash: dispatch sent, to the right path',
              err is None and local_reqs and local_reqs[0]['path'] == '/api/commands/dispatch', (err, local_reqs))

        # a base with a path, on loopback
        reset()
        rc, out = jegyzetek(local_api + '/api/notes?x=')
        check('jegyzetek, a path in the base: refused, nothing arrives', rc == 1 and not local_reqs, (rc, out))

        # the token file name rule (jegyzetek reads MARVEEN_TOKEN_FILE)
        tmp = tempfile.mkdtemp(prefix='env-gate-callers-tok-')
        wrong = os.path.join(tmp, 'notes.txt')
        with open(wrong, 'w') as f:
            f.write('first line of another file\n')
        reset()
        rc, out = jegyzetek(local_api, token_file=wrong)
        check('jegyzetek, a token file not named .dashboard-token: refused, nothing arrives',
              rc == 1 and '.dashboard-token' in out and not local_reqs, (rc, out))
        shutil.rmtree(tmp, ignore_errors=True)

        # MARVEEN_INSTALL_DIR names a root whose .env allows 127.0.0.2: the hook's gate still uses its own .env
        reset()
        (res, err), _ = hook(other_api, install_dir=fake)
        check('hook, MARVEEN_INSTALL_DIR with a permissive .env does not open the gate',
              res is None and err and err.startswith('env-kapu:') and not other_reqs, (res, err, other_reqs))

        # the install's own .env origin opens exactly that origin
        write_env(inst, 'AGENT_API_ORIGIN=%s/\n' % other_api)
        reset()
        rc, out = jegyzetek(other_api)
        check('jegyzetek, the .env origin: sent there', rc == 0 and len(other_reqs) == 1 and not local_reqs,
              (rc, out, other_reqs))
        reset()
        (res, err), _ = hook(other_api)
        check('hook, the .env origin: dispatch sent there', err is None and other_reqs
              and other_reqs[0]['path'] == '/api/commands/dispatch', (err, other_reqs))
        os.remove(os.path.join(inst, '.env'))

        # C2 PR4d: a malformed base is a clean refusal in every caller (it raised ValueError before, Ron 11828), and a
        # base with user:password@ is refused (not an origin) without ever printing the secret part (Kevin 11853).
        def helper(base):
            r = subprocess.run([sys.executable, os.path.join(inst, 'scripts', 'lib', 'marveen_api.py'), 'kanban-list'],
                               capture_output=True, text=True, env=dict(base_env, MARVEEN_API_BASE=base), timeout=60,
                               stdin=subprocess.DEVNULL)
            return r.returncode, r.stdout + r.stderr

        def agent_msg(base):
            r = subprocess.run(['bash', os.path.join(inst, 'scripts', 'agent-msg.sh'), 'dani', 'samu', 'szia'],
                               capture_output=True, text=True, env=dict(base_env, MARVEEN_API_BASE=base), timeout=60,
                               stdin=subprocess.DEVNULL)
            return r.returncode, r.stdout + r.stderr

        port = local_api.rsplit(':', 1)[1]
        secret = 's3cr3t-pw'
        for label, base, secret_part in [
            ('an unclosed IPv6 bracket', 'http://[', None),
            ('a non-numeric port', 'http://127.0.0.1:abc', None),
            ('user:password@ on loopback', 'http://dani:%s@127.0.0.1:%s' % (secret, port), secret),
            ('user@ only', 'http://%s@127.0.0.1:%s' % (secret, port), secret),
            ('a password with an unencoded slash', 'http://dani:%s/x@127.0.0.1:%s' % (secret, port), secret),
            ('user:password@ on a non-http scheme', 'ftp://dani:%s@127.0.0.1' % secret, secret),
        ]:
            outs = []
            reset()
            rc, out = helper(base)
            outs.append(out)
            check('helper, %s: exit 2, refused, nothing arrives' % label,
                  rc == 2 and 'nothing was sent' in out and 'Traceback' not in out and not local_reqs, (rc, out))
            reset()
            rc, out = agent_msg(base)
            outs.append(out)
            check('agent-msg.sh, %s: exit 2, refused, nothing arrives' % label,
                  rc == 2 and 'nothing was sent' in out and 'Traceback' not in out and not local_reqs, (rc, out))
            reset()
            rc, out = jegyzetek(base)
            outs.append(out)
            check('jegyzetek, %s: exit 1, refused, nothing arrives' % label,
                  rc == 1 and 'nothing was sent' in out and 'Traceback' not in out and not local_reqs, (rc, out))
            reset()
            try:
                (res, err), (names, note) = hook(base)
            except Exception as e:  # the hook must refuse, not raise
                res, err, note = None, 'RAISED %r' % e, None
            outs.append(err or '')
            check('hook, %s: dispatch refused by the env gate (no exception), menu not asked' % label,
                  res is None and err and err.startswith('env-kapu:') and note == 'EnvGateRefused'
                  and not local_reqs, (res, err, note))
            if secret_part:
                check('  ...%s: the secret part is in no output of the four callers' % label,
                      all(secret_part not in o for o in outs), [o for o in outs if secret_part in o])
        # the mask keeps the rest readable: the host is still named
        rc, out = jegyzetek('http://dani:%s@127.0.0.1:%s' % (secret, port))
        check('the refusal names the base with the userinfo masked', '***@127.0.0.1' in out and secret not in out, out)

        # --- Ron 11828 pins (the code was right; nothing held it) ------------------------------------------------
        # K3: the hook's third token path, run_stop (turn-ended), runs the gate too.
        hold = os.path.join(inst, 'store', 'main-model-hold.json')
        with open(hold, 'w') as f:
            json.dump({'until': 1}, f)  # an expired /model hold: run_stop notifies the dashboard
        sd = tempfile.mkdtemp(prefix='env-gate-callers-sd-')

        def stop(base):
            saved = {k: os.environ.get(k) for k in GATE_VARS + ('TELEGRAM_STATE_DIR',)}
            for k in GATE_VARS:
                os.environ.pop(k, None)
            os.environ.update(MARVEEN_API_BASE=base, TELEGRAM_STATE_DIR=sd)
            saved_stdin = sys.stdin
            try:
                spec = importlib.util.spec_from_file_location(
                    'marveen_commands_stop', os.path.join(inst, 'scripts', 'hooks', 'marveen-commands.py'))
                mod = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(mod)
                mod.is_main_session = lambda payload: True
                sys.stdin = io.StringIO('{}')
                try:
                    mod.run_stop()
                except SystemExit:
                    pass
            finally:
                sys.stdin = saved_stdin
                for k, v in saved.items():
                    if v is None:
                        os.environ.pop(k, None)
                    else:
                        os.environ[k] = v
        reset()
        stop(local_api)
        check('K3 control: run_stop on loopback posts turn-ended with the token', [r['path'] for r in local_reqs] ==
              ['/api/commands/turn-ended'] and local_reqs[0]['auth'] == 'Bearer gate-token', local_reqs)
        reset()
        stop(other_api)
        check('K3: run_stop with a base off loopback: refused, nothing arrives', not other_reqs and not local_reqs,
              other_reqs)
        os.remove(hold)
        shutil.rmtree(sd, ignore_errors=True)

        # M3/M4/J3: MARVEEN_INSTALL_DIR names a root whose .env allows 127.0.0.2 AND whose env_gate.py allows
        # everything. The helper, agent-msg.sh and jegyzetek take their root and their gate module from their own
        # file, so both are ignored.
        with open(os.path.join(fake, 'scripts', 'lib', 'env_gate.py'), 'w') as f:
            f.write('def check_env(root, environ=None):\n    return None\n\n\n'
                    'def normalise_base(raw):\n    return raw.strip().rstrip("/")\n\n\n'
                    'def env_file_values(root, *keys):\n    return {}\n')
        for label, run_it, code in [
            ('helper', lambda: subprocess.run(
                [sys.executable, os.path.join(inst, 'scripts', 'lib', 'marveen_api.py'), 'kanban-list'],
                capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL,
                env=dict(base_env, MARVEEN_API_BASE=other_api, MARVEEN_INSTALL_DIR=fake)), 2),
            ('agent-msg.sh', lambda: subprocess.run(
                ['bash', os.path.join(inst, 'scripts', 'agent-msg.sh'), 'dani', 'samu', 'szia'],
                capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL,
                env=dict(base_env, MARVEEN_API_BASE=other_api, MARVEEN_INSTALL_DIR=fake)), 2),
            ('jegyzetek', lambda: subprocess.run(
                [sys.executable, os.path.join(inst, 'scripts', 'jegyzetek.py'), 'lista'],
                capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL,
                env=dict(base_env, MARVEEN_API_BASE=other_api, MARVEEN_INSTALL_DIR=fake)), 1),
        ]:
            reset()
            r = run_it()
            check('M3/M4/J3 %s: a MARVEEN_INSTALL_DIR with a permissive .env and gate module opens nothing' % label,
                  r.returncode == code and 'neither loopback' in (r.stdout + r.stderr) and not other_reqs,
                  (r.returncode, (r.stdout + r.stderr)[-300:], other_reqs))

        # J2: jegyzetek runs the gate BEFORE it opens the token file. The token file is a FIFO with no writer: opened
        # first, the run would hang until the timeout; gated first, it is refused at once (Ron's PR4b method).
        fifo_dir = tempfile.mkdtemp(prefix='env-gate-callers-fifo-')
        fifo = os.path.join(fifo_dir, '.dashboard-token')
        os.mkfifo(fifo)
        reset()
        try:
            r = subprocess.run([sys.executable, os.path.join(inst, 'scripts', 'jegyzetek.py'), 'lista'],
                               capture_output=True, text=True, timeout=15, stdin=subprocess.DEVNULL,
                               env=dict(base_env, MARVEEN_API_BASE=other_api, MARVEEN_TOKEN_FILE=fifo))
            check('J2: jegyzetek refuses before it opens the token file (a writerless FIFO does not hang it)',
                  r.returncode == 1 and 'neither loopback' in (r.stdout + r.stderr) and not other_reqs,
                  (r.returncode, r.stdout + r.stderr))
        except subprocess.TimeoutExpired:
            check('J2: jegyzetek refuses before it opens the token file (a writerless FIFO does not hang it)', False,
                  'hung on the FIFO: the token file was opened before the gate')
            fd = os.open(fifo, os.O_WRONLY | os.O_NONBLOCK)  # release a reader stuck on it
            os.close(fd)
        shutil.rmtree(fifo_dir, ignore_errors=True)

        # H4: a .env origin is http(s) too: the same host under another scheme in AGENT_API_ORIGIN opens nothing.
        gate = load_gate(inst)
        with open(os.path.join(inst, '.env'), 'w') as f:
            f.write('AGENT_API_ORIGIN=ftp://127.0.0.2:%s\n' % port)
        refusal = gate.check_env(inst, {'MARVEEN_API_BASE': 'ftp://127.0.0.2:%s' % port})
        control = gate.check_env(inst, {'MARVEEN_API_BASE': 'http://127.0.0.2:%s' % port})
        check('H4: a non-http(s) .env origin is refused, by the scheme rule', refusal is not None
              and 'http:// or https://' in refusal, refusal)
        check('  ...control: the same host over http is not that .env origin either', control is not None
              and 'neither loopback' in control, control)
        os.remove(os.path.join(inst, '.env'))

        # S1: scripts/skill.ts talks to the skill registry through its OWN variable; MARVEEN_API_BASE (where the
        # dashboard token goes) is not read there (docs/config-reference.md states it).
        skill_src = open(os.path.join(ROOT, 'scripts', 'skill.ts'), encoding='utf-8').read()
        check('S1: skill.ts reads SKILL_REGISTRY_BASE and never MARVEEN_API_BASE',
              'process.env.SKILL_REGISTRY_BASE' in skill_src and not re.search(
                  r"""(?:process\.)?env(?:\.|\[\s*['"])MARVEEN_API_BASE""", skill_src))

        # env_gate.py missing: fail closed, even on loopback
        os.rename(os.path.join(inst, 'scripts', 'lib', 'env_gate.py'), os.path.join(inst, 'scripts', 'lib', 'gone.py'))
        reset()
        rc, out = jegyzetek(local_api)
        check('jegyzetek, env_gate.py missing: refused, nothing arrives', rc == 1 and 'cannot be loaded' in out
              and not local_reqs, (rc, out, local_reqs))
        reset()
        (res, err), (names, note) = hook(local_api)
        check('hook, env_gate.py missing: refused, nothing arrives', res is None and err and 'cannot be loaded' in err
              and not local_reqs, (res, err, local_reqs))
        # M2 (Ron 11828): the helper's own "missing module = refuse" branch, and agent-msg.sh through it
        reset()
        for label, (rc, out) in (('helper', helper(local_api)), ('agent-msg.sh', agent_msg(local_api))):
            check('M2 %s, env_gate.py missing: exit 2, "cannot be loaded", no traceback, nothing arrives' % label,
                  rc == 2 and 'cannot be loaded' in out and 'Traceback' not in out and not local_reqs, (rc, out))
    finally:
        local.shutdown()
        other.shutdown()
        shutil.rmtree(inst, ignore_errors=True)
        shutil.rmtree(fake, ignore_errors=True)

    print('%d check(s) failed: %s' % (len(FAILS), FAILS) if FAILS else 'all checks passed')
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main())
