#!/bin/bash
# Regression test: scripts/backup.sh must keep the scratch of sealed test runs
# under store/fork-audit (and the phase-e/rollback-* cutover copies) out of the
# manifest AND away from cp, while the audit notes, the rest of phase-e and
# every run's result files stay in the archive.
# Run: bash scripts/__tests__/backup-skips-fork-audit-scratch.test.sh
#
# The 2026-11-08 nightly backup exited 6: store/fork-audit was one manifest
# entry, so `cp -pR store/fork-audit` walked the sealed suite copy of a run
# that was still going (tom-runs/<run>/suite), the suite deleted one of its
# temp files mid-copy ("cp: cannot stat .../suite/tmp.provtest.*"), and the
# staging failure failed the run. The same entry also carried ~1.1 GB of run
# copies plus the scratch-* work trees into the stage.
#
# The race is reproduced, not mocked away: a `cp` shim on PATH fails exactly
# like that cp did whenever it is asked to copy a path that is, or contains,
# the live suite's temp file. It also logs every cp source, so a run that
# merely copies scratch (and deletes it later) is caught too.
#
# Run and directory names carry spaces and glob characters on purpose: the
# expansion must quote every path (no word splitting, no glob expansion).
#
# Hermetic: a throwaway repo and HOME under one temp dir, never the live store.

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="${BACKUP_SH_UNDER_TEST:-$REPO/scripts/backup.sh}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "backup.sh: fork-audit run scratch stays off the manifest and away from cp"
echo "========================================================================="

FAKE="$TMP/repo"; FHOME="$TMP/home"; OUT="$TMP/out"; SHIM="$TMP/shim"
mkdir -p "$FAKE/scripts/lib" "$FAKE/store" "$FHOME/.claude/skills/demo" \
  "$FHOME/.claude/scheduled-tasks/demo" "$OUT" "$SHIM"
cp "$SCRIPT" "$FAKE/scripts/backup.sh"
cp "$(dirname "$SCRIPT")/lib/archive-list-has.sh" "$FAKE/scripts/lib/"

# Load-bearing markers backup.sh insists on.
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$FAKE/store/claudeclaw.db" 'CREATE TABLE t(x);'
else
  printf 'db' > "$FAKE/store/claudeclaw.db"
fi
printf 'x' > "$FHOME/.claude/skills/demo/SKILL.md"
printf 'x' > "$FHOME/.claude/scheduled-tasks/demo/SKILL.md"

FA="store/fork-audit"
put() { mkdir -p "$(dirname "$FAKE/$1")"; printf '%s' "${2:-x}" > "$FAKE/$1"; }

# Kept: audit notes, a phase dir, the tom-runs root scripts, and per run the
# result files (including names that merely resemble the excluded ones).
KEEP="$FA/PLAN.md
$FA/phase-b/notes.md
$FA/odd dir [a]*/n.md
$FA/tom-runs/c1-build.sh
$FA/tom-runs/scratch-not-top.sh
$FA/phase-e/CUTOVER-RUNBOOK.md
$FA/phase-e/pre-rollback notes.md"
# Excluded: work trees, the phase-e cutover rollback copies (Johnny 13877), and
# each run's sealed copy, home, bin, tmp and tmux.
SKIP="$FA/scratch-stuart/big.bin
$FA/scratch-x y [z]*/f
$FA/phase-e/rollback-20261107-1003/claudeclaw.db
$FA/phase-e/rollback-odd name [q]*/dist.tgz"
for RUN in c33a2 "run 2 [x]*"; do
  KEEP="$KEEP
$FA/tom-runs/$RUN/steps/results.tsv
$FA/tom-runs/$RUN/steps/09.rc
$FA/tom-runs/$RUN/steps/home/kept-nested.txt
$FA/tom-runs/$RUN/vitest.json
$FA/tom-runs/$RUN/report.md
$FA/tom-runs/$RUN/head-check.txt
$FA/tom-runs/$RUN/suite-notes.txt
$FA/tom-runs/$RUN/home check.txt"
  SKIP="$SKIP
$FA/tom-runs/$RUN/suite/package.json
$FA/tom-runs/$RUN/suite/tmp.provtest.3cgSPm
$FA/tom-runs/$RUN/home/.bashrc
$FA/tom-runs/$RUN/bin/claude
$FA/tom-runs/$RUN/tmp/t.txt
$FA/tom-runs/$RUN/tmux/sock"
done
printf '%s\n' "$KEEP" | while IFS= read -r p; do put "$p" keep; done
printf '%s\n' "$SKIP" | while IFS= read -r p; do put "$p" scratch; done
# The excluded directories themselves (cp must never be handed one, or an
# ancestor of one).
SKIP_DIRS="$FA/scratch-stuart
$FA/scratch-x y [z]*
$FA/phase-e/rollback-20261107-1003
$FA/phase-e/rollback-odd name [q]*"
for RUN in c33a2 "run 2 [x]*"; do
  for d in suite home bin tmp tmux; do SKIP_DIRS="$SKIP_DIRS
$FA/tom-runs/$RUN/$d"; done
done
printf '%s\n' "$SKIP_DIRS" > "$TMP/skip-dirs"

# The racing suite, as seen by cp: copying anything that holds the live temp
# file fails the way the 2026-11-08 run did. Every source is logged.
REAL_CP="$(command -v cp)"
cat > "$SHIM/cp" <<EOF
#!/bin/bash
LOG="$TMP/cp-sources"
n=\$#; i=0; rc=0
for a in "\$@"; do
  i=\$((i + 1))
  [ "\$i" -eq "\$n" ] && break
  case "\$a" in -*) continue ;; esac
  printf '%s\n' "\$a" >> "\$LOG"
  for t in "\$a"/tom-runs/*/suite/tmp.provtest.* "\$a"/*/suite/tmp.provtest.* "\$a"/suite/tmp.provtest.* "\$a"/tmp.provtest.*; do
    [ -e "\$t" ] && { echo "cp: cannot stat '\$t': No such file or directory" >&2; rc=1; }
  done
done
"$REAL_CP" "\$@" || rc=1
exit \$rc
EOF
chmod +x "$SHIM/cp"

set +e
OUTPUT="$(cd "$FAKE" && HOME="$FHOME" BACKUP_DIR="$OUT" PATH="$SHIM:$PATH" bash scripts/backup.sh 2>&1)"
RC=$?

if [ "$RC" -eq 0 ]; then pass "backup.sh exits 0 while a sealed suite is running"; else
  fail "backup.sh exited $RC (the run scratch failed a healthy backup)"; echo "$OUTPUT" | tail -15; fi

if echo "$OUTPUT" | grep -q 'FAILED\|MISSING'; then
  fail "the run reported FAILED or MISSING"; echo "$OUTPUT" | grep 'FAILED\|MISSING\|WARN' | head -5
else
  pass "no FAILED / MISSING line in the output"
fi

ARCHIVE="$(ls -1 "$OUT"/claudeclaw-*.tar.gz 2>/dev/null | head -1)"
LIST="$TMP/archive.list"; MAN="$TMP/manifest.txt"
if [ -n "$ARCHIVE" ]; then
  tar -tzf "$ARCHIVE" > "$LIST" 2>/dev/null || : > "$LIST"
  tar -xzOf "$ARCHIVE" MANIFEST.txt > "$MAN" 2>/dev/null || : > "$MAN"
else
  : > "$LIST"; : > "$MAN"
fi

# Kept files: present in the archive, by exact name.
: > "$TMP/lost"
printf '%s\n' "$KEEP" | while IFS= read -r p; do
  grep -qxF "repo/$p" "$LIST" || printf '%s\n' "$p" >> "$TMP/lost"
done
if [ -s "$TMP/lost" ]; then
  fail "kept files missing from the archive: $(tr '\n' '|' < "$TMP/lost")"
else
  pass "notes, phase-e runbook, root scripts and every run's result files are in the archive"
fi

# Excluded paths: not in the archive, not on the manifest (prefix match, so a
# manifest line naming an ancestor directory counts as a leak too).
: > "$TMP/leaks"
printf '%s\n' "$SKIP" | while IFS= read -r p; do
  grep -qxF "repo/$p" "$LIST" && printf 'archive:%s\n' "$p" >> "$TMP/leaks"
done
while IFS= read -r line; do
  case "$line" in repo/*) ;; *) continue ;; esac
  m="${line#repo/}"
  while IFS= read -r d; do
    case "$d/" in "$m"/*) printf 'manifest:%s\n' "$m" >> "$TMP/leaks"; break ;; esac
  done < "$TMP/skip-dirs"
done < "$MAN"
if [ -s "$TMP/leaks" ]; then
  fail "run scratch or a rollback copy reached the archive or the manifest: $(sort -u "$TMP/leaks" | tr '\n' '|')"
else
  pass "no run scratch or rollback copy in the archive or on the manifest"
fi

# cp sources: none is an excluded directory or an ancestor of one.
: > "$TMP/cp-leaks"
if [ -s "$TMP/cp-sources" ]; then
  while IFS= read -r src; do
    case "$src" in "$FAKE"/*) rel="${src#"$FAKE"/}" ;; *) continue ;; esac
    while IFS= read -r d; do
      case "$d/" in "$rel"/*) printf '%s\n' "$rel" >> "$TMP/cp-leaks"; break ;; esac
    done < "$TMP/skip-dirs"
  done < "$TMP/cp-sources"
fi
if [ -s "$TMP/cp-leaks" ]; then
  fail "cp was handed run scratch: $(sort -u "$TMP/cp-leaks" | tr '\n' '|')"
elif [ ! -s "$TMP/cp-sources" ]; then
  fail "the cp shim saw no call (the test did not exercise staging)"
else
  pass "cp was never handed run scratch or a directory holding it"
fi

echo
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]
