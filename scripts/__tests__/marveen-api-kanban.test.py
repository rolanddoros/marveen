#!/usr/bin/env python3
"""marveen-api.sh kanban verbs, and the main agent's and the federation block's recipes on the helper.

The CLAUDE.md template and the federation onboarding block told every agent to call the dashboard
with `curl ... -H "Authorization: Bearer $(cat store/.dashboard-token)"`: the token sat on curl's
argv, which `ps` shows to every local user. scripts/marveen-api.sh already reads the token itself
(#2232, #2236, #2338); it had no kanban verbs, so the kanban recipes could not move to it. This
suite pins the kanban verbs (what each sends, and that a bad call sends nothing), and that the two
recipe sources name only the helper. The one curl recipe with a token header left in the template is
the schedule creation: the helper deliberately has no schedule verb (P13), so it cannot become a way
around the self-pace gate. P14-P16 read the recipe source text; they do not measure a runtime argv.

The message verb used to be a named exception (marveen-api.sh handed it to scripts/agent-msg.sh, and the recipes
said it put the token on curl's argv). Since C2 PR4 it is a python verb like the others, and P18 pins that no recipe
names that exception any more.

The helper runs against a local stub API on 127.0.0.1 (MARVEEN_API_BASE) with a dummy token file
(MARVEEN_TOKEN_FILE), so nothing reaches a real dashboard.

Run:  python3 scripts/__tests__/marveen-api-kanban.test.py
"""
import http.server
import json
import os
import re
import subprocess
import sys
import tempfile
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
HELPER = os.path.join(ROOT, 'scripts', 'marveen-api.sh')
API_PY = os.path.join(ROOT, 'scripts', 'lib', 'marveen_api.py')
TEMPLATE = os.path.join(ROOT, 'templates', 'CLAUDE.md.template')
ONBOARDING = os.path.join(ROOT, 'src', 'web', 'federation', 'onboarding.ts')
TOKEN = 'tok' + 'e' * 40 + '1234'
SEEN = []
REPLY = {'status': 200, 'body': '{"ok":true}', 'queue': []}
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
        # C2 PR2: a verb that sends two requests (kanban-card --full) gets the queued bodies in order
        out = (REPLY['queue'].pop(0) if REPLY['queue'] else REPLY['body']).encode()
        self.send_response(REPLY['status'])
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _any

    def log_message(self, *a):
        return  # the stub stays quiet; the test prints its own lines


SRV = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Stub)
threading.Thread(target=SRV.serve_forever, daemon=True).start()
TMP = tempfile.mkdtemp(prefix='mapi-kanban-')
TOKFILE = os.path.join(TMP, '.dashboard-token')
with open(TOKFILE, 'w') as f:
    f.write(TOKEN + '\n')


def fpath(name, content):
    p = os.path.join(TMP, name)
    with open(p, 'w', encoding='utf-8') as f:
        f.write(content)
    return p


def run(*args, status=200, body='{"ok":true}', queue=(), env_extra=None):
    SEEN.clear()
    REPLY['status'], REPLY['body'], REPLY['queue'] = status, body, list(queue)
    # TZ=UTC0: the compact list prints local times, so the expected strings below are UTC
    env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'MARVEEN_TOKEN_FILE': TOKFILE, 'TZ': 'UTC0',
           'MARVEEN_API_BASE': 'http://127.0.0.1:%d' % SRV.server_address[1], **(env_extra or {})}
    p = subprocess.run(['bash', HELPER, *args], env=env, capture_output=True, text=True, timeout=60)
    return p.returncode, p.stdout, p.stderr, list(SEEN)


def one(seen, method, path, body):
    if len(seen) != 1:
        return False, 'requests=%d' % len(seen)
    s = seen[0]
    auth = s['headers'].get('Authorization')
    good = s['method'] == method and s['path'] == path and s['body'] == body and auth == 'Bearer ' + TOKEN
    return good, '%s %s %r auth_ok=%s' % (s['method'], s['path'], s['body'], auth == 'Bearer ' + TOKEN)


# --- P1-P7: what each kanban verb sends -------------------------------------------------------------
LIST_Q = '?fields=id,status,priority,assignee,updated_at,title'
rc, out, err, seen = run('kanban-list', body='[{"id":"abcd1234","status":"planned","priority":"normal","assignee":"dani","updated_at":0,"title":"t"}]')
g, d = one(seen, 'GET', '/api/kanban' + LIST_Q, None)
ok(rc == 0 and g and out == 'abcd1234\tplanned\tnormal\tdani\t01-01 00:00\tt\n',
   'P1 kanban-list: GET /api/kanban with the six list fields, token header, one compact line per card', 'rc=%d %s out=%r %s' % (rc, d, out, err[:160]))
RAW_BOARD = '[{"id":"abcd1234","status":"done","title":"x\\ty"}]'
rc, out, err, seen = run('kanban-list', '--json', body=RAW_BOARD)
g, d = one(seen, 'GET', '/api/kanban', None)
ok(rc == 0 and g and out == RAW_BOARD + '\n', 'P1a kanban-list --json: the plain GET /api/kanban, the body byte for byte (a done card too)',
   'rc=%d %s out=%r' % (rc, d, out))

# fork A6: the dispatch's first step, one card's three fields (single-card GET, ?fields=)
rc, out, err, seen = run('kanban-card', 'abcd1234', body='{"id":"abcd1234","status":"in_progress"}')
g, d = one(seen, 'GET', '/api/kanban/abcd1234?fields=status,title,description', None)
ok(rc == 0 and g and out == 'status: in_progress\ntitle: \ndescription: (none)\n',
   'P1b kanban-card: GET /api/kanban/<id>?fields=status,title,description, the three fields labelled', 'rc=%d %s out=%r %s' % (rc, d, out, err[:160]))
rc, out, err, seen = run('kanban-card', '../x')
ok(rc == 2 and not seen, 'P1c kanban-card: a card id that leaves the path segment is refused, nothing sent', 'rc=%d n=%d' % (rc, len(seen)))

rc, out, err, seen = run('kanban-create', 'dani', 'high', fpath('title.txt', 'Uj kartya `x` $(nem)\n'))
g, d = one(seen, 'POST', '/api/kanban', {'title': 'Uj kartya `x` $(nem)', 'status': 'planned', 'assignee': 'dani', 'priority': 'high'})
ok(rc == 0 and g, 'P2 kanban-create: title from the file (trimmed), status planned', 'rc=%d %s %s' % (rc, d, err[:160]))

ev = fpath('ev.txt', 'eph j1: 11/11, a "quote" es \\ backslash')
rc, out, err, seen = run('kanban-move', 'abcd1234', 'done', '--expected-status', 'in_progress', '--evidence-file', ev, '--actor', 'dani')
g, d = one(seen, 'POST', '/api/kanban/abcd1234/move', {'status': 'done', 'expected_status': 'in_progress', 'evidence': 'eph j1: 11/11, a "quote" es \\ backslash', 'actor': 'dani'})
ok(rc == 0 and g, 'P3 kanban-move: status, expected_status, evidence from the file, actor', 'rc=%d %s %s' % (rc, d, err[:160]))
rc, out, err, seen = run('kanban-move', 'abcd1234', 'in_progress')
g, d = one(seen, 'POST', '/api/kanban/abcd1234/move', {'status': 'in_progress'})
ok(rc == 0 and g, 'P3b kanban-move: the bare form sends only the status', 'rc=%d %s %s' % (rc, d, err[:160]))

rc, out, err, seen = run('kanban-claim', 'abcd1234', 'dani')
g, d = one(seen, 'POST', '/api/kanban/abcd1234/claim', {'agent': 'dani'})
rc2, out2, err2, seen2 = run('kanban-claim', 'abcd1234', 'dani', '--ttl', '600')
g2, d2 = one(seen2, 'POST', '/api/kanban/abcd1234/claim', {'agent': 'dani', 'ttl_seconds': 600})
ok(rc == 0 and g and rc2 == 0 and g2, 'P4 kanban-claim: agent, and --ttl as an integer ttl_seconds', '%s | %s %s' % (d, d2, (err + err2)[:160]))

rc, out, err, seen = run('kanban-release', 'abcd1234', 'dani')
g, d = one(seen, 'POST', '/api/kanban/abcd1234/release', {'agent': 'dani'})
ok(rc == 0 and g, 'P5 kanban-release: agent', 'rc=%d %s %s' % (rc, d, err[:160]))

rc, out, err, seen = run('kanban-comment', 'abcd1234', 'dani', fpath('c.txt', 'eredmeny `backtick` es $(nem fut)\nmasodik sor\n'))
g, d = one(seen, 'POST', '/api/kanban/abcd1234/comments', {'author': 'dani', 'content': 'eredmeny `backtick` es $(nem fut)\nmasodik sor\n'})
ok(rc == 0 and g, 'P6 kanban-comment: the file content byte for byte, author', 'rc=%d %s %s' % (rc, d, err[:160]))

rc, out, err, seen = run('agents-list', body='[{"name":"dani"}]')
g, d = one(seen, 'GET', '/api/agents', None)
ok(rc == 0 and g and '"dani"' in out, 'P7 agents-list: GET /api/agents', 'rc=%d %s %s' % (rc, d, err[:160]))

# --- P8-P12: the error branches (each with its own token) ---------------------------------------------
rc, out, err, seen = run('kanban-move', 'abcd1234', 'done', '--expected-status', 'in_progress', status=409,
                         body='{"error":"status_conflict","current_status":"testing"}')
ok(rc == 4 and len(seen) == 1 and 'HTTP 409' in err and 'current_status' in err and out == '',
   'P8 409 on move: exit 4 (a conflict, C2 exit-code table), the conflict body on stderr', 'rc=%d n=%d err=%s' % (rc, len(seen), err[:200]))

rc, out, err, seen = run('kanban-claim', 'abcd1234', 'dani', status=404, body='{"ok":false,"reason":"claim_lock_disabled"}')
ok(rc == 1 and len(seen) == 1 and 'claim_lock_disabled' in err, 'P9 claim with the lock off: exit 1, the reason on stderr', 'rc=%d n=%d err=%s' % (rc, len(seen), err[:200]))

bad_ids = ['../schedules', 'a/b', 'abcd1234?x=1', '']
res = [run('kanban-comment', b, 'dani', fpath('c2.txt', 'x')) for b in bad_ids]
ok(all(r[0] == 2 and not r[3] and 'invalid card id' in r[2] for r in res),
   'P10 a card id that could leave /api/kanban/<id>/ (.., /, ?, empty): exit 2, invalid card id, nothing sent',
   ' | '.join('rc=%d n=%d %s' % (r[0], len(r[3]), r[2][:80].replace('\n', ' ')) for r in res))

rc, out, err, seen = run('kanban-comment', 'abcd1234', 'dani', os.path.join(TMP, 'nincs.txt'))
ok(rc == 2 and not seen and 'cannot read' in err, 'P11 a missing content file: exit 2, cannot read, nothing sent', 'rc=%d n=%d %s' % (rc, len(seen), err[:160]))
rc, out, err, seen = run('kanban-comment', 'abcd1234', 'dani', fpath('ures.txt', '  \n'))
ok(rc == 2 and not seen and 'empty' in err, 'P11b an empty comment: exit 2, empty, nothing sent', 'rc=%d n=%d %s' % (rc, len(seen), err[:160]))

checks = [
    (('kanban-move', 'abcd1234', 'Done;rm'), 'invalid status'),
    (('kanban-move', 'abcd1234', 'done', '--expected-status', 'x y'), 'invalid status'),
    (('kanban-claim', 'abcd1234', 'dani', '--ttl', 'abc'), 'invalid ttl'),
    (('kanban-create', 'dani', 'sürgős', fpath('t2.txt', 'x')), 'invalid priority'),
    (('kanban-release', 'abcd1234', 'Dani Kiss'), 'invalid agent name'),
]
res = [(run(*a), tok) for a, tok in checks]
ok(all(r[0] == 2 and not r[3] and tok in r[2] for r, tok in res),
   'P12 a bad status / ttl / priority / agent name: exit 2 with its own token, nothing sent',
   ' | '.join('rc=%d n=%d want=%s got=%s' % (r[0], len(r[3]), tok, r[2][:70].replace('\n', ' ')) for r, tok in res))

# --- P13 INVARIANS: the helper never WRITES a schedule ------------------------------------------------
# VOICETOKENLEAK1101 PR-B (Dani 65425, Samu 65434): the helper may READ the schedule list (schedules-list, GET), and
# never writes one. The self-pace gate cannot see what a helper call sends, so the guard is in the helper: the route
# appears only as the guard's constant and in the one GET verb, and main() asks the guard before it sends anything.
src = open(API_PY, encoding='utf-8').read()
paths = re.findall(r"""f?['"](/api/[^'"]*)['"]""", src)
sched = [p for p in paths if 'schedul' in p]
get_verb = re.search(r"if verb == 'schedules-list':\n(?:.*\n){0,4}?\s+return 'GET', '/api/schedules', None, headers, \{\}", src)
guard_def = re.search(r"SCHEDULE_ROUTE = '/api/schedules'", src)
main_src = src[src.index('def main('):]
guard_call = main_src.find('schedule_write_refused(method, path)')
send_at = main_src.find('urllib.request.Request(')
ok(paths and sched == ['/api/schedules', '/api/schedules'] and get_verb and guard_def and 0 <= guard_call < send_at,
   'P13 INVARIANS: the schedule route only in the guard constant and the one GET verb; the guard runs before the send',
   'sched=%r get_verb=%s guard=%s guard_call=%d send=%d' % (sched, bool(get_verb), bool(guard_def), guard_call, send_at))

# --- P14-P16: the recipe sources name the helper, not a curl token header (source text) --------------
tpl = open(TEMPLATE, encoding='utf-8').read()
argv = [m.start() for m in re.finditer(r'Authorization:\s*Bearer', tpl)]
sched = re.search(r'curl -s -X POST http://localhost:\{\{WEB_PORT\}\}/api/schedules \\\n  -H "Content-Type: application/json" \\\n  -H "Authorization: Bearer \$\(cat store/\.dashboard-token\)" \\\n', tpl)
ok(len(argv) == 1 and sched is not None and sched.start() < argv[0] < sched.end(),
   'P14 template: the only curl token header is the schedule creation recipe',
   'argv=%d at lines %s, schedule recipe found=%s' % (len(argv), [tpl.count('\n', 0, i) + 1 for i in argv], sched is not None))

onb = open(ONBOARDING, encoding='utf-8').read()
hits = [onb.count('\n', 0, m.start()) + 1 for m in re.finditer(r'Authorization:\s*Bearer', onb)]
ok(not hits, 'P15 federation onboarding block: no curl token header', 'lines %s' % hits)

help_rc, help_out, help_err, _ = run('--help')
known = set(re.findall(r'^\s{2}([a-z][a-z-]+)\s', help_out, re.M))
used_tpl = re.findall(r'marveen-api\.sh ([a-z][a-z-]*)', tpl)
# The sub-agent block names the helper through `${helper}`, its absolute path as one shell word (F2).
used_onb = re.findall(r'(?:marveen-api\.sh|\$\{helper\}) ([a-z][a-z-]*)', onb)
unknown = sorted(set(used_tpl + used_onb) - known)
need_tpl = {'memory-save', 'daily-log', 'memory-search', 'kanban-list', 'kanban-create', 'kanban-move',
            'kanban-claim', 'kanban-release', 'kanban-comment', 'message', 'agents-list'}
ok(not unknown and need_tpl <= set(used_tpl) and used_onb.count('message') >= 4,
   'P16 every helper call in the recipes names a verb the helper knows, and each former curl recipe has one',
   'unknown=%s missing_in_template=%s onboarding_message=%d' % (unknown, sorted(need_tpl - set(used_tpl)), used_onb.count('message')))

# --- P17 INVARIANS: a federated recipient passes through the message verb ----------------------------
rc, out, err, seen = run('message', 'dani', 'masik-rendszer/ugynok', fpath('m.txt', 'szia'), body='{"id":7,"status":"pending"}')
ok(rc == 0 and len(seen) >= 1 and seen[-1]['body'] and seen[-1]['body'].get('to') == 'masik-rendszer/ugynok',
   'P17 INVARIANS: message keeps a <system>/<agent> recipient',
   'rc=%d n=%d %s' % (rc, len(seen), (seen[-1]['body'] if seen else None, err[:120])))

# --- P18: no recipe claims an argv exception for the message verb (C2 PR4) -------------
# The recipes used to name an exception: "the message verb (agent-msg.sh) puts the token and the text on curl's argv".
# That stopped being true with #2439 (VOICETOKENLEAK1101 round 3: the token by process substitution, the body on
# stdin), and since C2 PR4 there is no curl at all: the send is urllib inside scripts/lib/marveen_api.py, the token is
# on no argv and in no child's environment (src/__tests__/agent-msg-token-argv.test.ts). So the check is inverted: no
# recipe may name that exception any more, and the template's helper claim stands for message too.
def sentences(s):
    return re.split(r'(?<=[.!?])\s+', re.sub(r'\s+', ' ', s))


def names_exception(s):
    return any('agent-msg.sh' in x and 'argv' in x for x in sentences(s))


CLAIM = re.compile(r'nem kerül a\s+parancssorba|never reaches the\s+command line')
ok(not names_exception(tpl) and CLAIM.search(tpl) is not None,
   'P18a template: the helper keeps the token off the command line, message included; no argv exception is named',
   'exception named=%s claim present=%s' % (names_exception(tpl), CLAIM.search(tpl) is not None))

calls = [m.start() for m in re.finditer(r'(?:marveen-api\.sh|\$\{helper\}) message ', onb)]
named = []
for i in calls:
    fence = onb.find('\\`\\`\\`', i)
    # the window runs to the end of the paragraph after the closing fence (the note under the call)
    after = onb.find('\n\n', fence if fence >= 0 else i)
    end = onb.find('\n\n', after + 2) if after >= 0 else -1
    if names_exception(onb[i:end if end >= 0 else len(onb)]):
        named.append(onb.count('\n', 0, i) + 1)
ok(len(calls) >= 4 and not named and not names_exception(onb),
   'P18b federation onboarding: no message recipe names an agent-msg.sh argv exception',
   'calls=%d exception named at lines %s' % (len(calls), named))

# --- P19-P20: review follow-ups -------------------------------------------------------
# A `$`-anchored pattern with re.match lets a trailing newline through ('abcd1234\n' reached
# http.client as a URL and died in a traceback, exit 1 instead of the usage exit 2).
checks = [
    (('kanban-comment', 'abcd1234\n', 'dani', fpath('c3.txt', 'x')), 'invalid card id'),
    (('kanban-move', 'abcd1234', 'done\n'), 'invalid status'),
    (('kanban-release', 'abcd1234', 'dani\n'), 'invalid agent name'),
]
res = [(run(*a), tok) for a, tok in checks]
ok(all(r[0] == 2 and not r[3] and tok in r[2] for r, tok in res),
   'P19 a trailing newline in a card id / status / agent name: exit 2 with its own token, nothing sent',
   ' | '.join('rc=%d n=%d want=%s got=%s' % (r[0], len(r[3]), tok, r[2][:70].replace('\n', ' ')) for r, tok in res))

rc, out, err, seen = run('kanban-move', 'abcd1234', 'done', '--evidence-file', fpath('ev-ures.txt', ' \n\t\n'))
ok(rc == 2 and not seen and 'evidence is empty' in err, 'P20 kanban-move with a blank evidence file: exit 2, evidence is empty, nothing sent',
   'rc=%d n=%d %s' % (rc, len(seen), err[:160]))

# --- P21-P23: the maintainer's review of #2080 -----------------------------------------------------
# An empty title must never reach the board (nothing pinned it: removing the check stayed green).
res = [run('kanban-create', 'dani', 'high', fpath('t-ures%d.txt' % i, c)) for i, c in enumerate(['', ' \n\t\n'])]
ok(all(r[0] == 2 and not r[3] and 'title is empty' in r[2] for r in res),
   'P21 kanban-create with an empty or blank title file: exit 2, title is empty, nothing sent',
   ' | '.join('rc=%d n=%d %s' % (r[0], len(r[3]), r[2][:80].replace('\n', ' ')) for r in res))

# The board cuts a title above 300 characters (the kanban_cards_title_gate trigger, src/db.ts): the
# helper refuses it up front instead of letting the card land with a different title. Characters,
# not bytes (SQLite length() and Python len() both count code points): 300 accented letters go out.
rc, out, err, seen = run('kanban-create', 'dani', 'high', fpath('t301.txt', 'é' * 301 + '\n'))
rc2, out2, err2, seen2 = run('kanban-create', 'dani', 'high', fpath('t300.txt', 'é' * 300 + '\n'))
g, d = one(seen2, 'POST', '/api/kanban', {'title': 'é' * 300, 'status': 'planned', 'assignee': 'dani', 'priority': 'high'})
ok(rc == 2 and not seen and 'longer than 300 characters' in err and rc2 == 0 and g,
   'P22 kanban-create: a 301-character title exits 2 (longer than 300 characters, nothing sent), 300 goes out',
   'rc301=%d n=%d %s | rc300=%d %s' % (rc, len(seen), err[:120].replace('\n', ' '), rc2, d))

# developer-junior (a strict profile) allows `bash ${PROJECT_ROOT}/scripts/marveen-api.sh:*`, so its agents get the
# kanban write verbs too: the description says so, naming the helper and each write verb.
with open(os.path.join(ROOT, 'templates', 'profiles', 'developer-junior.json'), encoding='utf-8') as f:
    desc = json.load(f).get('description', '')
WRITE_VERBS = ['kanban-create', 'kanban-move', 'kanban-claim', 'kanban-release', 'kanban-comment']
ok('marveen-api.sh' in desc and all(v in desc for v in WRITE_VERBS),
   'P23 developer-junior profile: the description says marveen-api.sh also gives the kanban write verbs',
   'missing: %s' % [v for v in ['marveen-api.sh'] + WRITE_VERBS if v not in desc])

# --- P24-P33: C2 PR2, the compact kanban answers, the list filters, kanban-card --full, kanban-archive -------------
# Each output is pinned as a whole string (TZ=UTC0 in run()): a formatter that drops a field, a line or the
# truncation note fails here by name.
from urllib.parse import urlsplit, parse_qs


def card(i, status='planned', ts=None, title=None, assignee='dani', prio='normal'):
    return {'id': 'c%02d' % i, 'status': status, 'priority': prio, 'assignee': assignee,
            'updated_at': 1700000000 + i * 60 if ts is None else ts, 'title': title or 'card %d' % i}


board = [card(1, ts=1700000000), card(2, 'done', ts=1700000300),
         card(3, 'in_progress', ts=1700000600, title='tab\there\nnew line  and   spaces', assignee=None),
         card(4, 'waiting', ts=1700000120, title='x' * 80, prio='urgent')]
rc, out, err, seen = run('kanban-list', body=json.dumps(board))
want = ('c03\tin_progress\tnormal\t-\t11-14 22:23\ttab here new line and spaces\n'
        'c04\twaiting\turgent\tdani\t11-14 22:15\t' + 'x' * 71 + '\u2026\n'
        'c01\tplanned\tnormal\tdani\t11-14 22:13\tcard 1\n')
ok(rc == 0 and out == want, 'P24 kanban-list: not done, newest change first, one line per card, title on one line and cut at 72, no assignee = -',
   'rc=%d out=%r' % (rc, out))

rc, out, err, seen = run('kanban-list', '--assignee', 'Sára Tüttő', '--status', 'planned,done', body=json.dumps(board))
q = parse_qs(urlsplit(seen[0]['path']).query) if seen else {}
ok(rc == 0 and len(seen) == 1 and urlsplit(seen[0]['path']).path == '/api/kanban'
   and q == {'assignee': ['Sára Tüttő'], 'status': ['planned,done'], 'fields': ['id,status,priority,assignee,updated_at,title']}
   and 'c02\tdone' in out,
   'P25 kanban-list --assignee/--status: the server filters (assignee=, status=), and a done card asked for is shown',
   'rc=%d seen=%r out=%r %s' % (rc, [x['path'] for x in seen], out[:120], err[:120]))

rc, out, err, seen = run('kanban-list', '--mine', body='[]', env_extra={'MARVEEN_AGENT_ID': 'dani'})
q = parse_qs(urlsplit(seen[0]['path']).query) if seen else {}
res = [run('kanban-list', '--mine', env_extra=e) for e in ({}, {'MARVEEN_AGENT_ID': ''}, {'MARVEEN_AGENT_ID': 'Dani X'})]
both = run('kanban-list', '--mine', '--assignee', 'tom', env_extra={'MARVEEN_AGENT_ID': 'dani'})
ok(rc == 0 and q.get('assignee') == ['dani'] and out == '# 0 cards\n'
   and all(r[0] == 2 and not r[3] for r in res) and 'MARVEEN_AGENT_ID is not set' in res[0][2]
   and 'not a valid agent name' in res[2][2] and both[0] == 2 and not both[3],
   'P26 kanban-list --mine: assignee from MARVEEN_AGENT_ID; unset, empty or malformed -> exit 2, nothing sent; '
   'with --assignee -> exit 2; an empty answer says # 0 cards',
   'rc=%d q=%r out=%r | %s | both=%d' % (rc, q, out, ' / '.join('rc=%d n=%d %s' % (r[0], len(r[3]), r[2][:60]) for r in res), both[0]))

many = [card(i, ts=1700000000 + i) for i in range(45)] + [card(99, 'done', ts=1800000000)]
r40 = run('kanban-list', body=json.dumps(many))
r2 = run('kanban-list', '--limit', '2', body=json.dumps(many))
rall = run('kanban-list', '--all', body=json.dumps(many))
rall3 = run('kanban-list', '--all', '--limit', '3', body=json.dumps(many))
bad = [run('kanban-list', *a) for a in (('--limit', '0'), ('--limit', 'x'), ('--limit', '5', '--json'))]
l40, l2, lall, lall3 = (r[1].rstrip('\n').split('\n') for r in (r40, r2, rall, rall3))
ok(len(l40) == 41 and l40[-1] == '# shown 40 of 45 (--limit <n> or --all for more)' and l40[0].startswith('c44\t')
   and l2 == [l40[0], l40[1], '# shown 2 of 45 (--limit <n> or --all for more)']
   and len(lall) == 46 and lall[0].startswith('c99\tdone') and not lall[-1].startswith('#')
   and lall3[-1] == '# shown 3 of 46 (--limit <n> or --all for more)'
   and all(b[0] == 2 and not b[3] for b in bad),
   'P27 kanban-list limit: 40 by default with a "# shown N of M" line, --limit n, --all = done too and no limit, '
   '--all --limit n; --limit 0 / not a number / with --json -> exit 2, nothing sent',
   'n40=%d last=%r n2=%r nall=%d first=%r last3=%r bad=%r' % (len(l40), l40[-1], l2[-1:], len(lall), lall[0][:12], lall3[-1:], [(b[0], len(b[3])) for b in bad]))

CARD = {'id': 'abcd1234', 'status': 'in_progress', 'title': 'Fix\tthe gate',
        'description': 'first line\nstatus: done\n\n  indented\n'}
rc, out, err, seen = run('kanban-card', 'abcd1234', body=json.dumps(CARD))
ok(rc == 0 and out == 'status: in_progress\ntitle: Fix the gate\ndescription:\n  first line\n  status: done\n  \n    indented\n',
   'P28 kanban-card: labelled fields, the description indented two spaces (a "status:" line in it cannot pass for the label)',
   'rc=%d out=%r' % (rc, out))
raw = json.dumps(CARD)
rc, out, err, seen = run('kanban-card', 'abcd1234', '--json', body=raw)
g, d = one(seen, 'GET', '/api/kanban/abcd1234?fields=status,title,description', None)
ok(rc == 0 and g and out == raw + '\n', 'P28b kanban-card --json: the same request, the body byte for byte', 'rc=%d %s out=%r' % (rc, d, out))

FULL = dict(CARD, description=None, test_steps='1. run it', done_evidence=None)
comments = [{'id': i, 'card_id': 'abcd1234', 'author': 'a%d' % i, 'content': 'c%d\nmore' % i, 'created_at': 1700000000 + i * 60}
            for i in range(7)]
rc, out, err, seen = run('kanban-card', 'abcd1234', '--full', queue=[json.dumps(FULL), json.dumps(comments)])
want = ('status: in_progress\ntitle: Fix the gate\ndescription: (none)\ntest_steps:\n  1. run it\ndone_evidence: (none)\n'
        'comments: 7 (the last 5)\n'
        + ''.join('- a%d 11-14 %s:\n  c%d\n  more\n' % (i, ['22:15', '22:16', '22:17', '22:18', '22:19'][i - 2], i) for i in range(2, 7)))
paths = [x['path'] for x in seen]
fj = run('kanban-card', 'abcd1234', '--full', '--json')
ok(rc == 0 and out == want and paths == ['/api/kanban/abcd1234?fields=status,title,description,test_steps,done_evidence',
                                         '/api/kanban/abcd1234/comments'] and fj[0] == 2 and not fj[3],
   'P29 kanban-card --full: test_steps, done_evidence and the last 5 comments (a second GET); --full --json -> exit 2, nothing sent',
   'rc=%d paths=%r out=%r fj=%d' % (rc, paths, out, fj[0]))
rc, out, err, seen = run('kanban-card', 'abcd1234', '--full', status=404, body='{"error":"Kártya nem található"}')
ok(rc == 1 and len(seen) == 1 and 'HTTP 404' in err, 'P29b kanban-card --full on a missing card: exit 1 after the first GET, no second one',
   'rc=%d n=%d %s' % (rc, len(seen), err[:120]))

w = [
    (('kanban-create', 'dani', 'high', fpath('t3.txt', 'Uj')), '{"ok":true,"id":"k9"}', 'OK id=k9\n'),
    (('kanban-comment', 'abcd1234', 'dani', fpath('c3.txt', 'x')),
     '{"id":12,"card_id":"abcd1234","author":"dani","content":"x","created_at":1,"automated":0}', 'OK id=12\n'),
    (('kanban-comment', 'abcd1234', 'dani', fpath('c4.txt', 'x')),
     '{"id":13,"card_id":"abcd1234","author":"dani","content":"x","created_at":1,"archived":true}', 'OK id=13\narchived: true\n'),
    (('kanban-move', 'abcd1234', 'done', '--actor', 'dani'),
     '{"ok":false,"status":"testing","evidence_required":true,"note":"Move it to done again with evidence."}',
     'NOT OK\nstatus: testing\nevidence_required: true\nnote: Move it to done again with evidence.\n'),
    (('kanban-claim', 'abcd1234', 'dani'), '{"id":"abcd1234","ok":true,"renewed":false,"took_over_from":null}',
     'OK\nid: abcd1234\nrenewed: false\ntook_over_from: null\n'),
    (('kanban-assign', 'abcd1234', 'tom'), '{"ok":true}', 'OK\n'),
]
# the held move's exit code is the HELD_WRITE_EXIT constant (P34); every other write exits 0
held_exit = int(re.search(r'^HELD_WRITE_EXIT = (\d+)$', open(API_PY, encoding='utf-8').read(), re.M).group(1))
res = [(run(*a, body=b), want, held_exit if i == 3 else 0) for i, (a, b, want) in enumerate(w)]
held_json = run('kanban-move', 'abcd1234', 'done', '--json', body=w[3][1])
ok(all(r[0] == code and r[1] == want for r, want, code in res) and held_json[0] == 0 and held_json[1] == w[3][1] + '\n',
   'P30 writes: OK (create/comment: OK id=<id>, the comment echo dropped), NOT OK for a held move, every other field on its '
   'own line; --json the body as it came',
   ' | '.join('rc=%d out=%r' % (r[0], r[1]) for r, _, _ in res) + ' | json=%r' % held_json[1])

rc, out, err, seen = run('kanban-archive', 'abcd1234')
g, d = one(seen, 'POST', '/api/kanban/abcd1234/archive', None)
nf = run('kanban-archive', 'abcd1234', status=404, body='{"error":"Kártya nem található"}')
bad = [run('kanban-archive', *a) for a in (('../x',), (), ('a', 'b'))]
ok(rc == 0 and g and out == 'OK\n' and nf[0] == 1 and 'HTTP 404' in nf[2] and all(b[0] == 2 and not b[3] for b in bad),
   'P31 kanban-archive: POST /api/kanban/<id>/archive with no body, OK; 404 -> exit 1; a bad id or argument count -> exit 2, nothing sent',
   'rc=%d %s out=%r nf=%d bad=%r' % (rc, d, out, nf[0], [(b[0], len(b[3])) for b in bad]))

res = [run(*a, status=409, body='{"error":"held","claimed_by":"tom"}') for a in
       (('kanban-claim', 'abcd1234', 'dani'), ('kanban-archive', 'abcd1234'), ('kanban-create', 'dani', 'low', fpath('t4.txt', 'x')))]
ok(all(r[0] == 4 and 'HTTP 409' in r[2] and 'claimed_by' in r[2] for r in res),
   'P32 every kanban write exits 4 on HTTP 409, the body on stderr', ' | '.join('rc=%d %s' % (r[0], r[2][:60]) for r in res))

lst = run('kanban-list', body='not json')
crd = run('kanban-card', 'abcd1234', body='[1]')
wr = run('kanban-assign', 'abcd1234', 'tom', body='not json')
ok(lst[0] == 1 and 'could not be read' in lst[2] and lst[1] == '' and crd[0] == 1 and 'not an object' in crd[2]
   and wr[0] == 0 and wr[1] == 'OK\n' and 'WARN' in wr[2] and len(wr[3]) == 1,
   'P33 an answer the compact form cannot read: a read fails (exit 1, --json named); a done write says OK and warns (no retry)',
   'list=%d %r card=%d %r write=%d %r %r' % (lst[0], lst[2][:80], crd[0], crd[2][:60], wr[0], wr[1], wr[2][:60]))

# P34: the held write's exit code is one constant (Kevin 11746: open between 7 and 1, 0 until decided). The test reads it
# from the source, so switching the constant is the one-line change, and a held write that ignores it fails here.
held = run('kanban-move', 'abcd1234', 'done', body='{"ok":false,"status":"testing","evidence_required":true}')
fine = run('kanban-move', 'abcd1234', 'done', body='{"ok":true}')
ok(held[0] == held_exit and held[1].startswith('NOT OK\n') and fine[0] == 0 and fine[1] == 'OK\n',
   'P34 a held write (2xx, ok:false) exits HELD_WRITE_EXIT (%d now) and prints NOT OK; an applied write exits 0' % held_exit,
   'held=%d %r fine=%d %r' % (held[0], held[1][:20], fine[0], fine[1]))

SRV.shutdown()
print('FAIL: %d' % len(FAILS) if FAILS else 'OK')
sys.exit(1 if FAILS else 0)
