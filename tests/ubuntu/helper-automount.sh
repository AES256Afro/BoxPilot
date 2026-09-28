#!/bin/bash
# BoxPilot's root helper must start whether or not the backup NAS is reachable, and still write to
# the share once it is. Shown here on real systemd, with a real CIFS automount written the way
# share.mount writes it and a real Samba server, for the sandbox as it was and as it is now.
#
#   sudo bash tests/ubuntu/helper-automount.sh /path/to/node-24
#
# DISPOSABLE MACHINES ONLY (CI runs it on GitHub's Ubuntu VMs): it installs Samba, rewrites
# /etc/fstab and installs its own copy of boxpilot-helper.service.
#
# The helper unit is deploy/boxpilot-helper.service with one line changed, ExecStart=, which runs
# tests/ubuntu/helper-probe.mjs: BoxPilot's own backup code (machine-snapshot-helper.mjs) inside the
# unit's real sandbox, answering write/inspect/sync requests. "Before the fix" is the same unit
# with the sandbox pointed at the share's automount point again, as it shipped until now.
set -uo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run as root, on a disposable machine" >&2; exit 2; }
NODE="${1:-$(command -v node || true)}"
[ -x "$NODE" ] && [ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -ge 24 ] || { echo "pass a Node.js 24 binary as the first argument" >&2; exit 2; }
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
UNIT=boxpilot-helper.service
UNIT_SOURCE="${ROOT}/deploy/${UNIT}"
PROBE_DIR=/var/lib/boxpilot/probe
NAS_ROOT=/srv/boxpilot-nas/backup
CRED=/etc/boxpilot/secrets/share-boxpilot-backup.cred
UNREACHABLE=192.0.2.1          # TEST-NET-1: nothing answers there
OLD=/mnt/boxpilot-backup       # where the backup destination was
NEW=/mnt/boxpilot/backup       # where it is now
SYSTEMD_VERSION="$(systemctl --version | sed -n '1s/^systemd \([0-9]*\).*/\1/p')"
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
fstype_at() { findmnt -rn -o TARGET,FSTYPE | awk -v target="$1" '$1 == target { print $2 }' | tr '\n' ' ' | sed 's/ $//'; }
escaped() { systemd-escape -p "$1"; }

prepare() {
  section "Prepare: systemd ${SYSTEMD_VERSION}, kernel $(uname -r), cifs-utils, Samba on 127.0.0.1"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq >/dev/null
  apt-get install -y -qq --no-install-recommends cifs-utils samba >/dev/null
  systemctl stop smbd nmbd 2>/dev/null || true
  systemctl disable nmbd 2>/dev/null || true
  # The runner's fstab mounts an Azure resource disk at /mnt that these VMs do not have, and every
  # automount under /mnt requires mnt.mount, which then waits 90 s for that device and fails. A
  # real server has no such line.
  if ! mountpoint -q /mnt && grep -qE '^[^#[:space:]]+[[:space:]]+/mnt[[:space:]]' /etc/fstab; then
    note "disabling the runner's own /mnt entry: $(grep -E '^[^#[:space:]]+[[:space:]]+/mnt[[:space:]]' /etc/fstab)"
    sed -i -E 's|^([^#[:space:]]+[[:space:]]+/mnt[[:space:]].*)$|# disabled for this test: \1|' /etc/fstab
    systemctl daemon-reload
    systemctl reset-failed mnt.mount 2>/dev/null || true
  fi
  getent group boxpilot >/dev/null || groupadd --system boxpilot
  id boxpilot >/dev/null 2>&1 || useradd --system -g boxpilot --home-dir /var/lib/boxpilot --shell /usr/sbin/nologin boxpilot
  install -d -m 0700 -o boxpilot -g boxpilot /var/lib/boxpilot
  install -d -m 0700 "$PROBE_DIR" /etc/boxpilot/secrets
  # What production has under /opt/boxpilot, as far as the probe needs it.
  install -d -m 0755 /opt/boxpilot/tests/ubuntu
  cp -r "${ROOT}/server" "${ROOT}/package.json" /opt/boxpilot/
  cp "${ROOT}/tests/ubuntu/helper-probe.mjs" /opt/boxpilot/tests/ubuntu/
  # A local backup for the mirror to copy, where the controller backups live.
  install -d -m 0700 /var/lib/boxpilot-managed /var/lib/boxpilot-managed/backups /var/lib/boxpilot-managed/backups/boxpilot-controller/probe-backup
  head -c 65536 /dev/urandom > /var/lib/boxpilot-managed/backups/boxpilot-controller/probe-backup/boxpilot.sqlite3
  # Another drive under /mnt, mounted before the helper starts, that the helper must not be able to write.
  install -d -m 0755 /mnt/other-drive /mnt/boxpilot
  mountpoint -q /mnt/other-drive || mount -t tmpfs -o size=4m tmpfs /mnt/other-drive
  # The NAS: one share, one user, on the loopback interface only.
  id nasuser >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin nasuser
  install -d -o nasuser -g nasuser -m 0755 "$NAS_ROOT"
  cat > /etc/samba/smb.conf <<'CONF'
[global]
   server role = standalone server
   interfaces = lo
   bind interfaces only = yes
   disable netbios = yes
   smb ports = 445
   map to guest = never
   log file = /var/log/samba/log.%m
[backup]
   path = /srv/boxpilot-nas/backup
   read only = no
   valid users = nasuser
CONF
  local password
  password="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)"
  printf '%s\n%s\n' "$password" "$password" | smbpasswd -a -s nasuser >/dev/null
  # Where share.mount keeps SMB credentials, in its format.
  printf 'username=nasuser\npassword=%s\n' "$password" > "$CRED"
  chmod 0600 "$CRED"
}

# share_line <host> <mountpoint>: the fstab entry BoxPilot's share.mount writes for the backup
# destination (buildShareEntry, the same function), moved to <mountpoint> for the old layout.
share_line() {
  "$NODE" --input-type=module -e "import { buildShareEntry } from '${ROOT}/server/tasks/shares.mjs'; console.log(buildShareEntry({ kind: 'smb', host: process.argv[1], share: 'backup', name: 'boxpilot-backup', guest: false }).entry);" "$1" \
    | sed "s| ${NEW} | $2 |"
}

clear_backup_share() {
  for mountpoint in "$OLD" "$NEW"; do
    systemctl stop "$(escaped "$mountpoint").mount" "$(escaped "$mountpoint").automount" 2>/dev/null || true
  done
  sed -i '/^# boxpilot:share-boxpilot-backup$/,+1d' /etc/fstab
  systemctl daemon-reload
}

# set_backup_share <host> <mountpoint>: exactly one backup share in fstab, its automount in place.
set_backup_share() {
  clear_backup_share
  mkdir -p "$2"
  local line; line="$(share_line "$1" "$2")"
  printf '# boxpilot:share-boxpilot-backup\n%s\n' "$line" >> /etc/fstab
  systemctl daemon-reload
  systemctl start "$(escaped "$2").automount" || { systemctl status "$(escaped "$2").automount" --no-pager; exit 1; }
  note "fstab: ${line}"
  [ "$(fstype_at "$2")" = autofs ] || { echo "the automount is not in place at $2" >&2; exit 1; }
}

# install_helper_unit shipped|before-fix
install_helper_unit() {
  local file="/etc/systemd/system/${UNIT}"
  sed -e "s|^ExecStart=.*|ExecStart=${NODE} /opt/boxpilot/tests/ubuntu/helper-probe.mjs|" "$UNIT_SOURCE" > "$file"
  if [ "$1" = before-fix ]; then
    # As it shipped until now: the sandbox given the share's own automount point, the backup code
    # looking there, and the ordering the previous attempt at this added.
    sed -i -e 's|^ReadWritePaths=-/mnt/boxpilot$|ReadWritePaths=-/mnt/boxpilot-backup|' \
      -e 's|_BACKUP_MOUNT=/mnt/boxpilot/backup$|_BACKUP_MOUNT=/mnt/boxpilot-backup|' \
      -e 's|^After=mnt-boxpilot-backup.automount$|Wants=network-online.target\nAfter=network-online.target mnt-boxpilot\\x2dbackup.automount|' "$file"
    grep -q '^ReadWritePaths=-/mnt/boxpilot-backup$' "$file" || { echo "could not rebuild the unit as it was" >&2; exit 1; }
  fi
  systemctl daemon-reload
  note "$1 unit: $(grep -E '^(ReadWritePaths=-/mnt|Environment=BOXPILOT_CONTROLLER_BACKUP_MOUNT)' "$file" | tr '\n' ' ')"
}

stop_helper() {
  timeout 60 systemctl stop "$UNIT" 2>/dev/null || systemctl kill -s KILL "$UNIT" 2>/dev/null || true
  systemctl reset-failed "$UNIT" 2>/dev/null || true
  rm -f "$PROBE_DIR"/*
}

# start_helper [seconds]: 0 once the probe answers from inside the sandbox.
start_helper() {
  stop_helper
  START_SINCE="$(date '+%Y-%m-%d %H:%M:%S')"
  local started=$SECONDS
  systemctl start --no-block "$UNIT"
  while [ ! -f "$PROBE_DIR/ready" ] && [ $((SECONDS - started)) -lt "${1:-60}" ]; do sleep 1; done
  START_SECONDS=$((SECONDS - started))
  [ -f "$PROBE_DIR/ready" ]
}
helper_journal() { journalctl -u "$UNIT" --since "$START_SINCE" --no-pager -o cat; }
restarts() { systemctl show "$UNIT" -p NRestarts --value; }

# probe <action> [argument] [limit]: sets ANSWER and ANSWER_SECONDS; "no answer" when it hangs.
probe() {
  local id="${PROBE_DIR}/$(date +%s%N)" waited=0
  printf '%s %s\n' "$1" "${2:-}" > "${id}.tmp-request"
  mv "${id}.tmp-request" "${id}.request"
  while [ ! -f "${id}.response" ] && [ $waited -lt "${3:-90}" ]; do sleep 1; waited=$((waited + 1)); done
  if [ -f "${id}.response" ]; then ANSWER="$(cat "${id}.response")"; rm -f "${id}.response"; else ANSWER="no answer after ${waited}s"; fi
  ANSWER_SECONDS="$(printf '%s' "$ANSWER" | sed -n 's/.*(\([0-9]*\)s)$/\1/p')"
  ANSWER_SECONDS="${ANSWER_SECONDS:-999}"
  note "$1 ${2:-}: ${ANSWER}"
}
answered_ok() { contains "$ANSWER" "ok: "; }
answered_failed() { contains "$ANSWER" "failed: "; }
within() { [ "$ANSWER_SECONDS" -le "$1" ]; }

prepare

section "1. Before the fix: the NAS is unreachable when the helper starts"
set_backup_share "$UNREACHABLE" "$OLD"
install_helper_unit before-fix
systemd-analyze log-level debug
start_helper 75 && reached=yes || reached=no
systemd-analyze log-level info
journal="$(helper_journal)"
printf '%s\n' "$journal" | grep -E 'Failed to set up mount namespacing|Failed at step NAMESPACE|mount_setattr\(\) failed|Scheduled restart job' | head -n 8 | sed 's/^/    journal: /'
note "probe ready: ${reached} after ${START_SECONDS}s; restarts: $(restarts); state: $(systemctl is-active "$UNIT")"
if [ "$SYSTEMD_VERSION" -ge 258 ]; then
  # systemd 258+ resolves every sandbox path through automounts: the failed mount fails the helper.
  check "the helper never starts while the NAS is unreachable" [ "$reached" = no ]
  check "the sandbox fails with the reported error" contains "$journal" "Failed to set up mount namespacing: /mnt/boxpilot-backup: No such device"
  check "... at the first command, as on the server" contains "$journal" "Failed at step NAMESPACE spawning /usr/bin/install: No such device"
  check "and Restart= retries it again and again" [ "$(restarts)" -ge 3 ]
else
  # systemd 255 fires the automount from its nosuid pass (NoNewPrivileges=) and swallows the error,
  # so the helper starts, but only after waiting out a mount attempt for every command it runs.
  check "setting up the sandbox fires the automount and waits for it" contains "$journal" "mount_setattr() failed, falling back to classic remounting: No such device"
  check "so the helper starts only after the NAS attempts time out (${START_SECONDS}s)" [ "$START_SECONDS" -ge 8 ]
fi
stop_helper

section "2. The fix: the same unreachable NAS, the unit as shipped"
set_backup_share "$UNREACHABLE" "$NEW"
install_helper_unit shipped
start_helper 30 && reached=yes || reached=no
journal="$(helper_journal)"
note "probe ready: ${reached} after ${START_SECONDS}s; restarts: $(restarts); state: $(systemctl is-active "$UNIT")"
check "the helper starts with the NAS unreachable" [ "$reached" = yes ]
check "... straight away (${START_SECONDS}s) and on the first try" eval '[ "$START_SECONDS" -le 10 ] && [ "$(restarts)" -eq 0 ]'
check "... without touching the share" [ "$(fstype_at "$NEW")" = autofs ]
check "no namespace error" eval '! contains "$journal" "Failed to set up mount namespacing"'
probe inspect "" 90
check "the backup code reports the destination as unavailable" contains "$ANSWER" "ok: unavailable: Mount an independent filesystem at /mnt/boxpilot/backup"
check "... in bounded time (${ANSWER_SECONDS}s, the mount timeout is 30s)" within 45
probe sync "" 90
check "a mirror sync fails with the same reason instead of hanging" answered_failed
check "... in bounded time (${ANSWER_SECONDS}s)" within 45
probe write "${NEW}/while-unreachable" 90
check "a write to the share fails with No such device (${ANSWER_SECONDS}s)" eval 'contains "$ANSWER" "ENODEV" && within 45'
section "2b. The hardening that stays"
systemctl show "$UNIT" -p ReadWritePaths -p ProtectSystem -p NoNewPrivileges | sed 's/^/    /'
probe write /etc/boxpilot-probe 20
check "/etc is read-only to the helper" contains "$ANSWER" "read-only file system"
probe write /mnt/other-drive/probe 20
check "another drive under /mnt is read-only to the helper" contains "$ANSWER" "read-only file system"
probe write /mnt/probe 20
check "/mnt itself is read-only to the helper" contains "$ANSWER" "read-only file system"
probe write /mnt/boxpilot/probe 20
check "/mnt/boxpilot, the folder it is given, is writable" answered_ok
rm -f /mnt/boxpilot/probe

section "3. A local Samba NAS that is off when the helper starts and comes up later"
stop_helper
systemctl stop smbd
set_backup_share 127.0.0.1 "$NEW"
start_helper 30 && reached=yes || reached=no
check "the helper starts with the NAS down" [ "$reached" = yes ]
systemctl start smbd
probe inspect "" 90
check "once the NAS is up, the backup code finds the destination mounted" contains "$ANSWER" "ok: mounted at /mnt/boxpilot/backup"
probe sync "" 120
check "the helper's mirror sync writes to the share" contains "$ANSWER" "ok: synced 1 of 1 files"
source_sum="$(sha256sum < /var/lib/boxpilot-managed/backups/boxpilot-controller/probe-backup/boxpilot.sqlite3 | cut -d' ' -f1)"
nas_file="${NAS_ROOT}/boxpilot-local-mirror/controller-backups/probe-backup/boxpilot.sqlite3"
nas_sum="$(sha256sum < "$nas_file" 2>/dev/null | cut -d' ' -f1)"
note "on the NAS: $(ls -l "$nas_file" 2>&1)"
check "... and the copy on the NAS is byte for byte the local backup" eval '[ -n "$nas_sum" ] && [ "$source_sum" = "$nas_sum" ]'
probe write "${NEW}/after-the-nas-came-up" 60
check "a plain write lands on the NAS too" [ -f "${NAS_ROOT}/after-the-nas-came-up" ]

section "4. The share is already mounted when the helper starts"
ls "$NEW" >/dev/null
note "host: $(fstype_at "$NEW")"
start_helper 30 && reached=yes || reached=no
check "the helper starts with the share mounted" [ "$reached" = yes ]
probe write "${NEW}/mounted-at-start" 60
check "... and can still write to it (a mount there at start is not made read-only)" [ -f "${NAS_ROOT}/mounted-at-start" ]
section "4b. The NAS goes away while the helper runs, and comes back"
systemctl stop smbd
probe write "${NEW}/while-the-nas-is-gone" 120
check "a write fails instead of hanging (${ANSWER_SECONDS}s)" eval 'answered_failed && within 60'
systemctl start smbd
sleep 2
probe write "${NEW}/after-the-nas-came-back" 90
check "the next write after it comes back lands on the NAS" [ -f "${NAS_ROOT}/after-the-nas-came-back" ]
stop_helper

section "5. Upgrading an install whose backup share is at the old place"
systemctl start smbd
set_backup_share 127.0.0.1 "$OLD"
install_helper_unit before-fix
start_helper 60 && reached=yes || reached=no
check "the old install runs (its NAS is up)" [ "$reached" = yes ]
ls "$OLD" >/dev/null
before="$(mktemp)"; cp /etc/fstab "$before"
section "5a. The share is in use: nothing moves"
stop_helper
( cd "$OLD" && exec sleep 600 ) &
holder=$!
sleep 1
output="$("$NODE" "${ROOT}/scripts/boxpilot-backup-mount-move.mjs" 2>&1)"; status=$?
printf '%s\n' "$output" | sed 's/^/    move: /'
check "the move refuses while the share is in use" eval '[ "$status" -ne 0 ] && contains "$output" "in use, so it was left where it is"'
check "... and fstab is exactly as it was" cmp -s "$before" /etc/fstab
check "... and the share is still mounted where it was" contains "$(fstype_at "$OLD")" cifs
kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null
section "5b. The move, as the upgrade runs it"
output="$("$NODE" "${ROOT}/scripts/boxpilot-backup-mount-move.mjs" 2>&1)"; status=$?
printf '%s\n' "$output" | sed 's/^/    move: /'
copy="$(printf '%s\n' "$output" | sed -n 's/^fstab-copy=//p')"
check "the move succeeds and names the fstab copy it kept" eval '[ "$status" -eq 0 ] && [ -n "$copy" ]'
check "... which is the fstab from before the move" cmp -s "$before" "$copy"
check "only the mount point of that one entry changed, marker and credentials kept" diff <(sed "s| ${OLD} | ${NEW} |" "$before") /etc/fstab
note "fstab now: $(grep -F " ${NEW} " /etc/fstab)"
check "the automount is at the new place and nothing is left at the old one" eval '[ "$(fstype_at "$NEW")" = autofs ] && [ -z "$(fstype_at "$OLD")" ]'
install_helper_unit shipped
start_helper 30 && reached=yes || reached=no
check "the new helper starts" [ "$reached" = yes ]
rm -rf "${NAS_ROOT}/boxpilot-local-mirror"
probe sync "" 120
check "... and mirrors to the moved share" eval 'contains "$ANSWER" "ok: synced 1 of 1 files" && [ -f "$nas_file" ]'
section "5c. Rolling the upgrade back puts it back"
stop_helper
output="$("$NODE" "${ROOT}/scripts/boxpilot-backup-mount-move.mjs" undo "$copy" 2>&1)"; status=$?
printf '%s\n' "$output" | sed 's/^/    undo: /'
check "undo succeeds" [ "$status" -eq 0 ]
check "... fstab is byte for byte what it was" cmp -s "$before" /etc/fstab
check "... and the automount is back at the old place" eval '[ "$(fstype_at "$OLD")" = autofs ] && [ -z "$(fstype_at "$NEW")" ]'
section "5d. Moving a share whose NAS is off"
systemctl stop smbd
set_backup_share "$UNREACHABLE" "$OLD"
started=$SECONDS
output="$("$NODE" "${ROOT}/scripts/boxpilot-backup-mount-move.mjs" 2>&1)"; status=$?
printf '%s\n' "$output" | sed 's/^/    move: /'
took=$((SECONDS - started))
check "the move needs nothing from the NAS (${took}s)" eval '[ "$status" -eq 0 ] && [ "$took" -le 15 ] && [ "$(fstype_at "$NEW")" = autofs ]'
install_helper_unit shipped
start_helper 30 && reached=yes || reached=no
check "and the new helper starts with that NAS off" [ "$reached" = yes ]
stop_helper

section "Summary (systemd ${SYSTEMD_VERSION})"
printf '%s' "$RESULTS"
if [ "$FAILURES" -gt 0 ]; then
  echo "${FAILURES} check(s) failed" >&2
  journalctl -u "$UNIT" -n 60 --no-pager >&2 || true
  exit 1
fi
echo "all checks passed"
