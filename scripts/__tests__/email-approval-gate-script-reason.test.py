"""EGATEREASON1108: the approval gate's deny names the real reason of a fail-closed script verdict.

script_run_sends (outgoing-copy-gate.py) calls a script run a send when it cannot read what runs: a `$VAR`, a glob
or `{` in the script path, or a script that is not on disk when the hook runs (missing, or written by a heredoc in
the same command). The deny then read only "email_send level 1", which looked like a verdict on the script's
content (Johnny 14000: `S=...; python3 -I $S/sched_patch.py ...` and a heredoc-written read-only Gmail script).

Pinned here: the verdict is unchanged (still a send, with and without the reasons list), the reason is recorded,
and the hook's deny leads with it at level 1 and level 2; a content send and a harmless script get no such lead.

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import importlib.util
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

# A read-only script in the shape of Johnny's schedule patch: urllib + json, Hungarian mail words in a literal.
READ_ONLY = ("import json, sys, urllib.request\n"
             "note = 'a levelkuldes-jovahagyasi kapu ... kuldesnek veszi, pedig csak olvas (Gmail-szkriptet)'\n"
             "json.dump({'prompt': note}, open(sys.argv[1], 'w'))\n")
SMTP_SEND = "import smtplib\ns = smtplib.SMTP('localhost')\n"

NOT_LITERAL, NOT_READABLE = ocg.SCRIPT_NOT_LITERAL, ocg.SCRIPT_NOT_READABLE
LEAD_LITERAL = "Az elso tiltott resz oka: a futtatott szkript utja nem szo szerinti"
# Ron N-1 / mutant G15: the lead is about the first refused part only, never an absolute verdict on the content
CLAUSE = ("Ennek a resznek a tiltasa NEM a szkript tartalmarol szol; a parancs tobbi reszet a kapu ettol "
          "fuggetlenul is tilthatja.")
LEAD_READABLE = "a hivas pillanataban nem olvashato"
FIX = "Megoldas: szo szerinti abszolut uttal futtass egy MAR LETEZO fajlt"

D = tempfile.mkdtemp(prefix="gate-script-reason-")
try:
    def put(name, text, mode=None):
        path = os.path.join(D, name)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        if mode:
            os.chmod(path, mode)
        return path

    put("sched_patch.py", READ_ONLY)
    put("smtp-send.py", SMTP_SEND)
    heredoc_body = "import json\nprint(json.dumps({'ok': 1}))\n"

    # (command, cwd, reason, script named in the reason, what)
    cases = [
        (f"S={D}; python3 -I $S/sched_patch.py $S/out.json", "/", NOT_LITERAL, "$S/sched_patch.py",
         "Johnny (2): $S in the script path"),
        (f"S={D}; cat > $S/mail24.py <<'PY'\n{heredoc_body}PY\npython3 -I $S/mail24.py", "/", NOT_LITERAL,
         "$S/mail24.py", "Johnny (1): heredoc to $S/x.py, run in the same command"),
        (f"python3 -I {D}/sched_*.py {D}/out.json", D, NOT_LITERAL, f"{D}/sched_*.py", "a glob in the script path"),
        (f"python3 {D}/{{sched_patch,x}}.py", D, NOT_LITERAL, f"{D}/{{sched_patch,x}}.py", "a brace in the script path"),
        (f"python3 -I {D}/nope.py", D, NOT_READABLE, f"{D}/nope.py", "a missing script, literal path"),
        (f"cat > {D}/h.py <<'PY'\n{heredoc_body}PY\npython3 -I {D}/h.py", D, NOT_READABLE, f"{D}/h.py",
         "heredoc to a literal path, run in the same command"),
        ('cd "$X" && python3 sched_patch.py', D, NOT_LITERAL, "sched_patch.py", "a relative script after a variable cd"),
        ('cd "$X" && ./direct-rel.py', D, NOT_LITERAL, "./direct-rel.py", "a directly executed file after a variable cd"),
        (f"{D}/nope-direct.py", D, NOT_READABLE, f"{D}/nope-direct.py", "a directly executed missing .py"),
        ("$S/direct.py", D, NOT_LITERAL, "$S/direct.py", "a directly executed .py through a variable"),
        (f"bash -c 'python3 -I $S/x.py'", D, NOT_LITERAL, "$S/x.py", "the reason passes through a shell -c string"),
    ]
    for cmd, cwd, reason, script, what in cases:
        reasons = []
        got = ocg.script_run_sends(cmd, cwd, reasons=reasons)
        plain = ocg.script_run_sends(cmd, cwd)
        check(f"EGATEREASON1108 still a send (with reasons): {what}", got is True, f"got {got}")
        check(f"EGATEREASON1108 still a send (default call): {what}", plain is True, f"got {plain}")
        check(f"EGATEREASON1108 reason recorded: {what}", reasons[:1] == [(reason, script)], f"got {reasons}")

    for cmd, want, what in [
        (f"python3 -I {D}/smtp-send.py", True, "a content send (smtplib import)"),
        (f"python3 -I {D}/sched_patch.py {D}/out.json", False, "the read-only script by its literal path"),
    ]:
        reasons = []
        got = ocg.script_run_sends(cmd, D, reasons=reasons)
        check(f"EGATEREASON1108 control, {what}: verdict {want}", got is want, f"got {got}")
        check(f"EGATEREASON1108 control, {what}: no fail-closed reason", reasons == [], f"got {reasons}")

    # end to end through the hook process: the deny leads with the reason, the level text is still there
    stores = {1: make_store(D, 1), 2: make_store(D, 2)}

    def run_gate(command, level, cwd=D):
        env = dict(os.environ, EMAIL_APPROVAL_GATE_STORE=stores[level],
                   OUTGOING_COPY_GATE_RULES=os.path.join(stores[level], "no-rules.json"))
        payload = {"tool_name": "Bash", "tool_input": {"command": command}, "cwd": cwd}
        p = subprocess.run([sys.executable, GATE], input=json.dumps(payload).encode(), capture_output=True, env=env)
        return p.returncode, p.stderr.decode()

    for cmd, cwd, reason, script, what in cases:
        lead = LEAD_LITERAL if reason == NOT_LITERAL else LEAD_READABLE
        for level in (1, 2):
            code, err = run_gate(cmd, level, cwd)
            check(f"EGATEREASON1108 hook level {level} still DENIES: {what}", code == 2, f"exit={code}")
            body = err.split("\n", 1)[1] if "\n" in err else ""
            check(f"EGATEREASON1108 hook level {level} leads with the reason: {what}",
                  body.startswith("Az elso tiltott resz oka:") and lead in err and repr(script) in err and FIX in err,
                  f"err={err[:400]!r}")
            check(f"EGATEREASON1108 hook level {level} says it is about the first refused part only: {what}",
                  CLAUSE in err, f"err={err[:400]!r}")
        code, err = run_gate(cmd, 1, cwd)
        check(f"EGATEREASON1108 hook level 1 keeps the level text: {what}",
              "autonomia-szint 1" in err, f"err={err[:400]!r}")

    code, err = run_gate(f"python3 -I {D}/smtp-send.py", 1)
    check("EGATEREASON1108 hook: a content send is DENIED without the fail-closed lead",
          code == 2 and "tiltott resz oka" not in err and "autonomia-szint 1" in err, f"exit={code} err={err[:300]!r}")

    # Ron N-1: a mixed command. The scan stops at the first fail-closed part; the lead names that part and says the
    # rest may still be refused. With that part fixed, the real content send behind it is refused on its own.
    mixed = f"S={D}; python3 -I $S/x.py; python3 -I {D}/smtp-send.py"
    code, err = run_gate(mixed, 1)
    check("EGATEREASON1108 mixed command: DENIED, the lead names the first (non-literal) part",
          code == 2 and LEAD_LITERAL in err and repr("$S/x.py") in err, f"exit={code} err={err[:400]!r}")
    check("EGATEREASON1108 mixed command: the lead says the rest of the command may still be refused",
          CLAUSE in err, f"err={err[:400]!r}")
    code, err = run_gate(f"python3 -I {D}/sched_patch.py {D}/out.json; python3 -I {D}/smtp-send.py", 1)
    check("EGATEREASON1108 mixed command, first part fixed: the content send is DENIED on its own, no fail-closed lead",
          code == 2 and "tiltott resz oka" not in err and "autonomia-szint 1" in err, f"exit={code} err={err[:300]!r}")

    # Ron N-2: the echoed path is cut at 200 characters, with a marker; the cut part is still repr()-escaped
    long_script = "/" + "a" * 5000 + ".py"
    code, err = run_gate(f"python3 -I {long_script}", 1)
    lead_line = err.split("\n")[1] if err.count("\n") >= 1 else ""
    check("EGATEREASON1108 a 5000-character path: still DENIED", code == 2, f"exit={code}")
    check("EGATEREASON1108 a 5000-character path: the first 200 characters, then the cut marker",
          repr(long_script[:200]) + "...(+4804 karakter levagva)" in err, f"lead={lead_line[:300]!r}")
    check("EGATEREASON1108 a 5000-character path: the lead line stays short (under 700 characters)",
          0 < len(lead_line) < 700 and long_script[:201] not in err, f"len={len(lead_line)}")
    edge = "/" + "b" * 196 + ".py"  # exactly 200 characters: echoed whole, no marker
    code, err = run_gate(f"python3 -I {edge}", 1)
    check("EGATEREASON1108 a path of exactly 200 characters: echoed whole, no cut marker",
          len(edge) == 200 and repr(edge) in err and "levagva" not in err, f"err={err[:300]!r}")
    code, err = run_gate(f"python3 -I {D}/sched_patch.py {D}/out.json", 1)
    check("EGATEREASON1108 hook: the read-only script by its literal path passes, Hungarian mail words and all",
          code == 0, f"exit={code} err={err[:300]!r}")
finally:
    if os.path.isdir(D):
        shutil.rmtree(D, ignore_errors=True)

print()
if failed:
    print(f"{len(failed)} FAILED: {failed}", file=sys.stderr)
    sys.exit(1)
print("All email-approval-gate-script-reason tests passed.")
