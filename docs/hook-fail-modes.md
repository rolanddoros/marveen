# Hook fail modes

Which fail mode each hook SHOULD have, by the role it plays, and why. The
policy is data in `src/web/hooks/fail-mode-policy.ts`; every entry of the hook
manifest (`src/web/hooks/manifest.ts`) carries its role as `kind`; and
`src/__tests__/hook-fail-mode-policy.test.ts` checks that every entry's
recorded fail mode is the policy of its kind, except the named exceptions
below. The manifest's fail mode is itself pinned to the real wrapper text by
`hook-manifest-main.test.ts` and `hook-manifest-sub.test.ts`, so the check
compares the policy with what the settings files really do.

This document and its test change nothing at runtime: no wrapper, no settings
file, no caller. Bringing the exceptions into line is the wrapper
normalisation (C3-5).

## What a fail mode is

The fail mode is what happens when the hook ITSELF breaks: the script or its
interpreter is missing, it crashes, or it runs out of time. It is decided by
the wrapper the settings file puts around the script, not by the script.

- `closed`: the failure blocks the call (exit 2).
- `open`: the failure lets the call through.
- `advisory`: the hook never blocks (a prompt-type hook).

What a WORKING hook decides (allow, warn, block) is a separate question and is
not covered here.

## The rule

The fail mode follows from what a broken hook costs. A broken security gate
that lets calls through silently disarms the protection, and nobody sees it; a
broken gate that blocks is visible at once, and its message says how to fix it.
Every other hook that blocks when broken makes the agent deaf or unable to work
and protects nothing in exchange.

| kind | fail mode | what belongs here | why |
|---|---|---|---|
| `security-gate` | `closed` | A PreToolUse gate on a trust boundary or a governance rule: egress, outgoing mail and copy, approvals, the security tables of the dashboard database, schedules, kanban writes, credentials, destructive commands. | Fail-open would remove the protection without a trace; fail-closed is loud and names the fix. |
| `kill-switch` | `closed` | The fleet freeze (`fleet-freeze-gate`). Closed WHILE FROZEN: a broken gate blocks only while `store/fleet-freeze.json` exists. | The red button stops anything only while the fleet is frozen; there it must not open. Unfrozen there is nothing to protect, so a broken script must not stop the fleet. Pending owner decision 3 (see below). |
| `guard` | `open` | A PreToolUse check against an accident, not a trust boundary: shell re-scan, child `claude` killing the poller, memory frontmatter, the token on an argv. | A broken guard would stop every Bash or Write call; the cost of one missed accident is bounded. The scripts say so themselves (see "Names that mislead"). |
| `enforcer` | `open` | A hook that holds the turn open until a rule is met (Stop): the Telegram reply guard. | A Stop hook that fails closed never lets the turn end. |
| `directive` | `open` | Puts something into the context: a directive, nudge, notice, replay, or an inbox delivery (UserPromptSubmit, PostToolUse, SessionStart). | A UserPromptSubmit exit 2 swallows the prompt: the deaf-agent incident in `src/web/hook-registration-guard.ts`. |
| `capture` | `open` | Records: the conversation ledger, tool and skill logs, task state, the clear snapshot. | A recording failure must not stop the work it records. |
| `handler` | `open` | Does work for the agent: the owner's slash commands, channel image resize, progress messages, the persona-change notice. | The work is a convenience; its failure must not block the session. |
| `prompt` | `advisory` | A prompt-type hook (`type: agent`): the PreCompact prompt. | It has no exit status that could block. |

### Closed only on PreToolUse

A hook may fail closed only on PreToolUse, where blocking stops one tool call.
Closed on UserPromptSubmit swallows every prompt; closed on Stop never ends the
turn. The test enforces this for every entry that fails closed.

### The kill switch: closed while frozen

For a `security-gate`, `closed` means any broken run blocks, always (the
fail-closed run wrappers). For the `kill-switch`, `closed` means closed while
frozen (the main agent's `failOpenExecClosedWhenFrozen` wrapper). The test
keeps the two apart: a kill switch must use a closed-while-frozen wrapper, and
no other kind may.

This line of the policy is PENDING OWNER DECISION 3 (C3 plan): whether the kill
switch should fail closed on the sub-agents too. It records the direction the
main agent already has; the question goes to the owner with the wrapper fix
(C3-5). If the decision is "open", the policy row and the exception change in
one commit.

## Names that mislead

A hook's role is what it does, not what it is called.

- `provenance-gate`: flags an input without a provenance envelope, never blocks
  (`scripts/hooks/provenance-gate.py`, "FLAG, not block", the owner's decision
  of 2026-07-22). Kind `directive`.
- `staleness-guard`: adds a re-confirm note to a late message, "It NEVER blocks
  the prompt" (`scripts/hooks/staleness-guard.py`). Kind `directive`.
- `memory-frontmatter-gate` and `memory-frontmatter-bash-gate`: block a memory
  write whose frontmatter does not parse, but a check that cannot run is "not a
  verdict, so it allows" (`scripts/hooks/memory-frontmatter-gate.py:16-18`;
  the guarded library import, HOOKDEPLOAD1008). A recall-blind memory is a
  bounded, repairable loss, not a crossed trust boundary. Kind `guard`, open in
  both scopes, as the policy says.
- `child-claude-channel-guard`: "a guard against an accident, not a security
  boundary, and a hook crash must not block every Bash call"
  (`scripts/hooks/child-claude-channel-guard.mjs`, header). Kind `guard`.
- `token-argv-guard`: warns by default (`TOKEN_ARGV_GUARD=warn`), blocks only
  when set to `enforce`. Kind `guard`.
- `telegram-reply-guard`: a Stop hook that holds the turn open. Kind `enforcer`.

## Exceptions

Entries whose recorded fail mode differs from the policy today. They are listed
in `FAIL_MODE_EXCEPTIONS`, recorded and NOT fixed here. A row that no longer
differs fails the test, so the list cannot outlive the mismatch it names.

| hook | scope | fail mode today | policy | reason |
|---|---|---|---|---|
| `fleet-freeze-gate` | sub | `open` | `closed` (while frozen) | The sub-agents get the template's plain fail-open wrapper, so a missing script lets calls through even while frozen. Owner decision 3, taken with the wrapper fix (C3-5). |
| `child-claude-channel-guard` | sub | `closed` | `open` | Decided per scope: fail-open on the main agent, the scaffold's sub-agent copy stays fail-closed (Kevin 13549 B1, `src/web/agent-scaffold.ts` at `CHILD_CLAUDE_GUARD_SCRIPT`). |

Every other entry, 50 of the 52 ids, follows the policy in every scope it is
part of (main 41 entries, sub 43 including one recorded but not rendered).

## `gate` in the sidecar vs the fail mode (Ron N5)

The sidecar `.claude/hooks.metadata.json` marks 16 hooks `gate: true`; the
manifest records 5 main-agent hooks `closed`. They answer two different
questions.

- `gate: true` means LOCKED: the hook's name is on the effective lock list
  (`DEFAULT_NON_DISABLEABLE` in `scripts/hooks/hook_switches.py`, plus the
  sidecar's optional `non_disableable` list). A locked hook may not be switched
  off by the `MARVEEN_DISABLED_HOOKS` environment variable, and an oversize
  stdin payload makes it fail closed instead of open.
  `scripts/hook-metadata.py` keeps the flag and the lock list in agreement
  (`GATE_NOT_LOCKED`, `GATE_UNFLAGGED`). The sidecar describes the main agent's
  tracked `.claude/settings.json` only; the sub-agents have no sidecar.
- The fail mode is what the WRAPPER does when the hook breaks (above).

So `gate` is "cannot be disabled", the fail mode is "what a broken hook does".
The relation between them:

- `closed` implies locked: a hook whose failure blocks must not be switchable
  off by an environment variable, or the closed wrapper protects nothing. The
  test checks it for every main-agent entry against the sidecar (read only):
  all 5 closed hooks are `gate: true`.
- Locked does not imply closed. 11 of the 16 locked hooks fail open, and that
  is right: `ledger-capture` must not be switched off (a disabled ledger loses
  channel messages silently), but a broken one must not make the agent deaf.

A measured fact about the lock: at runtime it acts only in the hook scripts
that import `hook_switches`, which today are two, `token-argv-guard.py` and
`tool-log-capture.py` (`git grep hook_switches scripts/hooks`). In the other
14 hooks marked `gate: true`, `MARVEEN_DISABLED_HOOKS` has no effect anyway, so
for them the flag is a classification, not a runtime protection. Follow-up:
a separate story.

## Adding or changing a hook

1. Give the manifest entry the `kind` of its role. The type requires one.
2. Give it the wrapper of that kind's fail mode. The policy test fails
   otherwise.
3. If it must differ today, add a row to `FAIL_MODE_EXCEPTIONS` with the reason,
   and a row to the exception table above (the test checks the doc names it).
4. If it fails closed on the main agent, lock it (the sidecar / lock list), or
   the closed-implies-locked check fails.
