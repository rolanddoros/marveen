#!/usr/bin/env python3
"""PreToolUse hook (matcher: Bash): warn when a command puts the dashboard token on a process argv.

WHY (C1 PR 13b, design 2.4 b). The fleet's dashboard token sits in a file named .dashboard-token. The
old CLAUDE.md recipes read it into the command text: `curl -H "Authorization: Bearer $(cat
<root>/store/.dashboard-token)" ...`. The shell expands the substitution BEFORE curl starts, so the
token value ends up on curl's argv, which every process of the same user can read (ps,
/proc/<pid>/cmdline). The helper `scripts/marveen-api.sh` reads the token itself and never puts it
on an argv; this hook points to it.

WHAT IT FLAGS, on the command TEXT (rule ids in the log and the message):
  subst-read  a command substitution -- $( ), a backtick, $(<file) -- whose inner command reads a
              path whose last component is .dashboard-token, directly (`$(cat .../.dashboard-token)`)
              or inside an assignment (`T=$(cat ...)`);
  read-taint  `read` / `mapfile` / `readarray` from such a file (`read T < .../.dashboard-token`,
              also `while read ...; done < file`), and that variable expanded later in the same
              command;
  unparsed    the text could not be parsed, and it names .dashboard-token next to a substitution
              marker ($( or a backtick).
NOT flagged: the helpers as the command word inside a substitution (scripts/marveen-api.sh,
scripts/agent-msg.sh, scripts/daily-log.sh: they read the token themselves, so a path in their
environment assignment stays off every argv); a mention that is not a substitution (`ls -l`,
`stat`, `chmod` on the file, `python3 -c "...open('.../.dashboard-token')..."`: the value stays inside
the process); a substitution whose command only inspects the file (ls, stat, test, wc, a hash);
single-quoted text, comments and quoted heredoc bodies (the shell expands nothing there).

SWITCH TOKEN_ARGV_GUARD = off | warn | enforce (environment first, then the install .env, then the
default warn; an unknown value is warn):
  off      nothing;
  warn     ALWAYS exit 0; the agent gets the recipe as PreToolUse additionalContext (measured
           2026-11-07, runlogs measure-13ab-hooks: additionalContext reaches the model,
           systemMessage only the user), and one line goes to store/token-argv-guard.log;
  enforce  exit 2 with the reason on stderr (the call is blocked); the same log line. A parse error
           blocks only when the raw text names .dashboard-token AND holds a substitution marker;
           otherwise it passes.
LOCKED (Kevin 13564): token-argv-guard is on hook_switches.DEFAULT_NON_DISABLEABLE, because the repo
rule there is that every hook that can block a tool call is locked; MARVEEN_DISABLED_HOOKS does not
switch it off. TOKEN_ARGV_GUARD=off does. An oversize payload never blocks here (hook_switches'
read_hook_stdin would fail a locked hook closed, which warn mode must never do), so the size cap is
applied in this file.

LOG. One JSON line per hit: local time with offset, the agent, the mode, the rule id and the sha256
of the command. NEVER the command text: it may hold the very token this hook is about.

FAIL MODE. An internal error is treated like a parse error (above); a broken log write never
changes the verdict; warn never exits non-zero.

SCOPE, stated so a quiet run is not read as coverage: only the Bash command text. A script file
that puts the token on an argv internally, a variable that holds the PATH (`f=...; cat $f` inside a
substitution), and a value that reaches argv through another program are not visible.
"""
import datetime
import hashlib
import json
import os
import re
import sys

NAME = "token-argv-guard"
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SWITCH = "TOKEN_ARGV_GUARD"
MODES = ("off", "warn", "enforce")
DEFAULT_MODE = "warn"
LOG = os.environ.get("TOKEN_ARGV_GUARD_LOG") or os.path.join(ROOT, "store", "token-argv-guard.log")
DEFAULT_MAX_INPUT = 8 * 1024 * 1024
MAX_DEPTH = 25

TOKEN_NAME = ".dashboard-token"
# The last path component is exactly .dashboard-token (after a "/", an "=" of an assignment or
# option, or at the start of the word). \x00 stands for an expansion inside the word.
TOKEN_WORD_RX = re.compile(r"(?:^|[/=])\.dashboard-token$")
SUBST_MARKER_RX = re.compile(r"\$\(|`")
HELPERS = frozenset({"marveen-api.sh", "agent-msg.sh", "daily-log.sh"})
SHELLS = frozenset({"bash", "sh", "dash", "zsh"})
# Commands that look at the file without printing its content.
INSPECTORS = frozenset({"ls", "stat", "test", "[", "[[", "wc", "file", "du", "chmod", "chown", "touch",
                        "sha256sum", "sha1sum", "md5sum", "realpath", "readlink", "dirname", "basename"})
READERS = frozenset({"read", "mapfile", "readarray"})
WRAPPERS = frozenset({"env", "command", "builtin", "exec", "nohup", "time", "nice"})
KEYWORDS = frozenset({"if", "then", "elif", "else", "while", "until", "do", "!", "{"})
REDIRS = ("<<<", "<>", "<&", ">>", ">|", ">&", "&>>", "&>", "<", ">")
ASSIGN_RX = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(?:\[[^]]*\])?\+?=")
NAME_RX = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
IDENT_RX = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
HEREDOC_RX = re.compile(r"<<(-?)[ \t]*((?:'[^'\n]*'|\"(?:\\.|[^\"\\\n])*\"|\\.|[A-Za-z0-9_.:+@%,=-])+)")
EXPANSION = "\x00"

RULE_TEXT = {
    "subst-read": "a $( ) or backtick substitution reads the .dashboard-token file",
    "read-taint": "a variable read from the .dashboard-token file is expanded later in the same command",
    "unparsed": "the command could not be parsed, and it names .dashboard-token next to a substitution",
}


class ParseError(Exception):
    pass


class Seg(object):
    """One simple command: its words (quotes removed, an expansion as \\x00), the substitutions and
    the variable names expanded anywhere in it, and its position in reading order."""
    __slots__ = ("order", "words", "substs", "vars")

    def __init__(self, order):
        self.order = order
        self.words = []
        self.substs = []   # lists of inner Seg
        self.vars = []


class Parser(object):
    """A small shell reader: quotes, escapes, comments, heredocs, $( ), backticks, ${ }, $name.
    It only needs what the rules ask: words, substitutions and expansions, per simple command."""

    def __init__(self):
        self.count = 0
        self.segs = []

    def _seg(self):
        self.count += 1
        seg = Seg(self.count)
        self.segs.append(seg)
        return seg

    def parse(self, s):
        self.lex(s, 0, None, 0)
        return self.segs

    # -- expansions shared by every context -------------------------------------------------------
    def dollar(self, s, i, seg, word, depth):
        """s[i] == "$". Appends to `word`, records in `seg`; returns the index after the expansion."""
        n = len(s)
        nxt = s[i + 1] if i + 1 < n else ""
        if nxt == "(" and s.startswith("((", i + 1):
            j, level = i + 3, 2
            while j < n and level:
                if s[j] == "(":
                    level += 1
                elif s[j] == ")":
                    level -= 1
                j += 1
            if level:
                raise ParseError("unterminated $((")
            word.append(EXPANSION)
            return j
        if nxt == "(":
            inner, j = self.lex(s, i + 2, ")", depth + 1)
            seg.substs.append(inner)
            word.append(EXPANSION)
            return j
        if nxt == "{":
            j, level = i + 2, 1
            while j < n and level:
                if s[j] == "\\":
                    j += 2
                    continue
                if s[j] == "{":
                    level += 1
                elif s[j] == "}":
                    level -= 1
                j += 1
            if level:
                raise ParseError("unterminated ${")
            body = s[i + 2:j - 1].lstrip("!#")
            m = NAME_RX.match(body)
            if m:
                seg.vars.append(m.group(0))
                self.text(body[m.end():], seg, depth + 1)   # ${X:-$(...)} expands its default
            word.append(EXPANSION)
            return j
        m = NAME_RX.match(s, i + 1)
        if m:
            seg.vars.append(m.group(0))
            word.append(EXPANSION)
            return m.end()
        if nxt and nxt in "0123456789*@#?$!-":
            word.append(EXPANSION)
            return i + 2
        word.append("$")
        return i + 1

    def backtick(self, s, i, seg, word, depth):
        """s[i] == "`". Returns the index after the closing backtick."""
        out, j, n = [], i + 1, len(s)
        while j < n and s[j] != "`":
            if s[j] == "\\" and j + 1 < n and s[j + 1] in "`$\\":
                out.append(s[j + 1])
                j += 2
                continue
            out.append(s[j])
            j += 1
        if j >= n:
            raise ParseError("unterminated backtick")
        inner, _ = self.lex("".join(out), 0, None, depth + 1)
        seg.substs.append(inner)
        word.append(EXPANSION)
        return j + 1

    def text(self, s, seg, depth, stop_dq=False, i=0, word=None):
        """Double-quoted text (stop_dq) or a whole text where only expansions count (an unquoted
        heredoc body, the rest of a ${ }). Returns the index after the closing quote."""
        if depth > MAX_DEPTH:
            raise ParseError("too deep")
        word = [] if word is None else word
        n = len(s)
        while i < n:
            c = s[i]
            if stop_dq and c == '"':
                return i + 1
            if c == "\\" and i + 1 < n:
                if s[i + 1] in '$`"\\\n':
                    if s[i + 1] != "\n":
                        word.append(s[i + 1])
                    i += 2
                    continue
                word.append(c)
                i += 1
                continue
            if c == "$":
                i = self.dollar(s, i, seg, word, depth)
                continue
            if c == "`":
                i = self.backtick(s, i, seg, word, depth)
                continue
            word.append(c)
            i += 1
        if stop_dq:
            raise ParseError("unterminated double quote")
        return n

    # -- the unquoted context ---------------------------------------------------------------------
    def lex(self, s, i, stop, depth):
        """Read simple commands from s[i:] until `stop` (")" for $( ), None for the end).
        Returns (the commands read, the index after `stop`)."""
        if depth > MAX_DEPTH:
            raise ParseError("too deep")
        n = len(s)
        out = []
        seg = self._seg()
        word = []
        in_word = False
        heredocs = []
        paren = 0

        def end_word():
            nonlocal word, in_word
            if in_word:
                seg.words.append("".join(word))
            word, in_word = [], False

        def end_seg():
            nonlocal seg
            end_word()
            if seg.words or seg.substs or seg.vars:
                out.append(seg)
            seg = self._seg()

        while i < n:
            c = s[i]
            if stop == ")" and c == ")" and paren == 0:
                end_seg()
                return out, i + 1
            if c in " \t":
                end_word()
                i += 1
                continue
            if c == "\\":
                if i + 1 < n and s[i + 1] == "\n":
                    i += 2
                    continue
                word.append(s[i + 1] if i + 1 < n else "\\")
                in_word = True
                i += 2
                continue
            if c == "#" and not in_word:
                while i < n and s[i] != "\n":
                    i += 1
                continue
            if c == "\n":
                end_word()
                i += 1
                for body_seg, delim, quoted, dash in heredocs:
                    i = self.heredoc_body(s, i, body_seg, delim, quoted, dash, depth)
                heredocs = []
                end_seg()
                continue
            if c in ";|" or (c == "&" and not s.startswith("&>", i)):
                end_seg()
                i += 1
                continue
            if c in "<>" and s.startswith(("<(", ">("), i):
                end_word()
                inner, i = self.lex(s, i + 2, ")", depth + 1)   # process substitution: no argv
                continue
            if c == "(":
                paren += 1
                end_seg()
                i += 1
                continue
            if c == ")":
                if paren == 0:
                    raise ParseError("unbalanced )")
                paren -= 1
                end_seg()
                i += 1
                continue
            if s.startswith("<<", i) and not s.startswith("<<<", i):
                m = HEREDOC_RX.match(s, i)
                if not m:
                    raise ParseError("heredoc without a delimiter")
                raw = m.group(2)
                quoted = any(q in raw for q in "'\"\\")
                delim = re.sub(r"\\(.)", r"\1", raw.replace("'", "").replace('"', ""))
                end_word()
                seg.words.append("<<")
                heredocs.append((seg, delim, quoted, m.group(1) == "-"))
                i = m.end()
                continue
            if c in "<>&":
                op = next((r for r in REDIRS if s.startswith(r, i)), None)
                if op:
                    if not (in_word and "".join(word).isdigit()):
                        end_word()
                    else:
                        word, in_word = [], False   # 2> : the digit is the descriptor
                    seg.words.append(op)
                    i += len(op)
                    continue
            if c == "'":
                j = s.find("'", i + 1)
                if j < 0:
                    raise ParseError("unterminated single quote")
                word.append(s[i + 1:j])
                in_word = True
                i = j + 1
                continue
            if c == '"':
                in_word = True
                i = self.text(s, seg, depth + 1, stop_dq=True, i=i + 1, word=word)
                continue
            if c == "$" and s.startswith("$'", i):
                j = i + 2
                while j < n and s[j] != "'":
                    j += 2 if s[j] == "\\" else 1
                if j >= n:
                    raise ParseError("unterminated $'")
                word.append(s[i + 2:j])
                in_word = True
                i = j + 1
                continue
            if c == "$":
                in_word = True
                i = self.dollar(s, i, seg, word, depth)
                continue
            if c == "`":
                in_word = True
                i = self.backtick(s, i, seg, word, depth)
                continue
            word.append(c)
            in_word = True
            i += 1
        if stop == ")":
            raise ParseError("unterminated $(")
        if heredocs:
            raise ParseError("heredoc without a body")
        if paren:
            raise ParseError("unbalanced (")
        end_seg()
        return out, n

    def heredoc_body(self, s, i, seg, delim, quoted, dash, depth):
        """Consume one heredoc body from s[i:]; bash ends it at a line that is exactly the delimiter
        (leading tabs stripped for <<-). Returns the index after the terminator line."""
        n = len(s)
        start = i
        while i <= n:
            j = s.find("\n", i)
            line_end = n if j < 0 else j
            line = s[i:line_end]
            if (line.lstrip("\t") if dash else line) == delim:
                if not quoted:
                    self.text(s[start:i], seg, depth + 1)
                return line_end + 1 if j >= 0 else n
            if j < 0:
                break
            i = j + 1
        raise ParseError("unterminated heredoc")


def _basename(w):
    return w.rsplit("/", 1)[-1]


def command_index(words):
    """Index of the command word: past assignments, redirections (with their target) and wrappers."""
    k = 0
    while k < len(words):
        w = words[k]
        if w == "<<":
            k += 1
        elif w in REDIRS:
            k += 2
        elif ASSIGN_RX.match(w) or w in KEYWORDS:
            k += 1
        elif w in WRAPPERS:
            k += 1
            while k < len(words) and words[k].startswith("-"):
                k += 1
        else:
            return k
    return None


def is_helper(words, k):
    if _basename(words[k]) in HELPERS:
        return True
    if _basename(words[k]) in SHELLS:
        rest = [w for w in words[k + 1:] if not w.startswith("-")]
        return bool(rest) and _basename(rest[0]) in HELPERS
    return False


def names_token(word):
    return bool(TOKEN_WORD_RX.search(word))


def reads_token(seg):
    """Does this simple command (inside a substitution) read the token file?"""
    if not any(names_token(w) for w in seg.words):
        return False
    k = command_index(seg.words)
    if k is None:
        return True              # $(<file): only a redirection, its output is the file
    if is_helper(seg.words, k) or _basename(seg.words[k]) in INSPECTORS:
        return False
    return True


def redirect_targets(words):
    return [words[k + 1] for k in range(len(words) - 1) if words[k] in ("<", "<>")]


def read_names(words, k):
    """The variable names a read/mapfile/readarray command fills."""
    cmd = _basename(words[k])
    names, j = [], k + 1
    while j < len(words):
        w = words[j]
        if w in REDIRS or w == "<<":
            j += 2 if w != "<<" else 1
            continue
        if w == "-a" and j + 1 < len(words):
            names.append(words[j + 1])
            j += 2
            continue
        if IDENT_RX.match(w):
            names.append(w)
        j += 1
    if not names:
        names = ["REPLY"] if cmd == "read" else ["MAPFILE"]
    return names


def hits(cmd):
    """Rule ids that fire on the command text (may raise ParseError)."""
    segs = Parser().parse(cmd)
    found = []
    if any(reads_token(inner) for seg in segs for sub in seg.substs for inner in sub):
        found.append("subst-read")
    loop_fed = any(seg.words and seg.words[0] == "done" and any(names_token(t) for t in redirect_targets(seg.words))
                   for seg in segs)
    for seg in segs:
        k = command_index(seg.words)
        if k is None or _basename(seg.words[k]) not in READERS:
            continue
        if not (loop_fed or any(names_token(t) for t in redirect_targets(seg.words))):
            continue
        names = set(read_names(seg.words, k))
        if any(later.order > seg.order and names & set(later.vars) for later in segs):
            found.append("read-taint")
            break
    return found


def verdict(cmd):
    """(rule ids, parsed?)."""
    try:
        return hits(cmd), True
    except Exception:  # noqa: BLE001 -- a parse error or a bug in the reader: judged on the raw text
        suspect = TOKEN_NAME in cmd and bool(SUBST_MARKER_RX.search(cmd))
        return (["unparsed"] if suspect else []), False


def _install_setting(key, default):
    """Environment first, then the install .env, then the default (the email-approval-gate pattern)."""
    v = os.environ.get(key)
    if v and v.strip():
        return v.strip()
    try:
        with open(os.path.join(ROOT, ".env"), encoding="utf-8") as fh:
            for line in fh:
                if line.startswith(key + "="):
                    val = line.split("=", 1)[1].strip().strip('"').strip("'")
                    if val:
                        return val
    except Exception:  # noqa: BLE001 -- a missing .env just means the default
        pass
    return default


def mode():
    m = _install_setting(SWITCH, DEFAULT_MODE).lower()
    return m if m in MODES else DEFAULT_MODE


def _agent(payload):
    try:
        sys.path.insert(0, HERE)
        import ledger_lib  # noqa: E402
        a = ledger_lib.agent_id_from_payload(payload)
        return a if isinstance(a, str) and a else "unknown"
    except Exception:  # noqa: BLE001
        return "unknown"


def log_hit(payload, cmd, rules, current_mode):
    """One line, one O_APPEND write; never the command text. A failure is swallowed."""
    try:
        rec = {
            "t": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
            "agent": _agent(payload),
            "mode": current_mode,
            "rule": ",".join(rules),
            "sha256": hashlib.sha256(cmd.encode("utf-8", "surrogatepass")).hexdigest(),
        }
        fd = os.open(LOG, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.write(fd, (json.dumps(rec) + "\n").encode("utf-8"))
        finally:
            os.close(fd)
    except Exception:  # noqa: BLE001
        pass


def message(rules, blocked):
    what = "; ".join(RULE_TEXT[r] for r in rules)
    head = ("token-argv-guard BLOCKED this command (enforce mode)" if blocked
            else "token-argv-guard (warn mode, the command still runs)")
    return (head + ": rule " + ",".join(rules) + ": " + what + ". The token value then sits on the argv of the "
            "process that receives it, readable by every process of the same user (ps, /proc/<pid>/cmdline). "
            "Use the helper instead: bash scripts/marveen-api.sh <verb> ... reads the token itself and keeps it "
            "off every argv (verbs: bash scripts/marveen-api.sh --help).")


def _read_stdin():
    """The payload, or None to stay out (disabled, oversize, unreadable)."""
    try:
        sys.path.insert(0, HERE)
        import hook_switches  # noqa: E402
        if hook_switches.is_disabled(NAME):
            return None
        limit = hook_switches.max_input_bytes()
    except Exception:  # noqa: BLE001 -- without the switches: previous behaviour, default cap
        limit = DEFAULT_MAX_INPUT
    stream = getattr(sys.stdin, "buffer", sys.stdin)
    data = stream.read(limit + 1)
    if isinstance(data, str):
        data = data.encode("utf-8", "surrogateescape")
    if len(data) > limit:
        return None   # never blocks: an oversize payload cannot be judged
    return data.decode("utf-8", "replace")


def main():
    current = mode()
    if current == "off":
        return 0
    raw = _read_stdin()
    if raw is None:
        return 0
    try:
        payload = json.loads(raw)
    except ValueError:
        return 0
    if not isinstance(payload, dict) or payload.get("tool_name") != "Bash":
        return 0
    tool_input = payload.get("tool_input")
    cmd = tool_input.get("command") if isinstance(tool_input, dict) else None
    if not isinstance(cmd, str) or TOKEN_NAME not in cmd:
        return 0
    rules, _parsed = verdict(cmd)
    if not rules:
        return 0
    log_hit(payload, cmd, rules, current)
    if current == "enforce":
        try:
            sys.stderr.write(message(rules, blocked=True) + "\n")
        except Exception:  # noqa: BLE001
            pass
        return 2
    try:
        out = json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                                 "additionalContext": message(rules, blocked=False)}})
        sys.stdout.write(out + "\n")
    except Exception:  # noqa: BLE001
        pass
    return 0


if __name__ == "__main__":
    try:
        code = main()
    except Exception:  # noqa: BLE001 -- warn must never fail a call; enforce decided inside main
        code = 0
    sys.exit(code)
