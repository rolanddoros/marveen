# db-write-gate (APPROVALDBGATE1030)

`scripts/hooks/db-write-gate.mjs` is a PreToolUse gate for every agent, the main agent included. It denies:

1. an SQL write on the dashboard database's security tables (`approvals`, `approval_events`, `auth_sessions`,
   `dashboard_users`, `device_keys`, `vault_ssh_keys`), `PRAGMA writable_schema`, and any write on `sqlite_master` /
   `sqlite_schema`;
2. a file-level write of `store/claudeclaw.db` (and its `-wal`, `-shm`, `-journal`);
3. a write of this install's gate wiring and autonomy levels: `.claude/settings.json`, `.claude/settings.local.json`,
   `scripts/hooks/`, `scripts/self-pace-gate.mjs`, `scripts/deploy/`, `scripts/write-main-config-root.sh`,
   `store/main-agent-config-root.json`, `store/extra-hooks.json`, `store/autonomy-config.json`, the main
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
