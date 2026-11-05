"""Secret redaction for the conversation ledger (LEDGERREDACT1105).

The ledger (conversation_log) stores every channel turn verbatim and the
SessionStart replay (ledger-replay.py) injects the recent turns into every
fresh session. Measured 2026-11-05 (fork audit, hooks-gates.md risk 1): an
outbound reply carrying a live VNC password was replayed into a new main
session. The fleet rule "always send the noVNC link AND the VNC password"
makes that systematic, so every such password used to be persisted and
re-injected.

redact(text) is applied at WRITE time (ledger_lib.log_inbound/log_outbound)
and again at REPLAY time (ledger-replay.py), defence in depth: a row written
before this module existed, or by a writer that bypasses ledger_lib, is still
masked before it reaches a model context.

Layers, each guarded on its own so one failing layer never disables the rest:
  1. EXACT known secret values read at run time, never copied anywhere: the
     VNC passwords (store/browser/vnc-passwords.txt, "<agent> <password>"
     per line), the dashboard token, the fleet OAuth token, and secret-named
     values (TOKEN/SECRET/PASSWORD/API_KEY/...) of the install and per-agent
     .env files.
  2. Generic labels: "password: X", "password=X", "jelszó: X", "jelszava: X",
     "VNC-jelszó: X", "pwd=X" -- the value after the label, whatever its shape.
  3. The credential-gate detector (credential_lib): a credential keyword
     followed on the same line by a value-shaped token.
  4. The tool-log redactor's token shapes (tool-log-capture.py
     _SECRET_PATTERNS): bearer/basic, URL userinfo, known token prefixes,
     Telegram bot tokens, JWTs, long hex blobs, KEY=value.

redact() never raises: a hook must not crash on a ledger write.
"""
import glob
import importlib.util
import os
import re

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(os.path.dirname(_HERE))

MARK_VNC = "[REDACTED:vnc]"
MARK_SECRET = "[REDACTED:secret]"
MARK_CREDENTIAL = "[REDACTED:credential]"

# Exact values shorter than this are not masked: a 3-char "secret" would
# blank out ordinary words all over the transcript.
_MIN_VNC_LEN = 4
_MIN_ENV_SECRET_LEN = 8
_ENV_SECRET_NAME = re.compile(
    r"(?i)(?:token|secret|passw(?:or)?d|passwd|api[_-]?key|_key$|credential)")

# Layer 2: a password label followed by its value. The value runs to the next
# whitespace; a value that is already a redaction marker, a placeholder in
# brackets or a shell variable reference is left alone.
_LABEL_VALUE = re.compile(
    r"(?i)(\b(?:vnc[- ]?)?(?:jelsz[oó]\w*|passw(?:or)?d\w*|passwd|pwd)\s*[:=]\s*)"
    r"(?![\[<{$])([^\s,;]+)")


def _root():
    return os.environ.get("LEDGER_REDACT_ROOT") or _ROOT


def _vnc_file():
    return os.environ.get("LEDGER_VNC_PASSWORDS_FILE") or os.path.join(
        _root(), "store", "browser", "vnc-passwords.txt")


def _read(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read()
    except (OSError, UnicodeDecodeError):
        return ""


def _vnc_passwords():
    out = []
    for line in _read(_vnc_file()).splitlines():
        parts = line.split()
        # "<agent> <password>"; a single-field line is taken as a bare password.
        value = parts[-1] if parts and not line.lstrip().startswith("#") else ""
        if len(value) >= _MIN_VNC_LEN:
            out.append(value)
    return out


def _env_secrets(path):
    out = []
    for line in _read(path).splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key.startswith("export "):
            key = key[len("export "):].strip()
        value = value.strip().strip("'\"")
        if _ENV_SECRET_NAME.search(key) and len(value) >= _MIN_ENV_SECRET_LEN:
            out.append(value)
    return out


def _known_secrets():
    """[(value, marker)], longest first so a value containing another is
    replaced whole. Read on every call: hooks are short-lived processes and
    a rotated password must be masked from its first use."""
    pairs = {}
    for v in _vnc_passwords():
        pairs[v] = MARK_VNC
    root = _root()
    for name in (".dashboard-token", ".claude-oauth-token"):
        v = _read(os.path.join(root, "store", name)).strip()
        if len(v) >= _MIN_ENV_SECRET_LEN:
            pairs.setdefault(v, MARK_SECRET)
    for env in [os.path.join(root, ".env")] + sorted(glob.glob(os.path.join(root, "agents", "*", ".env"))):
        for v in _env_secrets(env):
            pairs.setdefault(v, MARK_SECRET)
    return sorted(pairs.items(), key=lambda kv: len(kv[0]), reverse=True)


def _redact_known(text, counts):
    for value, mark in _known_secrets():
        n = text.count(value)
        if n:
            text = text.replace(value, mark)
            counts[mark] = counts.get(mark, 0) + n
    return text


def _redact_labels(text, counts):
    def sub(m):
        counts[MARK_CREDENTIAL] = counts.get(MARK_CREDENTIAL, 0) + 1
        return m.group(1) + MARK_CREDENTIAL
    return _LABEL_VALUE.sub(sub, text)


_cred_cfg = None


def _credential_cfg():
    global _cred_cfg
    if _cred_cfg is None:
        import sys
        if _HERE not in sys.path:
            sys.path.insert(0, _HERE)
        import credential_lib
        try:
            cfg = credential_lib.load_config()
        except credential_lib.GateConfigError:
            # A broken install config must not turn redaction off: defaults.
            cfg = dict(credential_lib.DEFAULTS)
            cfg["_kw_re"] = re.compile(
                r"(?<!\w)(?:" + "|".join(f"(?:{k})" for k in cfg["keywords"]) + r")(?!\w)",
                re.IGNORECASE)
            cfg["_glue"] = {g.lower() for g in cfg["glue_words"]}
        _cred_cfg = (credential_lib, cfg)
    return _cred_cfg


def _redact_detector(text, counts):
    """credential_lib's keyword + value-shaped-token detector, by POSITION (a
    bare-word value such as "admin: roland" must not blank every "roland" in
    the turn). Runs on a length-preserving preparation (non-newline whitespace
    -> space) so the offsets map back onto the original text."""
    lib, cfg = _credential_cfg()
    prepared = lib._WS_BUT_NEWLINE.sub(" ", text)
    spans = []
    for m in cfg["_kw_re"].finditer(prepared):
        tok_start = m.start()
        while tok_start > 0 and not prepared[tok_start - 1].isspace():
            tok_start -= 1
        head = prepared[tok_start:m.start()].lower()
        if ("://" in head or head.startswith("www.")) and prepared[m.end():m.end() + 1] != "=":
            continue
        if prepared[m.end():m.end() + 1] == "@":
            continue
        line_end = prepared.find("\n", m.end())
        line_end = len(prepared) if line_end < 0 else line_end
        got = lib._candidate(prepared, m.end(), line_end, cfg)
        if got:
            start, value = got
            if prepared[start:start + len(value)] == value:
                spans.append((start, start + len(value)))
    if not spans:
        return text
    out, last = [], 0
    for start, end in sorted(set(spans)):
        if start < last:
            continue
        out.append(text[last:start])
        out.append(MARK_CREDENTIAL)
        last = end
        counts[MARK_CREDENTIAL] = counts.get(MARK_CREDENTIAL, 0) + 1
    out.append(text[last:])
    return "".join(out)


_toollog_redact = None


def _redact_token_shapes(text, counts):
    global _toollog_redact
    if _toollog_redact is None:
        spec = importlib.util.spec_from_file_location(
            "_ledger_toollog_capture", os.path.join(_HERE, "tool-log-capture.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _toollog_redact = mod._redact
    new = _toollog_redact(text)
    if new != text:
        counts[MARK_SECRET] = counts.get(MARK_SECRET, 0) + 1
    return new


_LAYERS = (_redact_known, _redact_labels, _redact_detector, _redact_token_shapes)


def redact_with_counts(text):
    """(redacted_text, {marker: hits}). Counts only, never the values."""
    counts = {}
    if not isinstance(text, str) or not text:
        return text, counts
    for layer in _LAYERS:
        try:
            text = layer(text, counts)
        except Exception:
            continue  # one broken layer must not disable the others
    return text, counts


def redact(text):
    return redact_with_counts(text)[0]
