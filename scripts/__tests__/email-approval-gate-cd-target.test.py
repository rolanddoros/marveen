"""CDGATE1108: a relative script after a cd whose target is not literal is a send (fail-closed).

script_run_sends (outgoing-copy-gate.py) looks a relative script up under cwd and under every literal `cd DIR`
target of the command; a cd it cannot resolve makes such a script a send. The cd target was read from a flat list
of every segment's words, after `$(` and the backtick had been masked to `;`: in `cd $(mktemp -d) && python3 x.py`
the target read as "mktemp" (a literal relative directory), so the script was looked up under cwd and cwd/mktemp,
a harmless file there passed, and the real run went elsewhere. Same for a backtick target, `$((..))`, `<(..)`,
and a quoted backtick. A bare `cd` read the next segment's first word ("python3") as its directory instead of HOME.

Pinned here: every non-literal target is fail-closed with the not_literal reason; a literal cd still resolves (a
harmless script passes, a sending one is caught); a bare `cd` looks under HOME (a sending script there is now
caught, a harmless one passes); the mask's default output is the same as before for every other caller; the
substitution marker never shows in a reason or in the hook's deny.

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import importlib.util
import inspect
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HOOKS = os.path.join(os.path.dirname(HERE), "hooks")
GATE = os.path.join(HOOKS, "email-approval-gate.py")

failed = []


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" -- {detail}" if not ok and detail else ""))
    if not ok:
        failed.append(name)


def make_store(root, level):
    """The temporary store of email-approval-gate.test.py: the autonomy config and an empty approvals DB."""
    store = os.path.join(root, f"store{level}")
    os.makedirs(store, exist_ok=True)
    cat = {"key": "email_send", "label": "Email", "level": level, "locked": False}
    with open(os.path.join(store, "autonomy-config.json"), "w", encoding="utf-8") as fh:
        json.dump({"version": 1, "categories": [cat]}, fh)
    con = sqlite3.connect(os.path.join(store, "claudeclaw.db"))
    con.execute("""
      CREATE TABLE approvals (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, category TEXT NOT NULL,
        action_description TEXT NOT NULL, action_payload TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        timeout_at INTEGER, telegram_message_id INTEGER,
        requested_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
        resolved_at INTEGER, resolved_by TEXT,
        content_hash TEXT, consumed_at INTEGER)""")
    con.commit()
    con.close()
    return store


spec = importlib.util.spec_from_file_location("outgoing_copy_gate", os.path.join(HOOKS, "outgoing-copy-gate.py"))
ocg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ocg)

HARMLESS_PY = "print('x')\n"
HARMLESS_MJS = "console.log('x')\n"
SMTP_SEND = "import smtplib\ns = smtplib.SMTP('localhost')\n"
NOT_LITERAL = getattr(ocg, "SCRIPT_NOT_LITERAL", "not_literal")
LEAD_CD = "relativ ut egy nem szo szerinti cd utan"


def _old_mask(cmd: str) -> str:
    """_mask_subshell_markers as it was before CDGATE1108 (fork/main 621650b6), verbatim: the reference the
    default output is held to, so no other caller of the mask or of _segments_tokens moves."""
    out = []
    q = None  # None | "'" | '"'
    i, n = 0, len(cmd)
    while i < n:
        ch = cmd[i]
        if q:
            if ch == "\\" and q == '"' and i + 1 < n:
                out.append(cmd[i:i + 2]); i += 2; continue
            if ch == q:
                q = None
            out.append(ch); i += 1; continue
        if ch in "'\"":
            q = ch; out.append(ch); i += 1; continue
        if ch == "\\" and i + 1 < n:
            out.append(cmd[i:i + 2]); i += 2; continue
        if ch == "\n" or ch == "`":
            out.append(";"); i += 1; continue
        if ch == "$" and i + 1 < n and cmd[i + 1] == "(":
            out.append(";"); i += 2; continue
        out.append(ch); i += 1
    return "".join(out)


D = tempfile.mkdtemp(prefix="gate-cd-target-")
OLD_HOME = os.environ.get("HOME")
try:
    def put(rel, text):
        path = os.path.join(D, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        return path

    # cwd D: a harmless copy at every place the old reading looked (cwd, and cwd/<the substitution's command>)
    for base in ("", "sub", "sub/deeper", "mktemp", "pwd", "echo", "1", "x", "python3"):
        put(os.path.join(base, "job.py"), HARMLESS_PY)
        put(os.path.join(base, "job.mjs"), HARMLESS_MJS)
        put(os.path.join(base, "jobpkg", "__init__.py"), "")
        put(os.path.join(base, "jobpkg", "__main__.py"), HARMLESS_PY)
    put("snd/job.py", SMTP_SEND)
    put("home-send/job.py", SMTP_SEND)
    put("home-send/job.mjs", "import nodemailer from 'nodemailer'\n")
    put("home-clean/job.py", HARMLESS_PY)
    HOME_SEND, HOME_CLEAN = os.path.join(D, "home-send"), os.path.join(D, "home-clean")

    def judge(cmd, home=HOME_CLEAN):
        os.environ["HOME"] = home
        reasons = []
        return ocg.script_run_sends(cmd, D, reasons=reasons), reasons

    # --- non-literal cd targets: fail-closed, with the not_literal reason --------------------------------
    for cmd, what in [
        ("cd $(mktemp -d) && python3 job.py", "command substitution"),
        ("cd $(pwd)/sub && node job.mjs", "command substitution with a literal tail"),
        ("cd x$(echo y) && python3 job.py", "a literal head, then a substitution"),
        ("cd `pwd` && python3 job.py", "backticks"),
        ('cd "`pwd`" && python3 job.py', "quoted backticks"),
        ("cd `echo /tmp`/sub && ./job.py", "backticks, then a directly run file"),
        ("cd $((1)) && python3 job.py", "arithmetic expansion"),
        ("cd <(true) && python3 job.py", "process substitution"),
        ("cd $(pwd) && python3 -m jobpkg", "substitution, then python -m"),
        ("cd -P $(pwd) && python3 job.py", "an option before the substitution"),
        ("cd -- $(pwd) && python3 job.py", "-- before the substitution"),
        ("cd $(pwd)\npython3 job.py", "substitution, then a newline"),
        ("bash -c 'cd $(pwd) && python3 job.py'", "substitution inside sh -c"),
        ("cd $(pwd) && bash -c 'python3 job.py'", "substitution, then the script inside sh -c"),
        ("cd sub && cd `pwd` && python3 job.py", "a literal cd, then a backtick cd"),
        ("cd $DEST && python3 job.py", "a variable (already fail-closed before)"),
        ("cd ${DEST} && python3 job.py", "a braced variable (already fail-closed before)"),
        ('cd "$(dirname /a/b)" && python3 job.py', "a quoted substitution (already fail-closed before)"),
    ]:
        got, reasons = judge(cmd)
        check(f"CDGATE1108 {what}: {cmd!r} -> send (fail-closed)", got is True, f"got {got}")
        if "python3 -m" not in cmd:  # the python -m branch records no reason (E-GATE N-3, out of scope)
            check(f"CDGATE1108 {what}: the reason is not_literal", bool(reasons) and reasons[0][0] == NOT_LITERAL,
                  f"reasons={reasons!r}")
        check(f"CDGATE1108 {what}: no marker in the reason",
              all("\x00" not in r[1] for r in reasons), f"reasons={reasons!r}")

    # --- literal cd targets: resolved as before -----------------------------------------------------------
    for cmd, want, what in [
        (f"cd {D}/sub && python3 job.py", False, "an absolute literal cd, harmless script"),
        ("cd sub && node job.mjs", False, "a relative literal cd, harmless script"),
        ("cd -- sub && python3 job.py", False, "cd -- DIR, harmless script"),
        ("cd sub && cd deeper && python3 job.py", False, "chained literal cds, harmless script"),
        (f"cd {D}/sub && bash -c 'python3 job.py'", False, "a literal cd, then the script inside sh -c"),
        ("cd ~ && python3 job.py", False, "cd ~ with a harmless script under HOME"),
        ("echo $(date) && python3 job.py", False, "a substitution outside any cd changes nothing"),
        ("cd sub; python3 job.py `date`", False, "a substitution after the script's cd changes nothing"),
        (f"cd {D}/snd && python3 job.py", True, "a sending script in the literal cd target is still caught"),
        ("cd snd && python3 job.py", True, "a sending script in the relative literal cd target is still caught"),
    ]:
        got, reasons = judge(cmd)
        check(f"CDGATE1108 {what}: {cmd!r} -> {want}", got is want, f"got {got} reasons={reasons!r}")

    # --- a bare cd goes to HOME (Kevin 14199: it tightens) --------------------------------------------------
    for cmd, home, want, what in [
        ("cd && python3 job.py", HOME_SEND, True, "bare cd, a sending script under HOME is caught"),
        ("cd; python3 job.py", HOME_SEND, True, "bare cd and ;, a sending script under HOME is caught"),
        ("cd -P && python3 job.py", HOME_SEND, True, "bare cd with an option, a sending script under HOME is caught"),
        ("cd -- && node job.mjs", HOME_SEND, True, "bare cd --, a sending node script under HOME is caught"),
        ("cd && python3 job.py", HOME_CLEAN, False, "bare cd, a harmless script under HOME passes"),
        # the next segment's first word is no longer read as the cd's target: the script is judged under HOME
        ("cd && $X; python3 job.py", HOME_SEND, True, "bare cd, then a variable command: judged under HOME"),
        ("cd && $X; python3 job.py", HOME_CLEAN, False, "bare cd, then a variable command: harmless under HOME"),
    ]:
        got, reasons = judge(cmd, home)
        check(f"CDGATE1108 {what}: {cmd!r} -> {want}", got is want, f"got {got} reasons={reasons!r}")

    # --- the mask's default output is unchanged for every other caller ---------------------------------------
    corpus = [
        "a $(b) c", "a `b` c", "x\ny", "echo '$(x)' \"`y`\"", 'echo "a\\"$(b)"', "a\\$(b) c\\`d",
        "cd $(pwd) && python3 job.py", "$((1+2))", "cat <<EOF\n$(x)\nEOF\n", "", "$", "$(", "`",
        "sendmail a@b.c $(cat x) `y`; ls", "a 'b\nc' d",
    ]
    has_mask = "subst_mark" in inspect.signature(ocg._mask_subshell_markers).parameters
    for cmd in corpus:
        check(f"CDGATE1108 mask default output is byte-identical to 621650b6: {cmd!r}",
              ocg._mask_subshell_markers(cmd) == _old_mask(cmd))
        if has_mask:
            marked = ocg._mask_subshell_markers(cmd, ocg._SUBST_MARK)
            check(f"CDGATE1108 the marked mask differs only by the marker: {cmd!r}",
                  marked.replace(ocg._SUBST_MARK, "") == _old_mask(cmd))
    check("CDGATE1108 the mask takes a marker switch (subst_mark)", has_mask)

    # --- end to end through the hook process: the deny names the reason, no marker leaks ---------------------
    stores = {level: make_store(D, level) for level in (1, 2)}

    def run_gate(command, level, home=HOME_CLEAN):
        store = stores[level]
        env = dict(os.environ, EMAIL_APPROVAL_GATE_STORE=store, HOME=home,
                   OUTGOING_COPY_GATE_RULES=os.path.join(store, "no-rules.json"))
        payload = {"tool_name": "Bash", "tool_input": {"command": command}, "cwd": D}
        p = subprocess.run([sys.executable, GATE], input=json.dumps(payload).encode(),
                           capture_output=True, env=env)
        return p.returncode, p.stderr.decode("utf-8", errors="replace")

    for level in (1, 2):
        for cmd in ("cd $(mktemp -d) && python3 job.py", "cd x$(echo y) && python3 job.py",
                    "cd `pwd` && python3 job.py"):
            code, err = run_gate(cmd, level)
            check(f"CDGATE1108 hook level {level}: {cmd!r} is DENIED", code == 2, f"exit={code} err={err[:300]!r}")
            check(f"CDGATE1108 hook level {level}: {cmd!r} the deny names the non-literal cd",
                  LEAD_CD in err, f"err={err[:400]!r}")
            check(f"CDGATE1108 hook level {level}: {cmd!r} no marker in the deny (raw or escaped)",
                  "\x00" not in err and "\\x00" not in err and "\\u0000" not in err, f"err={err[:400]!r}")
        code, err = run_gate("cd sub && python3 job.py", level)
        check(f"CDGATE1108 hook level {level}: a literal cd with a harmless script passes",
              code == 0, f"exit={code} err={err[:300]!r}")
        code, err = run_gate("cd && python3 job.py", level, HOME_SEND)
        check(f"CDGATE1108 hook level {level}: bare cd, a sending script under HOME is DENIED",
              code == 2, f"exit={code} err={err[:300]!r}")
finally:
    if OLD_HOME is None:
        os.environ.pop("HOME", None)
    else:
        os.environ["HOME"] = OLD_HOME
    if os.path.isdir(D):
        shutil.rmtree(D, ignore_errors=True)

print()
if failed:
    print(f"{len(failed)} FAILED: {failed}", file=sys.stderr)
    sys.exit(1)
print("All email-approval-gate-cd-target tests passed.")
