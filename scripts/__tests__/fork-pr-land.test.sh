#!/usr/bin/env bash
# Tests for scripts/fork-pr-land.sh, hermetic: real git against a LOCAL bare repo as the
# "fork" remote, and a stub gh first on PATH that logs every call. Nothing here reaches a
# real remote or the real gh. Every STOP case proves two things: the exit code is the
# documented nonzero one, AND the step after the failing one did not happen (no push after
# a tree mismatch, no merge after a failed create, ...).
#
# Run: bash scripts/__tests__/fork-pr-land.test.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
LAND="${FORK_PR_LAND_SCRIPT:-$ROOT/scripts/fork-pr-land.sh}"
[ -f "$LAND" ] || { echo "FATAL: the script under test is missing: $LAND" >&2; exit 2; }

PASS=0; FAIL=0
ok() { if [ "$2" = "0" ]; then PASS=$((PASS + 1)); echo "  PASS: $1"; else FAIL=$((FAIL + 1)); echo "  FAIL: $1${3:+  -- $3}"; fi; }
check() { local name="$1"; shift; if "$@"; then ok "$name" 0; else ok "$name" 1; fi; }

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/forkland.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT

# Hermetic git: no user/system config, a fixed identity.
export HOME="$SANDBOX/home"; mkdir -p "$HOME"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
export FORK_PR_LAND_POLL_SLEEP=0
unset GH_TOKEN GITHUB_TOKEN GH_HOST

# The capability control runs in its own scratch repo, not in the cwd or ROOT: the suite must also run from a
# `git archive` export or any non-repo directory.
CAP="$SANDBOX/cap"; git init -q "$CAP" && git -C "$CAP" commit -q --allow-empty -m cap \
  || { echo "FATAL: cannot make a scratch git repo in $CAP" >&2; exit 2; }
if ! git -C "$CAP" merge-tree --write-tree HEAD HEAD >/dev/null 2>&1; then
  echo "SKIP (control unmet): this git has no 'merge-tree --write-tree' (needs git >= 2.38)" >&2; exit 77
fi

# --- stub gh ---------------------------------------------------------------------------
mkdir -p "$SANDBOX/bin"
cat > "$SANDBOX/bin/gh" <<'STUB'
#!/usr/bin/env bash
# Stub gh: logs the call, simulates create/view/merge against the local bare repo $STUB_FORK.
printf '%s\n' "$*" >> "$GH_LOG"
case "$1 $2" in
  "pr create")
    [ "${STUB_GH_CREATE:-ok}" != fail ] || { echo "stub: create failed" >&2; exit 1; }
    # A failure that still prints a URL: only the exit code can stop the script here.
    [ "${STUB_GH_CREATE:-ok}" != failurl ] || { echo "https://github.com/test/repo/pull/7"; echo "stub: create failed" >&2; exit 1; }
    [ "${STUB_GH_CREATE:-ok}" != nourl ] || { echo "Creating pull request for tools/x into main"; exit 0; }
    echo "https://github.com/test/repo/pull/7" ;;
  "pr view")
    if [ "${STUB_GH_MOVE_MAIN:-0}" = 1 ]; then
      t="$(mktemp -d)"; git clone -q "$STUB_FORK" "$t/c"; echo moved >> "$t/c/moved.txt"
      git -C "$t/c" add moved.txt; git -C "$t/c" commit -qm moved; git -C "$t/c" push -q origin HEAD:main; rm -rf "$t"
    fi
    [ -z "${STUB_BREAK_LS:-}" ] || git config --file "$STUB_BREAK_LS" remote.fork.uploadpack /nonexistent-upload-pack
    [ "${STUB_GH_VIEW:-ok}" != fail ] || { echo "stub: HTTP 502" >&2; exit 1; }
    n="$(grep -c '^pr view' "$GH_LOG")"
    if [ "${STUB_GH_UNKNOWN_FIRST:-0}" = 1 ] && [ "$n" -eq 1 ]; then echo UNKNOWN; else m="${STUB_GH_MERGEABLE:-MERGEABLE}"; [ "$m" != __EMPTY__ ] || m=""; echo "$m"; fi ;;
  "pr merge")
    case "${STUB_GH_MERGE:-ok}" in
      fail) echo "stub: GraphQL: something else went wrong" >&2; exit 1 ;;
      conflict) echo "X Pull request test/repo#7 is not mergeable: the merge commit cannot be cleanly created." >&2
                echo "Pull Request has merge conflicts" >&2; exit 1 ;;
    esac
    want=""; prev=""; for a in "$@"; do [ "$prev" = "--match-head-commit" ] && want="$a"; prev="$a"; done
    have="$(git --git-dir="$STUB_FORK" rev-parse "refs/heads/$STUB_BRANCH")"
    [ "$want" = "$have" ] || { echo "stub: head mismatch" >&2; exit 1; }
    t="$(mktemp -d)"; git clone -q "$STUB_FORK" "$t/c"
    if [ "${STUB_GH_MERGE:-ok}" = wrong ]; then
      echo extra >> "$t/c/extra.txt"; git -C "$t/c" add extra.txt; git -C "$t/c" commit -qm "not a merge"
    elif [ "${STUB_GH_MERGE:-ok}" = squash ]; then
      # the right tree, but one parent (a squash): only the main^2 = head check can tell
      git -C "$t/c" merge -q --no-ff --no-edit "origin/$STUB_BRANCH"
      sq="$(git -C "$t/c" commit-tree "$(git -C "$t/c" rev-parse 'HEAD^{tree}')" -p origin/main -m squash)"
      git -C "$t/c" reset -q --hard "$sq"
    else
      git -C "$t/c" merge -q --no-ff --no-edit "origin/$STUB_BRANCH"
    fi
    git -C "$t/c" push -q origin HEAD:main; rm -rf "$t"
    [ "${STUB_GH_DROP_FORK:-0}" != 1 ] || mv "$STUB_FORK" "$STUB_FORK.gone"
    echo "merged" ;;
  *) echo "stub gh: unexpected call: $*" >&2; exit 3 ;;
esac
STUB
chmod +x "$SANDBOX/bin/gh"
export PATH="$SANDBOX/bin:$PATH"
# The suite is only hermetic if the stub is the gh that runs.
[ "$(command -v gh)" = "$SANDBOX/bin/gh" ] || { echo "FATAL: stub gh is not first on PATH" >&2; exit 2; }

REAL_GIT="$(command -v git)"
mkdir -p "$SANDBOX/gitfail"
printf '#!/bin/sh\ncase " $* " in *" diff --name-only "*) echo "wrapper: diff fails" >&2; exit 1 ;; esac\nexec "%s" "$@"\n' "$REAL_GIT" > "$SANDBOX/gitfail/git"
chmod +x "$SANDBOX/gitfail/git"

# --- fixture ---------------------------------------------------------------------------
BR="tools/x"
mk_case() {
  C="$SANDBOX/$1"; mkdir -p "$C"
  FORK="$C/fork.git"; WT="$C/wt"; SEED="$C/seed"
  git init -q --bare -b main "$FORK"
  git init -q -b main "$SEED"
  printf 'base\n' > "$SEED/README"; git -C "$SEED" add README; git -C "$SEED" commit -qm base
  git -C "$SEED" push -q "$FORK" main
  git clone -q -o fork "$FORK" "$WT"
  git -C "$WT" checkout -q -b "$BR"
  export GH_LOG="$C/gh.log" STUB_FORK="$FORK" STUB_BRANCH="$BR"; : > "$GH_LOG"
  printf 'body\n' > "$C/body.md"
}
wt_commit() { mkdir -p "$(dirname "$WT/$1")"; printf '%s\n' "$2" > "$WT/$1"; git -C "$WT" add "$1"; git -C "$WT" commit -qm "wt $1"; }
main_commit() { mkdir -p "$(dirname "$SEED/$1")"; printf '%s\n' "$2" > "$SEED/$1"; git -C "$SEED" add "$1"; git -C "$SEED" commit -qm "main $1"; git -C "$SEED" push -q "$FORK" main; }
finish() { # main moves, then record the GO head and the predicted tree
  main_commit other.txt "main side"
  HEADSHA="$(git -C "$WT" rev-parse HEAD)"
  git -C "$WT" fetch -q fork
  TREE="$(git -C "$WT" merge-tree --write-tree fork/main HEAD | head -n 1)"
  MAIN0="$(git --git-dir="$FORK" rev-parse refs/heads/main)"
}
land() {
  RC=0
  "$LAND" --worktree "$WT" --head "$HEADSHA" --tree "$TREE" --branch "$BR" --repo test/repo \
    --title "T: land" --body-file "$C/body.md" "$@" > "$C/out" 2> "$C/err" || RC=$?
}
fork_branch() { git --git-dir="$FORK" rev-parse -q --verify "refs/heads/$BR" 2>/dev/null || true; }
fork_main() { git --git-dir="$FORK" rev-parse refs/heads/main; }
gh_calls() { grep -c "^pr $1" "$GH_LOG" || true; }
no_push_no_gh() { [ -z "$(fork_branch)" ] && [ ! -s "$GH_LOG" ]; }
is() { [ "$1" = "$2" ]; }

echo "fork-pr-land tests"
echo "=================="

echo "(a) happy path"
mk_case happy; wt_commit feature.txt "feature"; finish
case "$(git --git-dir="$FORK" config --get remote.origin.url || true)$(git -C "$WT" remote get-url fork)" in
  *github*) echo "FATAL: the fixture remote is not local" >&2; exit 2 ;;
esac
STUB_GH_UNKNOWN_FIRST=1 land
check "exit 0" is "$RC" 0
check "fork branch = GO head" is "$(fork_branch)" "$HEADSHA"
check "fork main tree = predicted tree" is "$(git --git-dir="$FORK" rev-parse 'refs/heads/main^{tree}')" "$TREE"
check "fork main^2 = GO head" is "$(git --git-dir="$FORK" rev-parse 'refs/heads/main^2')" "$HEADSHA"
check "create, view polled past UNKNOWN, then merge, in order" is "$(cut -d' ' -f1-2 "$GH_LOG" | tr '\n' ,)" "pr create,pr view,pr view,pr merge,"
check "create carries repo, base, head branch, body file" grep -qF -- "pr create -R test/repo -B main -H $BR --title T: land --body-file $C/body.md" "$GH_LOG"
check "merge pinned: --merge --admin --match-head-commit <GO head>" grep -qF -- "pr merge 7 -R test/repo --merge --admin --match-head-commit $HEADSHA" "$GH_LOG"
check "prints PR number and merge SHA" grep -qF "MERGED pr=7 merge=$(fork_main)" "$C/out"

echo "(b) worktree checks (step 1)"
mk_case dirty; wt_commit feature.txt "feature"; finish; printf 'x\n' >> "$WT/feature.txt"; land
check "tracked change: exit 10" is "$RC" 10; check "tracked change: no push, no gh" no_push_no_gh
mk_case untracked; wt_commit feature.txt "feature"; finish; printf 'x\n' > "$WT/stray.txt"; land
check "untracked file: exit 10" is "$RC" 10; check "untracked file: no push, no gh" no_push_no_gh
mk_case headmis; wt_commit feature.txt "feature"; finish; HEADSHA="$(git -C "$WT" rev-parse HEAD~1)"; land
check "HEAD != GO head: exit 10" is "$RC" 10; check "HEAD != GO head: no push, no gh" no_push_no_gh

echo "(c) merge prediction (step 2)"
mk_case treemis; wt_commit feature.txt "feature"; finish; TREE="$(git -C "$WT" rev-parse 'HEAD^{tree}')"; land
check "tree mismatch: exit 11" is "$RC" 11; check "tree mismatch: no push, no gh" no_push_no_gh
mk_case conflict; wt_commit README "branch side"; main_commit README "main side"; finish
TREE="$(git -C "$WT" rev-parse 'HEAD^{tree}')"; land
check "merge-tree conflict: exit 12" is "$RC" 12; check "merge-tree conflict: no push, no gh" no_push_no_gh
check "merge-tree conflict: reported as a conflict" grep -qF "merge-tree reports a conflict" "$C/err"
mk_case github; wt_commit .github/workflows/x.yml "on: push"; finish; land
check ".github touched: exit 13" is "$RC" 13; check ".github touched: no push, no gh" no_push_no_gh
check ".github touched: the path is named" grep -qF ".github/workflows/x.yml" "$C/err"
mk_case claude; wt_commit .claude/settings.json "{}"; finish; land
check ".claude touched: exit 13" is "$RC" 13; check ".claude touched: no push, no gh" no_push_no_gh
mk_case moved; main_commit .github/workflows/ci.yml "on: push"; git -C "$WT" fetch -q fork; git -C "$WT" merge -q --ff-only fork/main
git -C "$WT" mv .github/workflows/ci.yml ci-moved.yml; git -C "$WT" commit -qm "move the workflow out"; finish; land
check "protected file moved out of .github (git mv): exit 13" is "$RC" 13
check "protected file moved out: no push, no gh" no_push_no_gh
check "protected file moved out: the source path is named" grep -qF ".github/workflows/ci.yml" "$C/err"
mk_case nonascii; wt_commit ".github/workflows/$(printf '\303\251').yml" "on: push"; finish; land
check "top-level protected file with a non-ASCII name: exit 13" is "$RC" 13
check "top-level non-ASCII protected file: no push, no gh" no_push_no_gh
mk_case nestednonascii; wt_commit "sub/.claude/$(printf '\303\251').json" "{}"; finish; land
check "nested protected file with a non-ASCII name: exit 13" is "$RC" 13
check "nested non-ASCII protected file: no push, no gh" no_push_no_gh
mk_case nested; wt_commit "agents/x/.claude/settings.json" "{}"; finish; land
check "nested .claude path: exit 13" is "$RC" 13
mk_case nestedgithub; wt_commit "a/b/.github/workflows/x.yml" "on: push"; finish; land
check "nested .github path: exit 13" is "$RC" 13; check "nested .github path: no push, no gh" no_push_no_gh
mk_case symtop; mkdir -p "$WT/docs"; printf 'x\n' > "$WT/docs/settings.json"; ln -s docs "$WT/.github"
git -C "$WT" add docs .github; git -C "$WT" commit -qm "symlink named .github"; finish; land
check "a top-level symlink named exactly .github: exit 13" is "$RC" 13
check "top-level .github symlink: no push, no gh" no_push_no_gh
mk_case symnested; mkdir -p "$WT/sub" "$WT/docs"; printf 'x\n' > "$WT/docs/settings.json"; ln -s ../docs "$WT/sub/.claude"
git -C "$WT" add docs sub; git -C "$WT" commit -qm "nested symlink named .claude"; finish; land
check "a nested symlink named exactly .claude: exit 13" is "$RC" 13
check "nested .claude symlink: no push, no gh" no_push_no_gh
mk_case filetop; wt_commit .claude "not a dir"; finish; land
check "a top-level regular file named exactly .claude: exit 13" is "$RC" 13
mk_case lookalike; wt_commit "docs/x.github" "x"; wt_commit "docs/.githubx/y" "y"; finish; land
check "look-alike names (x.github, .githubx/) are not protected: exit 0" is "$RC" 0
mk_case difffail; wt_commit feature.txt "feature"; finish; PATH="$SANDBOX/gitfail:$PATH" land
check "the protected-path listing fails: exit 13" is "$RC" 13
check "the protected-path listing fails: named, no push, no gh" bash -c 'grep -qF "cannot list the changed paths" "$1" && [ -z "$2" ] && [ ! -s "$3" ]' _ "$C/err" "$(fork_branch)" "$GH_LOG"
mk_case mainside; wt_commit feature.txt "feature"; main_commit .github/workflows/y.yml "on: pr"; finish; land
check ".github only on main (not landing): exit 0" is "$RC" 0
mk_case allowed; wt_commit .github/workflows/x.yml "on: push"; finish; land --allow-protected-paths
check "--allow-protected-paths: exit 0" is "$RC" 0
check "--allow-protected-paths: loud WARNING with the path" grep -qF "WARNING: this merge changes protected paths" "$C/err"

echo "(d) push read-back (step 3)"
mk_case lsremote; wt_commit feature.txt "feature"; finish
printf '#!/bin/sh\nwhile read o n r; do [ "$r" = refs/heads/main ] || git update-ref "$r" "$(git rev-parse refs/heads/main)"; done\n' > "$FORK/hooks/post-receive"
chmod +x "$FORK/hooks/post-receive"; land
check "ls-remote != head: exit 14" is "$RC" 14; check "ls-remote != head: no gh call" is "$(wc -l < "$GH_LOG" | tr -d ' ')" 0

echo "(e) gh steps (4, 4b, 4c, 5)"
mk_case createfail; wt_commit feature.txt "feature"; finish; STUB_GH_CREATE=fail land
check "create fails: exit 15" is "$RC" 15
check "create fails: no view, no merge" is "$(gh_calls view)$(gh_calls merge)" 00
mk_case createfailurl; wt_commit feature.txt "feature"; finish; STUB_GH_CREATE=failurl land
check "create fails but prints a URL: exit 15" is "$RC" 15
check "create fails but prints a URL: no view, no merge" is "$(gh_calls view)$(gh_calls merge)" 00
mk_case createnourl; wt_commit feature.txt "feature"; finish; STUB_GH_CREATE=nourl land
check "create prints no PR URL: exit 15" is "$RC" 15
check "create prints no PR URL: no view, no merge" is "$(gh_calls view)$(gh_calls merge)" 00
mk_case crisscross; wt_commit feature.txt "feature"; finish; STUB_GH_MERGEABLE=CONFLICTING land
check "CONFLICTING: exit 16" is "$RC" 16; check "CONFLICTING: no merge call" is "$(gh_calls merge)" 0
check "CONFLICTING: main untouched" is "$(fork_main)" "$MAIN0"
check "CONFLICTING: prints the manual next step" grep -qF "merge --no-ff fork/main" "$C/err"
check "CONFLICTING: the step names PR, repo and --match-head-commit" grep -qF "gh pr merge 7 -R test/repo --merge --admin --match-head-commit" "$C/err"
mk_case mergeconflict; wt_commit feature.txt "feature"; finish; STUB_GH_MERGE=conflict land
check "merge says 'merge conflicts': exit 16" is "$RC" 16
check "merge says 'merge conflicts': manual step printed" grep -qF "Next manual step" "$C/err"
mk_case mergefail; wt_commit feature.txt "feature"; finish; STUB_GH_MERGE=fail land
check "other merge failure: exit 17" is "$RC" 17; check "other merge failure: main untouched" is "$(fork_main)" "$MAIN0"
mk_case unknown; wt_commit feature.txt "feature"; finish; FORK_PR_LAND_POLLS=3 STUB_GH_MERGEABLE=UNKNOWN land
check "mergeable still UNKNOWN after the polls: exit 20" is "$RC" 20
check "UNKNOWN: polled exactly 3 times, no merge call" is "$(gh_calls view)$(gh_calls merge)" 30
check "UNKNOWN: loud line names the PR" grep -qF "PR #7 is open, but GitHub still reports mergeable=UNKNOWN" "$C/err"
mk_case emptystate; wt_commit feature.txt "feature"; finish; STUB_GH_MERGEABLE=__EMPTY__ land
check "mergeable comes back empty: exit 20" is "$RC" 20; check "empty mergeable: no merge call" is "$(gh_calls merge)" 0
check "empty mergeable: the loud line quotes the state" grep -qF "reports mergeable='', not MERGEABLE" "$C/err"
mk_case oddstate; wt_commit feature.txt "feature"; finish; STUB_GH_MERGEABLE=SOMETHING_NEW land
check "an unexpected mergeable state: exit 20" is "$RC" 20; check "unexpected mergeable: no merge call" is "$(gh_calls merge)" 0
mk_case viewfail; wt_commit feature.txt "feature"; finish; STUB_GH_VIEW=fail land
check "gh pr view fails: exit 20" is "$RC" 20
check "gh pr view fails: no merge call" is "$(gh_calls merge)" 0
check "gh pr view fails: says the PR is open and view failed" grep -qF "PR #7 is open, but gh pr view failed" "$C/err"
mk_case mainmoved; wt_commit feature.txt "feature"; finish; STUB_GH_MOVE_MAIN=1 land
check "main moved before merge: exit 11" is "$RC" 11; check "main moved before merge: no merge call" is "$(gh_calls merge)" 0
mk_case mainls; wt_commit feature.txt "feature"; finish; STUB_BREAK_LS="$WT/.git/config" land
check "main read-back fails before merge: exit 11" is "$RC" 11; check "main read-back fails before merge: no merge call" is "$(gh_calls merge)" 0

echo "(f) post-merge verification (step 6)"
mk_case wrongmerge; wt_commit feature.txt "feature"; finish; STUB_GH_MERGE=wrong land
check "landed main != predicted: exit 18" is "$RC" 18
check "landed main != predicted: loud 'WAS MERGED'" grep -qF "WAS MERGED" "$C/err"
mk_case squash; wt_commit feature.txt "feature"; finish; STUB_GH_MERGE=squash land
check "right tree, but no GO head as second parent (squash): exit 18" is "$RC" 18
check "squash: the landed tree really is the predicted one" is "$(git --git-dir="$FORK" rev-parse 'refs/heads/main^{tree}')" "$TREE"
check "squash: the message names the second parent" grep -qF "second parent ''" "$C/err"

mk_case fetchafter; wt_commit feature.txt "feature"; finish
# The remote vanishes right after the merge: the post-merge fetch fails.
STUB_GH_DROP_FORK=1 land
check "post-merge fetch fails: exit 19" is "$RC" 19
check "post-merge fetch fails: loud 'WAS MERGED'" grep -qF "WAS MERGED, but git fetch failed" "$C/err"

echo "(g) git failures"
mk_case fetchfail; wt_commit feature.txt "feature"; finish; mv "$FORK" "$FORK.gone"; land
check "fetch fails: exit 19" is "$RC" 19
mv "$FORK.gone" "$FORK"; check "fetch fails: no push, no gh" no_push_no_gh
mk_case lsfail; wt_commit feature.txt "feature"; finish
# ls-remote itself fails (exit 128) after a successful push: a named STOP, not git's own code.
# The push's post-receive hook breaks the worktree's upload-pack: fetch (before) works, ls-remote (after) fails.
printf '#!/bin/sh\ngit config --file "%s/.git/config" remote.fork.uploadpack "%s/no-such-upload-pack"\n' "$WT" "$SANDBOX" > "$FORK/hooks/post-receive"
chmod +x "$FORK/hooks/post-receive"; land
check "ls-remote fails: the push did happen" is "$(fork_branch)" "$HEADSHA"
check "ls-remote fails: exit 14" is "$RC" 14; check "ls-remote fails: no gh call" is "$(wc -l < "$GH_LOG" | tr -d ' ')" 0

echo "(h) bad calls"
mk_case shortsha; wt_commit feature.txt "feature"; finish; HEADSHA="${HEADSHA:0:12}"; land
check "short --head: exit 2" is "$RC" 2; check "short --head: no push, no gh" no_push_no_gh
mk_case norepo; wt_commit feature.txt "feature"; finish; RC=0
"$LAND" --worktree "$WT" --head "$HEADSHA" --tree "$TREE" --branch "$BR" --title T --body-file "$C/body.md" > "$C/out" 2> "$C/err" || RC=$?
check "missing --repo: exit 2" is "$RC" 2; check "missing --repo: no push, no gh" no_push_no_gh
for bad in main develop upstream-main refs/heads/main refs/heads/tools/x "bad..name" "x y" "-x" "@{-1}" HEAD; do
  mk_case "br$(printf '%s' "$bad" | tr -c 'A-Za-z0-9' '_')"; wt_commit feature.txt "feature"; finish; MAIN_BEFORE="$(fork_main)"
  # run from inside the worktree: there @{-1} expands to the previous branch (main), so only the
  # "the name is unchanged by check-ref-format" rule refuses it
  RC=0; ( cd "$WT" && "$LAND" --worktree "$WT" --head "$HEADSHA" --tree "$TREE" --branch "$bad" --repo test/repo \
    --title T --body-file "$C/body.md" ) > "$C/out" 2> "$C/err" || RC=$?
  check "--branch '$bad': exit 2" is "$RC" 2
  check "--branch '$bad': nothing pushed, no gh" bash -c '[ "$1" = "$2" ] && [ ! -s "$3" ] && [ -z "$(git --git-dir="$4" for-each-ref refs/heads | grep -v refs/heads/main)" ]' _ "$(fork_main)" "$MAIN_BEFORE" "$GH_LOG" "$FORK"
done
mk_case notitle; wt_commit feature.txt "feature"; finish; RC=0
"$LAND" --worktree "$WT" --head "$HEADSHA" --tree "$TREE" --branch "$BR" --repo test/repo --body-file "$C/body.md" > "$C/out" 2> "$C/err" || RC=$?
check "missing --title: exit 2" is "$RC" 2; check "missing --title: no push, no gh" no_push_no_gh

mk_case pollsbad; wt_commit feature.txt "feature"; finish; FORK_PR_LAND_POLLS=abc land
check "FORK_PR_LAND_POLLS not a number: exit 2" is "$RC" 2; check "FORK_PR_LAND_POLLS not a number: no push, no gh" no_push_no_gh

echo "(i) source rules"
check "set -euo pipefail" grep -qE '^set -euo pipefail$' "$LAND"
code="$(grep -vE '^[[:space:]]*#' "$LAND")"
check "no eval" bash -c '! grep -qwE "eval" <<<"$1"' _ "$code"
check "no env dump (printenv, bare env, set -x)" bash -c '! grep -qE "(^|[;&|(\`[:space:]])(printenv|env)([[:space:];|)]|$)|set -x" <<<"$1"' _ "$code"
check "no token variable read" bash -c '! grep -qE "GH_TOKEN|GITHUB_TOKEN|\.secrets" <<<"$1"' _ "$code"
check "header: main agent only, never a developer agent" grep -qF "FOR THE MAIN AGENT (Johnny) ONLY" "$LAND"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
