#!/bin/bash
# The heartbeat (M39.3) on real systemd: deploy/boxpilot-heartbeat.service and .timer as shipped, the
# address in the real credential store, and a stand-in dead man's switch on loopback that records
# every request (tests/ubuntu/heartbeat-switch.mjs). It proves:
#
#   1. Installed, the timer is not enabled: the heartbeat is off until the owner turns it on.
#   2. Turning it on (heartbeat.configure, as heartbeat.set runs it) writes the interval, enables the
#      timer and sends the first ping at once: one GET, no body, to the saved address, from a unit
#      with no capabilities whose sandbox can still read the root-only credential store.
#   3. The timer fires by itself at the interval.
#   4. A switch that is down costs one quick try, recorded, and the unit still ends cleanly: no
#      retry loop, no failed unit on Home.
#   5. With no address saved it says so; the status file never holds the address.
#   6. The inspect the Settings page reads names the host only; turning it off disables the timer.
#
#   sudo bash tests/ubuntu/heartbeat.sh /path/to/node-24
#
# DISPOSABLE MACHINES ONLY (CI runs it on GitHub's Ubuntu VMs): it writes /opt/boxpilot,
# /var/lib/boxpilot-managed and units into /etc/systemd/system.
set -uo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run as root, on a disposable machine" >&2; exit 2; }
NODE="${1:-$(command -v node || true)}"
[ -x "$NODE" ] && [ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -ge 24 ] || { echo "pass a Node.js 24 binary as the first argument" >&2; exit 2; }
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SERVICE=boxpilot-heartbeat.service
TIMER=boxpilot-heartbeat.timer
PORT=18099
TOKEN="$(cat /proc/sys/kernel/random/uuid)"
URL="http://127.0.0.1:${PORT}/ping/${TOKEN}"
LOG=/tmp/bp-heartbeat-requests.jsonl
STATUS=/var/lib/boxpilot-heartbeat/last.json
STORE=/var/lib/boxpilot-managed/credentials.json
FAILURES=0
RESULTS=""
SWITCH_PID=""

section() { printf '\n==== %s ====\n' "$*"; }
note() { printf '    %s\n' "$*"; }
record() {
  RESULTS="${RESULTS}$1  $2"$'\n'
  printf '  %s  %s\n' "$1" "$2"
  [ "$1" = PASS ] || FAILURES=$((FAILURES + 1))
}
check() { local what="$1"; shift; if "$@"; then record PASS "$what"; else record FAIL "$what"; fi; }
wait_for() { # wait_for <seconds> <command...>
  local seconds="$1"; shift
  for _ in $(seq 1 "$seconds"); do "$@" && return 0; sleep 1; done
  return 1
}
requests() { [ -f "$LOG" ] && wc -l <"$LOG" | tr -d ' ' || echo 0; }
at_least() { [ "$(requests)" -ge "$1" ]; }
show() { systemctl show "$1" -p "$2" --value; }
status_field() { "$NODE" -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(s[process.argv[2]]))' "$STATUS" "$1"; }
request_field() { "$NODE" -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n");const r=JSON.parse(l[Number(process.argv[2])]);process.stdout.write(String(Array.isArray(r[process.argv[3]])?r[process.argv[3]].join(","):r[process.argv[3]]))' "$LOG" "$1" "$2"; }
task() { "$NODE" --input-type=module -e "const m = await import('/opt/boxpilot/server/tasks/heartbeat.mjs'); console.log(JSON.stringify(await m.$1));"; }
start_switch() {
  "$NODE" "${ROOT}/tests/ubuntu/heartbeat-switch.mjs" "$PORT" "$LOG" >/tmp/bp-heartbeat-switch.log 2>&1 &
  SWITCH_PID=$!
  wait_for 20 curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/ready" || { echo "the stand-in switch did not start" >&2; exit 1; }
  : >"$LOG"
}

cleanup() {
  systemctl disable --now "$TIMER" >/dev/null 2>&1 || true
  [ -n "$SWITCH_PID" ] && kill "$SWITCH_PID" 2>/dev/null
  journalctl -u "$SERVICE" -n 30 --no-pager 2>/dev/null | sed 's/^/    journal: /'
}
trap cleanup EXIT

section "Setting up BoxPilot's heartbeat as it ships"
[ -x /usr/local/bin/node ] || ln -sf "$NODE" /usr/local/bin/node
rm -rf /opt/boxpilot && install -d -m 0755 /opt/boxpilot
cp -r "${ROOT}/server" "${ROOT}/scripts" "${ROOT}/packages" "${ROOT}/package.json" /opt/boxpilot/
chmod -R a+rX /opt/boxpilot
install -d -m 0700 /var/lib/boxpilot-managed
"$NODE" --input-type=module -e "const m = await import('/opt/boxpilot/server/credentials.mjs'); await m.createCredentialStore({ file: '${STORE}' }).set({ name: 'heartbeat-url', value: process.argv[1] });" "$URL"
install -m 0644 "${ROOT}/deploy/${SERVICE}" "/etc/systemd/system/${SERVICE}"
install -m 0644 "${ROOT}/deploy/${TIMER}" "/etc/systemd/system/${TIMER}"
rm -rf "/etc/systemd/system/${TIMER}.d"
systemctl daemon-reload
start_switch

section "1. Installed and off"
check "the credential store is root-only (0600)" [ "$(stat -c %a "$STORE")" = "600" ]
check "the timer is installed but not enabled ($(systemctl is-enabled "$TIMER" 2>&1))" [ "$(systemctl is-enabled "$TIMER" 2>&1)" = "disabled" ]
check "nothing was sent" [ "$(requests)" = "0" ]

section "2. Turning it on"
ON="$(task 'heartbeatConfigure({ enabled: true, intervalMinutes: 1 })')"
note "heartbeat.configure: ${ON}"
timer_on() { [ "$(systemctl is-enabled "$TIMER" 2>&1)" = "enabled" ] && [ "$(systemctl is-active "$TIMER" 2>&1)" = "active" ]; }
timer_off() { [ "$(systemctl is-enabled "$TIMER" 2>&1)" = "disabled" ] && [ "$(systemctl is-active "$TIMER" 2>&1)" = "inactive" ]; }
refused() { [ "$(status_field ok)" = "false" ] && [ "$(status_field error)" = "the connection was refused" ]; }
check "the timer is enabled and running" timer_on
check "the interval drop-in says one minute" grep -qx 'OnUnitActiveSec=1min' "/etc/systemd/system/${TIMER}.d/interval.conf"
check "the timer's own interval took it ($(show "$TIMER" TimersMonotonic))" sh -c "systemctl show '$TIMER' -p TimersMonotonic --value | grep -q '1min'"
check "the first ping arrived at once" [ "$(requests)" = "1" ]
check "it was a GET ($(request_field 0 method))" [ "$(request_field 0 method)" = "GET" ]
check "to the saved address" [ "$(request_field 0 path)" = "/ping/${TOKEN}" ]
check "with no body" [ "$(request_field 0 bodyBytes)" = "0" ]
note "headers: $(request_field 0 headers); user agent: $(request_field 0 userAgent)"
check "and no header of BoxPilot's, no hostname" sh -c "! printf '%s' '$(request_field 0 headers)' | grep -qi 'boxpilot\|host-name\|x-'"
check "the status says it was taken" [ "$(status_field ok)" = "true" ]
check "the status file is world-readable (0644)" [ "$(stat -c %a "$STATUS")" = "644" ]
check "and does not hold the address" sh -c "! grep -q '${TOKEN}' '$STATUS'"
check "the unit ran with no capabilities" [ -z "$(show "$SERVICE" CapabilityBoundingSet)" ]
check "and ended cleanly ($(show "$SERVICE" Result))" [ "$(show "$SERVICE" Result)" = "success" ]

section "3. The timer fires by itself"
check "a second ping came from the timer within its minute" wait_for 100 at_least 2
check "it keeps the one-minute rhythm, not a loop ($(requests) in all)" [ "$(requests)" -le 3 ]

section "4. A switch that is down"
kill "$SWITCH_PID" 2>/dev/null; wait "$SWITCH_PID" 2>/dev/null; SWITCH_PID=""
STARTED="$(date +%s%N)"
systemctl start "$SERVICE"
TOOK=$((($(date +%s%N) - STARTED) / 1000000))
note "one ping to a closed port took ${TOOK} ms"
check "the unit still ends cleanly ($(show "$SERVICE" Result))" [ "$(show "$SERVICE" Result)" = "success" ]
check "within its ten-second budget (${TOOK} ms)" [ "$TOOK" -lt 15000 ]
check "the status says it was not taken: $(status_field error)" refused
check "nothing is left failed" sh -c "! systemctl is-failed --quiet '$SERVICE'"

section "5. No address saved"
"$NODE" --input-type=module -e "const m = await import('/opt/boxpilot/server/credentials.mjs'); await m.createCredentialStore({ file: '${STORE}' }).remove({ name: 'heartbeat-url' });"
systemctl start "$SERVICE"
check "it says there is no address ($(status_field error))" [ "$(status_field error)" = "no heartbeat address is saved" ]
"$NODE" --input-type=module -e "const m = await import('/opt/boxpilot/server/credentials.mjs'); await m.createCredentialStore({ file: '${STORE}' }).set({ name: 'heartbeat-url', value: process.argv[1] });" "$URL"

section "6. What Settings reads, and turning it off"
INSPECT="$("$NODE" --input-type=module -e "const { inspectHeartbeat } = await import('/opt/boxpilot/server/ops/heartbeat.mjs'); const { createCredentialStore } = await import('/opt/boxpilot/server/credentials.mjs'); const { fixedRun } = await import('/opt/boxpilot/server/exec.mjs'); console.log(JSON.stringify(await inspectHeartbeat({ credentials: createCredentialStore({ file: '${STORE}' }), run: fixedRun })));")"
note "heartbeat.inspect: ${INSPECT}"
check "it says on, every minute, to 127.0.0.1:${PORT}" sh -c "printf '%s' '$INSPECT' | grep -q '\"enabled\":true' && printf '%s' '$INSPECT' | grep -q '\"intervalMinutes\":1' && printf '%s' '$INSPECT' | grep -q '\"host\":\"127.0.0.1:${PORT}\"'"
check "and never the address" sh -c "! printf '%s' '$INSPECT' | grep -q '${TOKEN}'"
OFF="$(task 'heartbeatConfigure({ enabled: false })')"
note "heartbeat.configure: ${OFF}"
check "the timer is disabled and stopped" timer_off

section "Results"
printf '%s' "$RESULTS"
[ "$FAILURES" -eq 0 ] || { echo "${FAILURES} check(s) failed" >&2; exit 1; }
