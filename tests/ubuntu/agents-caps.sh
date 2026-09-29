#!/bin/bash
# The agents runner's hard caps on real systemd (M37): deploy/boxpilot-agents.service as shipped,
# the real runner (server/agents/runner-main.mjs), and the fake model made to burn three threads. The
# owner's requirement is that agents never make the server run hot, so this measures the unit's own
# cgroup, from the kernel's counters:
#
#   1. The unit carries the caps as shipped (CPUQuota=400%: four processors, CPUWeight=idle, Nice=19,
#      IOSchedulingClass=idle, MemoryMax=8G, loopback only), its key comes from LoadCredential, and it
#      runs as its own user.
#   2. The quota is enforced. GitHub's runners have four processors, so the shipped 400% can never be
#      reached there; the test lowers the running unit's quota to 200% (systemctl set-property
#      --runtime, a drop-in under /run that goes with the machine) and burns three threads under it:
#      the whole service - runner and model server in one cgroup - stays at or under 200%, and the
#      kernel throttled it to keep it there.
#   3. The model server is the runner's child, niced and in the idle I/O class with it.
#   4. When the run is over the runner stops the model server, and the service idles near 0%.
#
#   sudo bash tests/ubuntu/agents-caps.sh /path/to/node-24
#
# DISPOSABLE MACHINES ONLY (CI runs it on GitHub's Ubuntu VMs): it creates a system user, writes
# /opt/boxpilot, /var/lib/boxpilot/agents and a unit into /etc/systemd/system.
set -uo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run as root, on a disposable machine" >&2; exit 2; }
NODE="${1:-$(command -v node || true)}"
[ -x "$NODE" ] && [ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -ge 24 ] || { echo "pass a Node.js 24 binary as the first argument" >&2; exit 2; }
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
UNIT=boxpilot-agents.service
PORT=18787
TOKEN="$(head -c 32 /dev/urandom | base64 | tr -d '/+=\n' | cut -c1-43)"
CGROUP=/sys/fs/cgroup/system.slice/${UNIT}
# The quota section 2 enforces: below this machine's four processors and the three the busy model wants.
TEST_QUOTA=200
FAILURES=0
RESULTS=""
API_PID=""

section() { printf '\n==== %s ====\n' "$*"; }
note() { printf '    %s\n' "$*"; }
record() {
  RESULTS="${RESULTS}$1  $2"$'\n'
  printf '  %s  %s\n' "$1" "$2"
  [ "$1" = PASS ] || FAILURES=$((FAILURES + 1))
}
check() { local what="$1"; shift; if "$@"; then record PASS "$what"; else record FAIL "$what"; fi; }
state() { curl -fsS "http://127.0.0.1:${PORT}/control/state"; }
field() { state | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s)[process.argv[1]];process.stdout.write(String(v))})' "$1"; }
wait_for() { # wait_for <seconds> <command...>
  local seconds="$1"; shift
  for _ in $(seq 1 "$seconds"); do "$@" && return 0; sleep 1; done
  return 1
}
usage_usec() { awk '$1=="usage_usec"{print $2}' "${CGROUP}/cpu.stat"; }
throttled() { awk '$1=="nr_throttled"{print $2}' "${CGROUP}/cpu.stat"; }
# cpu_percent <seconds>: the service's processor use over a window, in percent of one processor.
cpu_percent() {
  local before after start end
  before="$(usage_usec)"; start="$(date +%s%N)"
  sleep "$1"
  after="$(usage_usec)"; end="$(date +%s%N)"
  awk -v u="$((after - before))" -v t="$(((end - start) / 1000))" 'BEGIN { printf "%.1f", u * 100 / t }'
}
procs() { wc -l <"${CGROUP}/cgroup.procs" | tr -d ' '; }

cleanup() {
  systemctl stop "$UNIT" >/dev/null 2>&1 || true
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null
  journalctl -u "$UNIT" -n 40 --no-pager 2>/dev/null | sed 's/^/    journal: /'
}
trap cleanup EXIT

section "Setting up the runner as it ships"
id -u boxpilot-agents >/dev/null 2>&1 || useradd --system --home-dir /var/lib/boxpilot-agents --no-create-home --shell /usr/sbin/nologin --user-group boxpilot-agents
[ -x /usr/local/bin/node ] || ln -sf "$NODE" /usr/local/bin/node
rm -rf /opt/boxpilot && install -d -m 0755 /opt/boxpilot
cp -r "${ROOT}/server" "${ROOT}/package.json" /opt/boxpilot/
chmod -R a+rX /opt/boxpilot
install -d -m 0700 /var/lib/boxpilot /var/lib/boxpilot/agents
printf '%s\n' "$TOKEN" >/var/lib/boxpilot/agents/runner.token && chmod 0600 /var/lib/boxpilot/agents/runner.token
install -m 0644 "${ROOT}/deploy/${UNIT}" "/etc/systemd/system/${UNIT}"
# The test's only change to the unit: where BoxPilot is, and the fake model made busy.
install -d "/etc/systemd/system/${UNIT}.d"
cat >"/etc/systemd/system/${UNIT}.d/cap-test.conf" <<EOF
[Service]
Environment=BOXPILOT_AGENTS_API=http://127.0.0.1:${PORT}
Environment=BOXPILOT_AGENTS_DRIVER_OVERRIDE=fake
Environment=BOXPILOT_AGENTS_FAKE_BUSY_THREADS=3
Environment=BOXPILOT_AGENTS_FAKE_BUSY_MS=30000
EOF
"$NODE" "${ROOT}/tests/ubuntu/agents-fake-api.mjs" "$PORT" "$TOKEN" >/tmp/agents-fake-api.log 2>&1 &
API_PID=$!
wait_for 20 curl -fsS "http://127.0.0.1:${PORT}/control/state" >/dev/null || { echo "the fake API did not start" >&2; cat /tmp/agents-fake-api.log; exit 1; }
systemctl daemon-reload
systemctl start "$UNIT"

section "1. The unit carries the caps"
show() { systemctl show "$UNIT" -p "$1" --value; }
# Each is a function, so a wait re-reads it every second rather than once.
weight_idle() { [ "$(show CPUWeight)" = "idle" ] || [ "$(cat "${CGROUP}/cpu.idle" 2>/dev/null)" = "1" ]; }
io_idle() { [ "$(show IOSchedulingClass)" = "3" ] || [ "$(show IOSchedulingClass)" = "idle" ]; }
said_hello() { [ "$(field hello)" = "true" ]; }
took_run() { [ "$(field claimed)" = "true" ]; }
finished() { [ "$(field finished)" = "true" ]; }
model_running() { [ "$(procs)" -ge 2 ]; }
model_stopped() { [ "$(procs)" -eq 1 ]; }
check "the shipped unit file says CPUQuota=400%" grep -qx 'CPUQuota=400%' "/etc/systemd/system/${UNIT}"
check "CPUQuota is 400% ($(show CPUQuotaPerSecUSec) a second)" [ "$(show CPUQuotaPerSecUSec)" = "4s" ]
check "CPUWeight is idle ($(show CPUWeight))" weight_idle
check "Nice is 19" [ "$(show Nice)" = "19" ]
check "IOSchedulingClass is idle ($(show IOSchedulingClass))" io_idle
check "MemoryMax is 8G ($(show MemoryMax))" [ "$(show MemoryMax)" = "$((8 * 1024 * 1024 * 1024))" ]
check "the cgroup's cpu.max is 400000 per 100000" [ "$(cut -d' ' -f1-2 "${CGROUP}/cpu.max")" = "400000 100000" ]
check "only loopback is allowed ($(show IPAddressDeny))" [ -n "$(show IPAddressDeny)" ]
check "it runs as boxpilot-agents" [ "$(show User)" = "boxpilot-agents" ]
check "the runner said hello with its key" wait_for 30 said_hello
check "no request came without the key" [ "$(field refused)" = "0" ]

section "2. Under a model that wants three processors, with the quota lowered to ${TEST_QUOTA}%"
# This machine has $(nproc) processors, so the shipped 400% cannot be reached here: the test lowers
# the running unit's quota (a runtime drop-in under /run) to prove the kernel enforces whatever it is.
systemctl set-property --runtime "$UNIT" "CPUQuota=${TEST_QUOTA}%"
check "the lowered quota is in the cgroup ($(cut -d' ' -f1-2 "${CGROUP}/cpu.max"))" [ "$(cut -d' ' -f1-2 "${CGROUP}/cpu.max")" = "$((TEST_QUOTA * 1000)) 100000" ]
curl -fsS -X POST "http://127.0.0.1:${PORT}/control/start" >/dev/null
check "the runner took the run" wait_for 30 took_run
# Give the model server time to start and the burn to begin, then measure a window inside it.
wait_for 30 model_running || true
sleep 6
THROTTLED_BEFORE="$(throttled)"
BUSY="$(cpu_percent 15)"
THROTTLED_AFTER="$(throttled)"
note "processor use under load: ${BUSY}% of one processor (the quota is ${TEST_QUOTA}%)"
check "stays at or under the ${TEST_QUOTA}% quota (${BUSY}%)" awk -v v="$BUSY" -v q="$TEST_QUOTA" 'BEGIN { exit !(v <= q + 5) }'
check "was really busy, so the quota is what held it (${BUSY}% >= $((TEST_QUOTA * 6 / 10))%)" awk -v v="$BUSY" -v q="$TEST_QUOTA" 'BEGIN { exit !(v >= q * 0.6) }'
check "the kernel throttled it ($((THROTTLED_AFTER - THROTTLED_BEFORE)) times)" [ "$((THROTTLED_AFTER - THROTTLED_BEFORE))" -gt 0 ]

section "3. The model server is the runner's child, under the same caps"
MAIN="$(show MainPID)"
CHILDREN="$(grep -vx "$MAIN" "${CGROUP}/cgroup.procs" | tr '\n' ' ')"
note "runner ${MAIN}; model server ${CHILDREN}"
check "the model server is in the runner's cgroup" [ -n "$CHILDREN" ]
for pid in $CHILDREN; do
  check "process ${pid} is niced to 19" [ "$(ps -o ni= -p "$pid" | tr -d ' ')" = "19" ]
  check "process ${pid} is in the idle I/O class" sh -c "ionice -p $pid | grep -q idle"
done

section "4. Idle"
check "the run finished" wait_for 90 finished
note "outcome: $(field outcome)"
check "the runner stopped the model server once idle" wait_for 90 model_stopped
IDLE="$(cpu_percent 30)"
note "processor use idle: ${IDLE}% of one processor"
check "idles near 0% (${IDLE}% < 2%)" awk -v v="$IDLE" 'BEGIN { exit !(v < 2) }'
MEMORY="$(cat "${CGROUP}/memory.current")"
note "memory idle: $((MEMORY / 1024 / 1024)) MiB"
check "holds little memory idle ($((MEMORY / 1024 / 1024)) MiB < 200 MiB)" [ "$MEMORY" -lt $((200 * 1024 * 1024)) ]

section "Results"
printf '%s' "$RESULTS"
printf '{"busyCpuPercent":%s,"idleCpuPercent":%s,"capPercent":400,"testQuotaPercent":%s,"idleMemoryBytes":%s}\n' "$BUSY" "$IDLE" "$TEST_QUOTA" "$MEMORY" | tee /tmp/agents-caps-results.json
[ "$FAILURES" -eq 0 ] || { echo "${FAILURES} check(s) failed" >&2; exit 1; }
