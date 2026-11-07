// C1 PR 8a: `node dist/web/claude-md/cli.js --dry-run --root <dir> (--agent <name> | --all)
//   [--json] [--excerpts] [--redact-names]`
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
// description, so the DEFAULT output carries no owner-zone text: a finding is
// file:line, detector and pattern name. `--excerpts` adds a masked excerpt of
// each finding's line; that output is NOT for a PR description (the owner
// zones belong to the agents' principals). `--redact-names` replaces the root
// with <ROOT> and every agent name with agent-01..NN (main agent first, then
// the sub-agents in name order): the fork is public, so the PR text is made
// with it, and the full report stays local (Kevin 13030). The header names the
// code version from dist/.built-commit ("unknown" without one).
//
// --dry-run is mandatory: there is no other mode (the writing path is PR 10).
//
// On a live tree, run it under Node's permission model with read access only:
//   node --permission --allow-fs-read=<checkout>/dist --allow-fs-read=<root> \
//     <checkout>/dist/web/claude-md/cli.js --dry-run --root <root> --all --redact-names
// claude-md-dry-run-readonly.test.ts runs this shape on a fixture tree, also
// through a symlinked path. What --permission closes: file writes, child
// processes and workers. What it does NOT close: the network (the code makes
// no network call; the test's guard checks that), and reads: the read grant
// covers the whole install, .env and other agents' secret files included, so
// what limits reads is this code, not the grant.
//
// Exit codes:
//   0  every requested agent was evaluated (owner-zone findings are information);
//   1  at least one file was refused (the v2 composer would not accept it:
//      marker or fence problem, not UTF-8) or could not be read; the report
//      still covers every other agent;
//   2  usage error (arguments, --root, unknown agent).

import { runCli } from './dry-run-cli.js'

process.exitCode = runCli(process.argv.slice(2), (s) => process.stdout.write(s), (s) => process.stderr.write(s))
