#!/bin/bash
# The port check an app runs before `compose up`, on a real host: the listeners read by the root
# task in boxpilot-run@ exactly as the helper asks for them, and real Docker publishing ports.
#
#   sudo bash tests/ubuntu/port-preflight.sh /path/to/node-24
#
# DISPOSABLE MACHINES ONLY (CI runs it on GitHub's Ubuntu VMs): it adds a dummy network interface,
# installs boxpilot-run@.service and runs containers. The repository needs its npm dependencies.
#
# Dockge on the owner's server published 0.0.0.0:5001 while Tailscale Serve held 100.x.y.z:5001 for
# the same app, and Start failed inside Docker with "address already in use". Tailscale is not on the
# runner: a Python web server bound to a tailnet-range address on a dummy interface stands in for
# tailscaled, the way tailscaled listens on the tailnet address for each port Serve publishes.
#
#   1. The trap is the kernel's: Docker cannot publish 0.0.0.0:5001 while 100.64.0.10:5001 is held,
#      and can publish 127.0.0.1:5001 beside it.
#   2. host.listeners, run in boxpilot-run@, sees that socket and names its process.
#   3. The app helper's Start refuses before `compose up`, naming the holder; nothing is created.
#   4. With the stand-in named tailscaled and Serve publishing the port: the sentence the owner gets.
#   5. Published on 127.0.0.1 instead (Repair's "Serve Dockge only through Tailscale"), Start works
#      and the app and the stand-in both answer on the same port number.
set -uo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run as root, on a disposable machine" >&2; exit 2; }
NODE="${1:-$(command -v node || true)}"
[ -x "$NODE" ] && [ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -ge 24 ] || { echo "pass a Node.js 24 binary as the first argument" >&2; exit 2; }
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
[ -d "${ROOT}/node_modules/yaml" ] || { echo "run npm ci in ${ROOT} first" >&2; exit 2; }
ADDRESS=100.64.0.10            # a tailnet-range address, as `tailscale ip -4` would give
PORT=5001
LINK=bp-tailnet0
IMAGE=bp-busybox
WORK="$(mktemp -d /var/tmp/bp-port-test.XXXXXX)"
STAND_IN=""
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
field() { "$NODE" -p "const value = JSON.parse(process.argv[1]); String(value.${1})" "$2"; }

cleanup() {
  [ -n "$STAND_IN" ] && kill "$STAND_IN" 2>/dev/null
  docker rm -f bp-dockge bp-trap bp-beside >/dev/null 2>&1
  ip link del "$LINK" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

# stand_in [tailscaled]: a web server on the tailnet-range address. Named tailscaled, it sets its
# own process name the way ss -p reads it (PR_SET_NAME), so it is taken for Tailscale.
stand_in() {
  if [ -n "$STAND_IN" ]; then kill "$STAND_IN" 2>/dev/null; wait "$STAND_IN" 2>/dev/null; STAND_IN=""; fi
  if [ "${1:-}" = tailscaled ]; then
    python3 -c "import ctypes, http.server
ctypes.CDLL(None).prctl(15, b'tailscaled', 0, 0, 0)
http.server.ThreadingHTTPServer(('${ADDRESS}', ${PORT}), http.server.SimpleHTTPRequestHandler).serve_forever()" >/dev/null 2>&1 &
  else
    python3 -m http.server --bind "$ADDRESS" "$PORT" >/dev/null 2>&1 &
  fi
  STAND_IN=$!
  for _ in $(seq 1 50); do ss -H -l -n -t "src ${ADDRESS}:${PORT}" | grep -q . && break; sleep 0.1; done
  note "stand-in: $(ss -H -l -n -t -p "src ${ADDRESS}:${PORT}" | tr -s ' ')"
}

# start_app <bind> [served]: the helper's Start of the app, published on <bind>:PORT. Sets OUTCOME.
start_app() {
  OUTCOME="$("$NODE" "${ROOT}/tests/ubuntu/port-preflight.mjs" "${WORK}/catalog" "$1" "$PORT" "$IMAGE" "${2:-}" | tail -n 1)"
  note "outcome: ${OUTCOME}"
}

section "Prepare: $(uname -r), $(docker --version), $(ss --version 2>&1 | head -n 1)"
ip link add "$LINK" type dummy && ip addr add "${ADDRESS}/32" dev "$LINK" && ip link set "$LINK" up
note "$(ip -brief address show "$LINK")"
# boxpilot-run@.service as shipped, but for where node is: the runner's is under the tool cache.
install -d -m 0755 /opt/boxpilot
cp -r "${ROOT}/server" "${ROOT}/scripts" "${ROOT}/package.json" /opt/boxpilot/
sed -e "s|/usr/local/bin/node|${NODE}|g" "${ROOT}/deploy/boxpilot-run@.service" > /etc/systemd/system/boxpilot-run@.service
install -d -m 0700 /run/boxpilot /run/boxpilot/run
systemctl daemon-reload
docker pull -q mirror.gcr.io/library/busybox:1.36 >/dev/null && docker tag mirror.gcr.io/library/busybox:1.36 "$IMAGE"
install -d -m 0700 "${WORK}/catalog" "${WORK}/backups"

section "1. The trap is the kernel's: a port held on one address blocks a publish on every address"
stand_in
trap_out="$(docker run -d --name bp-trap -p "0.0.0.0:${PORT}:80" "$IMAGE" httpd -f -p 80 2>&1)"; trap_status=$?
note "docker run -p 0.0.0.0:${PORT}:80: ${trap_out}"
check "Docker cannot publish 0.0.0.0:${PORT} while ${ADDRESS}:${PORT} is held" [ "$trap_status" -ne 0 ]
check "and says only \"address already in use\"" contains "$trap_out" "address already in use"
docker rm -f bp-trap >/dev/null 2>&1
beside_out="$(docker run -d --name bp-beside -p "127.0.0.1:${PORT}:80" "$IMAGE" httpd -f -p 80 -h /etc 2>&1)"; beside_status=$?
note "docker run -p 127.0.0.1:${PORT}:80: ${beside_out}"
check "Docker publishes 127.0.0.1:${PORT} beside it: two addresses do not collide" [ "$beside_status" -eq 0 ]
docker rm -f bp-beside >/dev/null 2>&1

section "2. host.listeners in boxpilot-run@, as the helper asks for it"
listed="$("$NODE" --input-type=module -e "
  import { createRunUnitClient } from '${ROOT}/server/run-unit.mjs';
  const { listeners } = await createRunUnitClient().runTask('host.listeners', {}, { timeoutMs: 30000 });
  console.log(JSON.stringify(listeners.find((entry) => entry.address === '${ADDRESS}' && entry.port === ${PORT}) ?? null));
" 2>&1 | tail -n 1)"
note "listener: ${listed}"
check "it lists ${ADDRESS}:${PORT}" contains "$listed" "\"address\":\"${ADDRESS}\""
check "and names the process holding it" contains "$listed" "\"name\":\"python3\""

section "3. Start refuses before compose up, naming the holder"
start_app 0.0.0.0
check "Start is refused" [ "$(field started "$OUTCOME")" = false ]
check "as a port conflict" [ "$(field code "$OUTCOME")" = port_conflict ]
check "naming the address and the process" contains "$(field message "$OUTCOME")" "Dockge was not started. Port ${PORT} is taken on the tailnet address (${ADDRESS}) by process python3 (pid ${STAND_IN})"
check "without Docker's sentence" bash -c '! grep -q "address already in use" <<<"$1"' _ "$(field message "$OUTCOME")"
check "and nothing was created" bash -c '! docker container inspect bp-dockge >/dev/null 2>&1'

section "4. The stand-in named tailscaled, and Serve publishing the port: the owner's case"
stand_in tailscaled
start_app 0.0.0.0 served
check "Start is refused" [ "$(field started "$OUTCOME")" = false ]
check "naming Tailscale Serve and the app it publishes" contains "$(field message "$OUTCOME")" "Port ${PORT} is taken on the tailnet address (${ADDRESS}) by Tailscale Serve, which publishes Dockge itself at https://homebox.tailXXXX.ts.net:${PORT}"
check "and saying what to do" contains "$(field message "$OUTCOME")" "Serve Dockge only through Tailscale"
check "and nothing was created" bash -c '! docker container inspect bp-dockge >/dev/null 2>&1'

section "5. On 127.0.0.1 instead, where Serve reaches it: Start works and both answer"
start_app 127.0.0.1 served
check "Start builds and starts it" [ "$(field started "$OUTCOME")" = true ]
check "its container is running" [ "$(docker inspect -f '{{.State.Running}}' bp-dockge 2>/dev/null)" = true ]
app_answer="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${PORT}/")"
stand_answer="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://${ADDRESS}:${PORT}/")"
note "127.0.0.1:${PORT} answered ${app_answer}; ${ADDRESS}:${PORT} answered ${stand_answer}"
check "the app answers on 127.0.0.1:${PORT}" [ "$app_answer" != 000 ]
check "and the stand-in still answers on ${ADDRESS}:${PORT}" [ "$stand_answer" = 200 ]

section "Summary"
printf '%s' "$RESULTS"
[ "$FAILURES" -eq 0 ] && echo "All checks passed." || echo "${FAILURES} check(s) failed."
exit "$FAILURES"
