#!/usr/bin/env bash
# Land one GO'd branch on the fork: push the exact GO head, open the PR, merge it, verify main.
#
# FOR THE MAIN AGENT (Johnny) ONLY. A developer agent must NEVER run this against the real
# remote or the real gh: developers commit locally, the main agent pushes and merges
# (skill marveen-fork-munka). The test (scripts/__tests__/fork-pr-land.test.sh) runs it
# against a local bare repo and a stub gh.
#
# Usage:
#   scripts/fork-pr-land.sh --worktree <dir> --head <sha40> --tree <sha40> --branch <name> \
#     --repo <owner/repo> --title <title> --body-file <file> [--remote fork] [--allow-protected-paths]
#
# Every step checks its result and STOPS on a mismatch; nothing after a failed step runs.
# Exit codes:
#   0  merged and verified           10 worktree HEAD != --head, or worktree not clean
#   2  bad call / missing tool       11 merge tree != --tree, or main moved before the merge
#  12  merge-tree conflict           13 .github/ or .claude/ touched (no --allow-protected-paths)
#  14  push failed / ls-remote != head  15 gh pr create failed
#  16  GitHub reports merge conflicts (criss-cross, #56): PR left open, manual step printed
#  17  gh pr merge failed            18 merged, but main^{tree} != --tree or main^2 != head
#  19  git fetch failed (step 2: nothing done yet; step 6: the PR WAS merged, verify by hand)
#  20  PR open, its mergeable state not verified (gh pr view failed, or still UNKNOWN after the polls)
# Step 6 reads the remote main TIP: a push by anyone else right after the merge also gives 18 (then
# check the PR's merge commit by hand). --branch must not be main, develop or upstream-main.
# No token handling: gh uses its own auth. No eval; every value is a literal argument.
set -euo pipefail

die() { local rc="$1"; shift; printf 'STOP (%s): %s\n' "$rc" "$*" >&2; exit "$rc"; }
loud() { printf '\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n%s\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n\n' "$*" >&2; }

WT="" HEAD_SHA="" TREE="" BRANCH="" REPO="" TITLE="" BODY="" REMOTE="fork" ALLOW_PROTECTED=0
while [ $# -gt 0 ]; do
  case "$1" in
    --worktree) WT="${2-}"; shift 2 || die 2 "--worktree needs a value" ;;
    --head) HEAD_SHA="${2-}"; shift 2 || die 2 "--head needs a value" ;;
    --tree) TREE="${2-}"; shift 2 || die 2 "--tree needs a value" ;;
    --branch) BRANCH="${2-}"; shift 2 || die 2 "--branch needs a value" ;;
    --repo) REPO="${2-}"; shift 2 || die 2 "--repo needs a value" ;;
    --title) TITLE="${2-}"; shift 2 || die 2 "--title needs a value" ;;
    --body-file) BODY="${2-}"; shift 2 || die 2 "--body-file needs a value" ;;
    --remote) REMOTE="${2-}"; shift 2 || die 2 "--remote needs a value" ;;
    --allow-protected-paths) ALLOW_PROTECTED=1; shift ;;
    *) die 2 "unknown argument: $1" ;;
  esac
done

for v in WT HEAD_SHA TREE BRANCH REPO TITLE BODY REMOTE; do
  [ -n "${!v}" ] || die 2 "missing required argument for $v (see the usage in the header)"
done
[[ "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]] || die 2 "--head must be a full 40-hex SHA (got: $HEAD_SHA)"
[[ "$TREE" =~ ^[0-9a-f]{40}$ ]] || die 2 "--tree must be a full 40-hex SHA (got: $TREE)"
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die 2 "--repo must be owner/repo (got: $REPO)"
[ -f "$BODY" ] || die 2 "--body-file not found: $BODY"
command -v git >/dev/null 2>&1 || die 2 "git not on PATH"
command -v gh >/dev/null 2>&1 || die 2 "gh not on PATH"
case "$BRANCH" in
  main|develop|upstream-main) die 2 "--branch $BRANCH is a protected fork branch; give the PR branch" ;;
esac
git check-ref-format --branch "$BRANCH" >/dev/null 2>&1 && [ "$(git check-ref-format --branch "$BRANCH")" = "$BRANCH" ] \
  || die 2 "--branch is not a valid branch name: $BRANCH"
POLLS="${FORK_PR_LAND_POLLS:-10}" POLL_SLEEP="${FORK_PR_LAND_POLL_SLEEP:-3}"
[[ "$POLLS" =~ ^[0-9]+$ ]] || die 2 "FORK_PR_LAND_POLLS must be a whole number (got: $POLLS)"
g() { git -C "$WT" "$@"; }
# NUL-separated paths in, the protected ones out (top-level or nested .github/ and .claude/), one per line.
protected_paths() {
  local p
  while IFS= read -r -d '' p; do
    case "$p" in .github/*|.claude/*|*/.github/*|*/.claude/*) printf '%s\n' "$p" ;; esac
  done
}

# 1. The worktree is at the GO head and clean (untracked files count as dirty).
actual="$(g rev-parse HEAD)" || die 10 "not a git worktree: $WT"
[ "$actual" = "$HEAD_SHA" ] || die 10 "worktree HEAD $actual != GO head $HEAD_SHA"
[ -z "$(g status --porcelain)" ] || { g status --short >&2; die 10 "worktree not clean: $WT"; }
echo "1. worktree at GO head and clean"

# 2. The merge with the newest main gives exactly the predicted tree; no protected path lands.
g fetch "$REMOTE" || die 19 "git fetch $REMOTE failed; nothing pushed"
MAIN="$(g rev-parse --verify "refs/remotes/$REMOTE/main^{commit}")"
mt_rc=0; mt_out="$(g merge-tree --write-tree "$MAIN" "$HEAD_SHA")" || mt_rc=$?
[ "$mt_rc" -ne 1 ] || { printf '%s\n' "$mt_out" >&2; die 12 "merge-tree reports a conflict with $REMOTE/main $MAIN"; }
[ "$mt_rc" -eq 0 ] || die 12 "merge-tree failed (exit $mt_rc)"
got_tree="$(printf '%s\n' "$mt_out" | head -n 1)"
[ "$got_tree" = "$TREE" ] || die 11 "merge tree $got_tree != predicted tree $TREE (main $MAIN)"
# -z: names raw, never quoted (a quoted ".github/..." would slip past the match); --no-renames: a moved
# protected file shows its source path as a deletion, not only its new name.
protected="$(g diff --name-only -z --no-renames "$MAIN" "$TREE" | protected_paths)" \
  || die 13 "cannot list the changed paths (git diff failed)"
if [ -n "$protected" ]; then
  if [ "$ALLOW_PROTECTED" -eq 1 ]; then
    loud "WARNING: this merge changes protected paths (allowed by --allow-protected-paths):
$protected"
  else
    loud "PROTECTED PATHS: this merge changes .github/ or .claude/ paths:
$protected
Tell Kevin; rerun with --allow-protected-paths only if that change is part of the GO."
    die 13 "protected paths touched"
  fi
fi
echo "2. merge tree = predicted tree $TREE (main $MAIN)"

# 3. Push the GO SHA itself (independent of the worktree's branch state), then read it back.
g push "$REMOTE" "$HEAD_SHA:refs/heads/$BRANCH" || die 14 "push failed"
remote_head="$(g ls-remote "$REMOTE" "refs/heads/$BRANCH" | cut -f1)" || remote_head="(ls-remote failed)"
[ "$remote_head" = "$HEAD_SHA" ] || die 14 "remote $BRANCH is '$remote_head', not GO head $HEAD_SHA"
echo "3. $REMOTE/$BRANCH = $HEAD_SHA"

# 4. Open the PR.
create_out="$(gh pr create -R "$REPO" -B main -H "$BRANCH" --title "$TITLE" --body-file "$BODY")" \
  || die 15 "gh pr create failed"
PR="$(printf '%s\n' "$create_out" | sed -nE 's#.*/pull/([0-9]+)[[:space:]]*$#\1#p' | tail -n 1)"
[ -n "$PR" ] || die 15 "no PR number in the gh pr create output: $create_out"
echo "4. PR #$PR opened"

conflict_stop() {
  loud "GitHub reports merge conflicts on PR #$PR (criss-cross case, skill marveen-fork-munka, Buktatok, #56).
The local merge-tree was clean and gave the predicted tree. This script does NOT resolve it. PR #$PR stays open.
Next manual step (the skill's recipe):
  1. In a NEW temporary detached worktree (never the developer's):
       git -C <repo> worktree add --detach <tmp> $HEAD_SHA
       git -C <tmp> -c user.name=<id> -c user.email=<mail> merge --no-ff $REMOTE/main
  2. Check: the new commit's tree = $TREE, and its diff against $HEAD_SHA brings in no content.
  3. git -C <tmp> push $REMOTE HEAD:refs/heads/$BRANCH; ls-remote = the new head.
  4. gh pr merge $PR -R $REPO --merge --admin --match-head-commit <new head>
  5. $REMOTE/main^{tree} = $TREE; remove <tmp>; tell Kevin the merged head differs from the GO head (content-free sync merge)."
  die 16 "GitHub merge conflicts on PR #$PR"
}

# 4b. Criss-cross detection: GitHub's own mergeable verdict (UNKNOWN while it computes).
state="UNKNOWN"
for _ in $(seq 1 "$POLLS"); do
  state="$(gh pr view "$PR" -R "$REPO" --json mergeable -q .mergeable)" \
    || die 20 "PR #$PR is open, but gh pr view failed: its mergeable state is not verified; nothing merged"
  [ "$state" = "UNKNOWN" ] || break
  sleep "$POLL_SLEEP"
done
[ "$state" != "CONFLICTING" ] || conflict_stop
if [ "$state" = "UNKNOWN" ]; then
  loud "PR #$PR is open, but GitHub still reports mergeable=UNKNOWN after $POLLS polls. Not merged (fail-closed).
Check it by hand (gh pr view $PR -R $REPO --json mergeable) before any merge."
  die 20 "mergeable state of PR #$PR not verified"
fi
echo "4b. GitHub mergeable: $state"

# 4c. main has not moved since the prediction.
now_main="$(g ls-remote "$REMOTE" refs/heads/main | cut -f1)" || now_main="(ls-remote failed)"
[ "$now_main" = "$MAIN" ] || die 11 "$REMOTE main moved: $now_main != predicted base $MAIN; PR #$PR left open, re-predict"

# 5. Merge, pinned to the GO head.
merge_rc=0; merge_out="$(gh pr merge "$PR" -R "$REPO" --merge --admin --match-head-commit "$HEAD_SHA" 2>&1)" || merge_rc=$?
[ -z "$merge_out" ] || printf '%s\n' "$merge_out"
if [ "$merge_rc" -ne 0 ]; then
  if printf '%s\n' "$merge_out" | grep -qi 'merge conflict'; then conflict_stop; fi
  die 17 "gh pr merge failed (exit $merge_rc); PR #$PR"
fi

# 6. Verify what landed.
g fetch "$REMOTE" || { loud "PR #$PR WAS MERGED, but git fetch failed: verify $REMOTE/main^{tree} = $TREE by hand."; die 19 "post-merge fetch failed"; }
MERGE="$(g rev-parse --verify "refs/remotes/$REMOTE/main^{commit}")"
landed_tree="$(g rev-parse "$MERGE^{tree}")"
second="$(g rev-parse --verify -q "$MERGE^2" || true)"
if [ "$landed_tree" != "$TREE" ] || [ "$second" != "$HEAD_SHA" ]; then
  loud "PR #$PR WAS MERGED, but $REMOTE/main $MERGE does not match: tree $landed_tree (want $TREE), second parent '$second' (want $HEAD_SHA).
$REMOTE/main may also have moved by an unrelated push right after the merge: check the PR's merge commit by hand."
  die 18 "post-merge verification failed"
fi
echo "MERGED pr=$PR merge=$MERGE tree=$TREE"
