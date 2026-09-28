#!/usr/bin/env bash
# Real reboots of a real Ubuntu, with an exFAT drive an app is writing to (M26).
#
# tests/ubuntu/drive-shutdown-order.sh shows what systemd orders and what the unit-stop half of a
# shutdown leaves behind. This one reboots: an Ubuntu 24.04 cloud image under KVM, a second disk
# holding one exFAT partition mounted by BoxPilot's fstab line, Docker with a container appending
# to a file on it, and then `systemctl reboot` - or BoxPilot's own reboot task. Whether the drive
# was unmounted cleanly is read the way the owner read it: from the kernel, as it mounts the drive
# at the next boot. The dirty mark is cleared before each round, since Linux would otherwise keep
# it (drive-shutdown-order.sh, part 3) and every round would look unclean.
#
# Runs as root on a disposable machine (the GitHub runner) with BOXPILOT_DISPOSABLE_TEST=1.
set -uo pipefail

if [ "$(id -u)" -ne 0 ] || [ "${BOXPILOT_DISPOSABLE_TEST:-}" != 1 ]; then
  echo "Run as root with BOXPILOT_DISPOSABLE_TEST=1 on a disposable machine." >&2
  exit 2
fi

REPO="$(pwd)"
WORK="$(mktemp -d /var/tmp/bp-reboot-vm.XXXXXX)"
IMAGE_URL="${BOXPILOT_TEST_IMAGE:-https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img}"
PORT=2222
TODAY="defaults,nofail,uid=1000,gid=1000"
NEW="${TODAY},x-systemd.before=docker.service,x-systemd.device-timeout=30s"
FAILURES=0
section() { printf '\n==================== %s ====================\n' "$*"; }
note() { printf '>> %s\n' "$*"; }
pass() { printf 'PASS: %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*"; FAILURES=$((FAILURES + 1)); }

cleanup() {
  [ -f "${WORK}/qemu.pid" ] && kill "$(cat "${WORK}/qemu.pid")" 2>/dev/null
  cp "${WORK}/console.log" "${BOXPILOT_TEST_ARTIFACTS:-/tmp}/drive-reboot-vm-console.log" 2>/dev/null && chmod 644 "${BOXPILOT_TEST_ARTIFACTS:-/tmp}/drive-reboot-vm-console.log"
}
trap cleanup EXIT

section "host"
export DEBIAN_FRONTEND=noninteractive
apt-get update >/dev/null
apt-get install -y --no-install-recommends qemu-system-x86 qemu-utils cloud-image-utils exfatprogs openssh-client >/dev/null || { echo "could not install qemu"; exit 1; }
[ -e /dev/kvm ] || { echo "no /dev/kvm on this runner"; exit 1; }
qemu-system-x86_64 --version | head -1

curl -fsSL --retry 3 -o "${WORK}/base.img" "$IMAGE_URL" || { echo "could not download $IMAGE_URL"; exit 1; }
qemu-img create -q -f qcow2 -F qcow2 -b "${WORK}/base.img" "${WORK}/root.qcow2" 12G

# The drive: GPT, one exFAT partition, as a USB disk comes.
truncate -s 1G "${WORK}/drive.raw"
echo 'type=EBD0A0A2-B9E5-4433-87C0-68B6B72699C7' | sfdisk --quiet --label gpt "${WORK}/drive.raw" >/dev/null
loop="$(losetup --find --show --partscan "${WORK}/drive.raw")"; udevadm settle
mkfs.exfat -L thedump "${loop}p1" >/dev/null
UUID="$(blkid -o value -s UUID "${loop}p1")"
losetup -d "$loop"
note "drive UUID=${UUID}"

ssh-keygen -q -t ed25519 -N '' -f "${WORK}/id"
cat > "${WORK}/user-data" <<EOF
#cloud-config
users:
  - name: tester
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys: [ "$(cat "${WORK}/id.pub")" ]
package_update: true
packages: [docker.io, exfatprogs, psmisc]
runcmd:
  - [ sh, -c, "modprobe exfat || apt-get install -y linux-modules-extra-\$(uname -r)" ]
  - [ systemctl, enable, --now, docker.socket, docker.service ]
  - [ sh, -c, "docker pull -q mirror.gcr.io/library/busybox:1.36 && docker tag mirror.gcr.io/library/busybox:1.36 busybox" ]
  - [ mkdir, -p, /mnt/the-dump ]
  - [ touch, /var/lib/cloud/bp-ready ]
EOF
printf 'instance-id: bp-reboot\nlocal-hostname: server\n' > "${WORK}/meta-data"
cloud-localds "${WORK}/seed.img" "${WORK}/user-data" "${WORK}/meta-data"

qemu-system-x86_64 -machine accel=kvm -cpu host -m 3072 -smp 2 \
  -drive file="${WORK}/root.qcow2",if=virtio \
  -drive file="${WORK}/drive.raw",if=virtio,format=raw \
  -drive file="${WORK}/seed.img",if=virtio,format=raw \
  -netdev user,id=net0,hostfwd=tcp:127.0.0.1:${PORT}-:22 -device virtio-net-pci,netdev=net0 \
  -display none -serial file:"${WORK}/console.log" -daemonize -pidfile "${WORK}/qemu.pid" || { echo "qemu did not start"; exit 1; }

vm() { ssh -q -i "${WORK}/id" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 -o BatchMode=yes -p "$PORT" tester@127.0.0.1 "$@"; }
wait_up() { for _ in $(seq 1 120); do vm true 2>/dev/null && return 0; sleep 3; done; return 1; }
wait_down() { for _ in $(seq 1 60); do vm true 2>/dev/null || return 0; sleep 1; done; return 1; }
boot_id() { vm cat /proc/sys/kernel/random/boot_id 2>/dev/null; }

section "guest"
wait_up || { echo "the VM never answered"; tail -50 "${WORK}/console.log"; exit 1; }
for _ in $(seq 1 120); do vm test -f /var/lib/cloud/bp-ready && break; sleep 5; done
vm test -f /var/lib/cloud/bp-ready || { echo "cloud-init did not finish"; vm sudo cloud-init status --long; exit 1; }
vm 'uname -r; systemctl --version | head -1; docker version --format "docker {{.Server.Version}}"; grep -w exfat /proc/filesystems'
vm sudo mkdir -p /opt/bp
# BoxPilot's own reboot task needs Node and the server's task modules, nothing else.
tar -C "$REPO" -cz server | vm sudo tar -C /opt/bp -xz
cat "$(command -v node)" | vm sudo tee /usr/local/bin/node >/dev/null; vm sudo chmod 755 /usr/local/bin/node

# One round: a clean, unmarked drive, the given fstab line and Docker setting, an app writing to
# the drive, and a reboot. Prints what the next boot's kernel said about the drive.
round() {  # $1 = label, $2 = fstab options, $3 = live-restore, $4 = how to reboot: systemctl|boxpilot
  section "round: $1 (live-restore $3, reboot by $4)"
  vm sudo bash -s <<EOF
set -u
docker rm -f holder >/dev/null 2>&1
systemctl stop 'mnt-the\x2ddump.mount' 2>/dev/null; umount /mnt/the-dump 2>/dev/null
fsck.exfat -p /dev/vdb1 >/dev/null
grep -v 'boxpilot:the-dump\|/mnt/the-dump' /etc/fstab > /etc/fstab.new
printf '# boxpilot:the-dump\nUUID=${UUID} /mnt/the-dump exfat $2 0 0\n' >> /etc/fstab.new
mv /etc/fstab.new /etc/fstab
printf '{ "live-restore": $3 }\n' > /etc/docker/daemon.json
systemctl daemon-reload
systemctl restart docker.service
systemctl start 'mnt-the\x2ddump.mount'
docker run -d --name holder --restart unless-stopped -v /mnt/the-dump:/data busybox sh -c '
  trap "echo stopping >&3; sleep 2; echo stopped >&3; exit 0" TERM
  exec 3>>/data/held.log
  while :; do echo "tick \$(date +%s)" >&3; head -c 65536 /dev/urandom >> /data/blob; sleep 0.5 & wait \$!; done' >/dev/null
sleep 3
echo "   drive: \$(findmnt -n -o SOURCE,FSTYPE /mnt/the-dump), holder: \$(docker inspect -f '{{.State.Status}}' holder)"
EOF
  local before offset; before="$(boot_id)"
  # QEMU writes the console at its own offset, so the round's part is found by where it began.
  offset="$(stat -c %s "${WORK}/console.log")"
  if [ "$4" = boxpilot ]; then
    vm "sudo /usr/local/bin/node --input-type=module -e \"import { systemReboot } from '/opt/bp/server/tasks/system.mjs'; console.log(JSON.stringify(await systemReboot({ delaySeconds: 3 }, { log: (line, stream) => console.log('   [' + stream + '] ' + line) })));\"" 2>&1 | tee "${WORK}/boxpilot-reboot.out"
  else
    vm sudo systemctl reboot 2>/dev/null
  fi
  wait_down; sleep 5; wait_up || { fail "$1: the VM did not come back"; return; }
  [ "$(boot_id)" != "$before" ] || { fail "$1: the VM did not reboot"; return; }
  sleep 5
  ROUND_WARNING="$(vm sudo journalctl -k -b 0 --no-pager | grep 'exFAT-fs (vdb1)' || true)"
  note "next boot's kernel about the drive: ${ROUND_WARNING:-nothing}"
  note "previous boot's shutdown, as the journal kept it:"
  vm sudo journalctl -b -1 -o short-precise --no-pager -u 'mnt-the\x2ddump.mount' -u docker.service -u 'docker-*.scope' | grep -E 'Stopping|Stopped|Unmount|Failed|busy|shutdown complete|Deactivated' | tail -12 | sed 's/^/   /'
  note "the last phase, from the serial console:"
  tail -c "+$((offset + 1))" "${WORK}/console.log" | tr -d '\r' | grep -aE 'the-dump|Unmount|unmount|remaining processes|ilesystems|Rebooting|reboot: |Stopped Docker|Stopping Docker' | head -24 | sed 's/^/   /'
  vm "sudo grep -E 'stopping|stopped' /mnt/the-dump/held.log | tail -2" 2>/dev/null | sed 's/^/   held.log: /'
}

round "today's line" "$TODAY" false systemctl; today_off="$ROUND_WARNING"
round "today's line" "$TODAY" true systemctl; today_on="$ROUND_WARNING"
round "new line" "$NEW" false systemctl; new_off="$ROUND_WARNING"
round "new line" "$NEW" true systemctl; new_on="$ROUND_WARNING"
round "BoxPilot's reboot, today's line" "$TODAY" true boxpilot; boxpilot_on="$ROUND_WARNING"
grep -q '"state":"unmounted"' "${WORK}/boxpilot-reboot.out" && pass "BoxPilot's reboot reported the drive unmounted cleanly before rebooting" || fail "BoxPilot's reboot did not report the drive unmounted"

section "summary: did the next boot find the drive not properly unmounted?"
for pair in "today's line, live-restore off|$today_off" "today's line, live-restore on|$today_on" "new line, live-restore off|$new_off" "new line, live-restore on|$new_on" "BoxPilot's reboot, live-restore on|$boxpilot_on"; do
  printf '   %-40s %s\n' "${pair%%|*}" "$([ -n "${pair#*|}" ] && echo 'NOT properly unmounted' || echo 'clean')"
done
[ -z "$new_off" ] && pass "new line, live-restore off: clean after a real reboot" || fail "new line, live-restore off: clean after a real reboot"
[ -z "$boxpilot_on" ] && pass "BoxPilot's reboot, live-restore on: clean after a real reboot" || fail "BoxPilot's reboot, live-restore on: clean after a real reboot"

section "result"
if [ "$FAILURES" -eq 0 ]; then echo "all checks passed"; else echo "${FAILURES} check(s) failed"; fi
exit "$FAILURES"
