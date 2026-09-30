#!/usr/bin/env bash
# Real reboots and a real power cut of a real Ubuntu (2026-09-29).
#
# The owner's server lost power at 18:41 and stayed off until 22:18; its journal simply stops. This
# boots an Ubuntu cloud image under KVM and asks, after each start, how the boot before it ended -
# with the reading the helper's system.boots.inspect makes, run inside a sandbox like the helper's
# (no network, no kernel log device, a read-only system):
#
#   1. after `systemctl reboot`: clean. A healthy server must never be told it lost power.
#   2. after the VM is killed outright (qemu gets SIGKILL: the power cord) and started a minute
#      later: unclean, stopped near the moment of the cut, back after the gap, with the next boot's
#      own words for it (journald's file left open, ext4 replaying its journal).
#   3. after another `systemctl reboot`: clean again - the boot after the cut ended properly.
#
# Runs as root on a disposable machine (the GitHub runner) with BOXPILOT_DISPOSABLE_TEST=1.
set -uo pipefail

if [ "$(id -u)" -ne 0 ] || [ "${BOXPILOT_DISPOSABLE_TEST:-}" != 1 ]; then
  echo "Run as root with BOXPILOT_DISPOSABLE_TEST=1 on a disposable machine." >&2
  exit 2
fi

REPO="$(pwd)"
WORK="$(mktemp -d /var/tmp/bp-power-vm.XXXXXX)"
IMAGE_URL="${BOXPILOT_TEST_IMAGE:-https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img}"
PORT=2223
FAILURES=0
section() { printf '\n==================== %s ====================\n' "$*"; }
note() { printf '>> %s\n' "$*"; }
pass() { printf 'PASS: %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
expect() { # expect <what> <command...>
  local what="$1"; shift
  if "$@"; then pass "$what"; else fail "$what"; fi
}
field() { node -p "const value = JSON.parse(process.argv[1]); String(value.${1})" "$2"; }

cleanup() {
  [ -f "${WORK}/qemu.pid" ] && kill -9 "$(cat "${WORK}/qemu.pid")" 2>/dev/null
  cp "${WORK}/console.log" "${BOXPILOT_TEST_ARTIFACTS:-/tmp}/power-loss-vm-console.log" 2>/dev/null && chmod 644 "${BOXPILOT_TEST_ARTIFACTS:-/tmp}/power-loss-vm-console.log"
}
trap cleanup EXIT

section "host"
export DEBIAN_FRONTEND=noninteractive
apt-get update >/dev/null
apt-get install -y --no-install-recommends qemu-system-x86 qemu-utils cloud-image-utils openssh-client >/dev/null || { echo "could not install qemu"; exit 1; }
[ -e /dev/kvm ] || { echo "no /dev/kvm on this runner"; exit 1; }
qemu-system-x86_64 --version | head -1
curl -fsSL --retry 3 -o "${WORK}/base.img" "$IMAGE_URL" || { echo "could not download $IMAGE_URL"; exit 1; }
qemu-img create -q -f qcow2 -F qcow2 -b "${WORK}/base.img" "${WORK}/root.qcow2" 12G

ssh-keygen -q -t ed25519 -N '' -f "${WORK}/id"
cat > "${WORK}/user-data" <<EOF
#cloud-config
users:
  - name: tester
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys: [ "$(cat "${WORK}/id.pub")" ]
runcmd:
  - [ touch, /var/lib/cloud/bp-ready ]
EOF
printf 'instance-id: bp-power\nlocal-hostname: homebox\n' > "${WORK}/meta-data"
cloud-localds "${WORK}/seed.img" "${WORK}/user-data" "${WORK}/meta-data"

# The machine. cache=none: what the guest wrote has reached the disk image when qemu dies, and
# nothing the guest had not written yet survives it - a power cut, not a paused VM.
launch() {
  qemu-system-x86_64 -machine accel=kvm -cpu host -m 2048 -smp 2 \
    -drive file="${WORK}/root.qcow2",if=virtio,cache=none \
    -drive file="${WORK}/seed.img",if=virtio,format=raw \
    -netdev user,id=net0,hostfwd=tcp:127.0.0.1:${PORT}-:22 -device virtio-net-pci,netdev=net0 \
    -display none -serial file:"${WORK}/console.log" -daemonize -pidfile "${WORK}/qemu.pid"
}
vm() { ssh -q -i "${WORK}/id" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 -o BatchMode=yes -p "$PORT" tester@127.0.0.1 "$@"; }
wait_up() { for _ in $(seq 1 120); do vm true 2>/dev/null && return 0; sleep 3; done; return 1; }
wait_down() { for _ in $(seq 1 60); do vm true 2>/dev/null || return 0; sleep 1; done; return 1; }
boot_id() { vm cat /proc/sys/kernel/random/boot_id 2>/dev/null | tr -d '-'; }
# The helper's read, in a sandbox like the helper's own: no network, no /dev/kmsg, a read-only /.
judge() {
  sleep 10   # let the boot finish writing what it says about the one before
  READ="$(vm "sudo systemd-run --quiet --wait --pipe --collect -p PrivateNetwork=yes -p ProtectKernelLogs=yes -p ProtectSystem=strict -p PrivateDevices=yes -p NoNewPrivileges=yes -p RestrictAddressFamilies=AF_UNIX /usr/local/bin/node /opt/bp/power-loss.mjs /opt/bp/server" 2>&1 | tail -n 1)"
  note "reading: ${READ}"
}

launch || { echo "qemu did not start"; exit 1; }
section "guest"
wait_up || { echo "the VM never answered"; tail -50 "${WORK}/console.log"; exit 1; }
for _ in $(seq 1 120); do vm test -f /var/lib/cloud/bp-ready && break; sleep 5; done
vm test -f /var/lib/cloud/bp-ready || { echo "cloud-init did not finish"; vm sudo cloud-init status --long; exit 1; }
vm 'uname -r; systemctl --version | head -1; findmnt -n -o SOURCE,FSTYPE / ; findmnt -n -o SOURCE,FSTYPE /boot/efi || true'
# A persistent journal, as Ubuntu keeps one.
vm 'sudo mkdir -p /var/log/journal && sudo systemd-tmpfiles --create --prefix /var/log/journal && sudo journalctl --flush'
vm sudo mkdir -p /opt/bp
tar -C "$REPO" -cz server | vm sudo tar -C /opt/bp -xz
vm sudo tee /opt/bp/power-loss.mjs < "${REPO}/tests/ubuntu/power-loss.mjs" >/dev/null
cat "$(command -v node)" | vm sudo tee /usr/local/bin/node >/dev/null; vm sudo chmod 755 /usr/local/bin/node
judge
note "first boot: $(field judgement.state "$READ")"

section "1. after a reboot"
before="$(boot_id)"
vm sudo systemctl reboot 2>/dev/null
wait_down; sleep 5; wait_up || { fail "the VM did not come back"; exit 1; }
expect "the VM rebooted" [ "$(boot_id)" != "$before" ]
judge
expect "a clean reboot reads clean" [ "$(field judgement.state "$READ")" = clean ]
note "what said so: $(field judgement.marker "$READ")"
note "the previous boot's tail, as the journal kept it:"
vm sudo journalctl -b -1 -n 8 --no-pager -o short-precise | sed 's/^/   /'

section "2. after a power cut"
vm 'logger -t bp-test "last words before the power cut"; sudo journalctl --sync; sync'
sleep 3
cut="$(date +%s)"
before="$(boot_id)"
kill -9 "$(cat "${WORK}/qemu.pid")"; rm -f "${WORK}/qemu.pid"
note "power cut at $(date -u -d "@${cut}" +%H:%M:%S); off for a minute"
sleep 60
launch || { fail "qemu did not start again"; exit 1; }
back="$(date +%s)"
wait_up || { fail "the VM did not come back after the cut"; exit 1; }
expect "it is a new boot" [ "$(boot_id)" != "$before" ]
judge
expect "the power cut reads unclean" [ "$(field judgement.state "$READ")" = unclean ]
expect "of the boot that was cut" [ "$(field judgement.previousBootId "$READ")" = "$before" ]
stopped="$(node -p 'Math.round(Date.parse(JSON.parse(process.argv[1]).judgement.stoppedAt) / 1000)' "$READ")"
came="$(node -p 'Math.round(Date.parse(JSON.parse(process.argv[1]).judgement.backAt) / 1000)' "$READ")"
note "stopped $((cut - stopped)) s before the cut; back $((came - back)) s after qemu started again"
# The guest's clock is the host's, set at each start, to within a second or two.
expect "it stopped no later than the cut, and not long before it" bash -c '[ "$1" -le "$(($2 + 5))" ] && [ "$(($2 - $1))" -le 120 ]' _ "$stopped" "$cut"
expect "and came back after qemu started again" bash -c '[ "$1" -ge "$(($2 - 5))" ] && [ "$(($1 - $2))" -le 120 ]' _ "$came" "$back"
expect "the gap is at least the minute it was off" [ "$(field judgement.offForMs "$READ")" -ge 60000 ]
note "evidence:"
node -e 'for (const line of JSON.parse(process.argv[1]).judgement.evidence ?? []) console.log(`   ${line}`)' "$READ"
note "Home would say: $(field title "$READ")"
note "this boot's kernel about the boot partition: $(vm sudo journalctl -k -b 0 --no-pager -o cat | grep 'FAT-fs' || echo nothing)"

section "3. after another reboot"
before="$(boot_id)"
vm sudo systemctl reboot 2>/dev/null
wait_down; sleep 5; wait_up || { fail "the VM did not come back"; exit 1; }
expect "the VM rebooted" [ "$(boot_id)" != "$before" ]
judge
expect "the boot after the cut ended cleanly, and reads so" [ "$(field judgement.state "$READ")" = clean ]

section "result"
if [ "$FAILURES" -eq 0 ]; then echo "all checks passed"; else echo "${FAILURES} check(s) failed"; fi
exit "$FAILURES"
