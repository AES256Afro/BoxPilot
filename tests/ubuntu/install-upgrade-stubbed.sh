#!/bin/bash
# The installer and the upgrade script, run for real by the shell production runs them under (sh,
# which is dash on Ubuntu), with every command that would change the machine replaced by a stub and
# their absolute paths moved under a scratch directory. It needs no root and touches nothing outside
# that directory, so scripts/boxpilot-upgrade.test.mjs runs it on every pull request; the install
# smoke test does the same things for real (tests/ubuntu/upgrade-db-copy.sh).
#
#   bash tests/ubuntu/install-upgrade-stubbed.sh             # the scripts under sh
#   SH=dash bash tests/ubuntu/install-upgrade-stubbed.sh     # under a shell of your choosing
#   UPGRADE_SCRIPT=a.sh INSTALL_SCRIPT=b.sh DOCTOR_SCRIPT=c.sh ...   # other copies of the scripts
#
#   1. The upgrade health-checks the port and address /etc/boxpilot/boxpilot.env gives the web
#      service. It always asked 127.0.0.1:8787, so on a box installed with --port every update
#      rolled back - after the new version had already started on the database.
#   2. An upgrade stopped by TERM or HUP once the service is down (an SSH drop during curl | sh, the
#      update unit stopped, a shutdown) rolls back and restarts the old tree, and a second TERM
#      during the rollback does not cut it short. dash runs no EXIT trap for a signal, so the old
#      script left both services stopped on the new, unchecked tree.
#   3. Re-running the installer (the documented upgrade path) with no --port or --access keeps the
#      port and access the env file holds, health-checks that port, and leaves an existing backup
#      mount point alone. It used to put 8787 and the default access back, and `install -d` on the
#      mount point woke its automount.
#   4. The host doctor, run with sudo, asks the web service where the env file says it listens.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "${HERE}/../.." && pwd)"
SH="${SH:-sh}"
UPGRADE="${UPGRADE_SCRIPT:-${REPO}/scripts/boxpilot-upgrade.sh}"
INSTALL="${INSTALL_SCRIPT:-${REPO}/scripts/boxpilot-install.sh}"
DOCTOR="${DOCTOR_SCRIPT:-${REPO}/scripts/boxpilot-doctor.sh}"
NODE_REAL="${NODE_BIN:-$(command -v node)}"
[ -n "$NODE_REAL" ] || { echo "node is required" >&2; exit 2; }
command -v perl >/dev/null 2>&1 || { echo "perl is required (it holds the stand-in helper socket)" >&2; exit 2; }

WORK="$(mktemp -d)"
FAKE="${WORK}/root"
BIN="${WORK}/bin"
STUB_LOG="${WORK}/log"
SOCKET_PID=""
cleanup() { [ -z "$SOCKET_PID" ] || kill "$SOCKET_PID" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT

failures=0
check() {
  if eval "$2"; then echo "ok   - $1"; else echo "FAIL - $1"; failures=$((failures + 1)); fi
}
show() { printf '%s\n' "$1" | sed 's/^/    | /'; }
wait_for() { local i; for i in $(seq 1 150); do [ -e "$1" ] && return 0; sleep 0.1; done; return 1; }
version_at() { sed -n 's/.*"version":"\([^"]*\)".*/\1/p' "$1/package.json" 2>/dev/null; }

# ---- Stubs. Each logs how it was called under $STUB_LOG; none reaches outside $WORK. ----
mkdir -p "$BIN"
stub() { printf '#!/bin/sh\n%s\n' "$2" > "${BIN}/$1"; chmod +x "${BIN}/$1"; }
stub node "exec \"${NODE_REAL}\" \"\$@\""
stub id 'case "${1:-}" in -u) echo 0 ;; -un) echo root ;; esac; exit 0'
stub flock 'exit 0'
stub npm 'exit 0'
stub chown 'exit 0'
stub journalctl 'exit 0'
stub sleep 'exit 0'
stub xz 'exit 0'
stub ip 'exit 0'
stub useradd 'printf "%s\n" "$*" >> "$STUB_LOG/useradd"'
stub apt-get 'echo "apt-get must not run here" >&2; exit 1'
stub sudo 'exit 1'
# Tailscale is "not running" unless a case says otherwise. Never the real one: it would publish.
stub tailscale 'printf "%s\n" "$*" >> "$STUB_LOG/tailscale"; exit 1'
# install: what it was asked to do, done without owners.
stub install 'printf "%s\n" "$*" >> "$STUB_LOG/install"
dir=0
while [ $# -gt 0 ]; do case "$1" in -d) dir=1; shift ;; -m|-o|-g) shift 2 ;; *) break ;; esac; done
if [ "$dir" -eq 1 ]; then mkdir -p "$@"; else cp "$1" "$2"; fi'
# curl: the release tarball for a download; for anything else, a health answer from the addresses
# in $STUB_LISTEN and a refused connection from every other.
stub curl 'for arg; do url="$arg"; done
case "$*" in *codeload.github.com*) exec cat "$STUB_TARBALL" ;; esac
printf "%s\n" "$url" >> "$STUB_LOG/curl"
for listening in $STUB_LISTEN; do
  if [ "$url" = "$listening" ]; then printf "{\"status\":\"ok\",\"product\":\"BoxPilot\",\"version\":\"%s\"}\n" "$STUB_VERSION"; exit 0; fi
done
exit 7'
# systemctl: logged; "<command>:<n>" in $STUB_HOLDS holds the nth such call until the harness lets
# it go, so a signal can arrive at a known point. Every unit is enabled unless $STUB_NOT_ENABLED.
stub systemctl 'printf "%s\n" "$*" >> "$STUB_LOG/systemctl"
i=0
for hold in ${STUB_HOLDS:-}; do
  i=$((i + 1))
  [ "$*" = "${hold%:*}" ] || continue
  [ "$(grep -cxF "${hold%:*}" "$STUB_LOG/systemctl")" -eq "${hold##*:}" ] || continue
  : > "$STUB_LOG/held-$i"
  while [ ! -e "$STUB_LOG/release-$i" ]; do "$STUB_SLEEP" 0.1; done
done
if [ "$1" = is-enabled ] && [ -n "${STUB_NOT_ENABLED:-}" ]; then exit 1; fi
exit 0'

# The scripts as they are, with the machine's paths moved under $FAKE (and CRLF dropped, for a
# Windows checkout).
relocate() {
  tr -d '\r' < "$1" | sed -e "s|/etc/|${FAKE}/etc/|g" -e "s|/mnt/|${FAKE}/mnt/|g" -e "s|/var/lib/|${FAKE}/var/lib/|g" \
    -e "s|/usr/local/bin/|${FAKE}/usr/local/bin/|g" -e "s|/opt/|${FAKE}/opt/|g" > "$2"
}
relocate "$UPGRADE" "${WORK}/upgrade.sh"
relocate "$INSTALL" "${WORK}/install.sh"
relocate "$DOCTOR" "${WORK}/doctor.sh"

# BoxPilot 2.0.0 as the upgrade downloads it: enough of a tree to pass its checks.
mkdir -p "${WORK}/release/BoxPilot-2.0.0/server" "${WORK}/release/BoxPilot-2.0.0/dist"
printf '{"name":"boxpilot","version":"2.0.0"}\n' > "${WORK}/release/BoxPilot-2.0.0/package.json"
: > "${WORK}/release/BoxPilot-2.0.0/server/index.mjs"
: > "${WORK}/release/BoxPilot-2.0.0/dist/index.html"
tar -czf "${WORK}/release.tar.gz" -C "${WORK}/release" BoxPilot-2.0.0

# The tree the installer downloads: its upgrade script is a stand-in that says what it was handed.
mkdir -p "${WORK}/installer/BoxPilot-2.0.0/scripts" "${WORK}/installer/BoxPilot-2.0.0/deploy"
printf '#!/bin/sh\nprintf "health=%%s\\n" "${BOXPILOT_HEALTH_URL:-}" > "$STUB_LOG/upgrade"\n' > "${WORK}/installer/BoxPilot-2.0.0/scripts/boxpilot-upgrade.sh"
tr -d '\r' < "${REPO}/deploy/boxpilot.env.example" > "${WORK}/installer/BoxPilot-2.0.0/deploy/boxpilot.env.example"
printf '{}\n' > "${WORK}/installer/BoxPilot-2.0.0/deploy/redaction.example.json"
tar -czf "${WORK}/installer.tar.gz" -C "${WORK}/installer" BoxPilot-2.0.0

# The helper's socket, which the upgrade waits to see. Relative, from $WORK: a socket's path has a
# length limit a scratch directory can exceed.
(cd "$WORK" && exec perl -MIO::Socket::UNIX -e 'IO::Socket::UNIX->new(Type => SOCK_STREAM(), Local => $ARGV[0], Listen => 1) or die "socket: $!\n"; sleep 600' helper.sock) &
SOCKET_PID=$!
wait_for "${WORK}/helper.sock" || { echo "could not make the stand-in helper socket" >&2; exit 2; }

common_env=(PATH="${BIN}:${PATH}" STUB_LOG="$STUB_LOG" STUB_SLEEP="$(command -v sleep)" STUB_VERSION=2.0.0
  BOXPILOT_NODE_BIN="${BIN}/node" BOXPILOT_UPGRADE_LOCK="${FAKE}/run/boxpilot-upgrade.lock" BOXPILOT_HELPER_SOCKET=helper.sock)

# A box running BoxPilot 1.0.0 whose env file holds $1.
fresh_box() {
  rm -rf "$FAKE" "$STUB_LOG"
  mkdir -p "${FAKE}/opt/boxpilot" "${FAKE}/etc/boxpilot" "${FAKE}/var/lib/boxpilot" "${FAKE}/run" "${FAKE}/usr/local/bin" "$STUB_LOG"
  : > "${STUB_LOG}/systemctl"
  printf '{"name":"boxpilot","version":"1.0.0"}\n' > "${FAKE}/opt/boxpilot/package.json"
  cp "${BIN}/node" "${FAKE}/usr/local/bin/node"
  : > "${FAKE}/etc/debian_version"
  if [ -n "$1" ]; then printf '%b\n' "$1" > "${FAKE}/etc/boxpilot/boxpilot.env"; fi
}

# run_upgrade [VAR=value ...]: sets out and status.
run_upgrade() {
  out="$(cd "$WORK" && env "${common_env[@]}" STUB_TARBALL="${WORK}/release.tar.gz" "$@" "$SH" "${WORK}/upgrade.sh" v2.0.0 2>&1)"; status=$?
}
# run_install <listening URL> [installer options]: sets out and status.
run_install() {
  local listen="$1"; shift
  out="$(cd "$WORK" && env "${common_env[@]}" STUB_TARBALL="${WORK}/installer.tar.gz" STUB_LISTEN="$listen" "$SH" "${WORK}/install.sh" --ref v2.0.0 --no-token "$@" 2>&1)"; status=$?
}
env_line() { grep -x "$1=.*" "${FAKE}/etc/boxpilot/boxpilot.env" | tail -n 1; }

echo "1. The upgrade health-checks the web service where its env file says it listens"
upgrade_case() { # upgrade_case <what> <env file> <the URL that answers> [VAR=value ...]
  local what="$1" envfile="$2"; want="$3"; shift 3
  fresh_box "$envfile"
  run_upgrade STUB_LISTEN="$want" "$@"
  show "$out"
  check "${what}: the upgrade went live" '[ "$status" -eq 0 ] && grep -q "BoxPilot 2.0.0 (v2.0.0) is live" <<<"$out"'
  check "${what}: it asked ${want} and nothing else" '[ "$(sort -u "${STUB_LOG}/curl" 2>/dev/null)" = "$want" ]'
  check "${what}: it did not roll back" '! grep -q "rolling back" <<<"$out" && [ "$(version_at "${FAKE}/opt/boxpilot")" = 2.0.0 ]'
}
upgrade_case "installed with --port 9000" 'BOXPILOT_HOST=127.0.0.1\nBOXPILOT_PORT=9000' http://127.0.0.1:9000/api/v1/health
upgrade_case "on the LAN, port quoted" 'BOXPILOT_HOST="0.0.0.0"\nBOXPILOT_PORT="9001"' http://127.0.0.1:9001/api/v1/health
upgrade_case "bound to one address" 'BOXPILOT_HOST=192.0.2.10\nBOXPILOT_PORT=9002' http://192.0.2.10:9002/api/v1/health
upgrade_case "no port in the env file" 'BOXPILOT_HOST=127.0.0.1' http://127.0.0.1:8787/api/v1/health
upgrade_case "BOXPILOT_HEALTH_URL given" 'BOXPILOT_PORT=9000' http://127.0.0.1:9100/api/v1/health BOXPILOT_HEALTH_URL=http://127.0.0.1:9100/api/v1/health

echo "2. An upgrade stopped by a signal once the service is down rolls back and restarts the old tree"
signal_case() { # signal_case <what> <signal> <TERM again during the rollback: yes|no>
  local what="$1" signal="$2" again="$3" holds="daemon-reload:1" pid
  [ "$again" = no ] || holds="daemon-reload:1 daemon-reload:2"
  fresh_box 'BOXPILOT_PORT=8787'
  (cd "$WORK" && exec env "${common_env[@]}" STUB_TARBALL="${WORK}/release.tar.gz" STUB_LISTEN=http://127.0.0.1:8787/api/v1/health STUB_HOLDS="$holds" "$SH" "${WORK}/upgrade.sh" v2.0.0 > "${WORK}/out" 2>&1) &
  pid=$!
  # The first daemon-reload: the service is stopped and the new tree is in place, not yet started.
  if wait_for "${STUB_LOG}/held-1"; then kill "-${signal}" "$pid"; fi
  : > "${STUB_LOG}/release-1"
  if [ "$again" = yes ]; then
    # The rollback's own daemon-reload: a second signal while it is putting the old tree back.
    if wait_for "${STUB_LOG}/held-2"; then kill -TERM "$pid"; fi
    : > "${STUB_LOG}/release-2"
  fi
  wait "$pid"; status=$?
  out="$(cat "${WORK}/out")"
  show "$out"
  check "${what}: the upgrade exited non-zero" '[ "$status" -ne 0 ]'
  check "${what}: it rolled back" 'grep -q "rolling back to previous tree" <<<"$out"'
  check "${what}: the old tree is back in place" '[ "$(version_at "${FAKE}/opt/boxpilot")" = 1.0.0 ]'
  check "${what}: the new tree is kept as evidence" 'ls -d "${FAKE}"/opt/boxpilot.failed.* >/dev/null 2>&1'
  # After the last daemon-reload: the rollback's restarts, which the old script never reached.
  check "${what}: it restarted the old helper and web service" 'sed -n "$(grep -nx daemon-reload "${STUB_LOG}/systemctl" | tail -n 1 | cut -d: -f1),\$p" "${STUB_LOG}/systemctl" | grep -qx "restart boxpilot-helper.service" &&
    sed -n "$(grep -nx daemon-reload "${STUB_LOG}/systemctl" | tail -n 1 | cut -d: -f1),\$p" "${STUB_LOG}/systemctl" | grep -qx "restart boxpilot.service"'
}
signal_case "TERM" TERM no
signal_case "HUP (the SSH session dropped)" HUP no
signal_case "TERM, then TERM again during the rollback" TERM yes

echo "3. Re-running the installer keeps the port and access the env file holds"
example="$(tr -d '\r' < "${REPO}/deploy/boxpilot.env.example")"
backup_touched() { grep -q "mnt/boxpilot/backup" "${STUB_LOG}/install" 2>/dev/null; }

fresh_box ""
rm -rf "${FAKE}/etc/boxpilot" "${FAKE}/mnt"
run_install http://127.0.0.1:9000/api/v1/health --port 9000 --access lan
show "$out"
check "fresh install with --port 9000 --access lan: it finished" '[ "$status" -eq 0 ] && grep -q "BoxPilot is installed and running" <<<"$out"'
check "fresh install: the env file has port 9000 on every address, cookies not https-only" '[ "$(env_line BOXPILOT_PORT)" = BOXPILOT_PORT=9000 ] && [ "$(env_line BOXPILOT_HOST)" = BOXPILOT_HOST=0.0.0.0 ] && [ "$(env_line BOXPILOT_COOKIE_SECURE)" = BOXPILOT_COOKIE_SECURE=false ]'
check "fresh install: it checked port 9000" 'grep -qx "http://127.0.0.1:9000/api/v1/health" "${STUB_LOG}/curl"'
check "fresh install: it made the backup mount point" 'backup_touched && [ -d "${FAKE}/mnt/boxpilot/backup" ]'

# A Tailscale install on port 9000 whose owner then turned on the LAN in Settings.
fresh_box "${example}"
sed -i -e 's/^BOXPILOT_PORT=.*/BOXPILOT_PORT=9000/' -e 's/^BOXPILOT_HOST=.*/BOXPILOT_HOST=0.0.0.0/' "${FAKE}/etc/boxpilot/boxpilot.env"
mkdir -p "${FAKE}/mnt/boxpilot/backup"
run_install http://127.0.0.1:9000/api/v1/health
show "$out"
check "re-run, no options: it finished" '[ "$status" -eq 0 ] && grep -q "BoxPilot is installed and running" <<<"$out"'
check "re-run: the port stays 9000" '[ "$(env_line BOXPILOT_PORT)" = BOXPILOT_PORT=9000 ]'
check "re-run: the LAN choice made in Settings stays" '[ "$(env_line BOXPILOT_HOST)" = BOXPILOT_HOST=0.0.0.0 ]'
check "re-run: cookies stay https-only, as the Tailscale install set them" '[ "$(env_line BOXPILOT_COOKIE_SECURE)" = BOXPILOT_COOKIE_SECURE=true ]'
check "re-run: the upgrade was told to check port 9000" 'grep -qx "health=http://127.0.0.1:9000/api/v1/health" "${STUB_LOG}/upgrade"'
check "re-run: it checked port 9000 and nothing else" '[ "$(sort -u "${STUB_LOG}/curl" 2>/dev/null)" = http://127.0.0.1:9000/api/v1/health ]'
check "re-run: it left the existing backup mount point alone" '! backup_touched'

# Installed with --access local: loopback, reached over an SSH tunnel. No Tailscale running.
fresh_box "${example}"
sed -i -e 's/^BOXPILOT_COOKIE_SECURE=.*/BOXPILOT_COOKIE_SECURE=false/' "${FAKE}/etc/boxpilot/boxpilot.env"
mkdir -p "${FAKE}/mnt/boxpilot/backup"
run_install http://127.0.0.1:8787/api/v1/health
show "$out"
check "re-run of a local install: it finished" '[ "$status" -eq 0 ]'
check "re-run of a local install: it stays on loopback, not the LAN" '[ "$(env_line BOXPILOT_HOST)" = BOXPILOT_HOST=127.0.0.1 ] && [ "$(env_line BOXPILOT_COOKIE_SECURE)" = BOXPILOT_COOKIE_SECURE=false ]'

# A new --port on a re-run: the upgrade restarts the service on the port it has now, and the new
# one is written after it.
fresh_box "${example}"
sed -i -e 's/^BOXPILOT_PORT=.*/BOXPILOT_PORT=9000/' -e 's/^BOXPILOT_COOKIE_SECURE=.*/BOXPILOT_COOKIE_SECURE=false/' "${FAKE}/etc/boxpilot/boxpilot.env"
mkdir -p "${FAKE}/mnt/boxpilot/backup"
run_install http://127.0.0.1:9100/api/v1/health --port 9100
show "$out"
check "re-run with --port 9100: it finished" '[ "$status" -eq 0 ]'
check "re-run with --port 9100: the upgrade checked the port the service still had" 'grep -qx "health=http://127.0.0.1:9000/api/v1/health" "${STUB_LOG}/upgrade"'
check "re-run with --port 9100: the env file says 9100 and the access is kept" '[ "$(env_line BOXPILOT_PORT)" = BOXPILOT_PORT=9100 ] && [ "$(env_line BOXPILOT_HOST)" = BOXPILOT_HOST=127.0.0.1 ]'
check "re-run with --port 9100: it checked 9100 at the end" '[ "$(tail -n 1 "${STUB_LOG}/curl")" = http://127.0.0.1:9100/api/v1/health ]'

# A first install that stopped before it finished (the service never enabled) left the example's
# env file: running it again is still a first install, with the default access.
fresh_box "${example}"
STUB_NOT_ENABLED=1 run_install http://127.0.0.1:8787/api/v1/health
show "$out"
check "first install run again after it stopped early: it finished" '[ "$status" -eq 0 ]'
check "first install run again: it takes the default access (no Tailscale: the LAN), not the example's" '[ "$(env_line BOXPILOT_HOST)" = BOXPILOT_HOST=0.0.0.0 ] && [ "$(env_line BOXPILOT_COOKIE_SECURE)" = BOXPILOT_COOKIE_SECURE=false ]'

# --access on a re-run still changes it.
fresh_box "${example}"
sed -i -e 's/^BOXPILOT_PORT=.*/BOXPILOT_PORT=9000/' "${FAKE}/etc/boxpilot/boxpilot.env"
mkdir -p "${FAKE}/mnt/boxpilot/backup"
run_install http://127.0.0.1:9000/api/v1/health --access lan
show "$out"
check "re-run with --access lan: it finished on the port it had" '[ "$status" -eq 0 ] && [ "$(env_line BOXPILOT_PORT)" = BOXPILOT_PORT=9000 ]'
check "re-run with --access lan: the LAN is what it asked for" '[ "$(env_line BOXPILOT_HOST)" = BOXPILOT_HOST=0.0.0.0 ] && [ "$(env_line BOXPILOT_COOKIE_SECURE)" = BOXPILOT_COOKIE_SECURE=false ]'

echo "4. The host doctor, run with sudo, checks the web service where its env file says it listens"
fresh_box 'BOXPILOT_HOST=0.0.0.0\nBOXPILOT_PORT=9000'
out="$(cd "$WORK" && env "${common_env[@]}" STUB_LISTEN=http://127.0.0.1:9000/api/v1/health "$SH" "${WORK}/doctor.sh" 2>&1)"
show "$(grep -i "health" <<<"$out")"
check "installed with --port 9000: the doctor finds it answering on 9000" 'grep -q "^\[PASS\] BoxPilot health endpoint responds at 127.0.0.1:9000" <<<"$out"'
check "it asked port 9000 and nothing else" '[ "$(sort -u "${STUB_LOG}/curl" 2>/dev/null)" = http://127.0.0.1:9000/api/v1/health ]'

if [ "$failures" -gt 0 ]; then echo "${failures} check(s) failed"; exit 1; fi
echo "all checks passed"
