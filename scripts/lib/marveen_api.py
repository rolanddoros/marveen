#!/usr/bin/env python3
"""marveen_api.py -- the dashboard-API calls an agent's CLAUDE.md prescribes, without `$(cat token)`.

WHY (#2232): every recipe in a sub-agent's CLAUDE.md was a `curl ... -H "Authorization: Bearer
$(cat <token file>)"` line. A strict-profile agent runs under `defaultMode: dontAsk`, where a
command substitution never matches the allow-list, so each of those calls was auto-denied: the
agent could not save or search memory, write the daily log, verify a system directive, close a
message or ask for an approval. This helper reads the token itself, so the allow-listed command
line carries no substitution, and every payload comes from a FILE, never from shell
interpolation of the agent's text.

The token never appears in an argv: it is read here and sent in a request header by urllib, so
`ps` (which shows other users' argv on this host) cannot see it.

Entry points: scripts/marveen-api.sh (the allow-listed command), which runs this file, and
scripts/agent-msg.sh, a shim that runs `--agent-msg` here with its own argv (C2 PR4: the send logic of
agent-msg.sh lives in send_message below, unchanged in what it checks, prints and logs).

Exit codes: one table for every verb and for agent-msg.sh, EXIT_CODES below (also printed by --help).
"""
import http.client
import importlib.util
import json
import math
import os
import posixpath
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# THE exit codes of the whole helper, every verb and agent-msg.sh alike (C2, Johnny 11641 via Kevin 11642). One table:
# --help prints it, the generated index reads it, and no other place in this file writes a number.
EXIT_CODES = (
    (0, 'ok', 'done'),
    (1, 'server_error', 'the server answered with an error (message: no message id after 3 tries); the body is on stderr'),
    (2, 'usage', 'usage error or no token; nothing was sent'),
    (3, 'unreachable', 'the dashboard could not be reached or did not answer in time; read back before retrying a write'),
    (4, 'conflict', 'already closed or consumed (HTTP 409): not an error, do not retry'),
    (5, 'content_rejected', 'message: the homoglyph gate refused the text; nothing was sent, rewrite the word'),
    (6, 'checker_error', 'message: the homoglyph checker failed; the message was NOT sent, retry is safe'),
)
EXIT = {name: code for code, name, _ in EXIT_CODES}
CATEGORIES = ('hot', 'warm', 'cold', 'shared')
NAME_RE = re.compile(r'^[a-z0-9][a-z0-9-]{0,63}$')
ID_RE = re.compile(r'^[0-9]{1,18}$')
APPROVAL_ID_RE = re.compile(r'^[A-Za-z0-9_-]{1,64}$')
CATEGORY_KEY_RE = re.compile(r'^[a-z][a-z0-9_]{1,63}$')
HASH_RE = re.compile(r'^[A-Za-z0-9:_-]{8,128}$')
# SKILLSPLIT1101: the server's rule (skill-quarantine.ts PROPOSED_FILE_RE) for the file name part.
REF_FILE_RE = re.compile(r'^[a-z0-9][a-z0-9._-]{0,99}\.md$')
# a card id is one path segment: no '/', '.', '?' or '#', so it cannot leave /api/kanban/<id>/
CARD_ID_RE = re.compile(r'^[A-Za-z0-9_-]{1,64}$')
# the status set belongs to the server; this only keeps the value one plain token
STATUS_RE = re.compile(r'^[a-z][a-z_]{1,31}$')
PRIORITIES = ('low', 'normal', 'high', 'urgent')
# a card's assignee: an agent name, or the owner's name as the board holds it ("Szabolcs"); letters (any script),
# digits, space, '.', '-', '_'; a JSON value in the body, never a path or a shell word
ASSIGNEE_RE = re.compile(r'^[^\W_][\w .-]{0,63}$')

USAGE = """usage: bash scripts/marveen-api.sh <verb> [args]
  message [<from>] <to> <content-file> [--as <agent>] [--priority high|normal]
                (sender: --as or <from> (equal if both), else $MARVEEN_AGENT_ID)
  message-close <id> [--result-file <file>] [--report] [--failed]
                (--report = a report or notice nobody waits on: no receipt to the sender; --no-notify is the old name)
                (exit 4: the message was already closed (409) - not an error, do not retry)
  directive-verify <msg-id>
  memory-search <agent> <query> [--category hot|warm|cold|shared] [--strict] [--date <expr>] [--since <day>] [--until <day>] [--limit <n>]
  memory-save <agent> <hot|warm|cold|shared> <keywords> <content-file>
  memory-list <agent> <hot|warm|cold|shared> [--limit <n>]
  memory-move <memory-id> <hot|warm|cold|shared> <updated-by>
  memory-update <memory-id> <updated-by> <content-file>
  daily-log <agent> <content-file>
  taskstate-save <agent> <json-file>
  approval-request <agent> <category-key> <timeout-seconds> <description-file> [--content-hash <h>] [--payload-file <json-file>]
  approval-status <approval-id>
  approval-consume <approval-id> <category-key> <consumer> [--content-hash <h>]
  skill-propose <skill-name> <skill-md-file> [--reason-file <file>] [--ref-file <name.md> ...]
                (each --ref-file goes as references/<its file name>, markdown only)
  kanban-list
  kanban-card <card-id>
  schedules-list
  kanban-create <assignee> <low|normal|high|urgent> <title-file>
  kanban-move <card-id> <status> [--expected-status <s>] [--evidence-file <file>] [--actor <name>]
  kanban-claim <card-id> <agent> [--ttl <seconds>]
  kanban-release <card-id> <agent>
  kanban-comment <card-id> <author> <content-file>
  kanban-assign <card-id> <assignee> [--actor <name>]
  agents-list
A <content-file> is a path, or - for stdin. Write it with your file tool first: never put the text on the command line.
Identity: memory-save <agent>, memory-move/memory-update <updated-by> and message <from> may be left out; they then
default to $MARVEEN_AGENT_ID (set by the launcher). An explicit argument always wins.
Exit codes:
""" + '\n'.join(f'  {code}  {text}' for code, _, text in EXIT_CODES)


class UsageError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    # urllib forwards every request header, Authorization included, to a redirect target on any
    # host. The dashboard never redirects an API call, so a 3xx is answered as a failure instead.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def fail_usage(msg):
    raise UsageError(msg)


ENV_GATE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'env_gate.py')


_ENV_GATE = None


def load_env_gate():
    """scripts/lib/env_gate.py, by its exact path next to this file (C2 PR4c): the one copy of the token env gate.
    Loaded once per process."""
    global _ENV_GATE
    if _ENV_GATE is None:
        spec = importlib.util.spec_from_file_location('marveen_env_gate', ENV_GATE_PATH)
        if spec is None or spec.loader is None:
            raise ImportError(ENV_GATE_PATH)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _ENV_GATE = mod
    return _ENV_GATE


def env_file_values(*keys):
    """The install's own .env values for these keys (an agent's environment cannot change them)."""
    return load_env_gate().env_file_values(BASE, *keys)


def check_env():
    """Refuses an environment that would send the token elsewhere; None when it is fine.

    The rules live in scripts/lib/env_gate.py (shared with jegyzetek.py, marveen-commands.py and the pre-push review
    gate). BASE, the install root, comes from this file's location, never from the environment. If the gate cannot
    be loaded, nothing is sent (fail closed)."""
    try:
        gate = load_env_gate()
    except (OSError, ImportError, SyntaxError) as e:
        return f'the env gate {ENV_GATE_PATH} cannot be loaded ({e.__class__.__name__}); nothing was sent.'
    return gate.check_env(BASE)


def api_base():
    base = os.environ.get('MARVEEN_API_BASE')
    if base:
        return load_env_gate().normalise_base(base)  # the same reading the gate checked
    port = os.environ.get('MARVEEN_WEB_PORT') or os.environ.get('WEB_PORT') or env_file_values('WEB_PORT').get('WEB_PORT')
    return f'http://localhost:{port or 3420}'


def read_token():
    path = os.environ.get('MARVEEN_TOKEN_FILE') or os.path.join(BASE, 'store', '.dashboard-token')
    try:
        with open(path, encoding='utf-8') as f:
            token = f.read().strip()
    except OSError as e:
        print(f'FAIL: no readable token file at {path} ({e.strerror}); nothing was sent.', file=sys.stderr)
        sys.exit(EXIT['usage'])
    if not token:
        print(f'FAIL: the token file at {path} is empty; nothing was sent.', file=sys.stderr)
        sys.exit(EXIT['usage'])
    return token


# VOICETOKENLEAK1101 PR-A1 (Dani 65157/1, Samu 65160): the generated recipes name ONE fixed payload file per kind
# (api-uzenet.txt, api-memoria.txt, ...). Two texts prepared in one round would both send the second. So a file with
# that name is emptied after a successful send, and an empty one stops the call: an old text is never sent again.
PAYLOAD_NAME_RE = re.compile(r'^api-[a-z]+\.txt$')
SENT_PAYLOADS = []


def is_recipe_payload(path):
    return path != '-' and PAYLOAD_NAME_RE.fullmatch(os.path.basename(path)) is not None


def read_text(path):
    if path == '-':
        return sys.stdin.read()
    try:
        with open(path, encoding='utf-8') as f:
            text = f.read()
    except OSError as e:
        fail_usage(f'cannot read {path}: {e.strerror}')
    if is_recipe_payload(path):
        if not text.strip():
            fail_usage(f'{path} is empty: a recipe payload file is emptied after each send, write the new text first')
        SENT_PAYLOADS.append(path)
    return text


def empty_sent_payloads():
    for p in SENT_PAYLOADS:
        try:
            with open(p, 'w', encoding='utf-8'):
                pass
        except OSError as e:
            print(f'WARN: sent, but could not empty {p} ({e.strerror}); empty it before the next use.', file=sys.stderr)


def take_flag(args, flag):
    if flag in args:
        args.remove(flag)
        return True
    return False


def take_opt(args, opt):
    if opt in args:
        i = args.index(opt)
        if i + 1 >= len(args):
            fail_usage(f'{opt} needs a value')
        value = args[i + 1]
        del args[i:i + 2]
        return value
    return None


def check(value, rx, what):
    if not rx.fullmatch(value or ''):
        fail_usage(f'invalid {what}: {value!r}')
    return value


def check_category(value):
    if value not in CATEGORIES:
        fail_usage(f'invalid category: {value!r} (one of {", ".join(CATEGORIES)})')
    return value


# C2 PR6: the launcher exports the agent's canonical name into every session it starts (src/web/agent-id-env.ts).
# ATTRIBUTION ONLY, not a security boundary: the value is self-asserted and the fleet shares one token (C5).
IDENTITY_ENV = 'MARVEEN_AGENT_ID'


def default_identity(args, n, index, verb):
    """Exactly one positional short of n, and MARVEEN_AGENT_ID set: insert it at `index` (the identity slot).
    An explicit argument (n positionals) always wins; without the variable nothing changes, and the count check in
    positional() reports the missing argument exactly as before. An invalid value is refused, naming its source."""
    ident = os.environ.get(IDENTITY_ENV, '')
    if not ident or len(args) != n - 1 or any(a.startswith('--') for a in args):
        return args
    if not NAME_RE.fullmatch(ident):
        fail_usage(f'{verb}: ${IDENTITY_ENV}={ident!r} is not a valid agent name; pass the name explicitly')
    return args[:index] + [ident] + args[index:]


def positional(args, n, verb):
    extra = [a for a in args if a.startswith('--')]
    if extra:
        fail_usage(f'{verb}: unknown option(s): {" ".join(extra)}')
    if len(args) != n:
        fail_usage(f'{verb}: expected {n} argument(s), got {len(args)}')
    return args


SCHEDULE_ROUTE = '/api/schedules'


def schedule_write_refused(method, path):
    """VOICETOKENLEAK1101 PR-B (Dani 65425): the helper never writes a schedule. The self-pace gate reads the COMMAND
    text, and a helper call names no route, so the gate cannot see what a verb sends: this is the one place where the
    path is put together, so the guard sits here, for every verb, before anything is sent. Any method but GET under
    the schedule route (after normalising the path) is refused."""
    # The path the request will really go to (Dani 65495): the final URL's, not the verb's alone. Unquoted, leading
    # slashes collapsed (POSIX normpath keeps a leading //), then normalised.
    sent = urllib.parse.urlsplit(api_base() + path).path
    route = posixpath.normpath('/' + urllib.parse.unquote(sent).lstrip('/'))
    if (route == SCHEDULE_ROUTE or route.startswith(SCHEDULE_ROUTE + '/')) and method.upper() != 'GET':
        return f'{method} {route}: the helper only reads schedules (writes are the main agent\'s); nothing was sent.'
    return None


def build_request(verb, args):
    """(method, path, body or None, extra headers, flags) for one verb. Pure: no IO except reading files."""
    args = list(args)
    headers = {}
    if verb == 'message-close':
        result_file = take_opt(args, '--result-file')
        # --report is the name the index teaches (C2 PR4); --no-notify stays for the callers that use it.
        report = take_flag(args, '--report')
        no_notify = take_flag(args, '--no-notify') or report
        failed = take_flag(args, '--failed')
        (msg_id,) = positional(args, 1, verb)
        check(msg_id, ID_RE, 'message id')
        body = {'status': 'failed' if failed else 'done'}
        if no_notify:
            body['notify'] = False
        if result_file is not None:
            body['result'] = read_text(result_file)
        return 'PUT', f'/api/messages/{msg_id}', body, headers, {'conflict_is_closed': msg_id}
    if verb == 'directive-verify':
        (msg_id,) = positional(args, 1, verb)
        check(msg_id, ID_RE, 'message id')
        return 'GET', f'/api/messages/{msg_id}', None, headers, {}
    if verb == 'memory-search':
        category = take_opt(args, '--category')
        strict = take_flag(args, '--strict')
        date = take_opt(args, '--date')
        since = take_opt(args, '--since')
        until = take_opt(args, '--until')
        limit = take_opt(args, '--limit')
        agent, query = positional(args, 2, verb)
        check(agent, NAME_RE, 'agent name')
        q = {'agent': agent, 'q': query}
        if category is not None:
            q['category'] = check_category(category)
        if strict:
            q['strict'] = '1'
        if date is not None:
            q['date'] = date
        if since is not None:
            q['since'] = since
        if until is not None:
            q['until'] = until
        if limit is not None:
            q['limit'] = check(limit, ID_RE, 'limit')
        return 'GET', '/api/memories?' + urllib.parse.urlencode(q), None, headers, {'search_header': True}
    if verb == 'memory-save':
        args = default_identity(args, 4, 0, verb)
        agent, category, keywords, content_file = positional(args, 4, verb)
        check(agent, NAME_RE, 'agent name')
        body = {'agent_id': agent, 'content': read_text(content_file), 'category': check_category(category), 'keywords': keywords}
        if not body['content'].strip():
            fail_usage('memory-save: the content is empty')
        headers['X-Agent-Id'] = agent
        return 'POST', '/api/memories', body, headers, {}
    if verb == 'memory-list':
        limit = take_opt(args, '--limit')
        agent, category = positional(args, 2, verb)
        check(agent, NAME_RE, 'agent name')
        q = {'agent': agent, 'category': check_category(category), 'limit': check(limit or '40', ID_RE, 'limit')}
        return 'GET', '/api/memories?' + urllib.parse.urlencode(q), None, headers, {}
    if verb == 'memory-move':
        args = default_identity(args, 3, 2, verb)
        mem_id, category, updated_by = positional(args, 3, verb)
        check(mem_id, ID_RE, 'memory id')
        check(updated_by, NAME_RE, 'updated-by name')
        headers['X-Agent-Id'] = updated_by
        # category-only PATCH: no agent_id, which would hand the row to another agent
        return 'PATCH', f'/api/memories/{mem_id}', {'category': check_category(category), 'updated_by': updated_by}, headers, {}
    if verb == 'memory-update':
        args = default_identity(args, 3, 1, verb)
        mem_id, updated_by, content_file = positional(args, 3, verb)
        check(mem_id, ID_RE, 'memory id')
        check(updated_by, NAME_RE, 'updated-by name')
        content = read_text(content_file)
        if not content.strip():
            fail_usage('memory-update: the content is empty')
        headers['X-Agent-Id'] = updated_by
        return 'PUT', f'/api/memories/{mem_id}', {'content': content, 'updated_by': updated_by}, headers, {}
    if verb == 'daily-log':
        agent, content_file = positional(args, 2, verb)
        check(agent, NAME_RE, 'agent name')
        content = read_text(content_file)
        if not content.strip():
            fail_usage('daily-log: the content is empty')
        return 'POST', '/api/daily-log', {'agent_id': agent, 'content': content}, headers, {}
    if verb == 'taskstate-save':
        # #2338: the PreCompact hook's task-state save, the last raw-curl recipe. The record is a
        # JSON object (summary, doneSteps, alreadyDelegated, nextAction, pendingDecision); it is
        # parsed here so a broken file fails loudly before anything is sent.
        agent, json_file = positional(args, 2, verb)
        check(agent, NAME_RE, 'agent name')
        try:
            record = json.loads(read_text(json_file))
        except ValueError as e:
            fail_usage(f'taskstate-save: {json_file} is not valid JSON ({e})')
        if not isinstance(record, dict) or not record:
            fail_usage('taskstate-save: the file must hold a non-empty JSON object')
        headers['X-Agent-Id'] = agent
        return 'POST', f'/api/agent-taskstate/{agent}', record, headers, {}
    if verb == 'approval-request':
        content_hash = take_opt(args, '--content-hash')
        payload_file = take_opt(args, '--payload-file')
        agent, category, timeout, description_file = positional(args, 4, verb)
        check(agent, NAME_RE, 'agent name')
        check(category, CATEGORY_KEY_RE, 'category key')
        check(timeout, ID_RE, 'timeout seconds')
        body = {'agent_id': agent, 'category': category, 'action_description': read_text(description_file), 'timeout_seconds': int(timeout)}
        if content_hash is not None:
            body['content_hash'] = check(content_hash, HASH_RE, 'content hash')
        # APPROVALSLACK1030 (2): the letter itself ({"envelope": {...}}), so the server can recompute the anchor and
        # show the owner what the approval is for; without it the decision stays on the dashboard.
        if payload_file is not None:
            try:
                payload = json.loads(read_text(payload_file))
            except ValueError as e:
                fail_usage(f'approval-request: {payload_file} is not valid JSON ({e})')
            if not isinstance(payload, dict) or not payload:
                fail_usage('approval-request: the payload file must hold a non-empty JSON object')
            body['action_payload'] = json.dumps(payload, ensure_ascii=False)
        return 'POST', '/api/approvals', body, headers, {}
    if verb == 'approval-status':
        (approval_id,) = positional(args, 1, verb)
        check(approval_id, APPROVAL_ID_RE, 'approval id')
        return 'GET', f'/api/approvals/{approval_id}', None, headers, {}
    if verb == 'approval-consume':
        content_hash = take_opt(args, '--content-hash')
        approval_id, category, consumer = positional(args, 3, verb)
        check(approval_id, APPROVAL_ID_RE, 'approval id')
        check(category, CATEGORY_KEY_RE, 'category key')
        check(consumer, NAME_RE, 'consumer name')
        body = {'category': category, 'consumer': consumer}
        if content_hash is not None:
            body['content_hash'] = check(content_hash, HASH_RE, 'content hash')
        return 'POST', f'/api/approvals/{approval_id}/consume', body, headers, {}
    if verb == 'skill-propose':
        reason_file = take_opt(args, '--reason-file')
        # SKILLSPLIT1101: a long skill split into SKILL.md + references/*.md; each file under its own name.
        ref_files = []
        while True:
            ref = take_opt(args, '--ref-file')
            if ref is None:
                break
            ref_files.append(ref)
        name, skill_md_file = positional(args, 2, verb)
        check(name, NAME_RE, 'skill name')
        body = {'name': name, 'skill_md': read_text(skill_md_file)}
        if not body['skill_md'].strip():
            fail_usage('skill-propose: the SKILL.md is empty')
        if reason_file is not None:
            body['reason'] = read_text(reason_file)
        if ref_files:
            files = {}
            for ref in ref_files:
                base = os.path.basename(ref)
                check(base, REF_FILE_RE, 'reference file name (lowercase letters, digits, . _ -, ending in .md)')
                key = f'references/{base}'
                if key in files:
                    fail_usage(f'skill-propose: {base} is given twice')
                files[key] = read_text(ref)
            body['files'] = files
        return 'POST', '/api/skills/propose', body, headers, {}
    if verb == 'kanban-list':
        positional(args, 0, verb)
        return 'GET', '/api/kanban', None, headers, {}
    if verb == 'kanban-card':
        # One card's status, title and description (the kanban dispatch's first step): the single-card GET, so the
        # reader gets three fields, not the whole board through a parser (fork A6, kept on top of VOICETOKENLEAK1101).
        (card,) = positional(args, 1, verb)
        check(card, CARD_ID_RE, 'card id')
        return 'GET', f'/api/kanban/{card}?fields=status,title,description', None, headers, {}
    if verb == 'schedules-list':
        # VOICETOKENLEAK1101 PR-B: the schedule list, read only (the self-pace gate keeps every schedule WRITE to the main
        # agent; schedule_write_refused stops any non-GET under the schedule route before it is sent).
        positional(args, 0, verb)
        return 'GET', '/api/schedules', None, headers, {}
    if verb == 'agents-list':
        positional(args, 0, verb)
        return 'GET', '/api/agents', None, headers, {}
    if verb == 'kanban-create':
        assignee, priority, title_file = positional(args, 3, verb)
        check(assignee, NAME_RE, 'agent name')
        if priority not in PRIORITIES:
            fail_usage(f'invalid priority: {priority!r} (one of {", ".join(PRIORITIES)})')
        title = read_text(title_file).strip()
        if not title:
            fail_usage('kanban-create: the title is empty')
        if len(title) > 300:
            fail_usage('kanban-create: the title is longer than 300 characters (the board would cut it)')
        return 'POST', '/api/kanban', {'title': title, 'status': 'planned', 'assignee': assignee, 'priority': priority}, headers, {}
    if verb == 'kanban-move':
        expected = take_opt(args, '--expected-status')
        evidence_file = take_opt(args, '--evidence-file')
        actor = take_opt(args, '--actor')
        card, status = positional(args, 2, verb)
        check(card, CARD_ID_RE, 'card id')
        body = {'status': check(status, STATUS_RE, 'status')}
        if expected is not None:
            body['expected_status'] = check(expected, STATUS_RE, 'status')
        if evidence_file is not None:
            body['evidence'] = read_text(evidence_file)
            if not body['evidence'].strip():
                fail_usage('kanban-move: the evidence is empty')
        if actor is not None:
            body['actor'] = check(actor, NAME_RE, 'agent name')
        return 'POST', f'/api/kanban/{card}/move', body, headers, {}
    if verb in ('kanban-claim', 'kanban-release'):
        ttl = take_opt(args, '--ttl') if verb == 'kanban-claim' else None
        card, agent = positional(args, 2, verb)
        check(card, CARD_ID_RE, 'card id')
        body = {'agent': check(agent, NAME_RE, 'agent name')}
        if ttl is not None:
            body['ttl_seconds'] = int(check(ttl, ID_RE, 'ttl'))
        return 'POST', f'/api/kanban/{card}/{verb.split("-")[1]}', body, headers, {}
    if verb == 'kanban-assign':
        # VOICETOKENLEAK1101 round 2: the kanban dispatch's hand-back step (PUT /api/kanban/<id> {assignee}).
        actor = take_opt(args, '--actor')
        card, assignee = positional(args, 2, verb)
        check(card, CARD_ID_RE, 'card id')
        body = {'assignee': check(assignee, ASSIGNEE_RE, 'assignee')}
        if actor is not None:
            body['actor'] = check(actor, NAME_RE, 'agent name')
        return 'PUT', f'/api/kanban/{card}', body, headers, {}
    if verb == 'kanban-comment':
        card, author, content_file = positional(args, 3, verb)
        check(card, CARD_ID_RE, 'card id')
        check(author, NAME_RE, 'agent name')
        content = read_text(content_file)
        if not content.strip():
            fail_usage('kanban-comment: the content is empty')
        return 'POST', f'/api/kanban/{card}/comments', {'author': author, 'content': content}, headers, {}
    fail_usage(f'unknown verb: {verb!r}')


# --- message: agent-msg.sh's send, in-process (C2 PR4) -----------------------------------------------------------
#
# WHY: `curl -s ... >/dev/null && echo sent` exits 0 even when the server REJECTED the request (401/400/5xx), so a
# send fails silently and two agents can wait on each other forever. A message counts as sent only when the server
# answered 200/201 AND returned a message id; anything else is tried again, three times in all, and then logged.
# This is scripts/agent-msg.sh's logic, moved here unchanged in what it checks, prints and logs; agent-msg.sh is now
# a shim that runs `--agent-msg` with its own argv, and `marveen-api.sh message` runs the same code.
#
# Output: success -> "OK id=<n> queue=<depth> (~<n> min)"; failure -> "FAIL ..." and a line in
# store/agent-msg-failures.log. The queue fields come from the POST response: a message is accepted at once but
# DELIVERED only into an idle gap in the recipient's pane, measured at 80+ minutes on a busy agent. "queue=" is the
# recipient's pending count including this message; "(~n min)" is the median delivery delay of its recent messages,
# rounded UP to at least one minute and OMITTED when there is no history (unknown is not "instant"). Both are absent
# against a server that does not return them, so the line is then exactly "OK id=<n>".
# A stopped target: "OK id=<n> ... (queued: target not running, delivered when it starts)" -- the row is PENDING, do
# NOT re-send. At MARVEEN_QUEUE_WARN_AT (default 3, 0 = off) or more waiting, a stderr NOTICE says so at the moment
# the sender decides whether to send the next one. --priority high: a sender over its hourly high budget toward that
# recipient gets the row accepted as normal (never dropped), and a stderr NOTICE says DOWNGRADED.
#
# LOG FORMAT, store/agent-msg-failures.log (tab-separated, one line per failure; parse by the `key=` names):
#   <YYYY-MM-DD HH:MM:SS>  FAIL  from=<a>  to=<b>  url=<endpoint>  http=<code>  resp=<first 200 bytes>
# http= is the status, 000 when nothing answered, and `timeout` when the request went out and no answer came in
# 30 s: that one is not tried again (the row may exist), "read back before re-sending".
#
# Homoglyph gate (MSGGATE924), on the RAW text before the payload is built: json.dumps would escape a Cyrillic letter
# into \uXXXX, where it is no longer visible as a letter. The checker is a verdict, not a filter: what goes out is the
# text the sender typed, never the checker's stdout (a checker that exits 0 with empty stdout once made the old
# helper send an empty message). 3 is the checker's one refusal code; anything else is the CHECKER failing. A missing
# checker is fail-open and loud (WARN ... UNCHECKED): this is the fleet's mandated message route.
#
# The token is read here and sent in a header by urllib: it is on no argv and in no child's environment, and the
# homoglyph checker child gets the text on stdin and the token nowhere.
#
# ENV GATE (C2 PR4b, Johnny 11641): agent-msg.sh, run directly (`--agent-msg`), applies check_env() like every verb,
# right after its argv and before the text or the token is read. A MARVEEN_API_BASE that is neither loopback nor this
# install's own AGENT_API_ORIGIN / DASHBOARD_PUBLIC_URL (.env), or a token file not named .dashboard-token, exits 2
# and the token is never read, let alone sent. A copy run outside this repo (measured 2026-09-13: a remote agent
# did) reads ITS OWN .env next to its scripts/ directory: that is where its dashboard origin is allowed.

MESSAGE_TRIES = 3
MESSAGE_TIMEOUT_S = 30
MESSAGE_PRIORITIES = ('high', 'normal')
QUEUE_WARN_DEFAULT = 3
MESSAGE_FAIL_LOG = os.path.join(BASE, 'store', 'agent-msg-failures.log')


def parse_agent_msg_argv(argv):
    """agent-msg.sh's own argv: [--priority high|normal] <from> <to> <content|->. (priority, from, to, content) or an
    error line. The switch may stand only before <from>, with one of the two words (card ad771121: an empty value went
    out as normal, a switch after the content was dropped, one after the sender took the recipient's place)."""
    args = list(argv)
    priority, given = '', False
    if args and args[0] == '--priority':
        given, priority = True, (args[1] if len(args) >= 2 else '')
        args = args[2:] if len(args) >= 2 else args[1:]
    elif args and args[0].startswith('--priority='):
        given, priority = True, args[0][len('--priority='):]
        args = args[1:]
    if given and priority not in MESSAGE_PRIORITIES:
        return None, 'FAIL: --priority must be high or normal (absent = normal)'
    if any(a == '--priority' or a.startswith('--priority=') for a in args):
        return None, ('FAIL: --priority goes before <from>: agent-msg.sh [--priority high|normal] <from> <to> '
                      '<content>; nothing was sent')
    for i, what in enumerate(('from', 'to', 'content (or - for STDIN)')):
        if len(args) <= i or args[i] == '':
            return None, f'FAIL: {what} required'
    return (priority, args[0], args[1], args[2]), None


def strip_trailing_newlines(text):
    # The shell's $(cat) dropped every trailing newline of the text; the payload stays the same.
    return text.rstrip('\n')


def homoglyph_gate(text):
    """None when the text may go, else the EXIT key that stops it."""
    checker = os.environ.get('MARVEEN_HOMOGLYPH_BIN') or os.path.join(BASE, 'scripts', 'lib', 'homoglyph.py')
    python = shutil.which('python3')
    if not (os.access(checker, os.R_OK) and os.path.isfile(checker)) or python is None:
        print(f'WARN: homoglyph checker not found at {checker} -- sending UNCHECKED.', file=sys.stderr)
        return None
    sys.stderr.flush()
    rc = subprocess.run([python, checker], input=text.encode('utf-8'), stdout=subprocess.DEVNULL).returncode
    if rc == 0:
        return None
    if rc == 3:
        print('FAIL: homoglyph gate refused the message; nothing was sent.', file=sys.stderr)
        return 'content_rejected'
    print(f'FAIL: homoglyph checker CRASHED (rc={rc}) at {checker}; nothing was sent.', file=sys.stderr)
    print('  This is not a verdict on the text -- fix or unset MARVEEN_HOMOGLYPH_BIN.', file=sys.stderr)
    return 'checker_error'


def post_message(url, token, body):
    """(http code as text, body text, timed_out). '000' when nothing answered, as curl's %{http_code} said."""
    req = urllib.request.Request(url, data=body, method='POST')
    req.add_header('Content-Type', 'application/json')
    req.add_header('Authorization', f'Bearer {token}')
    try:
        with OPENER.open(req, timeout=MESSAGE_TIMEOUT_S) as resp:
            return str(resp.status), resp.read().decode('utf-8', 'replace'), False
    except urllib.error.HTTPError as e:
        return str(e.code), e.read().decode('utf-8', 'replace'), False
    except (urllib.error.URLError, OSError) as e:
        if isinstance(e, TimeoutError) or isinstance(getattr(e, 'reason', None), TimeoutError):
            return 'timeout', '', True
        return '000', '', False
    except (http.client.HTTPException, ValueError):
        return '000', '', False


def message_answer(text):
    """(id, depth, minutes, queued, warning) from the POST answer, '' where a field is absent or not usable."""
    try:
        d = json.loads(text)
        if not isinstance(d, dict):
            d = {}
    except ValueError:
        d = {}
    q = d.get('queue') if isinstance(d.get('queue'), dict) else {}
    depth, delay = q.get('queueDepth'), q.get('estimatedDelaySec')
    depth = str(depth) if isinstance(depth, int) and not isinstance(depth, bool) else ''
    minutes = (str(max(1, math.ceil(delay / 60)))
               if isinstance(delay, (int, float)) and not isinstance(delay, bool) else '')
    warning = ' '.join(str(d.get('warning', '')).split())
    msg_id = d.get('id', '') or ''
    return str(msg_id), depth, minutes, d.get('queued') is True, warning, d.get('downgraded') is True


def log_message_failure(sender, to, url, code, text):
    stamp = time.strftime('%Y-%m-%d %H:%M:%S')
    resp = text.encode('utf-8')[:200].decode('utf-8', 'ignore')
    try:
        with open(MESSAGE_FAIL_LOG, 'a', encoding='utf-8') as f:
            f.write(f'{stamp}\tFAIL\tfrom={sender}\tto={to}\turl={url}\thttp={code}\tresp={resp}\n')
    except OSError:
        pass


def print_sent(msg_id, depth, minutes, queued, warning, downgraded, to, priority):
    line = f'OK id={msg_id}'  # "OK id=<n>" stays the prefix: callers and docs grep for it
    if depth:
        line += f' queue={depth}'
    if minutes:
        line += f' (~{minutes} min)'
    if queued:
        # PENDING, delivered when the target starts: not a failure and not a reason to re-send (a duplicate). The
        # "OK id=" prefix stays so no caller reads it as a failure.
        print(f'QUEUED id={msg_id}  NOTE: {warning}', file=sys.stderr)
        print(f'{line} (queued: target not running, delivered when it starts)')
    elif warning:
        print(f'{line}  WARNING: {warning}', file=sys.stderr)
        print(f'{line} (warning)')
    else:
        print(line)
    warn_at = os.environ.get('MARVEEN_QUEUE_WARN_AT', str(QUEUE_WARN_DEFAULT))
    warn_at = int(warn_at) if warn_at.isdigit() and warn_at.isascii() else QUEUE_WARN_DEFAULT
    if depth and warn_at > 0 and int(depth) >= warn_at:
        delay = f', measured delay ~{minutes} min' if minutes else ''
        print(f'NOTICE: {depth} message(s) are waiting for {to}{delay}.', file=sys.stderr)
        print('  It is busy; prefer adding to an existing message or a shared card over another message.',
              file=sys.stderr)
    if priority == 'high' and downgraded:
        print(f'NOTICE: DOWNGRADED -- the row to {to} was accepted as normal: the hourly high budget toward it is '
              'used up (MESSAGE_HIGH_PRIORITY_PER_HOUR).', file=sys.stderr)


def send_message(sender, to, text, priority, token):
    """The gate, the payload, three tries; prints the OK or FAIL line. Returns an EXIT key."""
    refused = homoglyph_gate(text)
    if refused:
        return refused
    payload = {'from': sender, 'to': to, 'content': text}
    if priority:
        payload['priority'] = priority
    body = json.dumps(payload).encode('utf-8')
    url = f'{message_api_base()}/api/messages'
    code, answer, msg_id = '', '', ''
    for attempt in range(1, MESSAGE_TRIES + 1):
        code, answer, timed_out = post_message(url, token, body)
        if timed_out:
            # The request went out; only the answer is missing, so the row may exist. A retry could duplicate it.
            print(f"FAIL from={sender} to={to} url={url} http=timeout id='' (no answer in {MESSAGE_TIMEOUT_S} s, not "
                  'tried again: the message may have arrived; read back before re-sending)')
            log_message_failure(sender, to, url, 'timeout', '')
            return 'unreachable'
        msg_id, depth, minutes, queued, warning, downgraded = message_answer(answer)
        if code in ('200', '201') and msg_id:
            print_sent(msg_id, depth, minutes, queued, warning, downgraded, to, priority)
            return 'ok'
        if attempt < MESSAGE_TRIES:
            time.sleep(1)
    print(f"FAIL from={sender} to={to} url={url} http={code or '?'} id='{msg_id}' (after {MESSAGE_TRIES} tries)")
    log_message_failure(sender, to, url, code or '?', answer)
    # nothing answered on the last try: unreachable (3); an answer without an id: the server's error (1)
    return 'unreachable' if code == '000' else 'server_error'


def message_api_base():
    # The gate's own reading (env_gate.normalise_base, Ron PR4b point 7), else the port chain. agent-msg.sh used to
    # drop only one trailing '/' and keep surrounding spaces, so a base the gate accepted could fail on the wire.
    return api_base()


def agent_msg_main(argv):
    """scripts/agent-msg.sh: its argv and its messages on stdout; the exit codes are the helper's (EXIT_CODES)."""
    parsed, error = parse_agent_msg_argv(argv)
    if error:
        print(error, file=sys.stderr if error.endswith('required') else sys.stdout)
        return EXIT['usage']
    priority, sender, to, content = parsed
    refused = check_env()  # before the text or the token is read (C2 PR4b); stdout, like agent-msg.sh's other FAILs
    if refused:
        print(f'FAIL: {refused}')
        return EXIT['usage']
    if content == '-':
        content = strip_trailing_newlines(sys.stdin.read())
    path = os.environ.get('MARVEEN_TOKEN_FILE') or os.path.join(BASE, 'store', '.dashboard-token')
    try:
        with open(path, encoding='utf-8') as f:
            token = strip_trailing_newlines(f.read())
    except OSError:
        print(f'FAIL: no token file at {path}')
        return EXIT['usage']
    if not token:
        print(f'FAIL: the token file at {path} is empty; nothing was sent')
        return EXIT['usage']
    return EXIT[send_message(sender, to, content, priority, token)]


def helper_message_main(argv):
    """`marveen-api.sh message [<from>] <to> <content-file|-> [--as <agent>] [--priority high|normal]`
    (check_env already ran)."""
    token = read_token()  # missing, unreadable or empty: exit 2 before anything else, never an empty Bearer
    args, priority, given = list(argv), '', False
    positionals, as_name = [], None
    while args:
        a = args.pop(0)
        if a == '--as' or a.startswith('--as='):
            if as_name is not None:
                print('FAIL: message: --as given twice; nothing was sent.', file=sys.stderr)
                return EXIT['usage']
            if a == '--as' and not args:
                print('FAIL: --as needs a value', file=sys.stderr)
                return EXIT['usage']
            as_name = args.pop(0) if a == '--as' else a[len('--as='):]
        elif a == '--priority':
            if not args:
                print('FAIL: --priority needs a value', file=sys.stderr)
                return EXIT['usage']
            given, priority = True, args.pop(0)
        elif a.startswith('--priority='):
            given, priority = True, a[len('--priority='):]
        elif a.startswith('--'):
            print(f'FAIL: message: unknown option {a}', file=sys.stderr)
            return EXIT['usage']
        else:
            positionals.append(a)
    # The sender (attribution only, not a security boundary; C2 PR6 and Johnny 11686/11691). Explicit first: --as, or
    # the positional <from>; both given, they must be equal. Then the launcher-exported MARVEEN_AGENT_ID. Then the
    # missing-argument error, as before.
    if as_name is not None:
        if not NAME_RE.fullmatch(as_name):
            print(f"FAIL: message: --as '{as_name}' is not a valid agent name; nothing was sent.", file=sys.stderr)
            return EXIT['usage']
        if len(positionals) == 3 and positionals[0] != as_name:
            print(f"FAIL: message: --as '{as_name}' and <from> '{positionals[0]}' disagree (ambiguous); nothing was "
                  'sent.', file=sys.stderr)
            return EXIT['usage']
        if len(positionals) == 2:
            positionals.insert(0, as_name)
    ident = os.environ.get(IDENTITY_ENV, '')
    if as_name is None and len(positionals) == 2 and ident:
        if not NAME_RE.fullmatch(ident):
            print(f"FAIL: message: ${IDENTITY_ENV}='{ident}' is not a valid agent name; pass <from> explicitly",
                  file=sys.stderr)
            return EXIT['usage']
        positionals.insert(0, ident)
    if len(positionals) != 3:
        print('FAIL: usage: bash scripts/marveen-api.sh message [<from>] <to> <content-file> [--as <agent>] '
              '[--priority high|normal]', file=sys.stderr)
        return EXIT['usage']
    sender, to, path = positionals
    if path == '-':
        text = sys.stdin.read()
    else:
        try:
            with open(path, encoding='utf-8') as f:
                text = f.read()
        except (OSError, UnicodeDecodeError):
            print(f'FAIL: cannot read {path}; nothing was sent.', file=sys.stderr)
            return EXIT['usage']
        # A recipe payload file is emptied after a successful send, and an empty one stops here, so an old text is
        # never sent twice (VOICETOKENLEAK1101 PR-A1); the same rule as read_text.
        if is_recipe_payload(path) and not text.strip():
            print(f'FAIL: {path} is empty: a recipe payload file is emptied after each send, write the new text '
                  'first; nothing was sent.', file=sys.stderr)
            return EXIT['usage']
    # Then agent-msg.sh's own checks, in the order the old hand-over ran them (after the file).
    if given and priority not in MESSAGE_PRIORITIES:
        print('FAIL: --priority must be high or normal (absent = normal)')
        return EXIT['usage']
    if sender == '' or to == '':
        print(f"FAIL: {'from' if sender == '' else 'to'} required", file=sys.stderr)
        return EXIT['usage']
    outcome = send_message(sender, to, strip_trailing_newlines(text), priority, token)
    if outcome == 'ok' and is_recipe_payload(path):
        SENT_PAYLOADS.append(path)
        empty_sent_payloads()
    return EXIT[outcome]


def main(argv):
    if argv and argv[0] == '--agent-msg':
        # scripts/agent-msg.sh, run directly: check_env() runs in agent_msg_main, after the argv (see ENV GATE).
        return agent_msg_main(argv[1:])
    if not argv or argv[0] in ('-h', '--help'):
        print(USAGE)
        return EXIT['ok'] if argv else EXIT['usage']
    refused = check_env()
    if refused:
        print(f'FAIL: {refused}', file=sys.stderr)
        return EXIT['usage']
    if argv[0] == '--check-env':
        # The env gate alone, nothing sent: exit 0 or 2. No script calls it since PR4 moved `message` into python;
        # the tests use it to probe the gate (marveen-api-helper.test.ts). (--check-token had no caller left and
        # is gone, C2 PR4c.)
        return EXIT['ok']
    if argv[0] == 'message':
        return helper_message_main(argv[1:])
    verb, rest = argv[0], argv[1:]
    try:
        method, path, body, headers, flags = build_request(verb, rest)
    except UsageError as e:
        print(f'FAIL: {e}\n{USAGE}', file=sys.stderr)
        return EXIT['usage']
    refused = schedule_write_refused(method, path)
    if refused:
        print(f'FAIL: {refused}', file=sys.stderr)
        return EXIT['usage']
    token = read_token()
    data = json.dumps(body).encode('utf-8') if body is not None else None
    req = urllib.request.Request(api_base() + path, data=data, method=method)
    req.add_header('Authorization', f'Bearer {token}')
    if data is not None:
        req.add_header('Content-Type', 'application/json')
    for k, v in headers.items():
        req.add_header(k, v)
    try:
        with OPENER.open(req, timeout=30) as resp:
            status, text, resp_headers = resp.status, resp.read().decode('utf-8', 'replace'), resp.headers
    except urllib.error.HTTPError as e:
        status, text, resp_headers = e.code, e.read().decode('utf-8', 'replace'), e.headers
    except (urllib.error.URLError, OSError) as e:
        if isinstance(e, TimeoutError) or isinstance(getattr(e, 'reason', None), TimeoutError):
            # The request may have been sent and processed; only the answer is missing.
            print(f'FAIL: the dashboard at {api_base()} did not answer in 30 s; read back before you retry a write.', file=sys.stderr)
            return EXIT['unreachable']
        print(f'FAIL: the dashboard at {api_base()} could not be reached ({getattr(e, "reason", e)}).', file=sys.stderr)
        return EXIT['unreachable']
    if flags.get('search_header'):
        # The search answers leniently; the label travels only in this header (#1374). Its ABSENCE
        # is printed too: a missing header is a request that failed, not an empty result.
        label = resp_headers.get('X-Memory-Search') if resp_headers else None
        print(f'X-Memory-Search: {label}' if label else 'X-Memory-Search: MISSING (the search did not run as asked)')
    if 200 <= status < 300:
        empty_sent_payloads()
        print(text)
        return EXIT['ok']
    if status == 409 and flags.get('conflict_is_closed'):
        # The first close stands and no receipt went out; a second close changes nothing (the payload file is kept).
        print(f'ALREADY CLOSED: message {flags["conflict_is_closed"]} (HTTP 409): not an error, do not retry; '
              'nothing changed.', file=sys.stderr)
        return EXIT['conflict']
    print(f'FAIL: HTTP {status}: {text[:500]}', file=sys.stderr)
    return EXIT['server_error']


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
