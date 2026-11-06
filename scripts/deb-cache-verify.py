#!/usr/bin/env python3
"""The ffmpeg .deb cache of the CI test job (C2, Johnny 12569 option 1, Kevin 12570).

Two subcommands, both used by .github/workflows/test.yml:

  key <uris-file> <package>
      Prints the cache key suffix for the .deb set apt resolved: "<package version>-<sha256 of the set, 16 hex>".
      <uris-file> is the output of `apt-get install --print-uris -qq ...` run with an EMPTY archive dir, so it lists
      every .deb of the set (apt leaves out a file it already has). Any change in the set (a new ffmpeg, a new library
      version) gives a new key. Fails when the file has no line for <package>, or more than one.

  prune <archives-dir> [<lists-dir>]
      Removes every cached .deb in <archives-dir> whose SHA256 is not the one the apt index in <lists-dir> gives for
      its package, version and architecture. Run it after the cache restore and BEFORE apt-get install.
      <lists-dir> defaults to the Debian/Ubuntu standard, DEFAULT_LISTS (the workflow uses the default, so its run
      block names no apt path that ci-apt-step.test.ts would have to read as an apt call).

Why prune exists (condition 5 of Johnny 12569): apt does NOT check the hash of a .deb it finds in its archive dir. It
only compares the size. Measured on apt 3.2.1 (2026-11-06): a same-size corrupted .deb in the archive dir was handed
to dpkg as it was, and only a size mismatch made apt download it again. scripts/__tests__/deb-cache-verify.test.sh
measures the same on whatever apt it runs on (its control case), so the CI runner's apt is measured too.

The index is the Packages files apt has just fetched with `apt-get update`, which apt accepts only when the signed
InRelease names their hashes. A cached .deb therefore stays only if it is byte for byte the file the signed index
names. Everything else (corrupted, unknown, another version, a symlink) is removed, and apt downloads the real file.
A .deb that cannot be checked is removed, never kept (fail-closed, Johnny 12583, Kevin 12587). With .deb files
present but no readable index at all, EVERY cached .deb is removed: apt downloads them as on a cache miss, and the
step stays green with a GitHub ::warning:: annotation naming why the cache could not be verified. Under GitHub Actions
prune also writes `unverified=true|false` to $GITHUB_OUTPUT; the save step of test.yml does not run after
unverified=true, so a run that could not verify its cache never stores one.
"""
import gzip
import hashlib
import os
import sys
import urllib.parse

USAGE = 'usage: deb-cache-verify.py key <uris-file> <package> | prune <archives-dir> [<lists-dir>]'
DEFAULT_LISTS = '/var/lib/apt/lists'


def die(msg, code=1):
    print(f'deb-cache-verify: {msg}', file=sys.stderr)
    sys.exit(code)


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


# --- key -------------------------------------------------------------------------------------------------------
def deb_name(line):
    # `'<uri>' <file name> <size> <hash>`: the file name is the second field
    parts = line.split()
    return parts[1] if len(parts) >= 3 and parts[0].startswith("'") else None


def cmd_key(uris_file, package):
    with open(uris_file, encoding='utf-8') as f:
        lines = sorted(l.strip() for l in f if l.strip())
    names = [deb_name(l) for l in lines]
    if not lines or None in names:
        die(f'{uris_file}: not a --print-uris list (empty, or a line in another form)')
    own = [n for n in names if n.startswith(f'{package}_') and n.endswith('.deb')]
    if len(own) != 1:
        die(f'{uris_file}: {len(own)} file(s) for {package}, expected exactly 1')
    version = urllib.parse.unquote(own[0].split('_')[1])
    digest = hashlib.sha256('\n'.join(lines).encode()).hexdigest()[:16]
    # a cache key is a plain string; the epoch colon of a Debian version becomes a dot
    print(f"{version.replace(':', '.')}-{digest}")


# --- prune -----------------------------------------------------------------------------------------------------
def read_index(lists_dir):
    """(package, version, architecture) -> {sha256}, from every Packages file in lists_dir."""
    index = {}
    files = 0
    for name in sorted(os.listdir(lists_dir)):
        path = os.path.join(lists_dir, name)
        if name.endswith('_Packages'):
            opener = open
        elif name.endswith('_Packages.gz'):
            opener = gzip.open
        else:
            continue   # other compressions (lz4, xz) are not read; with no readable index prune fails, see below
        files += 1
        with opener(path, 'rt', encoding='utf-8', errors='replace') as f:
            for stanza in f.read().split('\n\n'):
                fields = {}
                for line in stanza.split('\n'):
                    if line and not line[0].isspace() and ':' in line:
                        k, v = line.split(':', 1)
                        fields[k] = v.strip()
                if {'Package', 'Version', 'Architecture', 'SHA256'} <= fields.keys():
                    k = (fields['Package'], fields['Version'], fields['Architecture'])
                    index.setdefault(k, set()).add(fields['SHA256'].lower())
    return index, files


def cached_key(name):
    # apt names an archive <package>_<version, %-quoted>_<arch>.deb (the epoch colon is %3a)
    parts = name[:-len('.deb')].split('_')
    if len(parts) != 3:
        return None
    return (parts[0], urllib.parse.unquote(parts[1]), parts[2])


def write_output(name, value):
    # a step output under GitHub Actions; elsewhere (a local run, the suite without it) nothing to write
    path = os.environ.get('GITHUB_OUTPUT')
    if path:
        with open(path, 'a', encoding='utf-8') as f:
            f.write(f'{name}={value}\n')


def cmd_prune(lists_dir, archives_dir):
    debs = sorted(n for n in os.listdir(archives_dir) if n.endswith('.deb'))
    if not debs:
        print(f'deb-cache-verify: no cached .deb in {archives_dir} (a cache miss): nothing to check')
        write_output('unverified', 'false')
        return
    index, files = read_index(lists_dir)
    if not index:
        # fail-closed: nothing that cannot be checked is kept; apt downloads it all, as on a miss
        for name in debs:
            os.remove(os.path.join(archives_dir, name))
        print(f'::warning title=ffmpeg .deb cache not verified::no readable Packages index in {lists_dir} '
              f'({files} file(s)); all {len(debs)} cached .deb removed, apt downloads them')
        write_output('unverified', 'true')
        return
    kept, removed = [], []
    for name in debs:
        path = os.path.join(archives_dir, name)
        k = cached_key(name)
        ok = (not os.path.islink(path) and os.path.isfile(path) and k is not None
              and sha256_of(path) in index.get(k, set()))
        if ok:
            kept.append(name)
        else:
            os.remove(path)
            removed.append(name)
    print(f'deb-cache-verify: {len(kept)} cached .deb match the signed index, {len(removed)} removed')
    for name in removed:
        print(f'  removed: {name}')
    write_output('unverified', 'false')


def main(argv):
    if len(argv) == 4 and argv[1] == 'key':
        cmd_key(argv[2], argv[3])
    elif len(argv) in (3, 4) and argv[1] == 'prune':
        cmd_prune(argv[3] if len(argv) == 4 else DEFAULT_LISTS, argv[2])
    else:
        die(USAGE, 2)


if __name__ == '__main__':
    main(sys.argv)
