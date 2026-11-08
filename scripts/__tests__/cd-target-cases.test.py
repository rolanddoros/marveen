"""JSCD1108: the python side of the shared cd-target cases (scripts/hooks/cd-target-cases.json).

script_run_sends (outgoing-copy-gate.py, the main agent's approval gate) must answer each case's `py`; the JS twin
(scripts/email-send-gate.mjs, the sub-agent hard gate) answers `js` in src/__tests__/cd-target-cases.test.ts. A case
with py != js must name its reason, and js true -> py true holds for every case (the JS twin is never stricter).

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import importlib.util
import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HOOKS = os.path.join(os.path.dirname(HERE), "hooks")

spec = importlib.util.spec_from_file_location("outgoing_copy_gate", os.path.join(HOOKS, "outgoing-copy-gate.py"))
ocg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ocg)

with open(os.path.join(HOOKS, "cd-target-cases.json"), encoding="utf-8") as fh:
    CASES = json.load(fh)["cases"]

BODY = {
    (".py", "send"): "import smtplib\ns = smtplib.SMTP('localhost')\n",
    (".py", "harmless"): "print('x')\n",
    (".mjs", "send"): "import nodemailer from 'nodemailer'\n",
    (".mjs", "harmless"): "console.log('x')\n",
}

failed = []


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" -- {detail}" if not ok and detail else ""))
    if not ok:
        failed.append(name)


def layout(cwd, home, files):
    for rel, what in files.items():
        root, rel = (home, rel[2:]) if rel.startswith("~/") else (cwd, rel)
        path = os.path.join(root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(BODY[(os.path.splitext(rel)[1], what)])


check("JSCD1108 the shared list has cases on both sides of the py/js split",
      any(c["py"] != c["js"] for c in CASES) and any(c["py"] == c["js"] for c in CASES))
OLD_HOME = os.environ.get("HOME")
ROOT = tempfile.mkdtemp(prefix="cd-target-cases-")
try:
    for n, c in enumerate(CASES):
        check(f"JSCD1108 invariant js -> py: {c['name']}", c["py"] or not c["js"])
        if c["py"] != c["js"]:
            check(f"JSCD1108 py != js names its reason: {c['name']}", bool(c.get("reason", "").strip()))
        cwd, home = os.path.join(ROOT, str(n), "cwd"), os.path.join(ROOT, str(n), "home")
        os.makedirs(cwd)
        os.makedirs(home)
        layout(cwd, home, c["files"])
        os.environ["HOME"] = home
        got = ocg.script_run_sends(c["cmd"].replace("{CWD}", cwd), cwd)
        check(f"JSCD1108 py: {c['name']}: {c['cmd']!r} -> {c['py']}", got is c["py"], f"got {got}")
finally:
    if OLD_HOME is None:
        os.environ.pop("HOME", None)
    else:
        os.environ["HOME"] = OLD_HOME
    shutil.rmtree(ROOT, ignore_errors=True)

print()
if failed:
    print(f"{len(failed)} FAILED: {failed}", file=sys.stderr)
    sys.exit(1)
print("All cd-target-cases (python side) passed.")
