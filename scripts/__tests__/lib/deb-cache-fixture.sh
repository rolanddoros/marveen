#!/bin/bash
# Shared fixture of the deb-cache-verify suites (sourced, not a suite: scripts/__tests__/lib is not discovered).
# A real apt on a throwaway repo, with no network and no root: a local `copy:` repository (apt copies its files into
# the archive dir, like a mirror download), an isolated apt state, and a fake dpkg that records the SHA256 of every
# .deb apt hands it. That record is what apt would install.
# Sets: T REPO ARCH_DIR LISTS APT A B C C_REPO, and repo_sha corrupt fill install handed_has. Exits 77 when apt is
# not there, 1 when the fixture cannot be built. It sets the EXIT trap that removes $T; a caller sets no trap of its own.
for t in apt-get dpkg-deb python3 sha256sum; do
  if ! command -v "$t" >/dev/null 2>&1; then
    echo "SKIP (control unmet): $t is not available (an apt-based Linux is needed to measure apt)"
    exit 77
  fi
done

T="$(mktemp -d "${TMPDIR:-/tmp}/debcache.XXXXXX")"
trap 'rm -rf "$T"' EXIT
REPO="$T/repo"; ARCH_DIR="$T/cache/archives"; LISTS="$T/state/lists"
mkdir -p "$REPO" "$T/etc/sources.list.d" "$T/etc/preferences.d" "$LISTS/partial" "$ARCH_DIR/partial" "$T/status" "$T/bin"

# --- the repository: three packages, one with an epoch (its archive name carries %3a) ---------------------------
build() {   # $1 package, $2 version, $3 payload
  local d="$T/build/$1" f
  mkdir -p "$d/DEBIAN" "$d/usr/share/$1"
  printf '%s\n' "$3" > "$d/usr/share/$1/payload"
  printf 'Package: %s\nVersion: %s\nArchitecture: all\nMaintainer: t <t@example.invalid>\nDescription: probe\n' "$1" "$2" > "$d/DEBIAN/control"
  f="$REPO/$1_${2#*:}_all.deb"
  dpkg-deb --build --root-owner-group "$d" "$f" >/dev/null || { echo "SETUP FAILED: dpkg-deb $1"; exit 1; }
  printf 'Package: %s\nVersion: %s\nArchitecture: all\nMaintainer: t <t@example.invalid>\nDescription: probe\nFilename: ./%s\nSize: %s\nSHA256: %s\n\n' \
    "$1" "$2" "$(basename "$f")" "$(stat -c %s "$f")" "$(sha256sum "$f" | cut -d' ' -f1)" >> "$REPO/Packages"
}
build probe-a 1.0 "real payload a"
build probe-b 2.0 "real payload b"
build probe-c 1:3.0 "real payload c"
printf 'Origin: probe\nLabel: probe\nSuite: probe\nCodename: probe\nDate: %s\nArchitectures: all amd64\nSHA256:\n %s %s Packages\n' \
  "$(date -Ru)" "$(sha256sum "$REPO/Packages" | cut -d' ' -f1)" "$(stat -c %s "$REPO/Packages")" > "$REPO/Release"
echo "deb [trusted=yes] copy:$REPO ./" > "$T/etc/sources.list"
# The host's apt configuration stays out: APT_CONFIG is read BEFORE the parts dir, so pointing the parts dir at an
# empty one here means no /etc/apt/apt.conf.d snippet (hooks, proxies, sandbox users) of this machine applies.
mkdir -p "$T/etc/apt.conf.d"
printf 'Dir::Etc "%s";\nDir::Etc::parts "%s";\nDir::Etc::main "%s";\n' "$T/etc" "$T/etc/apt.conf.d" "$T/etc/apt.conf" > "$T/apt.conf"
: > "$T/etc/apt.conf"
export APT_CONFIG="$T/apt.conf"
: > "$T/status/status"
printf '#!/bin/sh\nfor a in "$@"; do case "$a" in *.deb) sha256sum "$a" | cut -d" " -f1 >> "%s/handed.txt";; esac; done\nexit 0\n' "$T" > "$T/bin/dpkg"
chmod +x "$T/bin/dpkg"

APT=(apt-get -q -y -o Dir::Etc="$T/etc" -o Dir::Etc::sourcelist="$T/etc/sources.list" -o Dir::Etc::sourceparts="$T/etc/sources.list.d"
     -o Dir::Etc::preferencesparts="$T/etc/preferences.d" -o Dir::State="$T/state" -o Dir::State::lists="$LISTS"
     -o Dir::State::status="$T/status/status" -o Dir::Cache="$T/cache" -o Dir::Cache::Archives="$ARCH_DIR"
     -o Debug::NoLocking=1 -o APT::Architecture=amd64 -o Dir::Bin::dpkg="$T/bin/dpkg"
     -o DPkg::Pre-Install-Pkgs::= -o DPkg::Post-Invoke::= -o DPkg::Pre-Invoke::= -o APT::Update::Post-Invoke::=
     -o APT::Update::Post-Invoke-Success::=)
if ! "${APT[@]}" update > "$T/update.log" 2>&1; then
  echo "SETUP FAILED: apt-get update on the local repo"; cat "$T/update.log"; exit 1
fi

repo_sha() { sha256sum "$REPO/$1" | cut -d' ' -f1; }
A=probe-a_1.0_all.deb; B=probe-b_2.0_all.deb; C_REPO=probe-c_3.0_all.deb; C='probe-c_1%3a3.0_all.deb'
corrupt() { python3 -c 'import sys; p = sys.argv[1]; b = bytearray(open(p, "rb").read()); b[-10] ^= 0xff; open(p, "wb").write(b)' "$1"; }
fill() {    # the archive dir as a cache restore leaves it: the three real files, under apt's own names
  rm -f "$ARCH_DIR"/*.deb
  cp "$REPO/$A" "$ARCH_DIR/$A"; cp "$REPO/$B" "$ARCH_DIR/$B"; cp "$REPO/$C_REPO" "$ARCH_DIR/$C"
}
install() { : > "$T/handed.txt"; "${APT[@]}" install probe-a probe-b probe-c > "$T/install.log" 2>&1; }
handed_has() { grep -qx "$1" "$T/handed.txt"; }

