#!/usr/bin/env bash
# Drive shutdown and boot ordering, on real systemd, the kernel's exFAT driver and Docker (M26).
#
# What it shows, each part against the line BoxPilot wrote before this change (today's line) and
# the one it writes now:
#   1. what `nofail` does to the ordering between a drive and docker.service, and what
#      x-systemd.before=docker.service restores (systemctl show / list-dependencies / verify);
#   2. that a unit with PrivateTmp= (boxpilot-run@ has it) cannot mount or unmount for the host;
#   3. the exFAT dirty flag: when it is set and cleared, that it stays set once a volume was
#      mounted dirty, what fsck.exfat -n says about it, and what clears it;
#   4. the unit-stop half of a shutdown, Docker and the drive stopped in one go;
#   5. boot: a drive that appears late and one that never does;
#   6. BoxPilot's own code on this machine: the fstab migration, and the reboot's preparation.
#
# It attaches loop devices, edits /etc/fstab, and stops and restarts Docker, so it runs only on a
# disposable machine (the GitHub runner), as root, with BOXPILOT_DISPOSABLE_TEST=1.
set -uo pipefail

if [ "$(id -u)" -ne 0 ] || [ "${BOXPILOT_DISPOSABLE_TEST:-}" != 1 ]; then
  echo "Run as root with BOXPILOT_DISPOSABLE_TEST=1 on a disposable machine: this edits /etc/fstab and restarts Docker." >&2
  exit 2
fi

REPO="$(pwd)"
NAME=the-dump
MNT="/mnt/${NAME}"
UNIT="$(systemd-escape -p --suffix=mount "$MNT")"
WORK="$(mktemp -d /var/tmp/bp-drive-test.XXXXXX)"
IMG="${WORK}/drive.img"
PROOF="${WORK}/proof"
TODAY="defaults,nofail,uid=1000,gid=1000"     # the line on the owner's server
NEW="${TODAY},x-systemd.before=docker.service,x-systemd.device-timeout=30s"
IMAGE=bp-busybox
DISK=""; PART=""; UUID=""
FAILURES=0
# The runner's own fstab mounts Azure's resource disk at /mnt, and that disk is not there: every
# /mnt/<name> mount requires mnt.mount, which then fails, and the drive with it. Without that line
# /mnt is a plain directory, as it is on a server.
cp /etc/fstab "${WORK}/fstab.runner"
grep -vE '^[^#[:space:]]+[[:space:]]+/mnt/?[[:space:]]' /etc/fstab > "${WORK}/fstab.orig"
cp "${WORK}/fstab.orig" /etc/fstab
systemctl daemon-reload; systemctl reset-failed mnt.mount 2>/dev/null

section() { printf '\n==================== %s ====================\n' "$*"; }
note() { printf '>> %s\n' "$*"; }
pass() { printf 'PASS: %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
check() { local what="$1"; shift; if "$@"; then pass "$what"; else fail "$what"; fi; }
now_ms() { date +%s%3N; }
# systemctl, bounded. A start first clears the unit's start limit: this test starts Docker and the
# drive far more often than systemd lets a real unit start (docker.service allows 3 a minute).
sc() {
  if [ "$1" = start ] || [ "$1" = restart ]; then local verb="$1"; shift; systemctl reset-failed "$@" 2>/dev/null; set -- "$verb" "$@"; fi
  timeout 150 systemctl "$@"
}

cleanup() {
  section "cleanup"
  docker rm -f bp-holder bp-bootwatch bp-reader >/dev/null 2>&1
  pkill -f 'bp-drive-test-holder' 2>/dev/null
  sc stop "$UNIT" >/dev/null 2>&1 || umount -l "$MNT" >/dev/null 2>&1
  cp "${WORK}/fstab.runner" /etc/fstab
  rm -f /etc/docker/daemon.json
  systemctl daemon-reload
  sc start docker.socket docker.service
  detach
}
trap cleanup EXIT

# ---- drives -------------------------------------------------------------------------------------
# A GPT image with one partition, like a USB disk: a whole-disk loop device never becomes a
# systemd device unit here (udev keeps it "not ready"), so a mount of it by UUID would wait for a
# device that never comes.

detach() { losetup -j "$IMG" 2>/dev/null | cut -d: -f1 | xargs -r -n1 losetup -d 2>/dev/null; udevadm settle; DISK=""; PART=""; }
attach() {
  DISK="$(losetup --find --show --partscan "$IMG")"
  PART="${DISK}p1"
  udevadm settle
  for _ in $(seq 1 40); do [ -b "$PART" ] && break; sleep 0.25; done
}
device_unit() { systemd-escape -p --suffix=device "/dev/disk/by-uuid/${UUID}"; }
wait_for_device() {
  for _ in $(seq 1 60); do systemctl is-active --quiet "$(device_unit)" && return 0; sleep 0.25; done
  note "the device unit $(device_unit) did not appear"
  ls -l /dev/disk/by-uuid/ | sed 's/^/   /'
  udevadm info "$PART" 2>&1 | grep -E 'SYSTEMD|ID_FS|DEVLINKS' | sed 's/^/   /'
  return 1
}
fresh_drive() {
  detach
  rm -f "$IMG"; truncate -s 256M "$IMG"
  echo 'type=EBD0A0A2-B9E5-4433-87C0-68B6B72699C7' | sfdisk --quiet --label gpt "$IMG" >/dev/null
  attach
  mkfs.exfat -L thedump "$PART" >/dev/null
  udevadm trigger --action=change --settle "$PART"
  UUID="$(blkid -o value -s UUID "$PART")"
  wait_for_device || { fail "the test drive $PART (UUID $UUID) never became a systemd device"; exit 1; }
  note "drive: $PART UUID=$UUID"
}
fstab_line() {  # $1 = options
  cp "${WORK}/fstab.orig" /etc/fstab
  printf '# boxpilot:%s\nUUID=%s %s exfat %s 0 0\n' "$NAME" "$UUID" "$MNT" "$1" >> /etc/fstab
  systemctl daemon-reload
}
mount_drive() {
  # This test starts the unit more often than systemd's start limit allows a real one.
  systemctl reset-failed "$UNIT" 2>/dev/null
  sc start "$UNIT"
  findmnt -n "$MNT" >/dev/null || { fail "could not mount $MNT"; journalctl -n 20 --no-pager -u "$UNIT" | sed 's/^/   /'; exit 1; }
}
majmin() { lsblk -dno MAJ:MIN "$PART" | tr -d ' '; }
dirty() { local byte; byte="$(od -An -tu1 -j106 -N1 "$PART" | tr -d ' ')"; echo $(( byte & 2 ? 1 : 0 )); }
set_dirty() { local byte; byte="$(od -An -tu1 -j106 -N1 "$PART" | tr -d ' ')"; printf "\\$(printf '%03o' $(( byte | 2 )))" | dd of="$PART" bs=1 seek=106 conv=notrunc status=none; sync; }
# Mount namespaces other than the host's that still have the filesystem, one process each.
held_in() {
  local mm host pid ns; mm="$(majmin)"; host="$(readlink /proc/1/ns/mnt)"
  for f in /proc/[0-9]*/mountinfo; do
    pid="${f#/proc/}"; pid="${pid%/mountinfo}"
    ns="$(readlink "/proc/${pid}/ns/mnt" 2>/dev/null)" || continue
    [ "$ns" = "$host" ] && continue
    awk -v mm="$mm" '$3 == mm { found = 1 } END { exit !found }' "$f" 2>/dev/null || continue
    printf '%s %s(%s)\n' "$ns" "$(cat "/proc/${pid}/comm" 2>/dev/null)" "$pid"
  done | sort -u -k1,1 | cut -d' ' -f2
}
mounted_here() { findmnt -n "$MNT" >/dev/null; }
not_mounted_here() { ! mounted_here; }
# Unmounts the drive, marks it, and mounts it afresh with the mark. A namespace still going away
# (the last step's app or runner unit) can keep the filesystem alive for a moment after the host
# unmounts it; a mount then reuses it without reading the mark, and its last unmount writes the
# mark clear again. So this waits for the kernel's warning, and marks and mounts again without it.
mount_marked() {
  local T
  for _ in 1 2 3 4 5; do
    sc stop "$UNIT"; for _ in $(seq 1 20); do mounted_here || break; sleep 0.25; done
    [ -z "$(held_in)" ] || sleep 1
    set_dirty; T=$(date +%s); mount_drive; sleep 1
    journalctl -k --since "@$T" --no-pager | grep -q 'Volume was not properly unmounted' && { sleep 1; return 0; }
    note "the mount reused a filesystem still held elsewhere, so it never read the mark; again"
    sleep 1
  done
  return 1
}
kernel_since() { journalctl -k --since "@$1" --no-pager 2>/dev/null | grep -i 'exfat' | sed 's/^/   kernel: /'; }

# ---- Docker -------------------------------------------------------------------------------------

set_live_restore() {  # $1 = true|false
  printf '{ "live-restore": %s }\n' "$1" > /etc/docker/daemon.json
  sc restart docker.service
  note "docker live-restore: $(docker info --format '{{.LiveRestoreEnabled}}')"
}
# A stand-in for qBittorrent: appends to a file on the drive all the time, and on SIGTERM writes a
# last line and takes two seconds to finish, as an app flushing its state does.
run_holder() {
  docker rm -f bp-holder >/dev/null 2>&1
  docker run -d --name bp-holder --restart unless-stopped -v "${MNT}:/data" "$IMAGE" sh -c '
    trap "echo stopping >&3; sleep 2; echo stopped >&3; exit 0" TERM
    exec 3>>/data/held.log
    while :; do echo "tick $(date +%s)" >&3; head -c 65536 /dev/urandom >> /data/blob; sleep 0.5 & wait $!; done' >/dev/null
  for _ in $(seq 1 20); do [ -s "${MNT}/held.log" ] && break; sleep 0.5; done
  note "holder running, writing to ${MNT}; dirty flag now: $(dirty)"
}
container_running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = true ]; }
wait_running() { for _ in $(seq 1 40); do container_running "$1" && return 0; sleep 0.5; done; return 1; }

# ---- environment --------------------------------------------------------------------------------

section "environment"
uname -r; systemctl --version | head -1; findmnt --version; docker version --format 'docker {{.Server.Version}}'
docker info --format 'cgroup driver {{.CgroupDriver}} v{{.CgroupVersion}}, live-restore {{.LiveRestoreEnabled}}'
export DEBIAN_FRONTEND=noninteractive
apt-get install -y --no-install-recommends exfatprogs psmisc >/dev/null 2>&1 || { apt-get update >/dev/null && apt-get install -y --no-install-recommends exfatprogs psmisc >/dev/null; }
modprobe exfat 2>/dev/null || { apt-get update >/dev/null; apt-get install -y "linux-modules-extra-$(uname -r)" >/dev/null && modprobe exfat; }
grep -qw exfat /proc/filesystems || { echo "no exfat in this kernel"; exit 1; }
dpkg-query -W exfatprogs
docker pull -q mirror.gcr.io/library/busybox:1.36 >/dev/null && docker tag mirror.gcr.io/library/busybox:1.36 "$IMAGE"
mkdir -p "$MNT" "$PROOF"
fresh_drive

# ---- 1. ordering --------------------------------------------------------------------------------

show_order() {
  systemctl show "$UNIT" -p Options -p WantedBy -p RequiredBy -p Before | sed 's/^/   /'
  note "systemctl list-dependencies --after docker.service, drives only:"
  systemctl list-dependencies --after --plain docker.service | grep 'mnt-' | sed 's/^/   /' || echo "   (none)"
}
docker_after_drive() { systemctl list-dependencies --after --plain docker.service | grep -qF "$UNIT"; }
drive_before_docker() { systemctl show "$UNIT" -p Before --value | tr ' ' '\n' | grep -qx docker.service; }
not_required() { [ -z "$(systemctl show "$UNIT" -p RequiredBy --value)" ]; }

section "1a. ordering, today's line: $TODAY"
fstab_line "$TODAY"; show_order
check "today's line: nothing orders docker.service after the drive" bash -c "! systemctl list-dependencies --after --plain docker.service | grep -qF '$UNIT'"

section "1b. ordering, the new line: $NEW"
fstab_line "$NEW"; show_order
check "new line: the drive is ordered before docker.service" drive_before_docker
check "new line: docker.service is ordered after the drive" docker_after_drive
check "new line: still only wanted by local-fs.target, so a missing drive cannot block boot" not_required
cat "/run/systemd/generator/${UNIT}" | sed 's/^/   /'
out="$(systemd-analyze verify "/run/systemd/generator/${UNIT}" 2>&1)"; rc=$?
[ -n "$out" ] && echo "$out" | sed 's/^/   /'; check "systemd-analyze verify accepts the generated unit" test "$rc" -eq 0
cp "${WORK}/fstab.orig" "${WORK}/fstab.today"; printf '# boxpilot:%s\nUUID=%s %s exfat %s 0 0\n' "$NAME" "$UUID" "$MNT" "$TODAY" >> "${WORK}/fstab.today"
# The count goes to stderr and the details to stdout, so the count is found, not taken from the end.
verify_count() { findmnt --verify --tab-file "$1" 2>&1 | grep -E 'parse error|no errors or warnings'; }
v_today="$(verify_count "${WORK}/fstab.today")"; v_new="$(verify_count /etc/fstab)"
note "findmnt --verify, today's line: $v_today"; note "findmnt --verify, new line:     $v_new"
check "findmnt --verify says no more about the new line than about today's" test "$v_today" = "$v_new"

# ---- 2. a unit with PrivateTmp= and the host's mounts ------------------------------------------

section "2. mounts made from a PrivateTmp=yes unit (boxpilot-run@ has one)"
mount_drive
systemd-run --quiet --wait --pipe -p PrivateTmp=yes /usr/bin/umount "$MNT"; note "umount inside the unit: exit $?"
check "an unmount inside a PrivateTmp unit leaves the host's mount in place" mounted_here
sc stop "$UNIT"
systemd-run --quiet --wait --pipe -p PrivateTmp=yes /usr/bin/mount "$MNT"; note "mount inside the unit: exit $?"
check "a mount inside a PrivateTmp unit does not reach the host" not_mounted_here
mount_drive; check "systemctl start/stop of the mount unit acts on the host" mounted_here
sc stop "$UNIT"; check "systemctl stop of the mount unit unmounts it on the host" not_mounted_here
# What the storage tasks now do instead: mount(8) and umount(8) switched into PID 1's namespace.
systemd-run --quiet --wait --pipe -p PrivateTmp=yes /usr/bin/mount -N /proc/1/ns/mnt "$MNT"; note "mount -N /proc/1/ns/mnt inside the unit: exit $?"
check "mount -N /proc/1/ns/mnt from a PrivateTmp unit mounts on the host" mounted_here
systemd-run --quiet --wait --pipe -p PrivateTmp=yes /usr/bin/umount -N /proc/1/ns/mnt "$MNT"; note "umount -N /proc/1/ns/mnt inside the unit: exit $?"
check "umount -N /proc/1/ns/mnt from a PrivateTmp unit unmounts on the host" not_mounted_here

# ---- 3. the exFAT dirty flag --------------------------------------------------------------------

section "3. exFAT VolumeDirty"
fresh_drive; fstab_line "$NEW"
mount_drive; note "mounted: dirty=$(dirty)"
echo hello > "${MNT}/a.txt"; note "after creating a file: dirty=$(dirty)"
head -c 1048576 /dev/urandom >> "${MNT}/a.txt"; note "after appending 1 MiB: dirty=$(dirty)"
sync; note "after sync: dirty=$(dirty)"
sc stop "$UNIT"; check "a clean unmount leaves the flag clear" test "$(dirty)" -eq 0
set_dirty; note "flag set by hand, as a drive pulled mid-write leaves it: dirty=$(dirty)"
out="$(fsck.exfat -n "$PART" 2>&1)"; rc=$?; echo "$out" | sed 's/^/   /'
check "fsck.exfat -n calls a consistent volume clean, dirty flag or not (exit $rc)" test "$rc" -eq 0
T=$(date +%s); mount_drive; sleep 1; kernel_since "$T"
check "the kernel warns at mount" bash -c "journalctl -k --since @$T --no-pager | grep -q 'Volume was not properly unmounted'"
echo more > "${MNT}/b.txt"; sync
sc stop "$UNIT"; note "after writing and a clean unmount of a volume mounted dirty: dirty=$(dirty)"
check "Linux keeps the flag set when the volume was dirty at mount, however cleanly it is unmounted" test "$(dirty)" -eq 1
T=$(date +%s); mount_drive; sleep 1; kernel_since "$T"; sc stop "$UNIT"
check "so the kernel warns again at the next mount" bash -c "journalctl -k --since @$T --no-pager | grep -q 'Volume was not properly unmounted'"
out="$(fsck.exfat -p "$PART" 2>&1)"; rc=$?; echo "$out" | sed 's/^/   /'
check "fsck.exfat -p (a repairing run) clears it: exit $rc, dirty=$(dirty)" test "$(dirty)" -eq 0
T=$(date +%s); mount_drive; sleep 1; sc stop "$UNIT"
check "and the kernel stops warning" bash -c "! journalctl -k --since @$T --no-pager | grep -q 'Volume was not properly unmounted'"

# ---- 4. the unit-stop half of a shutdown --------------------------------------------------------

section "4a. a host unmount while a container writes through a bind"
fresh_drive; fstab_line "$TODAY"; mount_drive; run_holder
sc stop "$UNIT"; note "systemctl stop of the mount: exit $?"
note "host: $(mounted_here && echo mounted || echo 'not mounted'); still open in: $(held_in | tr '\n' ' ')"
note "dirty flag: $(dirty)"
docker rm -f bp-holder >/dev/null; sleep 1
note "container gone: dirty=$(dirty); still open in: $(held_in | wc -l) namespaces"

shutdown_sim() {  # $1 = label, $2 = options, $3 = live-restore
  section "4b. shutdown's stop jobs: $1, live-restore $3"
  fresh_drive; fstab_line "$2"; set_live_restore "$3"; mount_drive; run_holder
  local T; T=$(date +%s)
  # Docker and the drive stopped together, as shutdown.target and umount.target stop them: systemd
  # orders the stop jobs by the units' Before=/After=, and runs unordered ones at once.
  sc stop docker.socket docker.service "$UNIT"; note "systemctl stop exit $?"
  journalctl --since "@$T" -o short-precise --no-pager -u docker.service -u "$UNIT" | grep -E 'Stopping|Stopped|Unmount|Deactivated|shutdown complete' | sed 's/^/   /'
  local holders; holders="$(held_in | tr '\n' ' ')"
  note "at the end of the unit-stop phase: host $(mounted_here && echo mounted || echo unmounted), still open in [${holders}], dirty=$(dirty)"
  SIM_RESULT="$([ -z "$holders" ] && ! mounted_here && [ "$(dirty)" -eq 0 ] && echo released || echo held)"
  note "=> the filesystem is ${SIM_RESULT} when systemd moves on to the final kill"
  sc start docker.socket docker.service; docker rm -f bp-holder >/dev/null 2>&1; sleep 1
  sc stop "$UNIT" 2>/dev/null
  rm -f /etc/docker/daemon.json; sc restart docker.service
}
shutdown_sim "today's line" "$TODAY" false; today_off="$SIM_RESULT"
shutdown_sim "new line" "$NEW" false; new_off="$SIM_RESULT"
shutdown_sim "today's line" "$TODAY" true; today_on="$SIM_RESULT"
shutdown_sim "new line" "$NEW" true; new_on="$SIM_RESULT"
note "summary: live-restore off: today ${today_off}, new ${new_off}; live-restore on: today ${today_on}, new ${new_on}"
check "live-restore off, new line: Docker has stopped its containers before the drive is unmounted" test "$new_off" = released

# ---- 5. boot ------------------------------------------------------------------------------------

boot_sim() {  # $1 = label, $2 = options, $3 = seconds until the drive appears, or "never"
  section "5. boot: $1, the drive appears after $3"
  fresh_drive; fstab_line "$2"; mount_drive
  echo marker > "${MNT}/drive-marker"; rm -f "${PROOF}"/seen.*
  docker rm -f bp-bootwatch >/dev/null 2>&1
  docker run -d --name bp-bootwatch --restart always -v "${MNT}:/data" -v "${PROOF}:/proof" "$IMAGE" sh -c 'ls -A /data > /proof/seen.$(date +%s%N); trap "exit 0" TERM; while :; do sleep 1 & wait $!; done' >/dev/null
  sleep 1
  sc stop docker.socket docker.service; sc stop "$UNIT"; rm -f "${PROOF}"/seen.*
  detach
  systemctl reset-failed "$UNIT" docker.service docker.socket 2>/dev/null
  local T; T=$(now_ms)
  # What boot does: local-fs.target wants the mount (nofail), multi-user.target wants Docker.
  systemctl start --no-block "$UNIT" docker.service
  if [ "$3" != never ]; then (sleep "$3"; losetup --find --show --partscan "$IMG" >/dev/null; udevadm settle) & fi
  for _ in $(seq 1 120); do systemctl is-active --quiet docker.service && break; sleep 0.5; done
  BOOT_DELAY=$(( $(now_ms) - T ))
  wait
  DISK="$(losetup -j "$IMG" | cut -d: -f1 | head -1)"; PART="${DISK:+${DISK}p1}"
  sleep 2
  BOOT_SEEN="$(cat "${PROOF}"/seen.* 2>/dev/null | tr '\n' ' ')"
  note "Docker active after ${BOOT_DELAY} ms; the drive: $(systemctl show "$UNIT" -p ActiveState --value); the app saw [${BOOT_SEEN}]"
  docker rm -f bp-bootwatch >/dev/null 2>&1
  sc stop "$UNIT" 2>/dev/null
}
boot_sim "today's line" "$TODAY" 6
check "today's line, drive 6 s late: Docker starts at once and the app sees the empty folder" bash -c "[ $BOOT_DELAY -lt 5000 ] && ! grep -q drive-marker <<< '$BOOT_SEEN'"
boot_sim "new line" "$NEW" 6
check "new line, drive 6 s late: Docker waits for it and the app sees the drive" bash -c "[ $BOOT_DELAY -ge 5000 ] && grep -q drive-marker <<< '$BOOT_SEEN'"
boot_sim "new line" "$NEW" never
check "new line, no drive at all: Docker still starts, after the 30 s device timeout (took ${BOOT_DELAY} ms)" bash -c "[ $BOOT_DELAY -ge 25000 ] && [ $BOOT_DELAY -lt 60000 ]"

section "5b. required-by instead of before: no drive"
fresh_drive; fstab_line "${TODAY},x-systemd.required-by=docker.service,x-systemd.before=docker.service,x-systemd.device-timeout=5s"
sc stop docker.socket docker.service; detach
sc start docker.service; note "systemctl start docker: exit $?"
check "with required-by, a missing drive keeps Docker - and every app, drive or not - from starting" bash -c "! systemctl is-active --quiet docker.service"
fstab_line "$TODAY"; sc start docker.socket docker.service
attach; udevadm trigger --action=change --settle "$PART"

# ---- 6. BoxPilot's own code on this machine ----------------------------------------------------

node_run() { node --input-type=module -e "$1"; }

section "6a. the fstab migration (storage.docker-order) on this runner's real fstab"
fresh_drive; fstab_line "$TODAY"
node_run "
  import { storageDockerOrder } from '${REPO}/server/tasks/drive-shutdown.mjs';
  const result = await storageDockerOrder({}, { log: (line, stream) => console.log('   [' + stream + '] ' + line) });
  console.log(JSON.stringify(result));
" > "${WORK}/migration.json"; rc=$?
cat "${WORK}/migration.json"
check "the migration succeeds on a real fstab (whose own entries findmnt already complains about)" test "$rc" -eq 0
check "it wrote the new options on BoxPilot's line only" bash -c "grep -qxF 'UUID=${UUID} ${MNT} exfat ${NEW} 0 0' /etc/fstab && diff <(grep -v 'boxpilot\|${MNT}' /etc/fstab) <(grep -v 'boxpilot\|${MNT}' '${WORK}/fstab.orig')"
check "systemd now orders the drive before Docker" drive_before_docker
backup="$(node -e "console.log(JSON.parse(require('fs').readFileSync('${WORK}/migration.json','utf8').trim().split('\n').pop()).backup)")"
check "the backup is the fstab as it was" bash -c "grep -qxF 'UUID=${UUID} ${MNT} exfat ${TODAY} 0 0' '$backup'"
node_run "
  import { storageDockerOrder } from '${REPO}/server/tasks/drive-shutdown.mjs';
  const again = await storageDockerOrder({});
  process.exit(again.changed ? 1 : 0);
"; check "a second run changes nothing" test $? -eq 0
rm -f /etc/fstab.boxpilot-*

prepare() {
  node_run "
    import { prepareDrivesForReboot } from '${REPO}/server/tasks/drive-shutdown.mjs';
    const summary = await prepareDrivesForReboot({}, { log: (line, stream) => console.log('   [' + stream + '] ' + line) });
    console.log(JSON.stringify(summary));
  " | tee "${WORK}/prepare.out"
  PREP="$(tail -1 "${WORK}/prepare.out")"
}
field() { node -e "const s = JSON.parse(process.argv[1]); console.log(JSON.stringify(eval('s.' + process.argv[2])))" "$PREP" "$1"; }

reboot_prep() {  # $1 = live-restore
  section "6b. the reboot's preparation, today's line (not migrated), live-restore $1"
  fresh_drive; fstab_line "$TODAY"; set_live_restore "$1"; mount_drive; run_holder
  prepare
  local holders rc out last; holders="$(held_in)"
  check "the drive is reported unmounted" test "$(field 'drives[0].state')" = '"unmounted"'
  check "and it is: not mounted on the host, open in no namespace [${holders}]" bash -c "! findmnt -n '$MNT' >/dev/null && [ -z '$holders' ]"
  check "the exFAT flag is clear and reported clear" bash -c "[ $(dirty) -eq 0 ] && [ '$(field 'drives[0].volumeDirty')' = false ]"
  out="$(fsck.exfat -n "$PART" 2>&1)"; rc=$?; check "fsck.exfat -n calls it clean: $(echo "$out" | tail -1)" test "$rc" -eq 0
  check "the holder is reported stopped" bash -c "grep -q bp-holder <<< '$(field 'containers.stopped')'"
  [ "$1" = true ] && check "with live-restore, it was sent its stop signal after Docker stopped" bash -c "grep -q bp-holder <<< '$(field 'containers.signalled')'"
  mount -t exfat "$PART" "${WORK}/peek"; last="$(tail -1 "${WORK}/peek/held.log")"; umount "${WORK}/peek"
  check "and it finished its last write before the drive went ('${last}')" test "$last" = stopped
  # After the reboot: Docker starts, and brings back what it stopped (not "stopped by hand").
  mount_drive; sc start docker.socket docker.service
  check "Docker starting again brings the app back by its restart policy (unless-stopped)" wait_running bp-holder
  docker rm -f bp-holder >/dev/null; sc stop "$UNIT"
  rm -f /etc/docker/daemon.json; sc restart docker.service
}
mkdir -p "${WORK}/peek"
reboot_prep false
reboot_prep true

section "6c. the reboot's preparation, a drive something else holds"
fresh_drive; fstab_line "$TODAY"; mount_drive
( cd "$MNT" && exec -a bp-drive-test-holder sleep 600 ) &
sleep 1
prepare
check "the drive is reported busy" test "$(field 'drives[0].state')" = '"busy"'
check "with what holds it" bash -c "grep -q sleep <<< '$(field 'drives[0].holders')'"
pkill -f bp-drive-test-holder; wait 2>/dev/null
sc stop "$UNIT"

# ---- 7. the storage tasks, run the way boxpilot-run@ runs them ---------------------------------

# A transient unit with the runner's PrivateTmp=, running the task the runner would.
in_runner() { systemd-run --quiet --wait --pipe -p PrivateTmp=yes -p KillMode=process "$(command -v node)" --input-type=module -e "$1"; }
# The host's own mount table, watched for the drive going away: only a real unmount does that. (A
# mount id cannot tell: the kernel hands the freed id straight to the next mount.)
watch_host() { findmnt --poll=umount --first-only --timeout 120000 --mountpoint "$MNT" > "${WORK}/poll.out" 2>&1 & POLLER=$!; sleep 0.5; }
host_saw_umount() { wait "$POLLER"; }

section "7a. Reconnect (storage.remount) from a PrivateTmp unit"
fresh_drive; fstab_line "$NEW"; mount_drive; run_holder
watch_host
in_runner "
  import { storageRemount } from '${REPO}/server/tasks/storage.mjs';
  console.log(JSON.stringify(await storageRemount({ name: '${NAME}' }, { log: (line, stream) => console.log('   [' + stream + '] ' + line) })));
"; rc=$?
host_saw_umount; seen=$?
check "storage.remount succeeds from the runner's namespace (exit $rc)" test "$rc" -eq 0
check "the host saw its own mount go ($(tr '\n' ' ' < "${WORK}/poll.out")) and it is back" bash -c "[ $seen -eq 0 ] && findmnt -n '$MNT' >/dev/null"
check "and restarted the app using it" wait_running bp-holder

section "7b. Check (storage.check) from a PrivateTmp unit, on a drive still carrying the mark"
docker rm -f bp-holder >/dev/null
mount_marked || fail "could not mount the drive afresh with the mark set"
run_holder
watch_host; T=$(date +%s)
in_runner "
  import { storageCheck } from '${REPO}/server/tasks/storage.mjs';
  console.log(JSON.stringify(await storageCheck({ name: '${NAME}' }, { log: (line, stream) => console.log('   [' + stream + '] ' + line) })));
" | tee "${WORK}/check.out"; rc=${PIPESTATUS[0]}
host_saw_umount; seen=$?; result="$(tail -1 "${WORK}/check.out")"
check "storage.check succeeds from the runner's namespace (exit $rc)" test "$rc" -eq 0
check "the host saw its own mount go for the check ($(tr '\n' ' ' < "${WORK}/poll.out")) and come back" bash -c "[ $seen -eq 0 ] && findmnt -n '$MNT' >/dev/null"
kernel_since "$T"
check "and the kernel mounted it afresh, repeating the mark's warning" bash -c "journalctl -k --since @$T --no-pager | grep -q 'Volume was not properly unmounted'"
check "it calls the drive clean and says it is still marked" bash -c "grep -q '\"clean\":true' <<< '$result' && grep -q '\"markedDirty\":true' <<< '$result'"
check "and started the app again" wait_running bp-holder
docker rm -f bp-holder >/dev/null; sc stop "$UNIT"

section "7c. Clear the mark (storage.dirty-mark.clear) from a PrivateTmp unit"
# 7b left the drive unmounted, marked and consistent, as the owner's was.
check "the drive is still marked before" test "$(dirty)" -eq 1
mount_drive; run_holder
in_runner "
  import { storageClearMark } from '${REPO}/server/tasks/storage.mjs';
  console.log(JSON.stringify(await storageClearMark({ name: '${NAME}' }, { log: (line, stream) => console.log('   [' + stream + '] ' + line) })));
" | tee "${WORK}/clear.out"; rc=${PIPESTATUS[0]}
check "storage.dirty-mark.clear succeeds (exit $rc)" test "$rc" -eq 0
check "it says it cleared the mark" grep -q '"cleared":true' "${WORK}/clear.out"
docker rm -f bp-holder >/dev/null; sc stop "$UNIT"
check "and the mark is clear on the drive" test "$(dirty)" -eq 0
T=$(date +%s); mount_drive; sleep 1
check "and the kernel no longer warns when it mounts it" bash -c "! journalctl -k --since @$T --no-pager | grep -q 'Volume was not properly unmounted'"

section "7d. What each drive's filesystem says (storage.volume-state), from a PrivateTmp unit"
# A second drive, ext4, beside the exFAT one: the kernel's word and the filesystem's side by side.
truncate -s 64M "${WORK}/ext.img"; mkfs.ext4 -q -L media "${WORK}/ext.img"
EXT_LOOP="$(losetup --find --show "${WORK}/ext.img")"; udevadm settle
EXT_UUID="$(blkid -o value -s UUID "$EXT_LOOP")"
mkdir -p /mnt/media
printf '# boxpilot:media\nUUID=%s /mnt/media ext4 defaults,nofail 0 2\n' "$EXT_UUID" >> /etc/fstab; systemctl daemon-reload
mount /mnt/media
echo written > "${MNT}/after-clear.txt"; sync
in_runner "
  import { storageVolumeState } from '${REPO}/server/tasks/drive-shutdown.mjs';
  console.log(JSON.stringify(await storageVolumeState({})));
" | tee "${WORK}/volumes.out"; rc=${PIPESTATUS[0]}
volumes="$(tail -1 "${WORK}/volumes.out")"
check "storage.volume-state reads both drives (exit $rc)" bash -c "grep -q '\"mountpoint\":\"/mnt/the-dump\"' <<< '$volumes' && grep -q '\"mountpoint\":\"/mnt/media\"' <<< '$volumes'"
check "ext4's superblock state is read" grep -q '"ext":{"state":"clean"}' <<< "$volumes"
check "a mounted exFAT drive written since mounting reads as marked, which is why a set mark alone decides nothing" grep -q '"exfat":{"dirty":true}' <<< "$volumes"
check "and each mount's start is known, to place the kernel's warnings" grep -q '"mountedAt":"20' <<< "$volumes"
umount /mnt/media; losetup -d "$EXT_LOOP"
cp "${WORK}/fstab.orig" /etc/fstab; printf '# boxpilot:%s\nUUID=%s %s exfat %s 0 0\n' "$NAME" "$UUID" "$MNT" "$NEW" >> /etc/fstab; systemctl daemon-reload

section "7e. A drive that is also a Samba share, with a client holding a file on it"
# The owner's case: a PC with the share mapped holds handles on the drive through smbd, and
# reconnects as soon as it is disconnected. Linux's own SMB client does both, as Windows does.
apt-get install -y --no-install-recommends samba cifs-utils >/dev/null 2>&1 || { apt-get update >/dev/null; apt-get install -y --no-install-recommends samba cifs-utils >/dev/null; }
cp /etc/samba/smb.conf "${WORK}/smb.conf.orig" 2>/dev/null
cat > /etc/samba/smb.conf <<EOF
[global]
   workgroup = WORKGROUP
   map to guest = bad user
   guest account = nobody
   server min protocol = SMB2
[Media]
   path = ${MNT}
   guest ok = yes
   read only = no
   force user = root
EOF
sc restart smbd
echo hold > "${MNT}/held.txt"
mkdir -p /mnt/pc
mount -t cifs //127.0.0.1/Media /mnt/pc -o guest,vers=3.0 || fail "could not mount the share as a client"
( exec 3< /mnt/pc/held.txt; exec sleep 600 ) &
PC=$!
sleep 2
umount "$MNT" 2>"${WORK}/umount.err"; rc=$?
note "a plain umount with the client holding a file: exit $rc, $(cat "${WORK}/umount.err")"
check "Samba holds the drive for its client" test "$rc" -ne 0
in_runner "
  import { storageCheck } from '${REPO}/server/tasks/storage.mjs';
  console.log(JSON.stringify(await storageCheck({ name: '${NAME}' }, { log: (line, stream) => console.log('   [' + stream + '] ' + line) })));
" | tee "${WORK}/check2.out"; rc=${PIPESTATUS[0]}
check "storage.check gets the share's client off the drive and checks it (exit $rc)" test "$rc" -eq 0
check "and says whom it disconnected" grep -qE 'Closed file-sharing connections from [^ ]*127\.0\.0\.1[^ ]* to Media so /mnt/the-dump could be unmounted' "${WORK}/check2.out"
kill "$PC" 2>/dev/null; wait 2>/dev/null

section "7f. Reconnect (storage.remount) a busy drive: an app with it bound and a PC holding the share (M35)"
# The owner's four refusals: "Reconnect the drive" said "target is busy" because an app had the
# folder bound and a PC had the share mapped, and told the owner to stop them by hand. It now goes
# through the check's pipeline: stop the app, close the share, unmount on the host, mount, start.
run_holder
# The PC connects afresh (7e's check disconnected the last one) and holds a file on the share.
umount -l /mnt/pc 2>/dev/null
mount -t cifs //127.0.0.1/Media /mnt/pc -o guest,vers=3.0 || fail "could not mount the share as a client again"
( exec 3< /mnt/pc/held.txt; exec sleep 600 ) &
PC=$!
sleep 2
note "smbd's open files: $(smbstatus -L 2>/dev/null | grep -c held.txt) on held.txt"
if umount "$MNT" 2>"${WORK}/umount3.err"; then fail "the drive was not busy, so this shows nothing"; mount "$MNT"; else pass "the drive is busy before the reconnect: $(cat "${WORK}/umount3.err")"; fi
watch_host
in_runner "
  import { storageRemount } from '${REPO}/server/tasks/storage.mjs';
  console.log(JSON.stringify(await storageRemount({ name: '${NAME}' }, { log: (line, stream) => console.log('   [' + stream + '] ' + line) })));
" | tee "${WORK}/remount2.out"; rc=${PIPESTATUS[0]}
host_saw_umount; seen=$?
result="$(tail -1 "${WORK}/remount2.out")"
check "storage.remount reconnects the busy drive (exit $rc)" test "$rc" -eq 0
check "the host saw its own mount go ($(tr '\n' ' ' < "${WORK}/poll.out")) and it is back" bash -c "[ $seen -eq 0 ] && findmnt -n '$MNT' >/dev/null"
check "it stopped the app holding the drive and started it again" bash -c "grep -q '\"stopped\":\[\"bp-holder\"\]' <<< '$result' && grep -q '\"restarted\":\[\"bp-holder\"\]' <<< '$result'"
check "and the app is running again" wait_running bp-holder
check "it says whom it disconnected from the share" grep -qE 'Closed file-sharing connections from [^ ]*127\.0\.0\.1[^ ]* to Media so /mnt/the-dump could be unmounted' "${WORK}/remount2.out"
check "the drive is read-write" bash -c "findmnt -n -o OPTIONS '$MNT' | grep -q '^rw'"
check "and the app writes to the drive as it is mounted now" bash -c "before=\$(wc -l < '${MNT}/held.log'); sleep 2; [ \$(wc -l < '${MNT}/held.log') -gt \$before ]"

section "7g. Reconnect a drive the kernel turned read-only, with an app still holding it (M35)"
# errors=remount-ro, as a drive that drops off USB for a moment leaves it. While any container still
# holds the filesystem, mounting the same device again hands back that same read-only filesystem
# (or is refused: "would change RO state"), which is why the app is stopped first, not just
# restarted afterwards. The kernel turns a filesystem read-only with files open for writing; a
# remount by hand refuses that, so the app here only reads, and still holds the filesystem.
docker rm -f bp-holder >/dev/null
docker run -d --name bp-reader --restart unless-stopped -v "${MNT}:/data" "$IMAGE" sh -c 'trap "exit 0" TERM; while :; do ls /data > /dev/null; sleep 1 & wait $!; done' >/dev/null
wait_running bp-reader
mount -o remount,ro "$MNT" || note "remount,ro refused: $(findmnt -n -o OPTIONS "$MNT")"
check "the drive is read-only before" bash -c "findmnt -n -o OPTIONS '$MNT' | grep -q '^ro'"
check "with the app holding it" container_running bp-reader
in_runner "
  import { storageRemount } from '${REPO}/server/tasks/storage.mjs';
  console.log(JSON.stringify(await storageRemount({ name: '${NAME}' }, { log: (line, stream) => console.log('   [' + stream + '] ' + line) })));
" | tee "${WORK}/remount3.out"; rc=${PIPESTATUS[0]}
result="$(tail -1 "${WORK}/remount3.out")"
check "storage.remount reconnects the read-only drive (exit $rc)" test "$rc" -eq 0
check "and it says it was read-only before" grep -q '"readOnlyBefore":true' <<< "$result"
check "it is read-write now, a fresh filesystem" bash -c "findmnt -n -o OPTIONS '$MNT' | grep -q '^rw'"
check "it stopped the app holding the read-only filesystem and started it again" bash -c "grep -q '\"stopped\":\[\"bp-reader\"\]' <<< '$result' && grep -q '\"restarted\":\[\"bp-reader\"\]' <<< '$result'"
check "and the app is running on it again" wait_running bp-reader
docker rm -f bp-reader >/dev/null
kill "$PC" 2>/dev/null; wait 2>/dev/null; umount -l /mnt/pc 2>/dev/null
sc stop smbd; cp "${WORK}/smb.conf.orig" /etc/samba/smb.conf 2>/dev/null

section "result"
if [ "$FAILURES" -eq 0 ]; then echo "all checks passed"; else echo "${FAILURES} check(s) failed"; fi
exit "$FAILURES"
