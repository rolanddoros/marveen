---
name: marveen-skill-authoring
description: Where a skill may be written on this Marveen install and who will see it (global folder, project root, an agent's own folder), which memory directory is really yours, and how to propose a global skill. Use BEFORE writing, moving or patching any skill, and before writing into a memory directory.
---

Generated from templates/skills/marveen-skill-authoring.md; local edits are overwritten.

# Skill locations: who sees what

## Measure your config root first

There are THREE places, not two, and the difference is not which one is "global" but WHO SEES IT. Before you write
or move a skill, MEASURE which config root you run from:

```bash
echo "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; ls -ld "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills"
```

If `$CLAUDE_CONFIG_DIR` is EMPTY (a default install, where the main agent runs on the shared `~/.claude` without an
isolated config root), your root is `~/.claude` itself, and its `skills` folder is the global one: place 1 below,
without a symlink. In isolated mode the root's NAME differs per agent (sub-agents: `agents/<name>/.claude-config`,
the main agent: `<project-root>/.channels-config`), so remembering the NAME misleads in both directions: a path that
does not exist for YOU says nothing about the rest of the fleet, and a root with a different name is not yours just
because of its name. The behaviour is the SAME everywhere, and the `ls -ld` above shows it: in isolated mode
`$CLAUDE_CONFIG_DIR/skills` is a SYMLINK to the global folder, so it is place 1 under another name; with an empty
variable it is `~/.claude/skills` itself.

## The three places

1. `~/.claude/skills`: the global folder. EVERY agent sees it. Do not write here directly: a new global skill or a
   fix to an existing one goes ONLY as a proposal (`POST /api/skills/propose`, see "Proposing a global skill"
   below). Whether it goes live at once (the scan and the audit still run) or waits in quarantine for the owner's
   approval is decided by the SKILL_QUARANTINE switch; the `live` field of the answer tells which. The base
   directory of a skill run MAY point at your own config root; the skill still belongs to the fleet.

### If you are the main agent ({{mainAgentId}})

2. The PROJECT ROOT's `.claude/skills` (`{{projectRoot}}/.claude/skills`). **It is NOT private to you.** Your
   working directory IS the project root, and every sub-agent's (`agents/<name>`) is INSIDE it, so this folder is
   their ancestor: what you write here shows up in their list. For visibility it behaves like the global folder.
   Do not write here directly either: it goes as a proposal too.
3. `agents/<name>/.claude/skills`: a SUB-AGENT's own folder, only theirs. YOU have none: an `agents/<your-name>`
   folder does not exist, and a folder created there would be a CHILD of your working directory, not its ancestor,
   so not even you would see it.

Consequence: on this install there is NO place where the main agent can write a skill for itself only. Do not
assume it is private: on 2026-09-23 that assumption failed, and not by itself: a sub-agent measured it. So for you
EVERY new or fixed skill goes as a proposal (`POST /api/skills/propose`).

### If you are a sub-agent

2. The PROJECT ROOT's `.claude/skills` (`{{projectRoot}}/.claude/skills`). Your working directory is INSIDE it, so
   this folder is your ancestor: you SEE the skills here, even the ones you did not write and that are not meant for
   you. Do NOT write here: it is the main agent's area, and whatever you put here every other agent would see too.
3. Your own `.claude/skills` in your working directory (`agents/<your-name>/.claude/skills`). This is the ONLY one
   that is really yours alone. Your own skills, and an untried external skill, go here.

## Memory has the same trap

The `.claude-config/projects` folder may be a symlink to `~/.claude/projects`. Do NOT derive which memory directory
is yours from your working directory's name: the authority is the path GIVEN in the memory section of your system
prompt, resolved with `readlink -f`. On a git-checkout install (the default case) Claude Code keys it by the REPO
ROOT: if the resolved path is the directory under `~/.claude/projects/` keyed with the install root's slug, it
belongs to the main agent, and what goes there is loaded by the main agent's session and by every agent session
that gets the same directory. It is yours if the resolved path is in the real directory of your own
`.claude-config`, or carries your own folder's slug (your own stub git repo, or an install without git). The place
for a memory that is only yours is the dashboard API in any case (`POST /api/memories`, with `agent_id`).

## Proposing a global skill

If a skill is useful to every agent, or you would fix an existing global skill, write the full SKILL.md as a draft
and send it as a proposal. If the name is already live, the proposal is a replacement: when it goes live, the old
version is saved. When you fix an existing global skill, start from its current text
(`cat ~/.claude/skills/<name>/SKILL.md`) and send the WHOLE fixed text.

The API helper sends it (`skill-propose`). Both files are written with your file tool (Write), never through the
command line:

- A sub-agent: write the full SKILL.md (the same structure as your own skill: YAML frontmatter with name and
  description, then the sections) to `agents/<your-name>/skill-javaslat.md`, and the reason (why it is needed, what
  it fixes) to `agents/<your-name>/skill-javaslat-indok.txt`. The reason gets its own file because the shared
  payload file is overwritten by every other recipe in between.
- The main agent: the draft goes to `.claude/skill-javaslat/SKILL.md` and the reason to
  `.claude/skill-javaslat/indok.txt`, under its working directory.

Then send it, with your own two paths:

```bash
{{apiHelper}} skill-propose <skill-name> <draft-file> --reason-file <reason-file>
```
