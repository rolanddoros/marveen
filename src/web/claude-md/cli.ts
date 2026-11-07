// C1 PR 8: `node dist/web/claude-md/cli.js --dry-run --root <dir> (--agent <name> | --all)
//   [--json] [--excerpts] [--redact-names] [--full-diff] [--show-chat-id] [--home <dir>]`
//
// The entry module: it runs the CLI on import, with no "am I the main module"
// guard. Such a guard (import.meta.url === pathToFileURL(process.argv[1]).href)
// is false when the CLI is started through a symlinked path, because Node
// resolves the main module to its real path while argv[1] stays as given: the
// run printed nothing and exited 0, a silent "no findings" (Ron, 8a review
// 13027). The logic is in dry-run-cli.ts, which the tests import.
//
// Read-only report over an install's CLAUDE.md files (dry-run.ts). The main
// agent runs it against the live tree and pastes the output into a PR
// description, so the DEFAULT output is a summary with no owner-zone text:
// per agent the status, the chars before and after, the legacy blocks, the
// owner-zone findings as file:line, detector and pattern name, and the
// assumptions (Kevin 13132). `--excerpts` adds a masked excerpt of each
// finding's line. `--full-diff` adds the unified diff (3 context lines, the
// owner text verbatim; each removed legacy block is one placeholder line with
// its line count and a sha256 prefix, never its text, since an owner may have
// edited it). Neither is for a PR description (the owner zones belong to the
// agents' principals); to keep a full diff, redirect stdout to a file under
// store/ (the CLI writes no file). The owner chat_id is masked in the diff
// unless --show-chat-id. `--redact-names` replaces the root with <ROOT>, every
// agent name with agent-01..NN (main agent first, then the sub-agents in name
// order), and the configured OWNER_NAME / BOT_NAME with <OWNER> / <BOT>: the
// fork is public, so the PR text is made with it, and the full report stays
// local (Kevin 13030, 13039). `--home` names the directory whose
// .claude/settings.json is the main agent's user-scope settings layer
// (default: os.homedir()). The header names the code version from
// dist/.built-commit ("unknown" without one).
//
// --dry-run is mandatory: there is no other mode (the writing path is PR 10).
//
// On a live tree, run it under Node's permission model with read access only:
//   node --permission --allow-fs-read=<checkout>/dist --allow-fs-read=<checkout>/templates \
//     --allow-fs-read=<root> --allow-fs-read=<home>/.claude/settings.json \
//     --allow-fs-read=/etc/claude-code/managed-settings.json \
//     <checkout>/dist/web/claude-md/cli.js --dry-run --root <root> --home <home> --all --redact-names
// (templates: the region text; the settings file: the main agent's user layer;
// the managed file: Claude Code's highest layer, on macOS /Library/Application
// Support/ClaudeCode/managed-settings.json. Without its grant every agent reads
// status "error": the highest layer is unknown, and the run says so.)
// A hook script outside the allowed paths reads as not wired (fail-closed: a
// longer region, never a dropped rule). claude-md-dry-run-readonly.test.ts runs
// this shape on a fixture tree, also through a symlinked path. What
// --permission closes: file writes, child processes and workers. What it does
// NOT close: the network (the code makes no network call; the test's guard
// checks that), and reads: the read grant covers the whole install, .env and
// other agents' secret files included, so what limits reads is this code, not
// the grant.
//
// Exit codes:
//   0  every requested agent was evaluated (owner-zone findings are information);
//   1  at least one file was refused (the v2 composer would not accept it:
//      marker or fence problem, not UTF-8), could not be read, or its context
//      or region could not be built (status "error"); the report still covers
//      every other agent;
//   2  usage error (arguments, --root, unknown agent).
// A crash (an uncaught error, e.g. a read outside the --permission grant)
// also exits 1, with EMPTY stdout and the error on stderr. A caller must
// treat an empty stdout as a failed run, never as "refused" or as "no
// findings" (Ron, 8a review 13073).

import { runCli } from './dry-run-cli.js'

process.exitCode = runCli(process.argv.slice(2), (s) => process.stdout.write(s), (s) => process.stderr.write(s))
