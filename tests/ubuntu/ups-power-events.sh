#!/usr/bin/env bash
# The UPS end to end on a real Ubuntu (M39.1): NUT as the distribution ships it, BoxPilot's own
# setup code (server/tasks/ups.mjs) and shutdown script, a Docker app, and NUT's dummy-ups driver
# standing in for the UPS on USB. Only the power-off itself is a stub.
#
#   sudo bash tests/ubuntu/ups-power-events.sh /path/to/node-24
#
# What it shows:
#   1. ups.setup configures NUT and it answers: the driver through systemd's nut-driver@ units (not
#      upsdrvctl beside them), upsd on loopback, upsmon logged in, the log and policy readable by
#      the web process, and setting up again changes nothing that works;
#   2. the power-event log: on battery, back on mains, with charge and runtime, read back by the
#      same reader the System page and Home use;
#   3. the owner's threshold: with ignorelb and override.battery.charge.low, a charge under it is a
#      low battery although the UPS never said so; with shutdown off, only a note is written;
#   4. the shutdown decision: on battery and low, upsmon runs BoxPilot's shutdown, which stops Docker
#      the way a shutdown does (the app comes back when Docker starts, not marked as stopped by
#      hand), logs it, and calls the power-off; and upsmon leaves /etc/killpower so the UPS would
#      switch its outlets off after the power-off.
#
# It installs NUT, rewrites /etc/nut and stops Docker, so it runs only on a disposable machine.
set -uo pipefail

NODE="${1:-$(command -v node || true)}"
[ -x "$NODE" ] && [ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -ge 24 ] || { echo "pass a Node.js 24 binary as the first argument" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "run as root on a disposable machine" >&2; exit 2; }
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEV=/etc/nut/boxpilot-ci.dev
EVENTS=/var/lib/boxpilot-power/events.log
POLICY=/var/lib/boxpilot-power/policy.json
POWEROFF=/usr/local/sbin/boxpilot-test-poweroff
POWEROFF_MARK=/run/boxpilot-test-poweroff
IMAGE=bp-busybox
APP=bp-ups-app
FAILURES=0

section() { printf '\n==================== %s ====================\n' "$*"; }
note() { printf '>> %s\n' "$*"; }
pass() { printf 'PASS: %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
check() { local what="$1"; shift; if "$@"; then pass "$what"; else fail "$what"; fi; }

cleanup() {
  section "cleanup"
  rm -f /etc/killpower
  systemctl start docker.socket docker.service >/dev/null 2>&1
  docker rm -f "$APP" >/dev/null 2>&1
  if [ "$FAILURES" -gt 0 ]; then
    section "What NUT said"
    journalctl -u nut-monitor -u nut-server -u 'nut-driver@*' -u nut-driver-enumerator -n 120 --no-pager -o short-monotonic | sed 's/^/    /'
    section "The power-event log"
    sed 's/^/    /' "$EVENTS" 2>/dev/null
  fi
}
trap cleanup EXIT

# The UPS as dummy-ups reads it: the status and the battery, and (unless UPS_LOWS=no, when the
# owner's thresholds stand in for them) the UPS's own idea of low. Written in place, so the driver
# sees the same file change (dummy-once mode reads it again when it changes).
UPS_LOWS=yes
ups_says() {
  local status="$1" charge="$2" runtime="$3"
  {
    printf 'battery.charge: %s\nbattery.runtime: %s\n' "$charge" "$runtime"
    [ "$UPS_LOWS" = yes ] && printf 'battery.charge.low: 20\nbattery.runtime.low: 300\n'
    printf 'ups.status: %s\n' "$status"
  } > "$DEV"
}

# wait_for <seconds> <description> <command...>: poll until the command succeeds.
wait_for() {
  local seconds="$1" what="$2"; shift 2
  local deadline=$((SECONDS + seconds))
  while [ "$SECONDS" -lt "$deadline" ]; do "$@" && { pass "$what (${SECONDS}s into the test)"; return 0; }; sleep 1; done
  fail "$what: not within ${seconds}s"
  return 1
}
logged() { grep -qE "^[0-9TZ:-]+ $1( |$)" "$EVENTS" 2>/dev/null; }
count_logged() { grep -cE "^[0-9TZ:-]+ $1( |$)" "$EVENTS" 2>/dev/null || true; }

# setup <parameters-json>: BoxPilot's ups.setup task, with the simulated UPS and the stub power-off.
setup() {
  SETUP_RESULT="$("$NODE" --input-type=module -e "
    import { upsSetup } from '/opt/boxpilot/server/tasks/ups.mjs';
    const log = (line, stream) => console.error((stream === 'stderr' ? '! ' : '') + line);
    try {
      const result = await upsSetup(JSON.parse(process.argv[1]), { log, simulated: { driver: 'dummy-ups', port: 'boxpilot-ci.dev' }, host: { installRoot: '/opt/boxpilot', nodeBinary: process.execPath, powerOff: '${POWEROFF}', eventsPath: '${EVENTS}' } });
      console.log(JSON.stringify(result));
    } catch (error) { console.log(JSON.stringify({ error: error.message })); }
  " "$1" 2>/run/boxpilot-test-setup.log)"
  sed 's/^/      /' /run/boxpilot-test-setup.log
  note "ups.setup $1 -> ${SETUP_RESULT}"
}
setup_field() { "$NODE" -p "String(JSON.parse(process.argv[1])${1})" "$SETUP_RESULT"; }
# When a setup fails: NUT's own units as this release ships them, and everything they said.
diagnose() {
  [ "$(setup_field .configured)" = true ] && return 0
  section "Why the setup failed"
  systemctl cat nut-server.service nut-monitor.service --no-pager 2>&1 | grep -vE '^#|^$' | sed 's/^/    /'
  systemctl status nut-server.service nut-monitor.service --no-pager -l 2>&1 | sed 's/^/    /' | head -40
  journalctl -u nut-server -u nut-monitor -u nut-driver-enumerator -u 'nut-driver@*' --no-pager -o short-monotonic 2>&1 | tail -n 120 | sed 's/^/    /'
}

# The reader the web process uses, as an unprivileged user.
read_events() { runuser -u nobody -- "$NODE" --input-type=module -e "
  import { readPowerEvents } from '/opt/boxpilot/server/power-events.mjs';
  console.log(JSON.stringify(await readPowerEvents({ limit: 50 })));"; }

prepare() {
  section "Prepare: $(. /etc/os-release; echo "$PRETTY_NAME"), systemd $(systemctl --version | head -n1 | cut -d' ' -f2), NUT, Docker"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq >/dev/null
  apt-get install -y -qq --no-install-recommends nut-server nut-client >/dev/null
  note "NUT $(dpkg-query -W -f '${Version}' nut-server)"
  install -d -m 0755 /opt/boxpilot
  cp -r "${ROOT}/server" "${ROOT}/scripts" "${ROOT}/package.json" /opt/boxpilot/
  printf '#!/bin/sh\necho "$(date -u +%%Y-%%m-%%dT%%H:%%M:%%SZ) $*" >> %s\n' "$POWEROFF_MARK" > "$POWEROFF"
  chmod 0755 "$POWEROFF"
  rm -f "$POWEROFF_MARK" /etc/killpower "$EVENTS" "$POLICY"
  docker pull -q mirror.gcr.io/library/busybox:1.36 >/dev/null && docker tag mirror.gcr.io/library/busybox:1.36 "$IMAGE"
  ups_says OL 100 1800
  chown root:nut "$DEV"; chmod 0640 "$DEV"
}

prepare

section "1. Setting the UPS up"
setup '{"name":"ups","driver":"usbhid-ups","description":"Test UPS","shutdownAtLowBattery":true}'
diagnose
check "ups.setup succeeded" [ "$(setup_field .configured)" = true ]
check "the drivers are NUT 2.8's systemd units, restarted through the enumerator" [ "$(setup_field .manager)" = enumerator ]
# 26.04's package starts upsd at install with no UPS defined, until systemd's start limit refuses it;
# the setup clears that first, so upsd starts at the first try rather than on the fallback retry.
check "upsd started at the first try, the install's start limit cleared" bash -c "! grep -q 'did not start the first time' /run/boxpilot-test-setup.log"
check "nut-driver@ups, nut-server and nut-monitor are active" systemctl is-active --quiet nut-driver@ups.service nut-server.service nut-monitor.service
check "upsd listens on loopback only" bash -c "ss -Hltn 'sport = :3493' | awk '{print \$4}' | grep -qx '127.0.0.1:3493'"
check "upsmon is logged in to upsd" bash -c "upsc -c ups@localhost 2>/dev/null | grep -qx 127.0.0.1"
check "the monitor password is the nut group's only" [ "$(stat -c '%a %U:%G' /etc/nut/upsmon.conf)" = "640 root:nut" ]
check "the scripts are root's and executable" [ "$(stat -c '%a %U' /etc/nut/boxpilot-notify /etc/nut/boxpilot-shutdown | sort -u)" = "755 root" ]
check "the event log belongs to nut and anyone may read it" [ "$(stat -c '%a %U' "$EVENTS")" = "644 nut" ]
check "the policy is readable and holds no password" bash -c "[ \"\$(stat -c %a '$POLICY')\" = 644 ] && ! grep -q password '$POLICY' && grep -q '\"shutdownAtLowBattery\": true' '$POLICY'"
check "setup logged that it is watching" logged watching
check "the thresholds the UPS reports are in the result" [ "$(setup_field .thresholds.lowBatteryPercent)/$(setup_field .thresholds.lowRuntimeSeconds)" = "20/300" ]
check "the web process's UPS reader sees it online, with the thresholds" bash -c "runuser -u nobody -- '$NODE' --input-type=module -e \"
  import { createUpsService } from '/opt/boxpilot/server/ups.mjs';
  const ups = await createUpsService().inspect();
  console.log(JSON.stringify(ups));
  process.exit(ups.state === 'online' && ups.lowBatteryPercent === 20 && ups.lowRuntimeSeconds === 300 ? 0 : 1);\""

note "Setting up a second time, as the owner would after changing a setting"
setup '{"name":"ups","driver":"usbhid-ups","description":"Test UPS","shutdownAtLowBattery":true}'
check "setting up again succeeds" [ "$(setup_field .configured)" = true ]
check "and kept the log it had" [ "$(count_logged watching)" -eq 2 ]
check "the originals were kept once, not overwritten by BoxPilot's own files" bash -c "ls /etc/nut/*.before-boxpilot >/dev/null && ! ls /etc/nut/boxpilot-*.before-boxpilot >/dev/null 2>&1"

section "2. The power goes out and comes back"
ups_says OB 87 1260
wait_for 45 "on battery is logged" logged on-battery
check "with the charge and runtime" grep -qE ' on-battery charge=87 runtime=1260$' "$EVENTS"
ups_says OL 88 1300
wait_for 45 "back on mains is logged" logged on-mains
EVENTS_JSON="$(read_events)"
note "readPowerEvents as nobody: ${EVENTS_JSON}"
check "the web process's reader returns them newest first" "$NODE" -e '
  const { available, events } = JSON.parse(process.argv[1]);
  const names = events.map((event) => event.event);
  process.exit(available === "yes" && names[0] === "on-mains" && names.indexOf("on-battery") > 0 && events.find((event) => event.event === "on-battery").charge === 87 ? 0 : 1);' "$EVENTS_JSON"
check "nothing shut down" [ ! -e "$POWEROFF_MARK" ]

section "3. The owner's threshold, with shutdown off"
UPS_LOWS=no
ups_says OL 88 1300
setup '{"name":"ups","driver":"usbhid-ups","description":"Test UPS","shutdownAtLowBattery":false,"lowBatteryPercent":50}'
check "setup with a threshold succeeds" [ "$(setup_field .configured)" = true ]
check "the driver took the owner's threshold over the UPS's" [ "$(upsc ups@localhost battery.charge.low 2>/dev/null)" = 50 ]
check "and does not cut the power at the next reboot" bash -c "! grep -q POWERDOWNFLAG /etc/nut/upsmon.conf"
ups_says OB 40 900
wait_for 45 "a charge under the owner's 50% is a low battery, though the UPS never said LB" logged low-battery
wait_for 30 "with shutdown off, the shutdown only notes it was skipped" logged shutdown-skipped
check "and nothing powered off" [ ! -e "$POWEROFF_MARK" ]
check "and no power-off was logged" bash -c "! grep -q ' power-off' '$EVENTS'"

section "4. The battery runs low, with shutdown on"
UPS_LOWS=yes
ups_says OL 100 1800
setup '{"name":"ups","driver":"usbhid-ups","description":"Test UPS","shutdownAtLowBattery":true}'
check "setup with shutdown on again succeeds" [ "$(setup_field .configured)" = true ]
docker run -d --name "$APP" --restart unless-stopped "$IMAGE" sh -c 'trap "exit 0" TERM; while :; do sleep 1 & wait $!; done' >/dev/null
check "an app is running" [ "$(docker inspect -f '{{.State.Running}}' "$APP")" = true ]
BEFORE_LOW="$(count_logged low-battery)"
ups_says "OB LB" 9 110
wait_for 45 "a new low battery is logged" bash -c "[ \"\$(grep -cE ' low-battery( |\$)' '$EVENTS')\" -gt $BEFORE_LOW ]"
wait_for 45 "upsmon ran BoxPilot's shutdown, which stopped the apps" logged apps-stopped
wait_for 30 "and then called the power-off" test -s "$POWEROFF_MARK"
check "the shutdown stopped the one running app and found no drive" grep -qE ' apps-stopped containers=1 drives=0 busy=0$' "$EVENTS"
check "the log ends with the power-off" bash -c "tail -n 1 '$EVENTS' | grep -qE ' power-off$'"
check "Docker was stopped, not the app by hand" bash -c "! systemctl is-active --quiet docker.service"
check "upsmon left /etc/killpower, so the UPS would switch its outlets off after the power-off" test -e /etc/killpower
check "nut-monitor's journal has what the shutdown did" bash -c "journalctl -u nut-monitor --no-pager -o cat | grep -q 'Stopping Docker so ${APP} stop the way they do at shutdown'"
systemctl start docker.socket docker.service
wait_for 60 "when Docker starts again the app comes back by its restart policy" bash -c "[ \"\$(docker inspect -f '{{.State.Running}}' '$APP' 2>/dev/null)\" = true ]"
EVENTS_JSON="$(read_events)"
check "the reader sees the whole story, newest first" "$NODE" -e '
  const names = JSON.parse(process.argv[1]).events.map((event) => event.event);
  const order = ["power-off", "apps-stopped", "shutdown", "low-battery"].map((name) => names.indexOf(name));
  process.exit(order.every((index, position) => index >= 0 && (position === 0 || index > order[position - 1])) ? 0 : 1);' "$EVENTS_JSON"

section "The power-event log"
sed 's/^/    /' "$EVENTS"
section "Result"
if [ "$FAILURES" -eq 0 ]; then echo "All checks passed"; else echo "${FAILURES} check(s) failed"; exit 1; fi
