#!/usr/bin/env bash
# Copy the newest local backup archive to the TrueNAS NFS export, verify it by
# sha256, prune NAS copies older than NAS_KEEP_DAYS, unmount.
# The mount lives only for the copy (a VM-side compromise cannot browse the NAS
# copy in between). Run after scripts/backup.sh (johnny-backup.service ExecStartPost).
# The NAS dataset takes a daily snapshot at 06:00, so this must finish before that.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/root/marveen/backups}"
NAS_EXPORT="${NAS_EXPORT:-192.168.0.15:/mnt/Data/Backups/marveen}"
MNT="${NAS_MNT:-/mnt/nas-backup}"
NAS_KEEP_DAYS="${NAS_KEEP_DAYS:-30}"

latest="$(ls -1t "${BACKUP_DIR}"/claudeclaw-*.tar.gz 2>/dev/null | head -1 || true)"
[[ -n "${latest}" ]] || { echo "nas-copy: no archive in ${BACKUP_DIR}" >&2; exit 2; }

mounted_here=0
cleanup() {
  local rc=$?
  if [[ "${mounted_here}" == 1 ]]; then umount "${MNT}" || umount -l "${MNT}" || true; fi
  # A failed off-site copy must not stay silent: the journal is read by nobody.
  if [[ "${rc}" != 0 ]]; then
    bash "$(dirname "$0")/agent-msg.sh" johnny johnny \
      "[MENTES] A TrueNAS-masolas ELBUKOTT (exit ${rc}). Reszletek: journalctl --user -u johnny-backup.service" \
      >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

install -d -m 0700 "${MNT}"
if ! mountpoint -q "${MNT}"; then
  mount -t nfs -o vers=4.2,_netdev,soft,timeo=150,retrans=3 "${NAS_EXPORT}" "${MNT}"
  mounted_here=1
fi

name="$(basename "${latest}")"
src_sum="$(sha256sum "${latest}" | awk '{print $1}')"
# Write under a temp name, rename only after the checksum matches, so a
# half-written file never looks like a good copy.
umask 077
cp "${latest}" "${MNT}/.${name}.part"
dst_sum="$(sha256sum "${MNT}/.${name}.part" | awk '{print $1}')"
if [[ "${src_sum}" != "${dst_sum}" ]]; then
  rm -f "${MNT}/.${name}.part"
  echo "nas-copy: sha256 MISMATCH for ${name}" >&2
  exit 3
fi
mv "${MNT}/.${name}.part" "${MNT}/${name}"
echo "${src_sum}  ${name}" > "${MNT}/${name}.sha256"
echo "nas-copy: ${name} copied and verified (${src_sum})"

find "${MNT}" -maxdepth 1 -type f \( -name 'claudeclaw-*.tar.gz' -o -name 'claudeclaw-*.tar.gz.sha256' \) \
  -mtime +"${NAS_KEEP_DAYS}" -print -delete | sed 's/^/nas-copy: pruned /'
find "${MNT}" -maxdepth 1 -type f -name '.claudeclaw-*.part' -mmin +120 -delete
