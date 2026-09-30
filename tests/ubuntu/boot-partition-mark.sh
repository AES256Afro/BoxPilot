#!/bin/bash
# The boot partition's "not properly unmounted" mark on a real kernel with real dosfstools
# (2026-09-29): after a power cut the owner's kernel said "FAT-fs (nvme0n1p1): Volume was not
# properly unmounted" about /boot/efi at every boot. A FAT32 partition on a loop device stands in for
# it, marked the way a power cut leaves it; then, when the runner has a /boot/efi of its own, that
# one, through boxpilot-run@.service as shipped.
#
#   sudo bash tests/ubuntu/boot-partition-mark.sh /path/to/node-24
#
# DISPOSABLE MACHINES ONLY (CI runs it on GitHub's Ubuntu VMs): it unmounts and marks the runner's
# own /boot/efi, and installs boxpilot-run@.service.
#
#   0. A clean FAT32 mount: the kernel says nothing, and Repair finds nothing.
#   1. Marked and mounted again: the kernel prints the owner's line, and Repair finds it.
#   2. fsck.fat -n reads the mark and the backup boot sector differing at 65:01/00, and the parser
#      calls that the mark and nothing else.
#   3. The fix clears it, mounts the partition again and reads it; fsck.fat then finds nothing, the
#      kernel says nothing at that mount, and the recorded check answers the old line.
#   4. Something with a file open on it: refused, left mounted, nothing checked.
#   5. More than the mark (FSInfo's free count off): refused, nothing written, mounted again.
#   6. The runner's own /boot/efi, marked, through boxpilot-run@.
set -uo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run as root, on a disposable machine" >&2; exit 2; }
NODE="${1:-$(command -v node || true)}"
[ -x "$NODE" ] && [ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -ge 24 ] || { echo "pass a Node.js 24 binary as the first argument" >&2; exit 2; }
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SERVER="${ROOT}/server"
HELPER="${ROOT}/tests/ubuntu/boot-partition.mjs"
WORK="$(mktemp -d /var/tmp/bp-esp.XXXXXX)"
TARGET=/mnt/bp-esp
DEV=""
HOLDER=""
FAILURES=0
RESULTS=""

section() { printf '\n==== %s ====\n' "$*"; }
note() { printf '    %s\n' "$*"; }
record() { # record PASS|FAIL <what>
  RESULTS="${RESULTS}$1  $2"$'\n'
  printf '  %s  %s\n' "$1" "$2"
  [ "$1" = PASS ] || FAILURES=$((FAILURES + 1))
}
check() { # check <what> <command...>
  local what="$1"; shift
  if "$@"; then record PASS "$what"; else record FAIL "$what"; fi
}
contains() { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }
field() { "$NODE" -p "const value = JSON.parse(process.argv[1]); String(value.${1})" "$2"; }
step() { OUT="$("$NODE" "$HELPER" "$@" | tail -n 1)"; }
mounted_from() { [ "$(findmnt -n -o SOURCE --mountpoint "$1" 2>/dev/null | tail -n 1)" = "$2" ]; }
# How many times the kernel has said the owner's line about this device, this boot.
warnings() { journalctl -k -b 0 --no-pager -o cat | grep -c "FAT-fs (${1#/dev/}): Volume was not properly unmounted" || true; }
marked_mount() { umount "$TARGET" && "$NODE" "$HELPER" mark "$DEV" >/dev/null && mount -t vfat -o umask=0077 "$DEV" "$TARGET"; }

cleanup() {
  [ -n "$HOLDER" ] && kill "$HOLDER" 2>/dev/null
  umount "$TARGET" 2>/dev/null
  [ -n "$DEV" ] && losetup -d "$DEV" 2>/dev/null
  rmdir "$TARGET" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

section "Prepare: $(uname -r), $(fsck.fat --version 2>&1 | head -n 1)"
command -v mkfs.fat >/dev/null || { apt-get update -qq && apt-get install -y -qq dosfstools >/dev/null; }
truncate -s 128M "${WORK}/esp.img"
mkfs.fat -F 32 -s 1 -n ESP "${WORK}/esp.img" >/dev/null
DEV="$(losetup --find --show "${WORK}/esp.img")"
install -d -m 0755 "$TARGET"
mount -t vfat -o umask=0077 "$DEV" "$TARGET"
mkdir -p "${TARGET}/EFI/ubuntu" && printf 'shim stand-in\n' > "${TARGET}/EFI/ubuntu/shimx64.efi"
note "${DEV} is FAT32 at ${TARGET}: $(ls "${TARGET}/EFI/ubuntu")"

section "0. A clean FAT32 mount"
umount "$TARGET" && mount -t vfat -o umask=0077 "$DEV" "$TARGET"
check "the kernel says nothing about it" [ "$(warnings "$DEV")" = 0 ]
step detect "$SERVER" "$TARGET"
check "and Repair finds nothing" [ "$(field finding "$OUT")" = null ]

section "1. Marked as a power cut leaves it, and mounted again"
marked_mount
note "kernel: $(journalctl -k -b 0 --no-pager -o cat | grep "FAT-fs (${DEV#/dev/})" | tail -n 1)"
check "the kernel prints the owner's line" [ "$(warnings "$DEV")" = 1 ]
step detect "$SERVER" "$TARGET"
check "Repair finds it" [ "$(field finding.id "$OUT")" = boot-partition-mark ]
check "and offers the check" [ "$(field finding.fix.operationId "$OUT")" = storage.boot-mark.clear ]
note "evidence: $(field 'finding.evidence[0]' "$OUT")"

section "2. What fsck.fat -n says about it, unmounted"
umount "$TARGET"
step fsck "$SERVER" "$DEV"
note "parsed: ${OUT}"
check "it reads the mark" [ "$(field dirty "$OUT")" = true ]
check "and the backup boot sector differing in that one bit, which is the mark too" [ "$(field backupIsTheMark "$OUT")" = true ]
check "so it is the mark and nothing else" [ "$(field onlyTheMark "$OUT")" = true ]
mount -t vfat -o umask=0077 "$DEV" "$TARGET"

section "3. Check and clear the boot partition's mark"
before="$(warnings "$DEV")"
step clear "$SERVER" "$TARGET"
note "result: ${OUT}"
check "it cleared the mark" [ "$(field result.cleared "$OUT")" = true ]
check "and mounted the partition again" mounted_from "$TARGET" "$DEV"
check "which reads" test -f "${TARGET}/EFI/ubuntu/shimx64.efi"
check "and the kernel said nothing at that mount" [ "$(warnings "$DEV")" = "$before" ]
CHECKED="$(field result.checkedAt "$OUT")"
umount "$TARGET"
step fsck "$SERVER" "$DEV"
check "fsck.fat -n finds nothing now" [ "$(field code "$OUT"):$(field clean "$OUT")" = "0:true" ]
mount -t vfat -o umask=0077 "$DEV" "$TARGET"
step detect "$SERVER" "$TARGET"
check "the kernel's old line is still in this boot's log, so without the record Repair would still say it" [ "$(field finding.id "$OUT")" = boot-partition-mark ]
step detect "$SERVER" "$TARGET" "$CHECKED"
check "and with the check recorded, as the job records it, Repair finds nothing" [ "$(field finding "$OUT")" = null ]

section "4. Something has a file open on it"
marked_mount
( cd "${TARGET}/EFI" && exec sleep 600 ) & HOLDER=$!
sleep 1
step clear "$SERVER" "$TARGET"
note "result: ${OUT}"
check "refused" contains "$(field error "$OUT")" "could not be unmounted"
check "and nothing was changed" contains "$(field error "$OUT")" "left mounted and nothing was changed"
check "it is still mounted" mounted_from "$TARGET" "$DEV"
kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null; HOLDER=""

section "5. More than the mark: FSInfo's free count is off"
# usefree: the kernel takes FSInfo's count as it is, rather than counting again (and writing the
# right one back) the first time anything asks how much space is free.
umount "$TARGET" && "$NODE" "$HELPER" freecount "$DEV" >/dev/null && mount -t vfat -o umask=0077,usefree "$DEV" "$TARGET"
step clear "$SERVER" "$TARGET"
note "result: ${OUT}"
check "refused, naming what the check found" contains "$(field error "$OUT")" "Free cluster summary wrong"
check "and it is mounted again" mounted_from "$TARGET" "$DEV"
umount "$TARGET"
step fsck "$SERVER" "$DEV"
check "nothing was written: the mark is still set" [ "$(field dirty "$OUT")" = true ]
mount -t vfat -o umask=0077 "$DEV" "$TARGET"

section "6. The runner's own /boot/efi, through boxpilot-run@"
ESP="$(findmnt -n -o SOURCE,FSTYPE --mountpoint /boot/efi 2>/dev/null | awk '$2 == "vfat" { print $1 }' | tail -n 1)"
if [ -z "$ESP" ]; then
  note "this runner has no FAT /boot/efi: skipped"
else
  install -d -m 0755 /opt/boxpilot
  cp -r "${ROOT}/server" "${ROOT}/scripts" "${ROOT}/package.json" /opt/boxpilot/
  sed -e "s|/usr/local/bin/node|${NODE}|g" "${ROOT}/deploy/boxpilot-run@.service" > /etc/systemd/system/boxpilot-run@.service
  install -d -m 0700 /run/boxpilot /run/boxpilot/run
  systemctl daemon-reload
  note "/boot/efi is ${ESP}: $(grep -E '[[:space:]]/boot/efi[[:space:]]' /etc/fstab || echo 'not in fstab')"
  umount /boot/efi && "$NODE" "$HELPER" mark "$ESP" >/dev/null && mount /boot/efi
  check "marked, the kernel prints the owner's line about it" [ "$(warnings "$ESP")" -ge 1 ]
  step unit /opt/boxpilot/server
  note "result: ${OUT}"
  check "boxpilot-run@ cleared it" [ "$(field result.cleared "$OUT")" = true ]
  check "and /boot/efi is mounted again from ${ESP}" mounted_from /boot/efi "$ESP"
  umount /boot/efi
  step fsck "$SERVER" "$ESP"
  check "fsck.fat -n finds nothing on it now" [ "$(field clean "$OUT")" = true ]
  mount /boot/efi
fi

section "Summary"
printf '%s' "$RESULTS"
[ "$FAILURES" -eq 0 ] && echo "All checks passed." || echo "${FAILURES} check(s) failed."
exit "$FAILURES"
