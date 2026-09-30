#!/usr/bin/env bash
# Wake-on-LAN's .link file on real udev (M39.6). A runner's network ports cannot wake anything, so
# ethtool is a stand-in that remembers what it was told; udev, its .link files and netplan's are
# the runner's own. It shows:
#
#   1. a port whose settings come from netplan's generated .link file: BoxPilot's file would never
#      apply, udev says so, and the change is refused, undone, with what to add to netplan instead;
#   2. a port on systemd's default .link file: BoxPilot's file, with the port's naming rules copied
#      from the default, is the one udev applies, and turning it off removes it.
#
#   sudo bash tests/ubuntu/wake-on-lan-link.sh /path/to/node-24
set -uo pipefail

NODE="${1:-$(command -v node || true)}"
[ -x "$NODE" ] && [ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -ge 24 ] || { echo "pass a Node.js 24 binary as the first argument" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "run as root on a disposable machine" >&2; exit 2; }
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FAKE=/usr/local/sbin/boxpilot-test-ethtool
STATE=/run/boxpilot-test-ethtool
FAILURES=0

section() { printf '\n==================== %s ====================\n' "$*"; }
note() { printf '>> %s\n' "$*"; }
pass() { printf 'PASS: %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
check() { local what="$1"; shift; if "$@"; then pass "$what"; else fail "$what"; fi; }

cleanup() {
  section "cleanup"
  rm -f /etc/systemd/network/50-boxpilot-wake-on-lan-*.link "$FAKE"
  udevadm control --reload
}
trap cleanup EXIT

# ethtool as BoxPilot uses it: the wake-on lines, and -s <port> wol <g|d>, remembered per port.
cat > "$FAKE" <<'SCRIPT'
#!/bin/sh
state=/run/boxpilot-test-ethtool
case "$1" in
  --version) echo "ethtool version 6.7 (test stand-in)" ;;
  -s) printf '%s\n' "$4" > "$state.$2" ;;
  *) printf 'Settings for %s:\n\tSupports Wake-on: pumbg\n\tWake-on: %s\n' "$1" "$(cat "$state.$1" 2>/dev/null || echo d)" ;;
esac
SCRIPT
chmod 0755 "$FAKE"
export BOXPILOT_ETHTOOL_BINARY="$FAKE"

# set_wol <port> <true|false>: BoxPilot's task, as boxpilot-run@ would run it.
set_wol() {
  WOL_RESULT="$("$NODE" --input-type=module -e "
    import { wakeOnLanSet } from '${ROOT}/server/tasks/wake-on-lan.mjs';
    const log = (line, stream) => console.error('      ' + (stream === 'stderr' ? '! ' : '') + line);
    try { console.log(JSON.stringify(await wakeOnLanSet({ interface: process.argv[1], enabled: process.argv[2] === 'true' }, { log }))); }
    catch (error) { console.log(JSON.stringify({ error: error.message })); }
  " "$1" "$2")"
  note "wakeOnLanSet $1 $2 -> ${WOL_RESULT}"
}
applied_file() { udevadm test-builtin net_setup_link "/sys/class/net/$1" 2>&1 | sed -n 's/.*Config file \(.*\.link\) is applied.*/\1/p' | head -n1; }

section "Prepare: $(. /etc/os-release; echo "$PRETTY_NAME"), systemd $(systemctl --version | head -n1 | cut -d' ' -f2)"
PORTS="$("$NODE" --input-type=module -e "
  import { inspectWakeOnLan } from '${ROOT}/server/tasks/wake-on-lan.mjs';
  console.log(JSON.stringify(await inspectWakeOnLan()));")"
note "inspectWakeOnLan: ${PORTS}"
check "the wired ports with a device behind them are listed, and docker0 is not" "$NODE" -e 'const { ethtool, ports } = JSON.parse(process.argv[1]); process.exit(ethtool && ports.length > 0 && !ports.some((port) => port.name === "docker0") && ports.every((port) => /^[0-9a-f:]{17}$/.test(port.mac) && port.supportsMagic) ? 0 : 1);' "$PORTS"
NETPLAN_PORT=""; DEFAULT_PORT=""
for port in $(ls /sys/class/net); do
  [ -e "/sys/class/net/${port}/device" ] || continue
  file="$(applied_file "$port")"
  note "${port}: udev applies ${file:-nothing}"
  case "$file" in
    */10-netplan-*) [ -z "$NETPLAN_PORT" ] && NETPLAN_PORT="$port" ;;
    */99-default.link) [ -z "$DEFAULT_PORT" ] && DEFAULT_PORT="$port" ;;
  esac
done

section "1. A port netplan's .link file decides"
if [ -n "$NETPLAN_PORT" ]; then
  set_wol "$NETPLAN_PORT" true
  check "refused, naming netplan's file and what to add" "$NODE" -e 'const { error } = JSON.parse(process.argv[1]); process.exit(/10-netplan-.*wakeonlan: true/.test(error ?? "") ? 0 : 1);' "$WOL_RESULT"
  check "and BoxPilot's file is not left behind" [ ! -e "/etc/systemd/network/50-boxpilot-wake-on-lan-${NETPLAN_PORT}.link" ]
  check "udev still applies netplan's file" bash -c "[[ \"\$(udevadm test-builtin net_setup_link /sys/class/net/${NETPLAN_PORT} 2>&1)\" == *'10-netplan-'*'is applied'* ]]"
else
  note "no port here takes its settings from netplan; skipped"
fi

section "2. A port on systemd's default .link file"
if [ -n "$DEFAULT_PORT" ]; then
  set_wol "$DEFAULT_PORT" true
  TARGET="/etc/systemd/network/50-boxpilot-wake-on-lan-${DEFAULT_PORT}.link"
  check "turned on" "$NODE" -e 'const result = JSON.parse(process.argv[1]); process.exit(result.enabled === true && result.wakeOn === "g" ? 0 : 1);' "$WOL_RESULT"
  check "udev applies BoxPilot's file to the port" [ "$(applied_file "$DEFAULT_PORT")" = "$TARGET" ]
  check "which keeps the default's naming rules and adds WakeOnLan=magic" bash -c "grep -qx 'NamePolicy=keep kernel database onboard slot path' '$TARGET' && grep -qx 'WakeOnLan=magic' '$TARGET' && grep -qx \"MACAddress=\$(cat /sys/class/net/${DEFAULT_PORT}/address)\" '$TARGET'"
  check "the port kept its name" [ -e "/sys/class/net/${DEFAULT_PORT}" ]
  set_wol "$DEFAULT_PORT" false
  check "turned off" "$NODE" -e 'const result = JSON.parse(process.argv[1]); process.exit(result.enabled === false && result.removed === true && result.wakeOn === "d" ? 0 : 1);' "$WOL_RESULT"
  check "and the file is gone" [ ! -e "$TARGET" ]
  check "udev applies the default again" bash -c "[[ \"\$(udevadm test-builtin net_setup_link /sys/class/net/${DEFAULT_PORT} 2>&1)\" == *'99-default.link is applied'* ]]"
else
  note "no port here takes its settings from systemd's default; skipped"
fi
check "at least one of the two cases ran" [ -n "${NETPLAN_PORT}${DEFAULT_PORT}" ]

section "Result"
if [ "$FAILURES" -eq 0 ]; then echo "All checks passed"; else echo "${FAILURES} check(s) failed"; exit 1; fi
