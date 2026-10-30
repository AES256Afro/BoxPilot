#!/usr/bin/env bash
# The hardware watchdog on real systemd (M39.4), with the kernel's softdog standing in for the
# board's timer. A GitHub runner is a virtual machine with no hardware watchdog, and Ubuntu lists
# softdog as not to be loaded automatically exactly as it lists sp5100_tco and iTCO_wdt, so:
#
#   1. what BoxPilot reads here: a virtual machine, the driver blacklisted, and turning it on refused;
#   2. turning it on with BoxPilot's own code, softdog treated as the board's timer: the driver
#      loaded by name, the drop-in in /etc/systemd/system.conf.d, `systemctl daemon-reload`, and
#      systemd taking it (systemctl show, the device active, wdctl, systemd's own journal line);
#   3. turning it off: the files gone, RuntimeWatchdogUSec=0 and the device stopped;
#   4. at boot: systemd-modules-load honours the blacklist, so a modules-load.d line alone does not
#      load the driver, and BoxPilot's drop-in for systemd-modules-load.service does.
#
# No hang is simulated. It edits systemd's configuration, so it runs only on a disposable machine.
#
#   sudo bash tests/ubuntu/watchdog-softdog.sh /path/to/node-24
set -uo pipefail

NODE="${1:-$(command -v node || true)}"
[ -x "$NODE" ] && [ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -ge 24 ] || { echo "pass a Node.js 24 binary as the first argument" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "run as root on a disposable machine" >&2; exit 2; }
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FAILURES=0

section() { printf '\n==================== %s ====================\n' "$*"; }
note() { printf '>> %s\n' "$*"; }
pass() { printf 'PASS: %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
check() { local what="$1"; shift; if "$@"; then pass "$what"; else fail "$what"; fi; }
bp() { "$NODE" --input-type=module -e "$1"; }
loaded() { grep -q '^softdog ' /proc/modules; }
state() { cat /sys/class/watchdog/watchdog0/state 2>/dev/null; }
runtime_usec() { systemctl show -p RuntimeWatchdogUSec --value; }

cleanup() {
  section "cleanup"
  rm -f /etc/systemd/system.conf.d/90-boxpilot-watchdog.conf /etc/modules-load.d/boxpilot-watchdog.conf /etc/systemd/system/systemd-modules-load.service.d/boxpilot-watchdog.conf
  systemctl daemon-reload
}
trap cleanup EXIT

section "Prepare: $(. /etc/os-release; echo "$PRETTY_NAME"), systemd $(systemctl --version | head -n1 | cut -d' ' -f2), kernel $(uname -r)"
if ! modinfo softdog >/dev/null 2>&1; then echo "SKIP: this kernel has no softdog module"; exit 0; fi
note "blacklist lines for watchdog drivers: $(grep -hE '^blacklist (softdog|sp5100_tco|iTCO_wdt)$' /lib/modprobe.d/*.conf /usr/lib/modprobe.d/*.conf 2>/dev/null | sort -u | tr '\n' ';')"
modprobe -r softdog 2>/dev/null

section "1. What BoxPilot reads on this machine"
INSPECT="$(bp "
  import { inspectWatchdog } from '${ROOT}/server/tasks/watchdog.mjs';
  console.log(JSON.stringify(await inspectWatchdog()));")"
note "inspectWatchdog: ${INSPECT}"
check "a virtual machine is recognised as one, and not offered" "$NODE" -e 'const found = JSON.parse(process.argv[1]); process.exit(found.state === "virtual-machine" && found.usable === false && found.virtualization !== "none" ? 0 : 1);' "$INSPECT"
REFUSED="$(bp "
  import { watchdogEnable } from '${ROOT}/server/tasks/watchdog.mjs';
  try { await watchdogEnable({ runtimeSeconds: 60 }); console.log('turned on'); } catch (error) { console.log(error.message); }")"
note "watchdogEnable here: ${REFUSED}"
check "turning it on is refused on a virtual machine, before anything is written" bash -c '[[ "$1" == *"virtual machine"* ]] && [ ! -e /etc/systemd/system.conf.d/90-boxpilot-watchdog.conf ]' _ "$REFUSED"
check "the softdog driver is on the blacklist here, as the chipset drivers are on a real server" "$NODE" -e '
  import("'"${ROOT}"'/server/tasks/watchdog.mjs").then(async ({ blacklisted }) => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const configs = ["/lib/modprobe.d", "/usr/lib/modprobe.d", "/etc/modprobe.d"].flatMap((dir) => { try { return readdirSync(dir).filter((f) => f.endsWith(".conf")).map((f) => readFileSync(`${dir}/${f}`, "utf8")); } catch { return []; } });
    process.exit(blacklisted(configs, "softdog") ? 0 : 1);
  });'

section "2. Turning it on, softdog standing in for the board's timer"
ENABLED="$(bp "
  import { watchdogEnable, watchdogDevices } from '${ROOT}/server/tasks/watchdog.mjs';
  const log = (line, stream) => console.error('      ' + (stream === 'stderr' ? '! ' : '') + line);
  // What a real board with a blacklisted chipset driver looks like: no device yet, the driver on disk.
  const inspect = async () => ({ state: 'loadable', usable: true, virtualization: 'none', devices: [], driver: { name: 'softdog', available: 'module', loaded: false, blacklisted: true } });
  const devices = async () => (await watchdogDevices()).map((device) => ({ ...device, software: false }));
  try { console.log(JSON.stringify(await watchdogEnable({ runtimeSeconds: 60 }, { log, inspect, devices }))); } catch (error) { console.log(JSON.stringify({ error: error.message })); }")"
note "watchdogEnable: ${ENABLED}"
check "it turned on" "$NODE" -e 'const result = JSON.parse(process.argv[1]); process.exit(result.on === true && result.runtimeSeconds === 60 && result.device === "/dev/watchdog0" ? 0 : 1);' "$ENABLED"
check "the driver was loaded by name, blacklist or not" loaded
check "the drop-in is in /etc/systemd/system.conf.d" grep -qx 'RuntimeWatchdogSec=60s' /etc/systemd/system.conf.d/90-boxpilot-watchdog.conf
check "systemctl show: RuntimeWatchdogUSec=1min" [ "$(runtime_usec)" = 1min ]
check "systemctl show: RebootWatchdogUSec=10min" [ "$(systemctl show -p RebootWatchdogUSec --value)" = 10min ]
check "the device is active" [ "$(state)" = active ]
check "wdctl reads it while systemd holds it" bash -c "wdctl -O /dev/watchdog0 | grep -q 'TIMEOUT=\"60\"'"
check "systemd says it is pinging it" bash -c "journalctl -b _PID=1 --no-pager -o cat | grep -qiE 'watchdog running with a (hardware )?timeout of 1min'"
check "the driver is set to load at boot" bash -c "grep -qx softdog /etc/modules-load.d/boxpilot-watchdog.conf && grep -q 'ExecStartPost=-/usr/sbin/modprobe softdog' /etc/systemd/system/systemd-modules-load.service.d/boxpilot-watchdog.conf"
check "systemd-modules-load.service has the drop-in" bash -c "systemctl show -p ExecStartPost systemd-modules-load.service | grep -q 'modprobe softdog'"
INSPECT="$(bp "
  import { inspectWatchdog } from '${ROOT}/server/tasks/watchdog.mjs';
  console.log(JSON.stringify(await inspectWatchdog()));")"
check "the read sees systemd's setting and BoxPilot's file" "$NODE" -e 'const found = JSON.parse(process.argv[1]); process.exit(found.runtimeSeconds === 60 && found.rebootSeconds === 600 && found.managedByBoxPilot && found.devices.some((device) => device.state === "active") ? 0 : 1);' "$INSPECT"

section "3. Turning it off"
DISABLED="$(bp "
  import { watchdogDisable, watchdogDevices } from '${ROOT}/server/tasks/watchdog.mjs';
  const log = (line, stream) => console.error('      ' + (stream === 'stderr' ? '! ' : '') + line);
  const devices = async () => (await watchdogDevices()).map((device) => ({ ...device, software: false }));
  try { console.log(JSON.stringify(await watchdogDisable({}, { log, devices }))); } catch (error) { console.log(JSON.stringify({ error: error.message })); }")"
note "watchdogDisable: ${DISABLED}"
check "it turned off and the watchdog stopped" "$NODE" -e 'const result = JSON.parse(process.argv[1]); process.exit(result.on === false && result.stopped === true && result.removed.length === 3 ? 0 : 1);' "$DISABLED"
check "systemctl show: RuntimeWatchdogUSec=0" [ "$(runtime_usec)" = 0 ]
check "the device is inactive" [ "$(state)" = inactive ]
check "BoxPilot's files are gone" bash -c "[ ! -e /etc/systemd/system.conf.d/90-boxpilot-watchdog.conf ] && [ ! -e /etc/modules-load.d/boxpilot-watchdog.conf ] && [ ! -e /etc/systemd/system/systemd-modules-load.service.d/boxpilot-watchdog.conf ]"

section "4. At boot: systemd-modules-load and the blacklist"
modprobe -r softdog
check "softdog is unloaded" bash -c "! grep -q '^softdog ' /proc/modules"
install -d /etc/modules-load.d
printf 'softdog\n' > /etc/modules-load.d/boxpilot-watchdog.conf
systemctl restart systemd-modules-load.service
check "a modules-load.d line alone does not load a blacklisted driver" bash -c "! grep -q '^softdog ' /proc/modules"
note "systemd-modules-load said: $(journalctl -u systemd-modules-load --no-pager -o cat -n 3 | tr '\n' ' ')"
bp "
  import { renderModuleFiles } from '${ROOT}/server/tasks/watchdog.mjs';
  import { mkdirSync, writeFileSync } from 'node:fs';
  for (const [file, content] of Object.entries(renderModuleFiles('softdog'))) { mkdirSync(file.slice(0, file.lastIndexOf('/')), { recursive: true }); writeFileSync(file, content); }"
systemctl daemon-reload
systemctl restart systemd-modules-load.service
check "with BoxPilot's drop-in, systemd-modules-load.service loads it" loaded

section "Result"
if [ "$FAILURES" -eq 0 ]; then echo "All checks passed"; else echo "${FAILURES} check(s) failed"; exit 1; fi
