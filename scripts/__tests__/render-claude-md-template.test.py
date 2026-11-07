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
   sed of {{CHAT_ID}} is left;
5. the file keeps its mode (a new one: 0666 minus umask), is replaced by a
   rename, and a symlinked target is written at the file it points at, the
   link kept (Ron 13359/1);
6. a .env that is not UTF-8 counts as no chat id, without a crash and without
   its content on stderr (Ron 13359/2);
7. a rename that fails after the check leaves the old file and no temp file
   (Ron 13359/3, his mutant P3);
8. the values are inserted as given, not stripped (his mutant P6).

Run:  python3 scripts/__tests__/render-claude-md-template.test.py
"""
import importlib.util
import os
import shutil
import stat
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


def run(template, env_text, workdir, out_name='CLAUDE.md', values=None, env_bytes=None):
    """(exit code, stderr, output text or None)."""
    env_file = os.path.join(workdir, '.env')
    if env_bytes is not None:
        with open(env_file, 'wb') as f:
            f.write(env_bytes)
    elif env_text is None:
        if os.path.exists(env_file):
            os.unlink(env_file)
    else:
        with open(env_file, 'w', encoding='utf-8') as f:
            f.write(env_text)
    out = os.path.join(workdir, out_name)
    env = dict(os.environ)
    env.update(values or VALUES)
    p = subprocess.run([sys.executable, '-I', RENDERER, template, out, env_file],
                       env=env, capture_output=True, text=True)
    text = open(out, encoding='utf-8').read() if os.path.exists(out) else None
    return p.returncode, p.stderr, text


def old_sed(template, chat_id, values=None):
    """The installers' sed before C1 PR 11c (install-linux.sh), with TIMEZONE given directly."""
    V = values or VALUES
    args = ['sed',
            '-e', f"s/{{{{OWNER_NAME}}}}/{V['OWNER_NAME']}/g",
            '-e', f"s|{{{{INSTALL_DIR}}}}|{V['INSTALL_DIR']}|g",
            '-e', f"s/{{{{CHAT_ID}}}}/{chat_id}/g",
            '-e', f"s/{{{{BOT_NAME}}}}/{V['BOT_NAME']}/g",
            '-e', f"s/{{{{MAIN_AGENT_ID}}}}/{V['MAIN_AGENT_ID']}/g",
            '-e', f"s/{{{{WEB_PORT}}}}/{V['WEB_PORT']}/g",
            '-e', f"s|{{{{TIMEZONE}}}}|{V['TIMEZONE']}|g",
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

        no_id_expected = old_sed(TEMPLATE, '{{CHAT_ID}}') \
            .replace(' (reply tool, chat_id `{{CHAT_ID}}`)', ' (reply tool)') \
            .replace(' (chat_id: {{CHAT_ID}})', '')

        # 5. Mode, symlink and the rename (Ron 13359/1, /3).
        mode_of = lambda p: stat.S_IMODE(os.stat(p).st_mode)  # noqa: E731
        for existing in (0o644, 0o640):
            out = os.path.join(work, 'mode.md')
            with open(out, 'w', encoding='utf-8') as f:
                f.write('previous file\n')
            os.chmod(out, existing)
            inode = os.stat(out).st_ino
            rc, err, text = run(TEMPLATE, 'ALLOWED_CHAT_ID=42\n', work, out_name='mode.md')
            check(f'an existing {oct(existing)} file keeps its mode', rc == 0 and mode_of(out) == existing,
                  f'rc={rc} mode={oct(mode_of(out))} {err}')
            check(f'an existing {oct(existing)} file is replaced by a rename, not rewritten in place',
                  os.stat(out).st_ino != inode)
            os.unlink(out)
        old_umask = os.umask(0o022)
        try:
            for umask, want in ((0o022, 0o644), (0o077, 0o600)):
                os.umask(umask)
                out = os.path.join(work, 'new.md')
                if os.path.exists(out):
                    os.unlink(out)
                rc, err, _ = run(TEMPLATE, 'ALLOWED_CHAT_ID=42\n', work, out_name='new.md')
                check(f'a new file under umask {oct(umask)} gets {oct(want)} (0666 minus umask)',
                      rc == 0 and mode_of(out) == want, f'rc={rc} mode={oct(mode_of(out))} {err}')
        finally:
            os.umask(old_umask)
        real_dir = os.path.join(work, 'real')
        os.mkdir(real_dir)
        real = os.path.join(real_dir, 'CLAUDE.md')
        with open(real, 'w', encoding='utf-8') as f:
            f.write('previous file\n')
        os.chmod(real, 0o640)
        os.symlink(real, os.path.join(work, 'link.md'))
        rc, err, _ = run(TEMPLATE, 'ALLOWED_CHAT_ID=42\n', work, out_name='link.md')
        link = os.path.join(work, 'link.md')
        check('a symlinked target: exit 0', rc == 0, err)
        check('a symlinked target stays a symlink to the same file',
              os.path.islink(link) and os.path.realpath(link) == os.path.realpath(real))
        check('a symlinked target: the file it points at is rendered and keeps its mode',
              open(real, encoding='utf-8').read() == old_sed(TEMPLATE, '42') and mode_of(real) == 0o640)
        check('a symlinked target: no temp file next to the link or the target',
              not [n for d in (work, real_dir) for n in os.listdir(d) if n.startswith('.claude-md-')])

        # 6. A .env that is not UTF-8 (Ron 13359/2): no id, never a crash, never its content on stderr.
        rc, err, text = run(TEMPLATE, None, work, env_bytes=b'ALLOWED_CHAT_ID=987654321\n\xff\xfe broken\n')
        check('a non-UTF-8 .env: exit 0', rc == 0, err)
        check('a non-UTF-8 .env: treated as no chat id (the fragments dropped)', text == no_id_expected)
        check('a non-UTF-8 .env: nothing of it on stderr', '987654321' not in err and 'broken' not in err, err)

        # 7. The write fails after the check (Ron 13359/3, mutant P3): the old file stays, no temp file.
        spec = importlib.util.spec_from_file_location('render_claude_md_template_under_test', RENDERER)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        out = os.path.join(work, 'fail.md')
        with open(out, 'w', encoding='utf-8') as f:
            f.write('previous file\n')
        env_file = os.path.join(work, 'fail.env')
        with open(env_file, 'w', encoding='utf-8') as f:
            f.write('ALLOWED_CHAT_ID=42\n')
        real_replace = os.replace

        def failing_replace(src, dst):
            raise OSError(28, 'No space left on device (test)')
        os.replace = failing_replace
        raised = None
        try:
            mod.main(['render', TEMPLATE, out, env_file])
        except OSError as e:
            raised = e
        finally:
            os.replace = real_replace
        check('a failing rename: the error reaches the caller (non-zero exit under the installer)', raised is not None)
        check('a failing rename: the old file is untouched', open(out, encoding='utf-8').read() == 'previous file\n')
        check('a failing rename: no temp file is left', not [n for n in os.listdir(work) if n.startswith('.claude-md-')])

        # 8. Values go in as given, not stripped (mutant P6): the same as the sed with the same values.
        spaced = dict(VALUES, OWNER_NAME=' Teszt  Elek ', BOT_NAME='Botond ', TIMEZONE=' Europe/Vienna')
        rc, err, text = run(TEMPLATE, 'ALLOWED_CHAT_ID=42\n', work, values=spaced)
        check('values with spaces around them: inserted as given, byte-identical to the sed',
              rc == 0 and text == old_sed(TEMPLATE, '42', values=spaced), err)

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
