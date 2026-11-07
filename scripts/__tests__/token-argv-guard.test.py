"""C1 PR 13b: scripts/hooks/token-argv-guard.py, the PreToolUse hook that warns when a Bash command puts
the dashboard token on a process argv.

The hook runs as Claude Code runs it: a subprocess, the PreToolUse payload on stdin. Every input comes
from the tables below and uses a placeholder path (/srv/demo/...); no token value appears anywhere.

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
HOOK = os.path.join(ROOT, "scripts", "hooks", "token-argv-guard.py")
ME = "tester"
TRANSCRIPT = os.path.join(ROOT, "agents", ME, ".claude-config", "projects", "x", "s.jsonl")

P = "/srv/demo/store/.dashboard-token"          # placeholder path, the store's token file
OWN = "/srv/demo/agents/demo/.dashboard-token"   # placeholder path, an agent's own copy
URL = "http://localhost:3420/api/memories?q=SENTINEL-4417"
TMP = tempfile.mkdtemp(prefix="token-argv-guard-")
LOG = os.path.join(TMP, "token-argv-guard.log")

failed = []


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" -- {detail}" if not ok and detail else ""))
    if not ok:
        failed.append(name)


def run(cmd, mode="warn", tool="Bash", raw=None, extra_env=None):
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": TMP, "LANG": "C.UTF-8",
           "TOKEN_ARGV_GUARD_LOG": LOG}
    if mode is not None:
        env["TOKEN_ARGV_GUARD"] = mode
    env.update(extra_env or {})
    payload = raw if raw is not None else json.dumps(
        {"hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": {"command": cmd},
         "transcript_path": TRANSCRIPT, "cwd": TMP, "session_id": "s1"})
    p = subprocess.run([sys.executable, HOOK], input=payload.encode(), capture_output=True, env=env, timeout=30)
    return p.returncode, p.stdout.decode(), p.stderr.decode()


def context(out):
    try:
        return json.loads(out)["hookSpecificOutput"]["additionalContext"]
    except (ValueError, KeyError, TypeError):
        return None


def log_lines():
    try:
        with open(LOG, encoding="utf-8") as fh:
            return [json.loads(l) for l in fh if l.strip()]
    except FileNotFoundError:
        return []


def reset_log():
    if os.path.exists(LOG):
        os.remove(LOG)


# (case, command, expected rule) -- every row must fire, in warn mode, with exactly this rule
HITS = [
    ("the old CLAUDE.md curl recipe (store token)",
     f'curl -s -H "Authorization: Bearer $(cat {P})" "{URL}"', "subst-read"),
    ("the old CLAUDE.md curl recipe (the agent's own token)",
     f'curl -s -H "Authorization: Bearer $(cat {OWN})" "{URL}"', "subst-read"),
    ("assignment T=$(cat ...) and $T later",
     f'T=$(cat {P}); curl -s -H "Authorization: Bearer $T" "{URL}"', "subst-read"),
    ("export with tr and a $HOME path",
     'export TOKEN=$(tr -d \'\\n\' < "$HOME/.dashboard-token")', "subst-read"),
    ("$(<file)", f'curl -s -H "Authorization: Bearer $(<{P})" "{URL}"', "subst-read"),
    ("backtick", f'curl -s -H "Authorization: Bearer `cat {P}`" "{URL}"', "subst-read"),
    ("unquoted backtick in an assignment", f"T=`cat {P}`", "subst-read"),
    ("nested substitution", f'echo "$(printf %s "$(cat {P})")"', "subst-read"),
    ("a substitution inside ${X:-...}", f'echo "${{TOKEN:-$(cat {P})}}"', "subst-read"),
    ("a substitution in an unquoted heredoc body (the shell expands it)",
     f"cat > req.txt <<EOF\nAuthorization: Bearer $(cat {P})\nEOF", "subst-read"),
    ("a helper call later in the same command does not exempt the recipe",
     f'curl -s -H "Authorization: Bearer $(cat {P})" "{URL}"; bash scripts/marveen-api.sh daily-log demo /srv/demo/n.txt',
     "subst-read"),
    ("read T < file and $T later",
     f'read -r T < {P}; curl -s -H "Authorization: Bearer $T" "{URL}"', "read-taint"),
    ("IFS= read with a prefix assignment",
     f'IFS= read -r TOK < {P} && curl -s -H "Authorization: Bearer ${{TOK}}" "{URL}"', "read-taint"),
    ("mapfile and an array element later",
     f'mapfile -t A < {P}; curl -s -H "Authorization: Bearer ${{A[0]}}" "{URL}"', "read-taint"),
    ("read without a name fills REPLY",
     f'read < {P}; curl -s -H "Authorization: Bearer $REPLY" "{URL}"', "read-taint"),
    ("a while-read loop fed from the file",
     f'while read -r T; do curl -s -H "Authorization: Bearer $T" "{URL}"; done < {P}', "read-taint"),
]

# (case, command) -- none of these may fire
CLEAN = [
    ("a helper call", "bash scripts/marveen-api.sh memory-search demo kulcs"),
    ("a helper call with the token file in its environment",
     f"MARVEEN_TOKEN_FILE={P} bash scripts/marveen-api.sh memory-list demo hot"),
    ("a helper call inside a substitution, the token file in its environment",
     f"OUT=$(MARVEEN_TOKEN_FILE={P} bash scripts/marveen-api.sh memory-list demo hot)"),
    ("the agent-msg helper inside a substitution",
     f"R=$(MARVEEN_TOKEN_FILE={P} scripts/agent-msg.sh demo kevin - < /srv/demo/m.txt)"),
    ("python3 -c opening the file in-process",
     f"python3 -c \"import json; t=open('{P}').read().strip(); print(len(t))\""),
    ("ls -l on the file", f"ls -l {P}"),
    ("stat on the file", f"stat -c %a {P}"),
    ("chmod on the file", f"chmod 600 {P}"),
    ("an inspecting command inside a substitution", f'[ "$(stat -c %a {P})" = 600 ] && echo ok'),
    ("a hash of the file inside a substitution", f"H=$(sha256sum {P})"),
    ("single-quoted text", f"echo '$(cat {P})'"),
    ("a quoted heredoc body (inert text)", f"cat > note.md <<'EOF'\nold recipe: $(cat {P})\nEOF"),
    ("a comment", f"ls  # $(cat {P})"),
    ("read without a later expansion", f"read -r T < {P}"),
    ("a variable expanded BEFORE the read", f'echo "$T"; read -r T < {P}'),
    ("another file whose name only starts with .dashboard-token", f"X=$(cat {P}.bak)"),
    ("reading the file to stdout (not an argv)", f"grep -c . {P}"),
]

# (case, command, warn fires?, enforce exit code)
UNPARSED = [
    ("unterminated double quote with a substitution marker", f'curl -H "Authorization: Bearer $(cat {P})', True, 2),
    ("unterminated $( )", f"T=$(cat {P}", True, 2),
    ("unterminated single quote, no substitution marker", f"ls {P} 'oops", False, 0),
    ("unterminated heredoc, no substitution marker", f"cat {P} <<EOF\nbody", False, 0),
]

try:
    for name, cmd, rule in HITS:
        reset_log()
        rc, out, err = run(cmd)
        ctx = context(out)
        check(f"C1 PR 13b hit: {name} -> warn, rule {rule}",
              rc == 0 and ctx is not None and f"rule {rule}:" in ctx, f"rc={rc} ctx={ctx!r}")
    for name, cmd in CLEAN:
        reset_log()
        rc, out, err = run(cmd)
        check(f"C1 PR 13b no hit: {name}", rc == 0 and out == "" and err == "" and log_lines() == [],
              f"rc={rc} out={out!r} err={err!r}")
    for name, cmd, fires, enforce_rc in UNPARSED:
        reset_log()
        rc, out, _ = run(cmd)
        ctx = context(out)
        check(f"C1 PR 13b parse error, warn: {name} -> " + ("warning, rule unparsed" if fires else "silent"),
              rc == 0 and ((ctx is not None and "rule unparsed:" in ctx) if fires else out == ""), f"rc={rc} out={out!r}")
        rc, out, err = run(cmd, mode="enforce")
        check(f"C1 PR 13b parse error, enforce: {name} -> exit {enforce_rc}",
              rc == enforce_rc and out == "" and (("rule unparsed:" in err) if enforce_rc == 2 else err == ""),
              f"rc={rc} err={err!r}")

    # the three modes on the old recipe
    recipe = HITS[0][1]
    reset_log()
    rc, out, err = run(recipe)
    ctx = context(out)
    lines = log_lines()
    check("C1 PR 13b warn: exit 0, PreToolUse additionalContext with the helper recipe, nothing on stderr",
          rc == 0 and err == "" and json.loads(out)["hookSpecificOutput"]["hookEventName"] == "PreToolUse"
          and "bash scripts/marveen-api.sh" in ctx and "warn mode, the command still runs" in ctx, f"rc={rc} out={out!r}")
    check("C1 PR 13b warn: no permission decision (the call runs normally)", "permissionDecision" not in out, out)
    check("C1 PR 13b warn: exactly one log line with time, agent, mode, rule and the command's sha256",
          len(lines) == 1 and set(lines[0]) == {"t", "agent", "mode", "rule", "sha256"}
          and lines[0]["agent"] == ME and lines[0]["mode"] == "warn" and lines[0]["rule"] == "subst-read"
          and lines[0]["sha256"] == hashlib.sha256(recipe.encode()).hexdigest() and lines[0]["t"][-6] in "+-", repr(lines))
    raw_log = open(LOG, encoding="utf-8").read()
    check("C1 PR 13b warn: the log holds no command text (no URL, no path, no curl)",
          "SENTINEL-4417" not in raw_log and "dashboard-token" not in raw_log and "curl" not in raw_log, raw_log)
    check("C1 PR 13b warn: the log file is private (0600)", (os.stat(LOG).st_mode & 0o777) == 0o600, oct(os.stat(LOG).st_mode))
    check("C1 PR 13b warn: the message quotes nothing from the command", "SENTINEL-4417" not in out and "curl -s" not in out, out)

    reset_log()
    rc, out, err = run(recipe, mode="enforce")
    lines = log_lines()
    check("C1 PR 13b enforce: exit 2 with the reason on stderr, nothing on stdout",
          rc == 2 and out == "" and "BLOCKED" in err and "bash scripts/marveen-api.sh" in err and "SENTINEL-4417" not in err,
          f"rc={rc} out={out!r} err={err!r}")
    check("C1 PR 13b enforce: one log line, mode enforce", len(lines) == 1 and lines[0]["mode"] == "enforce", repr(lines))
    for name, cmd in CLEAN[:3]:
        rc, out, err = run(cmd, mode="enforce")
        check(f"C1 PR 13b enforce: no hit stays allowed ({name})", rc == 0 and out == "" and err == "", f"rc={rc} err={err!r}")

    reset_log()
    rc, out, err = run(recipe, mode="off")
    check("C1 PR 13b off: silent, exit 0, no log line", rc == 0 and out == "" and err == "" and log_lines() == [],
          f"rc={rc} out={out!r}")

    # Kevin 13564: locked like every hook that can block; the off switch is TOKEN_ARGV_GUARD=off
    for m, want_rc in (("warn", 0), ("enforce", 2)):
        rc, out, err = run(recipe, mode=m, extra_env={"MARVEEN_DISABLED_HOOKS": "tool-log-capture,token-argv-guard"})
        check(f"C1 PR 13b MARVEEN_DISABLED_HOOKS listing it does NOT disable it ({m})",
              rc == want_rc and (context(out) is not None if m == "warn" else "BLOCKED" in err), f"rc={rc} out={out!r}")
    sys.path.insert(0, os.path.join(ROOT, "scripts", "hooks"))
    import hook_switches  # noqa: E402
    check("C1 PR 13b token-argv-guard is on the built-in locked list", "token-argv-guard" in hook_switches.DEFAULT_NON_DISABLEABLE)

    reset_log()
    rc, out, err = run(recipe, mode=None)
    check("C1 PR 13b default (switch unset): warn, not enforce",
          rc == 0 and context(out) is not None and "warn mode" in context(out), f"rc={rc} out={out!r}")
    rc, out, err = run(recipe, mode="bogus")
    check("C1 PR 13b an unknown switch value: warn", rc == 0 and context(out) is not None, f"rc={rc} out={out!r}")
    rc, out, err = run(recipe, mode="ENFORCE")
    check("C1 PR 13b the switch is case-insensitive", rc == 2, f"rc={rc}")

    # the install .env pattern: environment first, then <root>/.env, then warn
    spec = importlib.util.spec_from_file_location("tag", HOOK)
    tag = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(tag)
    fake_root = os.path.join(TMP, "root")
    os.makedirs(fake_root)
    with open(os.path.join(fake_root, ".env"), "w") as fh:
        fh.write("OTHER=1\nTOKEN_ARGV_GUARD=enforce\n")
    tag.ROOT = fake_root
    saved = os.environ.pop("TOKEN_ARGV_GUARD", None)
    try:
        check("C1 PR 13b the switch from the install .env", tag.mode() == "enforce", tag.mode())
        os.environ["TOKEN_ARGV_GUARD"] = "off"
        check("C1 PR 13b the environment wins over the .env", tag.mode() == "off", tag.mode())
        del os.environ["TOKEN_ARGV_GUARD"]
        tag.ROOT = os.path.join(TMP, "no-such-root")
        check("C1 PR 13b no environment, no .env: warn", tag.mode() == "warn", tag.mode())
    finally:
        os.environ.pop("TOKEN_ARGV_GUARD", None)
        if saved is not None:
            os.environ["TOKEN_ARGV_GUARD"] = saved

    # never in the way of other tools or broken input
    for raw, what in [("not json", "garbage stdin"), ("[]", "a JSON array"),
                      (json.dumps({"tool_name": "Bash", "tool_input": "x"}), "a non-object tool_input")]:
        for m in ("warn", "enforce"):
            rc, out, err = run(None, mode=m, raw=raw)
            check(f"C1 PR 13b {what} ({m}) -> exit 0, silent", rc == 0 and out == "", f"rc={rc} out={out!r}")
    rc, out, err = run(recipe, mode="enforce", tool="Write")
    check("C1 PR 13b another tool -> exit 0, silent", rc == 0 and out == "" and err == "", f"rc={rc}")
    rc, out, err = run(recipe, extra_env={"TOKEN_ARGV_GUARD_LOG": os.path.join(TMP, "no-such-dir", "x.log")})
    check("C1 PR 13b warn with an unwritable log: still exit 0 and the warning", rc == 0 and context(out) is not None,
          f"rc={rc} out={out!r}")
    rc, out, err = run(recipe, mode="enforce", extra_env={"TOKEN_ARGV_GUARD_LOG": os.path.join(TMP, "no-such-dir", "x.log")})
    check("C1 PR 13b enforce with an unwritable log: still exit 2", rc == 2, f"rc={rc}")
    rc, out, err = run(recipe, extra_env={"MARVEEN_HOOK_INPUT_MAX_BYTES": "64"})
    check("C1 PR 13b an oversize payload -> exit 0, silent (never blocks)", rc == 0 and out == "", f"rc={rc} out={out!r}")
    rc, out, err = run(recipe, mode="enforce", extra_env={"MARVEEN_HOOK_INPUT_MAX_BYTES": "64"})
    check("C1 PR 13b an oversize payload in enforce -> exit 0", rc == 0, f"rc={rc}")
finally:
    shutil.rmtree(TMP, ignore_errors=True)

print()
if failed:
    print(f"{len(failed)} FAILED: {failed}", file=sys.stderr)
    sys.exit(1)
print("All token-argv-guard tests passed.")
