---
name: marveen-fleet-auth
description: How the agents of this Marveen install authenticate to Claude, and the two auth rules that are never broken. Use when an agent shows "Not logged in" or a 401 cascade, before placing or symlinking a .credentials.json, before changing a CLAUDE_CONFIG_DIR or claudeConfigDir, and when a new agent needs its auth set up.
---

Generated from templates/skills/marveen-fleet-auth.md; local edits are overwritten.

# Fleet auth rule (never break it)

## How auth works on this install

- Sub-agents authenticate by default through `CLAUDE_CODE_OAUTH_TOKEN` (`store/.claude-oauth-token`), with an
  auto-provisioned `CLAUDE_CONFIG_DIR`. This path ended the recurring 401 cascade that hand-placed, expiring
  `.credentials.json` files caused.
- The main channels agent ({{mainAgentId}}) differs on purpose: by default it uses the shared `~/.claude`.
  `MAIN_AGENT_ISOLATED_CONFIG=1` switches it to the fleet setup token. If the bot has its OWN Claude login,
  `MAIN_AGENT_CONFIG_DIR` is for that, and it takes precedence.
- The per-agent `claudeConfigDir` field is SUPPORTED (also through a named plan), for an agent that needs its own
  Claude login or its own plan. Using it is a decision, not a ban.

## What is never broken

1. If an agent shows "Not logged in", the fix is the TOKEN SOURCE, never a hand-placed or symlinked
   `.credentials.json`. Hand-placed credentials brought the 401 cascade back every time: by Claude Code's
   precedence the expired file wins over a valid env token even when both are there.
2. NEVER copy another agent's token or credentials. A new agent gets its OWN per-agent token and its own
   external-service setup (own email, unique port, own creds directory, own OAuth). A copy cannot be audited, and
   it gives access to another principal's data.
