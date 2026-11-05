#!/usr/bin/env python3
"""marveen-api.sh: the identity argument defaults to $MARVEEN_AGENT_ID (C2 PR6).

The launcher exports the agent's canonical name into every session it starts (src/web/agent-id-env.ts).
memory-save <agent>, memory-move / memory-update <updated-by> and message <from> may then be left out.
Pinned here, against a local stub API (nothing reaches a real dashboard):
  - left out + variable set   -> the variable goes into the body and X-Agent-Id (message: "from")
  - explicit argument          -> it wins over the variable
  - left out + no variable     -> exit 2, nothing sent (exactly today's behaviour)
  - invalid variable value     -> exit 2, nothing sent, the error names the variable
It is attribution only, not a security boundary: the value is self-asserted.

Run:  python3 scripts/__tests__/marveen-api-identity.test.py
"""
import http.server
import json
import os
import subprocess
import sys
import tempfile
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
HELPER = os.path.join(ROOT, 'scripts', 'marveen-api.sh')
TOKEN = 'tok' + 'e' * 40 + '5678'
SEEN = []
REPLY = {'status': 200, 'body': '{"ok":true}'}
FAILS = []


def ok(cond, name, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + ('' if cond else '  -- ' + detail))
    if not cond:
        FAILS.append(name)


class Stub(http.server.BaseHTTPRequestHandler):
    def _any(self):
        n = int(self.headers.get('Content-Length', '0') or 0)
        raw = self.rfile.read(n) if n else b''
        SEEN.append({'method': self.command, 'path': self.path, 'headers': dict(self.headers),
                     'body': json.loads(raw) if raw else None})
        out = REPLY['body'].encode()
        self.send_response(REPLY['status'])
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _any

    def log_message(self, *a):
        return


SRV = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Stub)
threading.Thread(target=SRV.serve_forever, daemon=True).start()
TMP = tempfile.mkdtemp(prefix='mapi-identity-')
TOKFILE = os.path.join(TMP, '.dashboard-token')
with open(TOKFILE, 'w') as f:
    f.write(TOKEN + '\n')
CONTENT = os.path.join(TMP, 'content.txt')


def run(*args, ident=None, body='{"ok":true}'):
    with open(CONTENT, 'w', encoding='utf-8') as f:
        f.write('hello\n')
    SEEN.clear()
    REPLY['body'] = body
    env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'MARVEEN_TOKEN_FILE': TOKFILE,
           'MARVEEN_API_BASE': 'http://127.0.0.1:%d' % SRV.server_address[1], 'HOME': TMP}
    if ident is not None:
        env['MARVEEN_AGENT_ID'] = ident
    p = subprocess.run(['bash', HELPER, *args], env=env, capture_output=True, text=True, timeout=60)
    return p.returncode, p.stdout, p.stderr, list(SEEN)


def sent(seen):
    if len(seen) != 1:
        return None, None
    return seen[0]['body'], seen[0]['headers'].get('X-Agent-Id')


# --- memory-save <agent> ---------------------------------------------------------------------------
rc, _, err, seen = run('memory-save', 'warm', 'kw', CONTENT, ident='tom')
b, h = sent(seen)
ok(rc == 0 and b and b.get('agent_id') == 'tom' and h == 'tom',
   'I1 memory-save without <agent>: agent_id and X-Agent-Id from MARVEEN_AGENT_ID', 'rc=%d %r %r %s' % (rc, b, h, err[:200]))
rc, _, err, seen = run('memory-save', 'dani', 'warm', 'kw', CONTENT, ident='tom')
b, h = sent(seen)
ok(rc == 0 and b and b.get('agent_id') == 'dani' and h == 'dani',
   'I2 memory-save with an explicit <agent>: the argument wins', 'rc=%d %r %r %s' % (rc, b, h, err[:200]))
rc, _, err, seen = run('memory-save', 'warm', 'kw', CONTENT)
ok(rc == 2 and not seen and 'expected 4 argument(s), got 3' in err,
   'I3 memory-save without <agent> and without the variable: exit 2, nothing sent (as before)', 'rc=%d n=%d %s' % (rc, len(seen), err[:200]))

# --- memory-move <updated-by> ----------------------------------------------------------------------
rc, _, err, seen = run('memory-move', '5', 'cold', ident='tom')
b, h = sent(seen)
ok(rc == 0 and b == {'category': 'cold', 'updated_by': 'tom'} and h == 'tom' and seen[0]['path'] == '/api/memories/5',
   'I4 memory-move without <updated-by>: updated_by and X-Agent-Id from MARVEEN_AGENT_ID', 'rc=%d %r %r %s' % (rc, b, h, err[:200]))
rc, _, err, seen = run('memory-move', '5', 'cold', 'dani', ident='tom')
b, h = sent(seen)
ok(rc == 0 and b and b.get('updated_by') == 'dani' and h == 'dani',
   'I5 memory-move with an explicit <updated-by>: the argument wins', 'rc=%d %r %r' % (rc, b, h))
rc, _, err, seen = run('memory-move', '5', 'cold')
ok(rc == 2 and not seen, 'I6 memory-move without <updated-by> and without the variable: exit 2, nothing sent',
   'rc=%d n=%d %s' % (rc, len(seen), err[:200]))

# --- memory-update <updated-by> --------------------------------------------------------------------
rc, _, err, seen = run('memory-update', '5', CONTENT, ident='tom')
b, h = sent(seen)
ok(rc == 0 and b == {'content': 'hello\n', 'updated_by': 'tom'} and h == 'tom' and seen[0]['method'] == 'PUT',
   'I7 memory-update without <updated-by>: updated_by and X-Agent-Id from MARVEEN_AGENT_ID', 'rc=%d %r %r %s' % (rc, b, h, err[:200]))
rc, _, err, seen = run('memory-update', '5', 'dani', CONTENT, ident='tom')
b, h = sent(seen)
ok(rc == 0 and b and b.get('updated_by') == 'dani' and h == 'dani',
   'I8 memory-update with an explicit <updated-by>: the argument wins', 'rc=%d %r %r' % (rc, b, h))
rc, _, err, seen = run('memory-update', '5', CONTENT)
ok(rc == 2 and not seen, 'I9 memory-update without <updated-by> and without the variable: exit 2, nothing sent',
   'rc=%d n=%d %s' % (rc, len(seen), err[:200]))

# --- an invalid variable is refused, naming its source ---------------------------------------------
rc, _, err, seen = run('memory-move', '5', 'cold', ident="x'; id")
ok(rc == 2 and not seen and 'MARVEEN_AGENT_ID' in err,
   'I10 an invalid MARVEEN_AGENT_ID: exit 2, nothing sent, the error names the variable', 'rc=%d n=%d %s' % (rc, len(seen), err[:200]))

# --- verbs whose arity is full keep ignoring the variable ------------------------------------------
rc, _, err, seen = run('daily-log', 'dani', CONTENT, ident='tom')
b, h = sent(seen)
ok(rc == 0 and b and b.get('agent_id') == 'dani', 'I11 a full-arity call is untouched by the variable', 'rc=%d %r' % (rc, b))

# --- message <from> (marveen-api.sh -> agent-msg.sh) ------------------------------------------------
MSG_OK = '{"id":42,"status":"pending"}'
rc, out, err, seen = run('message', 'dani', CONTENT, ident='tom', body=MSG_OK)
b, _ = sent(seen)
ok(rc == 0 and b and b.get('from') == 'tom' and b.get('to') == 'dani',
   'I12 message without <from>: "from" is MARVEEN_AGENT_ID', 'rc=%d %r %s %s' % (rc, b, out[:120], err[:200]))
rc, out, err, seen = run('message', 'kevin', 'dani', CONTENT, ident='tom', body=MSG_OK)
b, _ = sent(seen)
ok(rc == 0 and b and b.get('from') == 'kevin', 'I13 message with an explicit <from>: the argument wins', 'rc=%d %r' % (rc, b))
rc, out, err, seen = run('message', 'dani', CONTENT, body=MSG_OK)
ok(rc == 2 and not seen, 'I14 message without <from> and without the variable: exit 2, nothing sent (as before)',
   'rc=%d n=%d %s' % (rc, len(seen), err[:200]))
rc, out, err, seen = run('message', 'dani', CONTENT, ident='Bad Name', body=MSG_OK)
ok(rc == 2 and not seen and 'MARVEEN_AGENT_ID' in err, 'I15 message with an invalid MARVEEN_AGENT_ID: exit 2, nothing sent',
   'rc=%d n=%d %s' % (rc, len(seen), err[:200]))

SRV.shutdown()
print('FAIL: %d' % len(FAILS) if FAILS else 'OK')
sys.exit(1 if FAILS else 0)
