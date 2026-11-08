// C3-3a: `npm run hook-settings -- --dry-run --root <install> [--agent <name>]... [--node-bin <path>]
//   [--json] [--diff] [--redact-names]`
//
// Read-only report: per sub-agent of the install at --root, what the sub-agent
// settings generator (sub-generator.ts) would write into its
// agents/<name>/.claude/settings.json `hooks`, against the file on disk:
// hooks before -> after, the flattened multiset difference (+ added, - dropped,
// ~ rewrapped: the same hook with another wrapper or timeout, C3-5a), the
// order/grouping changes, the hooks kept as they are (an operator's own
// wiring, a switched-off gate's copy), and with --diff the unified diff of the whole file. Nothing is written: the
// generator acts in the dashboard (C3-3b), never from here. --dry-run is
// mandatory, there is no other mode.
//
// --node-bin: the node binary the dashboard burns into the gates; default this
// process's own (resolved like HOOK_NODE_BIN). A different one shows every node
// gate as changed, so the header prints it. --redact-names: the root, the node
// binary, the main agent id and the agent names (sub-01..NN in name order) are
// replaced, for a public PR text.
//
// The entry module runs on import, with no "am I the main module" guard (a
// symlinked start would make such a guard false: Ron 13027 on C1 PR 8a); the
// logic is in dry-run.ts, which the tests import. Its import graph is read
// only (hook-settings-dry-run.test.ts pins it: no config.js, no logger, no
// database, no network, no writing fs call).
//
// Exit codes: 0 every agent's multiset EMPTY or rewrap only; 1 an agent with an
// added or dropped hook, or an error; 2 usage (arguments, --root, unknown agent). A
// crash also exits 1, with an empty stdout: read an empty stdout as a failed run.

import { runHookSettingsCli } from './dry-run.js'

process.exitCode = runHookSettingsCli(process.argv.slice(2), (s) => process.stdout.write(s), (s) => process.stderr.write(s))
