#!/bin/bash
# Network shares mounted and unmounted by share.mount and share.unmount, run the way the helper runs
# them: in boxpilot-run@.service, whose PrivateTmp= gives each task a mount namespace of its own that
# does not propagate back to the host. Real systemd, a real Samba server and a real NFS server on the
# runner, the fstab lines BoxPilot writes, and PID 1's own mount table read before and after.
#
#   sudo bash tests/ubuntu/share-mount-host.sh /path/to/node-24
#
# DISPOSABLE MACHINES ONLY (CI runs it on GitHub's Ubuntu VMs): it installs Samba and an NFS server,
# rewrites /etc/fstab, runs a container and installs boxpilot-run@.service.
#
#   1. Before: what share.mount and share.unmount did from inside a PrivateTmp unit: the first
#      mount stayed in the task, and stopping the automount took the share off the host even while
#      it was in use. What mount -N does with a share's helper, and what stopping the mount unit
#      and starting the automount do.
#   2. share.mount through boxpilot-run@, the unit as shipped with its node path changed; then
#      share.reconnect, refused while a shell uses the share and done, app restarted, when an app does.
#   3. share.unmount: refused while a shell or an app uses the share, done when nothing does, and
#      done after getting Samba clients off it.
#   4. A first mount that fails: a wrong password, and a NAS that does not answer.
#   5. The same over NFS.
set -uo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run as root, on a disposable machine" >&2; exit 2; }
NODE="${1:-$(command -v node || true)}"
[ -x "$NODE" ] && [ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -ge 24 ] || { echo "pass a Node.js 24 binary as the first argument" >&2; exit 2; }
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NAME=nas-media
MNT="/mnt/${NAME}"
BASE="$(systemd-escape -p "$MNT")"
NAS_ROOT=/srv/boxpilot-nas
SMB_DIR="${NAS_ROOT}/media"
NFS_DIR="${NAS_ROOT}/exports"
CRED="/etc/boxpilot/secrets/share-${NAME}.cred"
PC=/media/bp-pc                # where a file-sharing client mounts the server's own Samba share
UNREACHABLE=192.0.2.1          # TEST-NET-1: nothing answers there
IMAGE=bp-busybox
WORK="$(mktemp -d /var/tmp/bp-share-test.XXXXXX)"
SYSTEMD_VERSION="$(systemctl --version | sed -n '1s/^systemd \([0-9]*\).*/\1/p')"
PASSWORD=""
FAILURES=0
RESULTS=""
HOLDERS=()

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

# What PID 1's namespace has mounted exactly at a path, bottom first: "autofs cifs", "autofs", "".
host_types() { findmnt --task 1 -rn -o TARGET,FSTYPE | awk -v target="$1" '$1 == target { print $2 }' | tr '\n' ' ' | sed 's/ $//'; }
host_has_share() { case " $(host_types "$1") " in *" cifs "* | *" nfs "* | *" nfs4 "*) return 0 ;; *) return 1 ;; esac; }
host_clear() { [ -z "$(host_types "$1")" ]; }
in_fstab() { grep -qx "# boxpilot:share-${NAME}" /etc/fstab; }
unit_failed() { systemctl is-failed --quiet "${BASE}.mount" || systemctl is-failed --quiet "${BASE}.automount"; }
# A transient unit with boxpilot-run@'s PrivateTmp=, for the commands the tasks used to run.
in_private() { systemd-run --quiet --wait --pipe --collect -p PrivateTmp=yes "$@"; }

# hold <dir>: a process sitting in a folder, as a shell left in it would.
hold() { ( cd "$1" && exec sleep 600 ) & HOLDER=$!; HOLDERS+=("$HOLDER"); sleep 1; }
let_go() { kill "$1" 2>/dev/null; wait "$1" 2>/dev/null; }

cleanup() {
  for pid in "${HOLDERS[@]}"; do kill "$pid" 2>/dev/null; done
  docker rm -f bp-share-app >/dev/null 2>&1
  umount -l "$PC" 2>/dev/null
  if [ "$FAILURES" -gt 0 ]; then
    section "Journal of the share's units"
    journalctl -u "${BASE}.mount" -u "${BASE}.automount" -n 60 --no-pager -o short-monotonic 2>/dev/null | sed 's/^/    /'
  fi
}
trap cleanup EXIT

# share_line smb|nfs: the fstab entry share.mount writes (buildShareEntry, the same function).
share_line() {
  "$NODE" --input-type=module -e "
    import { buildShareEntry } from '${ROOT}/server/tasks/shares.mjs';
    const kind = process.argv[1];
    const share = kind === 'smb' ? { kind, host: '127.0.0.1', share: 'media', name: '${NAME}', guest: false } : { kind, host: '127.0.0.1', share: '${NFS_DIR}', name: '${NAME}' };
    console.log(buildShareEntry(share).entry);" "$1"
}

# set_line smb|nfs: the share's entry in fstab, its credentials beside it, nothing started.
set_line() {
  forget_share
  mkdir -p "$MNT"
  printf '# boxpilot:share-%s\n%s\n' "$NAME" "$(share_line "$1")" >> /etc/fstab
  [ "$1" = smb ] && { printf 'username=nasuser\npassword=%s\n' "$PASSWORD" > "$CRED"; chmod 0600 "$CRED"; }
  systemctl daemon-reload
}

# Everything of the share gone from the host, whatever state a section left it in.
forget_share() {
  systemctl stop "${BASE}.mount" "${BASE}.automount" 2>/dev/null
  host_has_share "$MNT" && umount -l "$MNT" 2>/dev/null
  sed -i "/^# boxpilot:share-${NAME}\$/,+1d" /etc/fstab
  rm -f "$CRED"
  systemctl daemon-reload
  systemctl reset-failed "${BASE}.mount" "${BASE}.automount" 2>/dev/null
  true
}

# run_task <task> <parameters-json>: one task in boxpilot-run@<id>.service, as the helper starts it.
# Sets TASK_OK (true|false), TASK_RESULT (the runner's result) and TASK_LOG (the job log).
run_task() {
  local id; id="$(cat /proc/sys/kernel/random/uuid)"
  TASK_LOG="/run/boxpilot/logs/${id}.log"
  "$NODE" -e '
    const [task, parameters, file, logPath] = process.argv.slice(1);
    require("node:fs").writeFileSync(file, JSON.stringify({ task, parameters: JSON.parse(parameters), approvedAt: new Date().toISOString(), timeoutMs: 180000, logPath }), { mode: 0o600 });
  ' "$1" "$2" "/run/boxpilot/run/${id}.json" "$TASK_LOG"
  local started=$SECONDS
  timeout 240 systemctl start "boxpilot-run@${id}.service"   # Type=oneshot: returns when the task has finished
  TASK_SECONDS=$((SECONDS - started))
  TASK_RESULT="$(cat "/run/boxpilot/run/${id}.result.json" 2>/dev/null || echo '{"ok":false,"error":"the runner wrote no result"}')"
  TASK_OK="$("$NODE" -p 'JSON.parse(process.argv[1]).ok === true' "$TASK_RESULT")"
  [ -f "$TASK_LOG" ] && sed 's/^/      job log: /' "$TASK_LOG"
  note "$1 in boxpilot-run@ (${TASK_SECONDS}s): ${TASK_RESULT}"
}
result_field() { "$NODE" -p "const value = JSON.parse(process.argv[1]); String(${1})" "$TASK_RESULT"; }

prepare() {
  section "Prepare: systemd ${SYSTEMD_VERSION}, kernel $(uname -r), Samba and NFS on 127.0.0.1"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq >/dev/null
  apt-get install -y -qq --no-install-recommends cifs-utils samba nfs-common nfs-kernel-server >/dev/null
  note "$(mount --version | head -n 1); cifs-utils $(dpkg-query -W -f '${Version}' cifs-utils); nfs-common $(dpkg-query -W -f '${Version}' nfs-common)"
  note "helpers: $(ls /sbin/mount.cifs /sbin/mount.nfs /sbin/umount.nfs /sbin/umount.nfs4 /sbin/umount.cifs 2>/dev/null | tr '\n' ' ')"
  systemctl stop nmbd 2>/dev/null; systemctl disable nmbd 2>/dev/null
  # The runner's fstab mounts an Azure resource disk at /mnt that these VMs do not have, and every
  # mount under /mnt requires mnt.mount, which then waits 90 s for that device and fails. A real
  # server has no such line.
  if ! mountpoint -q /mnt && grep -qE '^[^#[:space:]]+[[:space:]]+/mnt[[:space:]]' /etc/fstab; then
    note "disabling the runner's own /mnt entry: $(grep -E '^[^#[:space:]]+[[:space:]]+/mnt[[:space:]]' /etc/fstab)"
    sed -i -E 's|^([^#[:space:]]+[[:space:]]+/mnt[[:space:]].*)$|# disabled for this test: \1|' /etc/fstab
    systemctl daemon-reload
    systemctl reset-failed mnt.mount 2>/dev/null
  fi
  install -d -m 0700 /etc/boxpilot/secrets

  # The NAS: one SMB share for one user, and one NFS export, on the loopback interface only.
  id nasuser >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin nasuser
  install -d -o nasuser -g nasuser -m 0755 "$SMB_DIR"
  echo "on the NAS from the start" > "${SMB_DIR}/from-before.txt"
  install -d -m 0777 "$NFS_DIR"
  write_smb_conf
  PASSWORD="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)"
  printf '%s\n%s\n' "$PASSWORD" "$PASSWORD" | smbpasswd -a -s nasuser >/dev/null
  systemctl restart smbd
  mkdir -p /etc/exports.d
  printf '%s 127.0.0.1(rw,sync,no_subtree_check,no_root_squash)\n' "$NFS_DIR" > /etc/exports.d/boxpilot-test.exports
  systemctl restart nfs-server && exportfs -ra
  note "NFS server: $(systemctl is-active nfs-server); exports: $(exportfs -s | tr '\n' ' ')"

  # boxpilot-run@.service as shipped, but for where node is: the runner's is under the tool cache.
  install -d -m 0755 /opt/boxpilot
  cp -r "${ROOT}/server" "${ROOT}/scripts" "${ROOT}/package.json" /opt/boxpilot/
  sed -e "s|/usr/local/bin/node|${NODE}|g" "${ROOT}/deploy/boxpilot-run@.service" > /etc/systemd/system/boxpilot-run@.service
  install -d -m 0700 /run/boxpilot /run/boxpilot/run
  systemctl daemon-reload
  note "runner unit: $(systemctl show 'boxpilot-run@x.service' -p PrivateTmp -p ExecStart --value | tr '\n' ' ' | cut -c1-160)"

  if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
    docker pull -q mirror.gcr.io/library/busybox:1.36 >/dev/null && docker tag mirror.gcr.io/library/busybox:1.36 "$IMAGE"
  fi
}

# write_smb_conf [everything]: the NAS's share, and with "everything" a share of this server's /mnt,
# which reaches into every mount under it: BoxPilot's file sharing offers exactly that.
write_smb_conf() {
  cat > /etc/samba/smb.conf <<CONF
[global]
   server role = standalone server
   interfaces = lo
   bind interfaces only = yes
   disable netbios = yes
   smb ports = 445
   map to guest = bad user
   log file = /var/log/samba/log.%m
[media]
   path = ${SMB_DIR}
   read only = no
   valid users = nasuser
CONF
  [ "${1:-}" = everything ] && cat >> /etc/samba/smb.conf <<CONF
[everything]
   path = /mnt
   guest ok = yes
   read only = no
   force user = root
CONF
  true
}

prepare
SMB_PARAMETERS="{\"kind\":\"smb\",\"host\":\"127.0.0.1\",\"share\":\"media\",\"name\":\"${NAME}\",\"username\":\"nasuser\",\"password\":\"${PASSWORD}\"}"
NFS_PARAMETERS="{\"kind\":\"nfs\",\"host\":\"127.0.0.1\",\"share\":\"${NFS_DIR}\",\"name\":\"${NAME}\"}"

# ---- 1. before ----------------------------------------------------------------------------------

section "1a. Before: share.mount ran mount in its own namespace, then started the automount"
set_line smb
note "fstab: $(grep -A1 -x "# boxpilot:share-${NAME}" /etc/fstab | tail -n 1)"
in_private /usr/bin/mount "$MNT"; rc=$?
note "mount ${MNT} inside a PrivateTmp unit: exit ${rc}; the host has: '$(host_types "$MNT")'"
check "mount inside a PrivateTmp unit mounts the share (exit ${rc})" [ "$rc" -eq 0 ]
check "... where the host never sees it" host_clear "$MNT"
systemctl start "${BASE}.automount"
note "after starting the automount, as share.mount then did: '$(host_types "$MNT")'"

section "1b. What mount -N /proc/1/ns/mnt does with the cifs helper"
systemctl stop "${BASE}.automount"
out="$(in_private /usr/bin/mount -N /proc/1/ns/mnt "$MNT" 2>&1)"; rc=$?
note "mount -N /proc/1/ns/mnt ${MNT} inside a PrivateTmp unit: exit ${rc}: $(printf '%s' "$out" | head -n 1)"
check "mount passes -N on to mount.cifs, which rejects it" contains "$out" "mount.cifs: invalid option -- 'N'"
check "... and nothing is mounted on the host (though mount exited ${rc})" host_clear "$MNT"
forget_share

section "1c. Before: share.unmount stopped the automount, then ran umount in its own namespace"
set_line smb
systemctl start "${BASE}.automount"; ls "$MNT" >/dev/null
note "the host has: '$(host_types "$MNT")'"
in_private /bin/bash -c '
  systemctl stop "$1.automount"
  echo "    the task sees at $2: $(findmnt -rn -o FSTYPE --mountpoint "$2" | tr "\n" " ")"
  if findmnt -n "$2" >/dev/null; then umount "$2"; echo "    umount in the task: exit $?"; else echo "    nothing there as the task sees it, so no umount"; fi
' _ "$BASE" "$MNT" | tee "${WORK}/old-unmount.out"
check "stopping the automount took the share off the host as well ('$(host_types "$MNT")')" host_clear "$MNT"
check "... so the task's own umount never ran" grep -q "so no umount" "${WORK}/old-unmount.out"
forget_share

section "1d. Stopping the units of a share that is in use"
set_line smb
systemctl start "${BASE}.automount"; ls "$MNT" >/dev/null
hold "$MNT"; shell=$HOLDER
note "a shell sits in ${MNT}; the host has: '$(host_types "$MNT")'"
out="$(systemctl stop "${BASE}.mount" 2>&1)"; rc=$?
note "systemctl stop ${BASE}.mount: exit ${rc}${out:+: ${out}}; the host has: '$(host_types "$MNT")'"
check "stopping the mount unit is refused while the share is in use" host_has_share "$MNT"
out="$(systemctl stop "${BASE}.automount" 2>&1)"; rc=$?
note "systemctl stop ${BASE}.automount: exit ${rc}${out:+: ${out}}; the host has: '$(host_types "$MNT")'"
check "stopping the automount is not refused: the share is gone from the host, in use or not" host_clear "$MNT"
check "... while the shell still reads the NAS through a mount nobody can see" ls "/proc/${shell}/cwd/from-before.txt"
let_go "$shell"
forget_share

section "1e. Starting the automount where the share is already mounted"
set_line smb
systemctl start "${BASE}.mount"
out="$(systemctl start "${BASE}.automount" 2>&1)"; rc=$?
note "the share mounted without its automount, then systemctl start ${BASE}.automount: exit ${rc}; the host has: '$(host_types "$MNT")'"
journalctl -u "${BASE}.automount" -n 3 --no-pager -o cat 2>/dev/null | sed 's/^/    journal: /'
check "systemd will not start an automount on a path that is already mounted, hence share.mount's order" [ "$rc" -ne 0 ]
forget_share

# ---- 2. share.mount -----------------------------------------------------------------------------

section "2. share.mount from boxpilot-run@ (PrivateTmp=true)"
run_task share.mount "$SMB_PARAMETERS"
check "share.mount succeeds" [ "$TASK_OK" = true ]
check "the host has the share mounted over its automount ('$(host_types "$MNT")')" [ "$(host_types "$MNT")" = "autofs cifs" ]
check "... and both units are active" eval 'systemctl is-active --quiet "${BASE}.automount" && systemctl is-active --quiet "${BASE}.mount"'
check "fstab has its entry" in_fstab
check "its credentials are root-only ($(stat -c '%a %U' "$CRED" 2>&1))" [ "$(stat -c '%a %U' "$CRED" 2>/dev/null)" = "600 root" ]
check "it reports the share's size, read from the host ($(result_field 'value.result?.sizeBytes'))" [ "$(result_field 'value.result?.sizeBytes > 0')" = true ]
echo "written on the host" > "${MNT}/from-the-host.txt"
check "a file written at ${MNT} on the host lands on the NAS" [ -f "${SMB_DIR}/from-the-host.txt" ]

# ---- 2b. share.reconnect --------------------------------------------------------------------------

section "2b. share.reconnect while a shell sits in the share"
hold "$MNT"; shell=$HOLDER
run_task share.reconnect "{\"name\":\"${NAME}\"}"
check "share.reconnect refuses" [ "$TASK_OK" = false ]
check "... naming what holds it: sleep (${shell})" contains "$(result_field 'value.error')" "in use by sleep (${shell})"
check "the share is untouched on the host ('$(host_types "$MNT")')" [ "$(host_types "$MNT")" = "autofs cifs" ]
let_go "$shell"

section "2c. share.reconnect while an app has the share"
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker run -d --name bp-share-app -v "${MNT}:/data" "$IMAGE" sleep 600 >/dev/null
  started_before="$(docker inspect -f '{{.State.StartedAt}}' bp-share-app)"
  sleep 1
  run_task share.reconnect "{\"name\":\"${NAME}\"}"
  check "share.reconnect succeeds" [ "$TASK_OK" = true ]
  check "the host has the share mounted again over its automount ('$(host_types "$MNT")')" [ "$(host_types "$MNT")" = "autofs cifs" ]
  check "... its entry and credentials kept" eval 'in_fstab && [ -f "$CRED" ]'
  check "the app was restarted, so it sees the new mount ($(result_field 'JSON.stringify(value.result?.restarted)'))" eval '[ "$(docker inspect -f "{{.State.StartedAt}}" bp-share-app)" != "$started_before" ]'
  echo "after the reconnect" > "${MNT}/after-reconnect.txt"
  check "a write on the host lands on the NAS" [ -f "${SMB_DIR}/after-reconnect.txt" ]
  docker exec bp-share-app sh -c 'echo "from the app" > /data/from-the-app.txt'
  check "... and so does one from the restarted app" [ -f "${SMB_DIR}/from-the-app.txt" ]
  docker rm -f bp-share-app >/dev/null
else
  record FAIL "no Docker on this runner, so a reconnect with an app on the share was not tried"
fi

# ---- 3. share.unmount ---------------------------------------------------------------------------

section "3a. share.unmount while a shell sits in the share"
hold "$MNT"; shell=$HOLDER
run_task share.unmount "{\"name\":\"${NAME}\"}"
error="$(result_field 'value.error')"
check "share.unmount refuses" [ "$TASK_OK" = false ]
check "... naming what holds it: sleep (${shell})" contains "$error" "still in use by sleep (${shell})"
check "... and why" contains "$error" "target is busy"
check "the share is still mounted on the host, automount and all ('$(host_types "$MNT")')" [ "$(host_types "$MNT")" = "autofs cifs" ]
check "... still in fstab, with its credentials" eval 'in_fstab && [ -f "$CRED" ]'
let_go "$shell"

section "3b. share.unmount while an app has the share"
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker run -d --name bp-share-app -v "${MNT}:/data" "$IMAGE" sleep 600 >/dev/null
  run_task share.unmount "{\"name\":\"${NAME}\"}"
  check "share.unmount refuses, naming the app" eval '[ "$TASK_OK" = false ] && contains "$(result_field "value.error")" "in use by bp-share-app"'
  check "the share is untouched ('$(host_types "$MNT")')" eval '[ "$(host_types "$MNT")" = "autofs cifs" ] && in_fstab'
  docker rm -f bp-share-app >/dev/null
else
  record FAIL "no Docker on this runner, so an app holding the share was not tried"
fi

section "3c. share.unmount with nothing using the share"
run_task share.unmount "{\"name\":\"${NAME}\"}"
check "share.unmount succeeds" [ "$TASK_OK" = true ]
check "the host has nothing at ${MNT}, neither the share nor its automount ('$(host_types "$MNT")')" host_clear "$MNT"
check "fstab no longer has the entry, and the credentials are gone" eval '! in_fstab && [ ! -e "$CRED" ]'
check "no unit of the share is left active or failed" eval '! systemctl is-active --quiet "${BASE}.mount" "${BASE}.automount" && ! unit_failed'
check "the NAS still has its files" [ -f "${SMB_DIR}/from-the-host.txt" ]
check "the folder is kept" [ -d "$MNT" ]

section "3d. share.unmount while this server's own Samba share of /mnt has a client reaching into it"
run_task share.mount "$SMB_PARAMETERS"
check "mounted again" eval '[ "$TASK_OK" = true ] && host_has_share "$MNT"'
echo hold > "${SMB_DIR}/held.txt"
write_smb_conf everything
systemctl restart smbd
mkdir -p "$PC"
if mount -t cifs //127.0.0.1/everything "$PC" -o guest,vers=3.0; then
  ( exec 3< "${PC}/${NAME}/held.txt" && exec sleep 600 ) 2>"${WORK}/client.err" & client=$!; HOLDERS+=("$client")
  sleep 2
  if [ -e "/proc/${client}/fd/3" ]; then note "the client has ${PC}/${NAME}/held.txt open"
  else note "the client could not open ${PC}/${NAME}/held.txt: $(tr '\n' ' ' < "${WORK}/client.err")"; fi
  note "Samba says: $(smbstatus -S 2>/dev/null | grep -E '^everything' | head -n 3 | tr -s ' ' | tr '\n' ';')"
  out="$(systemctl stop "${BASE}.mount" 2>&1)"; rc=$?
  check "Samba holds the share for its client (stop: exit ${rc}, '$(host_types "$MNT")')" host_has_share "$MNT"
  run_task share.unmount "{\"name\":\"${NAME}\"}"
  check "share.unmount gets the client off and succeeds" [ "$TASK_OK" = true ]
  check "... and says whom it disconnected" grep -qE 'Closed file-sharing connections from [^ ]*127\.0\.0\.1[^ ]* to everything so /mnt/nas-media could be unmounted' "$TASK_LOG"
  check "the host has nothing at ${MNT} ('$(host_types "$MNT")')" host_clear "$MNT"
  sleep 5
  check "... and still nothing after the client has had time to reconnect ('$(host_types "$MNT")')" host_clear "$MNT"
  let_go "$client"
else
  record FAIL "could not mount this server's own Samba share as a client"
fi
umount -l "$PC" 2>/dev/null
write_smb_conf
systemctl restart smbd
forget_share

# ---- 4. a first mount that fails ------------------------------------------------------------------

section "4a. share.mount with a wrong password"
rmdir "$MNT"   # kept by share.unmount; a folder share.mount did not make is not its to remove
run_task share.mount "{\"kind\":\"smb\",\"host\":\"127.0.0.1\",\"share\":\"media\",\"name\":\"${NAME}\",\"username\":\"nasuser\",\"password\":\"not-the-password\"}"
error="$(result_field 'value.error')"
check "share.mount fails" [ "$TASK_OK" = false ]
check "... saying the NAS refused the credentials, from the helper's words in the journal" contains "$error" "The NAS refused the credentials"
check "... and that it put everything back" contains "$error" "were removed again"
check "nothing is left on the host, in fstab or in the secrets folder" eval 'host_clear "$MNT" && ! in_fstab && [ ! -e "$CRED" ]'
check "no failed unit is left behind" eval '! unit_failed'
check "the empty folder it made is gone" [ ! -e "$MNT" ]

section "4b. share.mount of a NAS that does not answer"
run_task share.mount "{\"kind\":\"smb\",\"host\":\"${UNREACHABLE}\",\"share\":\"media\",\"name\":\"${NAME}\",\"username\":\"nasuser\",\"password\":\"${PASSWORD}\"}"
error="$(result_field 'value.error')"
check "share.mount fails in bounded time (${TASK_SECONDS}s; the mount timeout is 30s)" eval '[ "$TASK_OK" = false ] && [ "$TASK_SECONDS" -le 90 ]'
check "... saying the host did not answer" contains "$error" "The host did not answer"
check "nothing is left on the host, in fstab or failed" eval 'host_clear "$MNT" && ! in_fstab && ! unit_failed'

# ---- 5. NFS -------------------------------------------------------------------------------------

section "5a. What mount -N /proc/1/ns/mnt does with the nfs helper"
set_line nfs
note "fstab: $(grep -A1 -x "# boxpilot:share-${NAME}" /etc/fstab | tail -n 1)"
out="$(in_private /usr/bin/mount -N /proc/1/ns/mnt "$MNT" 2>&1)"; rc=$?
note "mount -N /proc/1/ns/mnt ${MNT} inside a PrivateTmp unit: exit ${rc}: $(printf '%s' "$out" | head -n 1)"
check "mount passes -N on to mount.nfs, which rejects it" contains "$out" "mount.nfs: invalid option -- 'N'"
check "... and nothing is mounted on the host (exit ${rc})" host_clear "$MNT"
forget_share

section "5b. share.mount and share.unmount of an NFS export from boxpilot-run@"
run_task share.mount "$NFS_PARAMETERS"
check "share.mount succeeds" [ "$TASK_OK" = true ]
check "the host has the export mounted over its automount ('$(host_types "$MNT")')" eval 'host_has_share "$MNT" && contains "$(host_types "$MNT")" autofs'
echo "written on the host" > "${MNT}/over-nfs.txt"
check "a file written at ${MNT} on the host lands in the export" [ -f "${NFS_DIR}/over-nfs.txt" ]
hold "$MNT"; shell=$HOLDER
run_task share.unmount "{\"name\":\"${NAME}\"}"
check "share.unmount refuses while a shell sits in it, naming it" eval '[ "$TASK_OK" = false ] && contains "$(result_field "value.error")" "still in use by sleep (${shell})"'
check "... and the export stays mounted ('$(host_types "$MNT")')" host_has_share "$MNT"
let_go "$shell"
run_task share.unmount "{\"name\":\"${NAME}\"}"
check "share.unmount succeeds once nothing uses it" [ "$TASK_OK" = true ]
check "the host has nothing at ${MNT} ('$(host_types "$MNT")')" host_clear "$MNT"
check "fstab no longer has the entry, and no unit is failed" eval '! in_fstab && ! unit_failed'

section "Summary (systemd ${SYSTEMD_VERSION})"
printf '%s' "$RESULTS"
if [ "$FAILURES" -gt 0 ]; then
  echo "${FAILURES} check(s) failed" >&2
  exit 1
fi
echo "all checks passed"
