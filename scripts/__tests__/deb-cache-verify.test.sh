#!/bin/bash
# scripts/deb-cache-verify.py: the CI ffmpeg .deb cache never hands a bad cached .deb to dpkg (C2, Johnny 12569 (5)).
#
# A real apt on a throwaway repo, no network, no root (the fixture: lib/deb-cache-fixture.sh). Runs the same as root
# and as any user; the two cases that need a non-root user are deb-cache-verify-nonroot.test.sh (Kevin 12618: as
# root they would turn THIS suite into a counted skip, and its core cases would give no signal).
#
# The control (case 1) measures the hole on THIS apt: without prune, a same-size corrupted .deb in the archive dir is
# handed to dpkg as it is (measured on apt 3.2.1, 2026-11-06; in CI this measures the runner's apt). If a future apt
# checks the hash itself, the control turns red: then this suite and prune are to be revisited, not silenced.
# Run:  bash scripts/__tests__/deb-cache-verify.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
VERIFY="$HERE/../deb-cache-verify.py"
FAILS=0; N=0
ok() { N=$((N+1)); if [ "$2" = "0" ]; then echo "PASS  $1"; else echo "FAIL  $1${3:+  -- $3}"; FAILS=$((FAILS+1)); fi; }

# shellcheck source=lib/deb-cache-fixture.sh
. "$HERE/lib/deb-cache-fixture.sh"

echo "deb-cache-verify"
echo "================"

# --- (0) the archive names are apt's own: a full download from the repo makes exactly these files -------------
rm -f "$ARCH_DIR"/*.deb
"${APT[@]}" install -d probe-a probe-b probe-c > "$T/dl.log" 2>&1
got="$(cd "$ARCH_DIR" && ls ./*.deb 2>/dev/null | sed 's#^\./##' | sort | tr '\n' ' ')"
want="$(printf '%s\n' "$A" "$B" "$C" | sort | tr '\n' ' ')"
ok "(0) apt names the cached files <package>_<%-quoted version>_<arch>.deb (epoch as %3a)" "$([ "$got" = "$want" ]; echo $?)" "got: $got"

# --- (1) CONTROL: without prune, this apt hands a same-size corrupted cached .deb to dpkg ----------------------
fill; corrupt "$ARCH_DIR/$A"
bad="$(sha256sum "$ARCH_DIR/$A" | cut -d' ' -f1)"
install
ok "(1) control: same size, other bytes; apt hands the CORRUPTED $A to dpkg (the hole prune closes)" \
  "$(handed_has "$bad" && ! handed_has "$(repo_sha "$A")"; echo $?)" "handed: $(tr '\n' ' ' < "$T/handed.txt")"

# --- (2) prune removes it, keeps the good ones; apt downloads the real file and hands only real files ----------
fill; corrupt "$ARCH_DIR/$A"
: > "$T/gh-out.txt"
out="$(GITHUB_OUTPUT="$T/gh-out.txt" python3 "$VERIFY" prune "$ARCH_DIR" "$LISTS" 2>&1)"; rc=$?
ok "(2) prune exits 0 and names the removed file" "$([ $rc = 0 ] && grep -q "removed: $A" <<<"$out"; echo $?)" "$out"
ok "(2) a verified cache: the step output says unverified=false (the save may run)" "$([ "$(cat "$T/gh-out.txt")" = "unverified=false" ]; echo $?)" "$(cat "$T/gh-out.txt")"
ok "(2) the good files stay (B, and C with its epoch name)" "$([ -f "$ARCH_DIR/$B" ] && [ -f "$ARCH_DIR/$C" ] && [ ! -e "$ARCH_DIR/$A" ]; echo $?)"
install
ok "(2) dpkg gets exactly the three REAL files, the corrupted one never" \
  "$(handed_has "$(repo_sha "$A")" && handed_has "$(repo_sha "$B")" && handed_has "$(repo_sha "$C_REPO")" && ! handed_has "$bad" \
     && [ "$(wc -l < "$T/handed.txt")" -eq 3 ]; echo $?)" "handed: $(tr '\n' ' ' < "$T/handed.txt")"
ok "(2) only the removed file was downloaded again" \
  "$(grep -c '^Get:' "$T/install.log" | grep -qx 1 && grep -q '^Get:.* probe-a ' "$T/install.log"; echo $?)" "$(grep '^Get:' "$T/install.log")"

# --- (3) what a cache may hold that the index does not vouch for: all removed -----------------------------------
fill
cp "$REPO/$B" "$ARCH_DIR/probe-b_9.9_all.deb"           # a version the index does not have
cp "$REPO/$B" "$ARCH_DIR/stranger_1.0_all.deb"          # a package the index does not have
rm -f "$ARCH_DIR/$C"; ln -s "$REPO/$C_REPO" "$ARCH_DIR/$C"   # a symlink, even to the real file (it can be swapped later)
cp "$REPO/$B" "$ARCH_DIR/odd-name.deb"                  # not <package>_<version>_<arch>.deb
cp "$REPO/$A" "$ARCH_DIR/$B"                            # the right name, another package's (real) bytes
python3 "$VERIFY" prune "$ARCH_DIR" "$LISTS" > "$T/p3.log" 2>&1
left="$(cd "$ARCH_DIR" && ls ./*.deb 2>/dev/null | sed 's#^\./##' | sort | tr '\n' ' ')"
ok "(3) only the one real, regular file the index vouches for is left" "$([ "$left" = "$A " ]; echo $?)" "left: $left"

# --- (4) fail closed (Johnny 12583, Kevin 12587): no readable index -> every cached .deb drops out, apt downloads -
fill; corrupt "$ARCH_DIR/$A"
mkdir -p "$T/nolists"
: > "$T/gh-out.txt"
GITHUB_OUTPUT="$T/gh-out.txt" python3 "$VERIFY" prune "$ARCH_DIR" "$T/nolists" > "$T/p4.log" 2>&1; rc=$?
ok "(4) no Packages index: exit 0 (the step stays green), with a ::warning:: that names why" \
  "$([ $rc = 0 ] && grep -q '^::warning title=ffmpeg .deb cache not verified::no readable Packages index' "$T/p4.log"; echo $?)" "rc=$rc $(cat "$T/p4.log")"
ok "(4) no cached .deb is left, not even the good ones" "$([ -z "$(ls "$ARCH_DIR"/*.deb 2>/dev/null)" ]; echo $?)" "$(ls "$ARCH_DIR")"
ok "(4) the step output says unverified=true (test.yml does not save after it)" "$([ "$(cat "$T/gh-out.txt")" = "unverified=true" ]; echo $?)" "$(cat "$T/gh-out.txt")"
install
ok "(4) 0 cached files reach dpkg: it gets the three real files, all downloaded again" \
  "$(handed_has "$(repo_sha "$A")" && handed_has "$(repo_sha "$B")" && handed_has "$(repo_sha "$C_REPO")" && ! handed_has "$bad" \
     && [ "$(wc -l < "$T/handed.txt")" -eq 3 ] && [ "$(grep -c '^Get:' "$T/install.log")" -eq 3 ]; echo $?)" "handed: $(tr '\n' ' ' < "$T/handed.txt")"

# --- (5) a cache miss (no .deb at all) needs no index and is fine -------------------------------------------------
rm -f "$ARCH_DIR"/*.deb
: > "$T/gh-out.txt"
GITHUB_OUTPUT="$T/gh-out.txt" python3 "$VERIFY" prune "$ARCH_DIR" "$T/nolists" > "$T/p5.log" 2>&1; rc=$?
ok "(5) an empty archive dir: exit 0, nothing to check, unverified=false" \
  "$([ $rc = 0 ] && grep -q 'nothing to check' "$T/p5.log" && [ "$(cat "$T/gh-out.txt")" = "unverified=false" ]; echo $?)"

# --- (7) a DIRECTORY under a .deb name (Ron 12607): removed like any bad entry, exit 0, no traceback ----------------
fill
mkdir -p "$ARCH_DIR/x_1_amd64.deb/inner"; echo junk > "$ARCH_DIR/x_1_amd64.deb/inner/f"
mkdir -p "$T/outside"; echo keep > "$T/outside/f"; ln -s "$T/outside" "$ARCH_DIR/y_1_amd64.deb"
python3 "$VERIFY" prune "$ARCH_DIR" "$LISTS" > "$T/p7.log" 2>&1; rc=$?
ok "(7) a directory named x_1_amd64.deb: removed and counted, exit 0, no traceback" \
  "$([ $rc = 0 ] && [ ! -e "$ARCH_DIR/x_1_amd64.deb" ] && grep -q 'removed: x_1_amd64.deb' "$T/p7.log" && grep -q ', 2 removed' "$T/p7.log" \
     && ! grep -q Traceback "$T/p7.log" && [ -f "$ARCH_DIR/$A" ]; echo $?)" "rc=$rc $(cat "$T/p7.log")"
ok "(7) a symlink to a directory under a .deb name: the LINK is removed, what it points to is untouched" \
  "$([ ! -L "$ARCH_DIR/y_1_amd64.deb" ] && grep -q 'removed: y_1_amd64.deb' "$T/p7.log" && [ "$(cat "$T/outside/f")" = keep ]; echo $?)"
fill
mkdir -p "$ARCH_DIR/x_1_amd64.deb"
python3 "$VERIFY" prune "$ARCH_DIR" "$T/nolists" > "$T/p7b.log" 2>&1; rc=$?
ok "(7) and on the no-index path too: the directory goes with the files, exit 0" \
  "$([ $rc = 0 ] && [ -z "$(ls -A "$ARCH_DIR" | grep '\.deb$')" ] && ! grep -q Traceback "$T/p7b.log"; echo $?)" "rc=$rc $(cat "$T/p7b.log")"

# --- (6) key: from apt's own --print-uris of an EMPTY archive dir ------------------------------------------------
rm -f "$ARCH_DIR"/*.deb
"${APT[@]}" install --print-uris -qq probe-a probe-b probe-c > "$T/uris.txt" 2>"$T/uris.err"
k1="$(python3 "$VERIFY" key "$T/uris.txt" probe-c 2>&1)"
ok "(6) the key starts with the package's version (epoch colon as a dot) and ends in a 16-hex set hash" \
  "$(grep -Eqx '1\.3\.0-[0-9a-f]{16}' <<<"$k1"; echo $?)" "key: $k1"
sed 's/probe-b_2\.0/probe-b_2.1/' "$T/uris.txt" > "$T/uris2.txt"
k2="$(python3 "$VERIFY" key "$T/uris2.txt" probe-c 2>&1)"
ok "(6) another library version in the set gives another key, the package version unchanged" \
  "$([ "${k1%-*}" = "${k2%-*}" ] && [ "$k1" != "$k2" ]; echo $?)" "$k1 vs $k2"
python3 "$VERIFY" key "$T/uris.txt" ffmpeg > /dev/null 2>&1; rc=$?
ok "(6) no line for the package: the key fails (no key for a set without it)" "$([ $rc = 1 ]; echo $?)"
{ cat "$T/uris.txt"; grep 'probe-c_' "$T/uris.txt" | sed 's/3\.0_all/3.1_all/g'; } > "$T/uris-two.txt"
python3 "$VERIFY" key "$T/uris-two.txt" probe-c > /dev/null 2>&1; rc=$?
ok "(6) two files for the package: the key fails (which one would the key name?)" "$([ $rc = 1 ] && [ "$(grep -c 'probe-c_' "$T/uris-two.txt")" = 2 ]; echo $?)"
: > "$T/empty.txt"
python3 "$VERIFY" key "$T/empty.txt" probe-c > /dev/null 2>&1; rc=$?
ok "(6) an empty uris file: the key fails" "$([ $rc = 1 ]; echo $?)"

echo
echo "$((N - FAILS))/$N passed"
[ "$FAILS" -eq 0 ]
