---
name: marveen-background-work
description: Checkpoint-and-resume rule for long background work (a background sub-agent or a run_in_background command). Use before starting background work that may run longer than 15 minutes, when writing a background sub-agent's brief, and right after a restart or a key wall stopped such work.
---

Generated from templates/skills/marveen-background-work.md; local edits are overwritten.

# Long background work: save as you go, resume from the saved part

A key wall (key rotation) and a restart (context guard, key rotation) stop a running background sub-agent and a
command running in the background. The main conversation continues, the background work does not, and whatever is
not in a file is lost.

- If a background sub-agent or a background run is expected to work longer than 15 minutes, it saves its partial
  result to a file about every 10 minutes, under your working directory. Not in the scratchpad: that `/tmp` folder
  is bound to the session and is gone after a new session (for example a fresh context-guard start) or a machine
  restart. Put this rule, with the file path, into the background sub-agent's brief.
- No secret, token or personal data goes into the checkpoint. It goes to a git-ignored place (a subfolder covered by
  .gitignore), never into a file that can end up in a commit.
- After a restart or a key wall, read the saved part FIRST and continue from there, not from the start.
- One line on the card (or in HANDOFF.md): where the saved part is (its path) and what the next step is.
