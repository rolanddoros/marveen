#!/usr/bin/env python3
"""render_claude_md_template.py -- the main agent's CLAUDE.md from templates/CLAUDE.md.template.

C1 PR 11c. The installers rendered the template with sed and the shell's
CHAT_ID, which is "0" until the owner pairs (install-linux.sh, install-macos.sh),
so a fresh install's CLAUDE.md told the main agent to send to chat 0. The chat
id now comes from the install's .env (ALLOWED_CHAT_ID, scripts/lib/owner_chat.py):

- set: every {{CHAT_ID}} becomes it;
- unset, empty or "0": the chat id fragment is dropped and the rule it sits in
  stays -- the template carries {{CHAT_ID}} only inside two rules (the unknown
  sender escalation and the morning briefing's send step), so dropping the whole
  line would drop the rule (Kevin 13339).

A {{CHAT_ID}} outside the known fragments stops the render (exit 2, nothing
written) instead of reaching the file: a new occurrence must be added here with
its null form first. The other placeholders are literal replacements of the
values the installer passes in the environment (OWNER_NAME, INSTALL_DIR,
BOT_NAME, MAIN_AGENT_ID, WEB_PORT, TIMEZONE), an empty value when one is unset,
as the sed did.

Usage: render_claude_md_template.py TEMPLATE OUT ENV_FILE
Exit: 0 written; 2 bad call or a {{CHAT_ID}} outside the known fragments.
The output is written atomically (a temp file in OUT's directory, then rename).
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from owner_chat import configured_chat_id  # noqa: E402

CHAT = "{{CHAT_ID}}"

# Each fragment that carries the chat id, and what it becomes without one.
CHAT_FRAGMENTS = (
    (" (reply tool, chat_id `{{CHAT_ID}}`)", " (reply tool)"),
    (" (chat_id: {{CHAT_ID}})", ""),
)

PLACEHOLDERS = ("OWNER_NAME", "INSTALL_DIR", "BOT_NAME", "MAIN_AGENT_ID", "WEB_PORT", "TIMEZONE")


class RenderError(Exception):
    pass


def render(template, chat_id, values):
    """The rendered text. chat_id: the id, or None. values: placeholder -> value."""
    known = sum(template.count(frag) for frag, _ in CHAT_FRAGMENTS)
    total = template.count(CHAT)
    if total != known:
        raise RenderError(
            f"{total - known} {CHAT} occurrence(s) outside the known chat id fragments; "
            "add the new one to CHAT_FRAGMENTS with its form without a chat id")
    text = template
    if chat_id is None:
        for frag, without in CHAT_FRAGMENTS:
            text = text.replace(frag, without)
    else:
        text = text.replace(CHAT, chat_id)
    for key in PLACEHOLDERS:
        text = text.replace("{{" + key + "}}", values.get(key, ""))
    return text


def write_atomic(path, text):
    d = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(prefix=".claude-md-", dir=d)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def main(argv):
    if len(argv) != 4:
        print("usage: render_claude_md_template.py TEMPLATE OUT ENV_FILE", file=sys.stderr)
        return 2
    template_path, out_path, env_file = argv[1:]
    with open(template_path, encoding="utf-8") as f:
        template = f.read()
    values = {k: os.environ.get(k, "") for k in PLACEHOLDERS}
    try:
        text = render(template, configured_chat_id(env_file), values)
    except RenderError as e:
        print(f"render_claude_md_template: {e}", file=sys.stderr)
        return 2
    write_atomic(out_path, text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
