#!/usr/bin/env python3
"""Test scripts/lib/render_claude_md_template.py (C1 PR 11c).

The installers rendered templates/CLAUDE.md.template with sed and the shell's
CHAT_ID, which is "0" before pairing, so a fresh install's main CLAUDE.md told
the agent to send to chat 0. The renderer reads ALLOWED_CHAT_ID from the
install's .env; without a real id it drops the chat id fragment and keeps the
rule it sits in (Kevin 13339). Measured here on the real template:

1. with an id: both rules carry it, and the output is byte-identical to the
   installers' old sed with the same values (nothing else changed);
2. without one (no file, no key, empty, "0", quoted "0"): no {{CHAT_ID}} and no
   chat 0 in the file, both rules still there, the rest identical to the sed;
3. a {{CHAT_ID}} outside the known fragments stops the render loudly (exit 2,
   the old file untouched), with or without an id;
4. both installers and update.sh --regen-claudemd call the renderer, and no
   sed of {{CHAT_ID}} is left.

Run:  python3 scripts/__tests__/render-claude-md-template.test.py
"""
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
RENDERER = os.path.join(ROOT, 'scripts', 'lib', 'render_claude_md_template.py')
TEMPLATE = os.path.join(ROOT, 'templates', 'CLAUDE.md.template')
FAILS = []

VALUES = {
    'OWNER_NAME': 'Teszt Elek',
    'INSTALL_DIR': '/opt/marveen-test',
    'BOT_NAME': 'Botond',
    'MAIN_AGENT_ID': 'botond',
    'WEB_PORT': '3421',
    'TIMEZONE': 'Europe/Vienna',
}

RULE_ESCALATE = 'Eszkaláld Teszt Elek-hez Telegramon (reply tool'
RULE_SEND = '4. Telegram küldés: a reply tool-lal'


def check(name, cond, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + (('  -- ' + detail) if detail and not cond else ''))
    if not cond:
        FAILS.append(name)


def run(template, env_text, workdir, out_name='CLAUDE.md'):
    """(exit code, stderr, output text or None)."""
    env_file = os.path.join(workdir, '.env')
    if env_text is None:
        if os.path.exists(env_file):
            os.unlink(env_file)
    else:
        with open(env_file, 'w', encoding='utf-8') as f:
            f.write(env_text)
    out = os.path.join(workdir, out_name)
    env = dict(os.environ)
    env.update(VALUES)
    p = subprocess.run([sys.executable, '-I', RENDERER, template, out, env_file],
                       env=env, capture_output=True, text=True)
    text = open(out, encoding='utf-8').read() if os.path.exists(out) else None
    return p.returncode, p.stderr, text


def old_sed(template, chat_id):
    """The installers' sed before C1 PR 11c (install-linux.sh), with TIMEZONE given directly."""
    args = ['sed',
            '-e', f"s/{{{{OWNER_NAME}}}}/{VALUES['OWNER_NAME']}/g",
            '-e', f"s|{{{{INSTALL_DIR}}}}|{VALUES['INSTALL_DIR']}|g",
            '-e', f"s/{{{{CHAT_ID}}}}/{chat_id}/g",
            '-e', f"s/{{{{BOT_NAME}}}}/{VALUES['BOT_NAME']}/g",
            '-e', f"s/{{{{MAIN_AGENT_ID}}}}/{VALUES['MAIN_AGENT_ID']}/g",
            '-e', f"s/{{{{WEB_PORT}}}}/{VALUES['WEB_PORT']}/g",
            '-e', f"s|{{{{TIMEZONE}}}}|{VALUES['TIMEZONE']}|g",
            template]
    return subprocess.run(args, capture_output=True, text=True, check=True).stdout


def main():
    work = tempfile.mkdtemp(prefix='render-claude-md-')
    try:
        tpl = open(TEMPLATE, encoding='utf-8').read()
        check('the real template carries {{CHAT_ID}} exactly twice (the test covers every occurrence)',
              tpl.count('{{CHAT_ID}}') == 2, str(tpl.count('{{CHAT_ID}}')))

        # 1. With an id.
        rc, err, text = run(TEMPLATE, 'FOO=1\nALLOWED_CHAT_ID=123456789\n', work)
        check('with an id: exit 0', rc == 0, err)
        text = text or ''
        check('with an id: the escalation rule names it',
              'Telegramon (reply tool, chat_id `123456789`): `Egy sub-ágenshez' in text)
        check('with an id: the send step names it', RULE_SEND + ' (chat_id: 123456789)\n' in text)
        check('with an id: no placeholder of the template is left', '{{' not in text)
        check('with an id: byte-identical to the old sed with the same values',
              text == old_sed(TEMPLATE, '123456789'))

        # 2. Without one.
        cases = {
            'no .env file': None,
            'no ALLOWED_CHAT_ID key': 'FOO=1\n',
            'empty': 'ALLOWED_CHAT_ID=\n',
            'the installer placeholder 0': 'ALLOWED_CHAT_ID=0\n',
            'a quoted "0"': 'ALLOWED_CHAT_ID="0"\n',
            '0 with spaces and CR': 'ALLOWED_CHAT_ID= 0 \r\n',
        }
        for label, env_text in cases.items():
            rc, err, text = run(TEMPLATE, env_text, work)
            text = text or ''
            check(f'{label}: exit 0', rc == 0, err)
            check(f'{label}: no {{{{CHAT_ID}}}} left', '{{CHAT_ID}}' not in text)
            check(f'{label}: no chat 0 in the file',
                  'chat_id: 0' not in text and 'chat_id `0`' not in text and 'chat_id' not in text)
            check(f'{label}: the escalation rule is still there, without the chat id',
                  RULE_ESCALATE + '): `Egy sub-ágenshez ismeretlen, NEM párosított sender [ID] írt' in text)
            check(f'{label}: the send step is still there, without the chat id', RULE_SEND + '\n' in text)
            expected = old_sed(TEMPLATE, '{{CHAT_ID}}') \
                .replace(' (reply tool, chat_id `{{CHAT_ID}}`)', ' (reply tool)') \
                .replace(' (chat_id: {{CHAT_ID}})', '')
            check(f'{label}: everything else identical to the old sed', text == expected)

        # 3. An unknown occurrence stops the render, with and without an id; the old file stays.
        extra = os.path.join(work, 'extra.template')
        with open(extra, 'w', encoding='utf-8') as f:
            f.write(tpl + '\n5. Új lépés: küldd a {{CHAT_ID}} chatbe.\n')
        for label, env_text in (('without an id', 'ALLOWED_CHAT_ID=0\n'), ('with an id', 'ALLOWED_CHAT_ID=42\n')):
            out = os.path.join(work, 'kept.md')
            with open(out, 'w', encoding='utf-8') as f:
                f.write('previous file\n')
            rc, err, text = run(extra, env_text, work, out_name='kept.md')
            check(f'unknown {{{{CHAT_ID}}}} {label}: exit 2', rc == 2, f'rc={rc}')
            check(f'unknown {{{{CHAT_ID}}}} {label}: says why on stderr', 'outside the known chat id fragments' in err, err)
            check(f'unknown {{{{CHAT_ID}}}} {label}: the old file is untouched', text == 'previous file\n', repr(text))
        check('no temp file is left behind',
              not [n for n in os.listdir(work) if n.startswith('.claude-md-')])

        p = subprocess.run([sys.executable, '-I', RENDERER, TEMPLATE], capture_output=True, text=True)
        check('a bad call exits 2 with the usage', p.returncode == 2 and 'usage:' in p.stderr, p.stderr)

        # 4. The installers.
        for script in ('install-linux.sh', 'install-macos.sh'):
            src = open(os.path.join(ROOT, script), encoding='utf-8').read()
            check(f'{script}: calls the renderer on the template with the install .env',
                  'scripts/lib/render_claude_md_template.py" "$INSTALL_DIR/templates/CLAUDE.md.template" '
                  '"$INSTALL_DIR/CLAUDE.md" "$INSTALL_DIR/.env"' in src)
            check(f'{script}: no sed of {{{{CHAT_ID}}}} is left', 's/{{CHAT_ID}}/' not in src)
        # update.sh --regen-claudemd renders the same template; it used to grep a CHAT_ID= key the .env lacks.
        src = open(os.path.join(ROOT, 'update.sh'), encoding='utf-8').read()
        check('update.sh --regen-claudemd: calls the renderer with the install .env',
              'scripts/lib/render_claude_md_template.py" "$INSTALL_DIR/templates/CLAUDE.md.template" '
              '"$CLAUDE_MD" "$INSTALL_DIR/.env"' in src)
        check('update.sh: no sed of {{CHAT_ID}} and no CHAT_ID= grep is left',
              's/{{CHAT_ID}}/' not in src and "grep '^CHAT_ID='" not in src)
    finally:
        shutil.rmtree(work, ignore_errors=True)

    if FAILS:
        print(f'\n{len(FAILS)} FAILED')
        sys.exit(1)
    print('\nALL PASS')


if __name__ == '__main__':
    main()
