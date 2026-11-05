#!/usr/bin/env python3
"""LEDGERREDACT1105: secrets never persisted into, nor replayed from, the
conversation ledger.

Measured 2026-11-05 (fork audit, hooks-gates.md risk 1): the SessionStart
replay injected an outbound reply carrying a live VNC password into a fresh
main session. This suite pins, behaviourally:

  - WRITE: log_outbound / log_inbound store the turn with every secret shape
    masked (VNC password read from the install's password file, dashboard
    token, a secret-named .env value, a Telegram bot token, generic
    "password=" / "jelszó:" labels, the credential-gate detector form), and the
    secret is nowhere in the stored row;
  - REPLAY: a row that bypassed ledger_lib (raw INSERT, i.e. a pre-fix row) is
    masked in the SessionStart hook's actual stdout;
  - KEEP: ordinary text, the noVNC link and a bare word that only appears as a
    credential value elsewhere in the turn stay readable;
  - redaction is stable when applied twice (write time, then replay time).

Every fabricated secret is ASSEMBLED at run time, so no literal secret shape
sits in this file. Run: python3 <thisfile>   Exit 0 = all pass.
"""
import json
import os
import sqlite3
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HOOKS = os.path.join(os.path.dirname(HERE), "hooks")

TMP = tempfile.mkdtemp(prefix="ledger-redact-test-")
ROOT = os.path.join(TMP, "install")
os.makedirs(os.path.join(ROOT, "store", "browser"))
os.makedirs(os.path.join(ROOT, "agents", "iris"))

VNC_JOHNNY = "Vq" + "7rT2" + "xk"
VNC_IRIS = "pl" + "mnbv" + "c9"
DASH = "d1e2" * 16
ENV_SECRET = "envSecret" + "Value" + "_42x"
AGENT_ENV_SECRET = "agentKey" + "Zz" + "98765"
BOT = "8" + "123456789" + ":" + "AAH" + "q1W2e3R4t5Y6u7I8o9P0aSdFgHjKl"
PASS_EQ = "Pw" + "d_" + "553311"
JELSZO = "Jx" + "9" + "kalap"

with open(os.path.join(ROOT, "store", "browser", "vnc-passwords.txt"), "w") as fh:
    fh.write(f"johnny {VNC_JOHNNY}\niris {VNC_IRIS}\n")
with open(os.path.join(ROOT, "store", ".dashboard-token"), "w") as fh:
    fh.write(DASH + "\n")
with open(os.path.join(ROOT, ".env"), "w") as fh:
    fh.write(f"WEB_PORT=3420\nSOME_API_TOKEN={ENV_SECRET}\nOWNER_NAME=Gazda\n")
with open(os.path.join(ROOT, "agents", "iris", ".env"), "w") as fh:
    fh.write(f'export SERVICE_KEY="{AGENT_ENV_SECRET}"\n')

DB = os.path.join(TMP, "ledger.db")
ENV = {
    "LEDGER_REDACT_ROOT": ROOT,
    "LEDGER_DB_PATH": DB,
    "CREDENTIAL_GATE_STORE": os.path.join(TMP, "credstore"),
    "MARVEEN_AGENT_ID": "johnny",
    "MAIN_AGENT_ID": "johnny",
    "OWNER_NAME": "Gazda",
}
os.environ.update(ENV)
sys.path.insert(0, HOOKS)
import ledger_lib  # noqa: E402
import ledger_redact  # noqa: E402

failed = []


def check(name, ok):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}")
    if not ok:
        failed.append(name)


def stored(direction):
    con = sqlite3.connect(DB)
    try:
        return [r[0] for r in con.execute(
            "SELECT text FROM conversation_log WHERE direction=? ORDER BY id", (direction,))]
    finally:
        con.close()


SECRETS = [VNC_JOHNNY, VNC_IRIS, DASH, ENV_SECRET, AGENT_ENV_SECRET, BOT, PASS_EQ, JELSZO]

print("write time")
out_text = (
    f"Lépj be ide: http://10.0.0.5:6080/vnc.html , VNC-jelszó: {VNC_JOHNNY}\n"
    f"Iris böngészője is kész, a jelszava a következő: {VNC_IRIS}\n"
    f"Token: {DASH}, env: {ENV_SECRET}, agent: {AGENT_ENV_SECRET}\n"
    f"bot {BOT} és password={PASS_EQ}"
)
ledger_lib.log_outbound("johnny", "100", out_text, "1")
row = stored("out")[0]
for s in SECRETS[:7]:
    check(f"outbound: secret #{SECRETS.index(s)} not stored", s not in row)
check("outbound: VNC marker present", ledger_redact.MARK_VNC in row)
check("outbound: noVNC link kept", "http://10.0.0.5:6080/vnc.html" in row)
check("outbound: ordinary words kept", "Lépj be ide" in row and "böngészője is kész" in row)

ledger_lib.log_inbound("johnny", "100", "2", f"jelszó: {JELSZO}\nadmin: roland\nköszi roland",
                       "2026-11-05T10:00:00Z")
row_in = stored("in")[0]
check("inbound: jelszó value not stored", JELSZO not in row_in)
check("inbound: detector value masked by position, the same word elsewhere kept",
      "admin: " + ledger_redact.MARK_CREDENTIAL in row_in and "köszi roland" in row_in)

print("redaction helper")
plain = "Holnap 9-kor megnézem a kanbant, a PR #2276 már bent van."
check("plain text unchanged", ledger_redact.redact(plain) == plain)
once = ledger_redact.redact(out_text)
twice = ledger_redact.redact(once)
check("double redaction leaks nothing", not any(s in twice for s in SECRETS))
check("double redaction keeps the link", "http://10.0.0.5:6080/vnc.html" in twice)
txt, counts = ledger_redact.redact_with_counts(out_text)
check("counts report the VNC hits", counts.get(ledger_redact.MARK_VNC) == 2)
check("non-string passes through", ledger_redact.redact(None) is None)

print("replay time (a row that bypassed ledger_lib)")
con = sqlite3.connect(DB)
con.execute(
    "INSERT INTO conversation_log (agent_id, chat_id, direction, message_id, text, ts, created_at)"
    " VALUES ('johnny', '100', 'out', '3', ?, '2026-11-05T10:01:00Z', 4102444800)",
    (f"régi sor, VNC jelszó {VNC_IRIS}, token {DASH}",))
con.commit()
con.close()
check("precondition: the raw row holds the secret", any(VNC_IRIS in t for t in stored("out")))
res = subprocess.run([sys.executable, os.path.join(HOOKS, "ledger-replay.py")],
                     input=json.dumps({"hook_event_name": "SessionStart"}),
                     capture_output=True, text=True, env={**os.environ, **ENV}, timeout=60)
check("replay exits 0", res.returncode == 0)
ctx = ""
try:
    ctx = json.loads(res.stdout)["hookSpecificOutput"]["additionalContext"]
except Exception:
    pass
check("replay produced context", "régi sor" in ctx)
check("replay: no secret in the injected context", not any(s in res.stdout for s in SECRETS))

if failed:
    print(f"FAILED: {len(failed)}")
    sys.exit(1)
print("all pass")
