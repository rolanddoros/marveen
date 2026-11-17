# db-write-gate (APPROVALDBGATE1030)

`scripts/hooks/db-write-gate.mjs` is a PreToolUse gate for every agent, the main agent included. It denies:

1. an SQL write on the dashboard database's security tables (`approvals`, `approval_events`, `auth_sessions`,
   `dashboard_users`, `device_keys`, `vault_ssh_keys`), `PRAGMA writable_schema`, and any write on `sqlite_master` /
   `sqlite_schema`;
2. a file-level write of `store/claudeclaw.db` (and its `-wal`, `-shm`, `-journal`);
3. a write of this install's gate wiring and autonomy levels: `.claude/settings.json`, `.claude/settings.local.json`,
   `scripts/hooks/`, `scripts/self-pace-gate.mjs`, `scripts/deploy/`, `scripts/write-main-config-root.sh`,
   `store/main-agent-config-root.json`, `store/extra-hooks.json`, `store/autonomy-config.json`, what decides a
   sub-agent's hooks and environment (see "Sub-agent settings" below), the main
   checkout's `.git/config`, `.git/packed-refs`, `.git/refs/remotes/`, `.git/hooks/`, and the user's `~/.gitconfig` and
   `~/.config/git/config`;
4. in the install's main checkout, every git subcommand that changes the tree or the refs except
   `git fetch [origin]`, exactly `git pull --ff-only origin <branch>`, and `git checkout -- <paths>` /
   `git restore <paths>` with no ref; everywhere, a write of `refs/remotes/*` and of the config keys that redirect a
   remote or name hooks (`remote.*.url`, `remote.*.pushurl`, `remote.*.fetch`, `core.hooksPath`, `include.path`,
   `includeIf.*`, `url.*.insteadOf`), also through `-c`, `--config-env` and the `GIT_CONFIG_*` environment.

Development happens in a git worktree; the worktree's own copies of these files are not protected.

**The limit.** This is a text-based brake, not an OS boundary: it reads the command text, and a program that builds a
statement or a path at run time (a script file written earlier, a string assembled in an interpreter) passes. The
owner's approval becomes trustworthy only once GROMZODONTES1030 (F1-F3) moves the decision to the mxd store.

## The code deploy (`code_deploy`)

The one exception to rule 4: the main agent brings a fork commit into the running install through
`scripts/deploy/fork-deploy.mjs`, never through raw git. The gate lets exactly one spelling through, as the whole
command, and only from the main agent:

```text
node <install>/scripts/deploy/fork-deploy.mjs request
node <install>/scripts/deploy/fork-deploy.mjs status
node <install>/scripts/deploy/fork-deploy.mjs apply --approval <id> --sha <40 lowercase hex>
```

No assignment or `env` before it, no second command, `cd`, substitution, redirect, glob or quoting. Any other command
that names the helper or a file under the install's `scripts/deploy/` is denied, the main agent's included; reading
those files goes through a worktree's own copy, named by its absolute path.

**Who is calling (SEC-2).** `scripts/hooks/agent-identity.mjs` reads the hook payload's `transcript_path`: MAIN only
under the config root the launcher recorded for the main agent on this boot (`store/main-agent-config-root.json`,
written by `scripts/write-main-config-root.sh` in the launchers' pane command), in exactly the install's flattened
project segment, with `MAIN_AGENT_ID` from `<install>/.env`. Anything else is not MAIN, and a missing record or `.env`
line means no MAIN at all. This is an accident and injection brake, not a security boundary: it stops a sub-agent that
types the helper's command by mistake or under a prompt injection; the general limit above applies to it as well.

**What the approval binds (SEC-3).** `request` files a `code_deploy` approval whose `content_hash` is
`sha256("marveen-code-deploy/v1\n" + repo + "\n" + branch + "\n" + FROM + "\n" + TO)`, FROM the install's HEAD and TO
the fork tip, with a bounded owner text (the commits, the gate and deploy paths changed, the package changes, whether
`npm ci` runs). `apply` re-renders that text and compares it byte for byte with the stored one, checks the hash, the
category, `agent_id`, `approved` and not consumed, that HEAD is still FROM, that the fetched tip is still TO and that
FROM is an ancestor of TO, and consumes the approval only right before the merge. The server files a `code_deploy` row
only for the main agent and only with a `content_hash`.

**Where the approval came from (SEC-5).** `CODE_DEPLOY_OWNER_CHANNEL_ONLY` (`src/code-deploy-policy.ts`, the same value
in `fork-deploy.mjs`, pinned equal by a test) is on until the owner decides otherwise. On: a `code_deploy` approve
needs the owner's own dashboard session cookie, and the server stores `owner_session:<user>` itself; the Slack
reaction route writes `slack_reaction:<id>`; no request body may carry either prefix, for any category; `apply`
accepts only those two prefixes, so a row born approved from a chat message (`<provider>_text`) does not deploy. Off:
the usual owner-gated approve, and `apply` reports the `resolved_by` it found.

### When a deploy stops

Every line `apply` prints also goes to `store/deploy-logs/<UTC>.log`, and `store/deploy-state.json` holds the last
step. A stop before the consume changed nothing. A stop after it says so (exit 4) and names what it left:

- **build failed**: the tree is at TO, `dist/` is the old build and the dashboard runs the old code. Fix the build in a
  worktree and deploy again, or go back with the restore points below.
- **restart failed / not proven**: the new build is in `dist/`, the old one in `dist.prev/`. To go back, as the owner:
  stop the dashboard, `mv dist dist.failed && mv dist.prev dist`, start it, then put the tree back as below.
- **Restore points**, made before the consume: the tag `deploy/pre-<UTC>` on FROM and
  `store/deploy-backups/dist-<UTC>.tar.gz`. Putting the tree back to the tag is a `reset`, which the gate denies to
  every agent: it is the owner's step, exactly as in the next section.

## Sub-agent settings (`agent_settings`)

What decides a sub-agent's hooks and environment at its next start is protected the same way as the install's own gate
wiring (Fork C settings-protect, plan v2 + addendum 1, Ron 17402 / 17451 / 17505):

- every `agents/<name>/.claude/settings.json`, `.claude/settings.local.json`, `.claude-config/settings.json` and
  `.claude-config/settings.local.json`, and the `.claude`, `.claude-config`, `.config` and `.config/gh` directories
  themselves (rename, removal, symlink; what they hold stays writable);
- the launchers and what they source (`scripts/watchdog.sh`, `stuck-modal-guard.sh`, `channels.sh`,
  `channel-watchdog.sh`, `fleet-venv-prefix.sh`, `main-extra-plugins-settings.sh`, `scripts/lib/owner-chat.sh`,
  `send-telegram.sh`, `channel-net-wait.sh`), `templates/profiles/`, the settings writers in `src/web` and `dist/web`
  (`agent-process`, `agent-scaffold`, `hooks/`), the shared `~/.claude/settings(.local).json`;
- `store/agent-settings-baseline.json`, `store/gate-wiring-state.json`, `scripts/agent-settings/`;
- `scripts/statusline-ratelimit.sh`, the one command an isolated copy's `statusLine` may run (the CLI runs it outside
  the PreToolUse gate chain);
- the install root's `.env` (it holds `GATE_WIRING_ENFORCE`). An agent's own channel `.env` stays writable. Earlier
  text said the `.env` was protected by `destructive-gate.py`: that gate is not wired on this install; the protection
  is this gate's, from this change on.

**The verifier.** `scripts/hooks/verify-gate-wiring.mjs` runs before every sub-agent start, on both launch paths (the
watchdog's `--gate-wiring` call before `tmux new-session`, and `startAgentProcess` in the dashboard). It imports
neither `src/` nor `dist/`. It checks: the hooks lock `scripts/hooks/sub-hooks.lock.json` (its own sha256 first); the
agent's three settings files against one validator (`scripts/hooks/settings-validator.mjs`); the hooks block against
the lock expanded with the switch tuple of the agent's baseline entry ONLY, never with the live inputs; and against the
baseline (plan addendum 1 K3):

- **(e)** `settings.local.json` byte-equal to the baseline record; a difference is named, a removed deny row first
  (`deny row removed: <row>`), then added rows, keys and env key names; a value is never named;
- **(f)** no baseline entry: the main agent requests one (enrolment, below);
- **(g)** the isolation rows (K4), independent of the hash.

**Report or enforce.** `GATE_WIRING_ENFORCE` is read from the install's `.env` only, never from a file under `agents/`
or `store/`. Unset or empty: report (the default): the findings of a start go into one `[GATE-WIRING]` line (` NEW` when
the finding set changed since the last check, so the alert goes out once), and the agent starts. `1`: enforce, a finding means no start. `0`: report, only together
with `GATE_WIRING_ENFORCE_UNTIL=YYYY-MM-DD` at most 7 days ahead; a missing, malformed, past or too-far date is
enforce with an alert, as is any other value and an `.env` that exists but cannot be read. Switching to enforce is the
owner's own `.env` edit, after the report window.

### The helper

The main agent changes a sub-agent's `settings.local.json` or the baseline only through
`scripts/agent-settings/apply-local.mjs`, on an `agent_settings` approval the owner gave. The gate lets exactly these
spellings through, as the whole command, from the main agent only (the deploy helper's rule):

```text
node <install>/scripts/agent-settings/apply-local.mjs request --batch <id>
node <install>/scripts/agent-settings/apply-local.mjs baseline --isolated <name[,name...]|none>
node <install>/scripts/agent-settings/apply-local.mjs rebaseline --agent <name>
node <install>/scripts/agent-settings/apply-local.mjs apply --approval <id>
node <install>/scripts/agent-settings/apply-local.mjs resume
node <install>/scripts/agent-settings/apply-local.mjs status
```

- `request`: the main agent writes `store/agent-settings-staging/<id>.json` (`{"format":"marveen-agent-settings-batch/v1",
  "isolated":[...],"files":[{"agent":"<name>","content":"<the full new file>"}]}`), the helper validates every file
  with the verifier's validator and every agent's live switch tuple against the lock, and files one approval. A batch
  outside the rules is refused with every reason, and no approval exists.
- `baseline`: the first baseline, on the day the feature is switched on: today's file and switch tuple of every
  sub-agent, one approval. `rebaseline`: accept today's file and tuple of one agent (after the owner's hand edit, a
  security profile or capability change through the API, a sender-role gate change, a node upgrade). Both also add a
  new agent to the baseline.
- `apply`: re-derives everything from the batch bytes and the disk, re-renders the owner text and compares it byte for
  byte, checks the approval field by field (category, the main agent, approved, not consumed, `content_hash`, and with
  `CODE_DEPLOY_OWNER_CHANNEL_ONLY` on an owner-channel `resolved_by`, the same switch as the deploy), writes the new
  hashes into `store/agent-settings-state.json`, consumes the approval, writes the files (a random
  `O_CREAT|O_EXCL|O_NOFOLLOW` temp in the agent's real `.claude` directory, fsync, rename; a linked target or directory
  stops before the consume) and the baseline last.
- **What the approval binds:** `content_hash = sha256("marveen-agent-settings/v1\n", the kind, the isolated list, then
  per agent in name order: name \0 file text \0 canonical switch tuple \0)`. The owner text (at most 3000 characters)
  never cuts the header, the `content_hash`, the isolated list (and whether it changes), the request log
  `store/agent-settings-logs/request-<UTC>-<hex>.log` with its sha256, any `SÉRÜL` (missing isolation rows),
  `ELTÁVOLÍTVA` (removed deny row), `KAPCSOLÓ` (switch change of an existing entry) or `ENV` (a `GH_CONFIG_DIR` other
  than the agent's own `.config/gh`) line; if those alone do not fit, the request is refused: split the batch.

**When an apply stops.** A stop before the consume changed nothing. A stop after it (exit 4) leaves some files written
and the baseline unchanged, so those agents do not pass the verifier until `resume` or `rebaseline`. `resume` needs no
new approval and trusts nothing in the state file: it reads the consumed approval back from the dashboard (consumed by
this helper, at most 24 hours ago, `consumed_ref` equal to the hash, and this helper's NEWEST `agent_settings` consume:
no other approval it consumed at the same second or later), re-derives the batch, and seals the baseline only
when every target file on disk is byte-equal to the approved content. Anything else: `rebaseline`, with an approval. With
500 or more `agent_settings` rows in the dashboard the newest consume cannot be proven and `resume` stops; the way
out is `rebaseline`.

**The isolation rows (K4).** The baseline names the isolated agents. Every other agent's file denies each isolated
agent's directory (`Read/Edit/Write(//<install>/agents/<s>/**)`, `Bash(*agents/<s>*)`); an isolated agent's file
denies every other agent's directory and the owner's credential paths (`~/.claude/channels`, `<install>/.claude/channels`,
`~/.gmail-mcp`, `~/.config/google-calendar-mcp`, `~/.config/gh`, `<install>/store/browser`, four rows each, plus the
`~`, `$HOME`, `.gmail-mcp` and `google-calendar-mcp` Bash spellings). The rows are built from the install dir and the
home, the form measured on the live files. This proves that the deny rules are PRESENT, not that the agents are
isolated: they are text patterns for Claude Code's permission check, not file-system permissions, and every agent runs
as the same Unix user. The main agent's own `settings.local.json` is not the helper's (the dashboard and the owner
write it).

### Processes this denies, and what to use instead

| Command | Use instead |
|---|---|
| `tar czf store/agent-backups/<n>-<date>.tar.gz -C agents <n>` | `DELETE /api/agents/<n>` makes the backup itself, before it removes anything (0600, the answer names the path; a failed backup removes nothing) |
| `tar xzf <backup> -C agents` | the owner's terminal, then `rebaseline --agent <n>` |
| `cp -r agents/<n> ...` | the `DELETE` backup, or the owner |
| `mv agents/<n> agents/<m>` | the owner's terminal (self-rename writes `CLAUDE.md` / `SOUL.md`, not the folder) |
| `rm -rf agents/<n>` | `DELETE /api/agents/<n>` |
| a hand edit of an agent's `.claude/settings.json` | the dashboard's routes (`enabledPlugins`: the channel save; the hooks: the generator, the `browser` capability) |
| a hand edit of an agent's `.claude/settings.local.json` | `request --batch` |
| `BRAND_NAME` into the root `.env` (self-rename step 4) | the owner's terminal; the onboarding API also writes `BOT_NAME` |

The directory rule behind the first rows: a program that changes what a directory holds (`rm`, `mv`, `cp`, `tar`,
`unzip`, `patch`, ...; `DIR_CHANGERS` and `writesIntoCwd` in `scripts/hooks/db-write-gate.mjs`, lines 233-248 at fork
main 4f7469c6) pointed at a directory that contains a protected path is denied without naming it.

**Writers of the root `.env` (Ron 17505 1a), none of them through this gate:** the dashboard process
(`src/web/model-fallback-runner.ts:97`, the onboarding `setEnvKey`, `src/web/fleet-transfer.ts:1417`
`updateEnvFile`); the installer (`scripts/setup.ts:177`); `scripts/migrate-main-agent-id.sh:161,294` from inside the
script; `scripts/update.sh` does not write it. A Node process and a script run by the owner are not tool calls, so the
gate does not see them: the verifier's report and the owner's review are the check there.

**Residuals, not closed here.** The gate is a text brake (the limit at the top). An agent's own PreCompact prompt is
compared for presence and size only, so the agent still steers its compaction prompt. `enabledPlugins` in the isolated
copy is checked for shape only unless the dashboard passes the exact map; ENFORCE needs the plugin-id set in the
baseline or the owner's acceptance of the residual. Whether a PreCompact agent hook's tool calls pass the PreToolUse
gates was not measured (no `claude -p` session on this install).

Also open (Ron 17563, suggestions 4 and 5):

- an agent's `.claude/settings.json` `permissions.allow` / `permissions.deny` are checked for shape only, not compared
  with the profile (the scaffold writes them every start; the watchdog path starts without the scaffold);
- the helpers the launchers EXECUTE (not source) are not protected paths: `main-agent-isolated-config.mjs`,
  `resolve-plan-token-env.mjs`, `main-agent-custom-provider.mjs`, and on the watchdog path `watchdog-replay.py` and
  `notify.sh`. The protection boundary is the launchers, what they source, and the files listed above.

**Not a residual any more (Ron 17563):** a key whose value is a command the CLI runs itself (`apiKeyHelper`,
`awsAuthRefresh`, `awsCredentialExport`, `otelHeadersHelper`; all four names occur in the installed CLI 2.1.318
binary, `grep -a -c` 58 / 17 / 9 / 17, the semantics of the last three per Ron) is an error in the isolated copy and in the shared file; an unexpected exception inside the verifier's
checks is a finding, so report starts the agent with the line and enforce does not (a load failure, crash, timeout or
exit 127 stays no start).

## Vész-helyreállítás

When the install's working tree is broken (a failed update, a half-applied merge, a wrong branch), the agents cannot
repair it themselves any more: `reset`, `checkout <branch>`, `merge`, `rebase` and `stash` are denied in the main
checkout. The repair goes through the owner, in one of two ways.

**1. The owner's own terminal.** Run as the owner, not through an agent:

```bash
cd /Users/marvin/ClaudeClaw          # the install's root
git status                           # what is changed; save anything that should be kept first
git fetch origin
git checkout develop                 # the branch the install runs (develop or main)
git reset --hard origin/develop      # the reviewed tree; untracked files (store/, logs) are not touched
npm ci && npm run build              # only if src/ or package*.json changed
```

Then restart the dashboard the usual way (`claudeclaw-host-update-to-develop`, its restart step).

**2. An approval request, carried out by the owner.** The agent that found the broken tree sends an approval request
(`POST /api/approvals`) whose description holds the exact commands above for this case and why they are needed. The
owner runs them in their own terminal. The gate does not read approvals: an approved request does not let the agent's
own `git reset` through, it only records the owner's decision.

What still works for an agent in the main checkout: `git status`, `git diff`, `git log` and the other reads,
`git fetch origin`, `git pull --ff-only origin <branch>` (a fast-forward from the remote itself), and
`git checkout -- <paths>` / `git restore <paths>` to put back the reviewed content of single files (the host update
skill's clean-up step, after the diff is saved).
