#!/usr/bin/env python3
"""scripts/marveen-admin.sh: the main agent's schedule writes (C2 PR5, design C1-C2 section 4, "main only").

Reuses scripts/lib/marveen_api.py (loaded by its exact path next to this file): the same token env gate
(env_gate.py, before the token is read), the same token reading, the same request function and the same exit-code
table. It does NOT go through marveen_api's verb dispatcher, so the helper's refusal of schedule writes
(schedule_write_refused) stays in force for every marveen-api.sh call.

Who may run it, three layers, none of them a security boundary on its own (one shared token, C5):
  - the self-pace gate (every sub-agent's PreToolUse hook) denies the names marveen-admin.sh and marveen_admin.py;
  - no permission profile allow-lists it;
  - here: MARVEEN_AGENT_ID set to anything but the main agent's id -> exit 2 (an accident guard; self-declared).
With AGENT_TOKENS on, the server itself refuses a sub-agent's schedule write (auth-gate.ts).

Text never comes from argv: the prompt and the description come from a file (or - for stdin).
Before you CHANGE an existing schedule, read the skill `utemezett-feladat-modositas` (CLAUDE.md rule).
"""
import importlib.util
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
API_PATH = os.path.join(HERE, 'marveen_api.py')
SCHEDULE_TYPES = ('task', 'heartbeat')
CRON_RE = re.compile(r'^[0-9*/,\- A-Za-z?#LW]{1,100}$')

USAGE = """usage: bash scripts/marveen-admin.sh <verb> [args]   (main agent only)
  schedule-create <name> <cron> <type> <agent> <prompt-file|-> [--description-file <f>] [--once] [--skip-if-busy]
                <type>: task (always reports) or heartbeat (silent unless important); <cron> in Europe/Budapest,
                one quoted word, e.g. "0 8 * * *". 409 (already exists) -> exit 4: use schedule-update.
  schedule-update <name> [--prompt-file <f>] [--description-file <f>] [--schedule <cron>] [--enabled true|false]
                [--type task|heartbeat] [--agent <name>]
                at least one change. Read the skill utemezett-feladat-modositas BEFORE changing a schedule.
                Unknown name (404) -> exit 2.
Exit codes: the helper's table (bash scripts/marveen-api.sh --help)."""


def load_api():
    spec = importlib.util.spec_from_file_location('marveen_api_for_admin', API_PATH)
    if spec is None or spec.loader is None:
        raise ImportError(API_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def read_text(api, path, what):
    if path == '-':
        text = sys.stdin.read()
    else:
        try:
            with open(path, encoding='utf-8') as f:
                text = f.read()
        except OSError as e:
            raise ValueError(f'cannot read the {what} file {path} ({e.strerror})')
    text = api.strip_trailing_newlines(text)
    if not text.strip():
        raise ValueError(f'the {what} file {path} is empty')
    return text


def main_agent_id(api):
    # the install's own .env first (an agent's environment cannot change it), then the environment, then the default
    return (api.env_file_values('MAIN_AGENT_ID').get('MAIN_AGENT_ID') or os.environ.get('MAIN_AGENT_ID')
            or 'marveen').strip()


def parse_create(api, args):
    flags = {'once': False, 'skip': False, 'desc': None}
    pos = []
    while args:
        a = args.pop(0)
        if a == '--once':
            flags['once'] = True
        elif a == '--skip-if-busy':
            flags['skip'] = True
        elif a == '--description-file':
            if not args:
                raise ValueError('--description-file needs a file')
            flags['desc'] = args.pop(0)
        elif a.startswith('--'):
            raise ValueError(f'unknown option {a}')
        else:
            pos.append(a)
    if len(pos) != 5:
        raise ValueError('schedule-create needs <name> <cron> <type> <agent> <prompt-file>')
    name, cron, typ, agent, prompt_file = pos
    check_name(api, name, 'schedule name')
    check_cron(cron)
    if typ not in SCHEDULE_TYPES:
        raise ValueError(f'type must be one of {", ".join(SCHEDULE_TYPES)}')
    check_name(api, agent, 'agent')
    body = {'name': name, 'schedule': cron, 'type': typ, 'agent': agent,
            'prompt': read_text(api, prompt_file, 'prompt')}
    if flags['desc']:
        body['description'] = read_text(api, flags['desc'], 'description')
    if flags['once']:
        body['once'] = True
    if flags['skip']:
        body['skipIfBusy'] = True
    return 'POST', '/api/schedules', body, name


def parse_update(api, args):
    if not args or args[0].startswith('--'):
        raise ValueError('schedule-update needs <name> first')
    name = args.pop(0)
    check_name(api, name, 'schedule name')
    body = {}
    while args:
        a = args.pop(0)
        if a not in ('--prompt-file', '--description-file', '--schedule', '--enabled', '--type', '--agent'):
            raise ValueError(f'unknown option {a}')
        if not args:
            raise ValueError(f'{a} needs a value')
        v = args.pop(0)
        key = {'--prompt-file': 'prompt', '--description-file': 'description', '--schedule': 'schedule',
               '--enabled': 'enabled', '--type': 'type', '--agent': 'agent'}[a]
        if key in body:
            raise ValueError(f'{a} given twice')
        if a == '--prompt-file':
            v = read_text(api, v, 'prompt')
        elif a == '--description-file':
            v = read_text(api, v, 'description')
        elif a == '--schedule':
            check_cron(v)
        elif a == '--enabled':
            if v not in ('true', 'false'):
                raise ValueError('--enabled must be true or false')
            v = v == 'true'
        elif a == '--type':
            if v not in SCHEDULE_TYPES:
                raise ValueError(f'--type must be one of {", ".join(SCHEDULE_TYPES)}')
        elif a == '--agent':
            check_name(api, v, 'agent')
        body[key] = v
    if not body:
        raise ValueError('schedule-update needs at least one change')
    return 'PUT', f'/api/schedules/{name}', body, name


def check_name(api, value, what):
    if not api.NAME_RE.fullmatch(value):
        raise ValueError(f'invalid {what}: {value!r} (lowercase letters, digits and -)')


def check_cron(value):
    if not CRON_RE.fullmatch(value) or len(value.split()) not in (5, 6):
        raise ValueError(f'invalid cron expression: {value!r} (five fields, one quoted word)')


def main(argv):
    try:
        api = load_api()
    except (OSError, ImportError, SyntaxError) as e:
        print(f'FAIL: cannot load {API_PATH} ({e.__class__.__name__}); nothing was sent.', file=sys.stderr)
        # The one literal exit code: the table (EXIT_CODES) lives in the module that just failed to load. 2 = its
        # 'usage' row ("nothing was sent"); marveen-admin.test.py pins that the two stay equal.
        return 2
    EXIT = api.EXIT
    if not argv or argv[0] in ('-h', '--help'):
        print(USAGE)
        return EXIT['ok'] if argv else EXIT['usage']
    ident = (os.environ.get('MARVEEN_AGENT_ID') or '').strip()
    main_id = main_agent_id(api)
    if ident and ident != main_id:
        print(f'FAIL: marveen-admin.sh is the main agent\'s ({main_id}); MARVEEN_AGENT_ID={ident}. Ask {main_id} '
              'by message. Nothing was sent.', file=sys.stderr)
        return EXIT['usage']
    refused = api.check_env()
    if refused:
        print(f'FAIL: {refused}', file=sys.stderr)
        return EXIT['usage']
    verb, args = argv[0], list(argv[1:])
    try:
        if verb == 'schedule-create':
            method, path, body, name = parse_create(api, args)
        elif verb == 'schedule-update':
            method, path, body, name = parse_update(api, args)
        else:
            raise ValueError(f'unknown verb {verb}')
    except ValueError as e:
        print(f'FAIL: {e}\n{USAGE}', file=sys.stderr)
        return EXIT['usage']
    token = api.read_token()
    status, text, _, failure = api.send_request(method, path, body, {}, token)
    if failure:
        print(failure, file=sys.stderr)
        return EXIT['unreachable']
    if 200 <= status < 300:
        print(f'OK {verb} {name}')
        return EXIT['ok']
    if status == 409:
        print(f'ALREADY EXISTS: schedule {name} (HTTP 409): not created again; use schedule-update.', file=sys.stderr)
        return EXIT['conflict']
    if status == 404:
        print(f'FAIL: no schedule {name} (HTTP 404); nothing changed.', file=sys.stderr)
        return EXIT['usage']
    print(f'FAIL: HTTP {status}: {text[:500]}', file=sys.stderr)
    return EXIT['server_error']


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
