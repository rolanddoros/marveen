#!/bin/bash
# scripts/deb-cache-verify.py: the two fail-closed cases that only a non-root user can measure (Ron 12607, Kevin 12618).
# chmod does not deny root, so as root this whole suite is a counted skip (exit 77); the CI runner is not root, so CI
# measures them. Split from deb-cache-verify.test.sh so that a root run of that suite still measures its core cases.
# Run:  bash scripts/__tests__/deb-cache-verify-nonroot.test.sh   (as a non-root user)
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
VERIFY="$HERE/../deb-cache-verify.py"
FAILS=0; N=0
ok() { N=$((N+1)); if [ "$2" = "0" ]; then echo "PASS  $1"; else echo "FAIL  $1${3:+  -- $3}"; FAILS=$((FAILS+1)); fi; }

if [ "$(id -u)" = 0 ]; then
  echo "SKIP (control unmet): running as root, and chmod does not deny root (cases: an unreadable .deb, an unremovable entry)"
  exit 77
fi
# shellcheck source=lib/deb-cache-fixture.sh
. "$HERE/lib/deb-cache-fixture.sh"

echo "deb-cache-verify (non-root cases)"
echo "================================="

# --- (8) an unreadable .deb (Ron 12607): not checkable = not kept; removed, counted, exit 0 ----------------------
fill
chmod 000 "$ARCH_DIR/$B"
if [ -r "$ARCH_DIR/$B" ]; then
  ok "(8) control: chmod 000 makes the .deb unreadable for this user" 1 "still readable"
else
  python3 "$VERIFY" prune "$ARCH_DIR" "$LISTS" > "$T/p8.log" 2>&1; rc=$?
  ok "(8) an unreadable $B: removed and counted, exit 0, no traceback" \
    "$([ $rc = 0 ] && [ ! -e "$ARCH_DIR/$B" ] && grep -q "removed: $B" "$T/p8.log" && ! grep -q Traceback "$T/p8.log"; echo $?)" "rc=$rc $(cat "$T/p8.log")"
fi
chmod 644 "$ARCH_DIR/$B" 2>/dev/null

# --- (9) an entry prune cannot remove: exit 1, never a silent pass (it would reach apt unverified) ---------------
fill; corrupt "$ARCH_DIR/$A"
chmod 555 "$ARCH_DIR"
if [ -w "$ARCH_DIR" ]; then
  ok "(9) control: chmod 555 makes the archive dir read-only for this user" 1 "still writable"
else
  python3 "$VERIFY" prune "$ARCH_DIR" "$LISTS" > "$T/p9.log" 2>&1; rc=$?
  ok "(9) the corrupted $A cannot be removed (read-only dir): exit 1, named, no traceback" \
    "$([ $rc = 1 ] && grep -q "cannot remove .*$A.*would reach apt unverified" "$T/p9.log" && ! grep -q Traceback "$T/p9.log"; echo $?)" "rc=$rc $(cat "$T/p9.log")"
fi
chmod 755 "$ARCH_DIR"

echo
echo "$((N - FAILS))/$N passed"
[ "$FAILS" -eq 0 ]
