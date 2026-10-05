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
#      rolled back - after the new version had already started on the database. The file is read
#      the way systemd reads it: CRLF, blanks around "=" and trailing blanks are not part of a value,
#      the last line for a key wins, a # after a value is part of it, a quote runs to its match
#      (over lines if need be) and what follows it is part of the value, a line like `export KEY=`
#      is ignored. The port is taken as the service takes it, with parseInt: `9000 # moved` is 9000.
#   2. An upgrade stopped by TERM or HUP once the service is down (an SSH drop during curl | sh, the
#      update unit stopped, a shutdown) rolls back and restarts the old tree, and a second TERM
#      during the rollback does not cut it short. dash runs no EXIT trap for a signal, so the old
#      script left both services stopped on the new, unchecked tree.
#   3. The same when nobody reads its output any more (the terminal or the pipe it wrote to gone):
#      the rollback's first line used to kill it (SIGPIPE, or a failed printf under set -e), and the
#      line relaying the backup-destination move started a rollback that died the same way.
#   4. Re-running the installer (the documented upgrade path) with no --port or --access keeps the
#      port and access the env file holds, health-checks that port, and leaves an existing backup
#      mount point alone. It used to put 8787 and the default access back, and `install -d` on the
#      mount point woke its automount. A --port outside 1024-65535 is refused before anything
#      changes; a new --port or --access is written before the upgrade and checked there, and the
#      env file is put back if the box does not come up on it; a LAN address opens the port in ufw.
#   5. The host doctor, run with sudo, asks the web service where the env file says it listens.
#   6. An installer re-run stopped by HUP (the SSH session dropped), during the build or once the
#      upgrade has stopped the service, puts the env file back and restarts BoxPilot on it.
#   7. An upgrade stopped during its build (HUP, TERM) removes its staging tree, and the next upgrade
#      removes one an earlier run left.
#   8. A new --port re-points Tailscale Serve wherever BoxPilot is published through it, even on a
#      Tailscale install whose owner has since turned on the LAN.
#   9. A rollback checks the old tree went back and asks the restarted service, and says what it
#      found: back and answering, back and silent, or not back (and where both trees are).
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
command -v mkfifo >/dev/null 2>&1 || { echo "mkfifo is required (it stands in for a terminal that goes away)" >&2; exit 2; }

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
# npm: does nothing, but holds `npm ci` (the build) until the harness lets it go when $STUB_NPM_HOLD is set.
stub npm 'if [ -n "${STUB_NPM_HOLD:-}" ] && [ "${1:-}" = ci ]; then
  : > "$STUB_LOG/npm-held"
  while [ ! -e "$STUB_LOG/npm-release" ]; do "$STUB_SLEEP" 0.1; done
fi
exit 0'
stub chown 'exit 0'
stub journalctl 'exit 0'
stub sleep 'exit 0'
stub xz 'exit 0'
stub ip 'exit 0'
stub useradd 'printf "%s\n" "$*" >> "$STUB_LOG/useradd"'
stub apt-get 'echo "apt-get must not run here" >&2; exit 1'
stub sudo 'exit 1'
# Tailscale is "not running" unless $STUB_TAILSCALE says "running". Never the real one: it would publish.
stub tailscale 'printf "%s\n" "$*" >> "$STUB_LOG/tailscale"; [ "${STUB_TAILSCALE:-}" = running ]'
# ufw: logged, and inactive unless $STUB_UFW says "active". Never the real one: it would open ports.
stub ufw 'printf "%s\n" "$*" >> "$STUB_LOG/ufw"
case "${1:-}" in status) echo "Status: ${STUB_UFW:-inactive}" ;; esac
exit 0'
# install: what it was asked to do, done without owners.
stub install 'printf "%s\n" "$*" >> "$STUB_LOG/install"
dir=0
while [ $# -gt 0 ]; do case "$1" in -d) dir=1; shift ;; -m|-o|-g) shift 2 ;; *) break ;; esac; done
if [ "$dir" -eq 1 ]; then mkdir -p "$@"; else cp "$1" "$2"; fi'
# curl: the release tarball for a download; for anything else, a health answer from the addresses
# in $STUB_LISTEN and a refused connection from every other. The answer names $STUB_VERSION, or with
# $STUB_TREE set, the version of the tree there (none there, nothing answers): the service answers
# as whichever version is in place.
stub curl 'for arg; do url="$arg"; done
case "$*" in *codeload.github.com*) exec cat "$STUB_TARBALL" ;; esac
printf "%s\n" "$url" >> "$STUB_LOG/curl"
version="$STUB_VERSION"
if [ -n "${STUB_TREE:-}" ]; then
  version="$(sed -n "s/.*\"version\":\"\([^\"]*\)\".*/\1/p" "$STUB_TREE/package.json" 2>/dev/null)"
  [ -n "$version" ] || exit 7
fi
for listening in $STUB_LISTEN; do
  if [ "$url" = "$listening" ]; then printf "{\"status\":\"ok\",\"product\":\"BoxPilot\",\"version\":\"%s\"}\n" "$version"; exit 0; fi
done
exit 7'
# mv: the real one, except that with $STUB_MV_FAIL=prev moving a previous tree (.prev.) fails, as a
# read-only or broken /opt would make it.
MV_REAL="$(command -v mv)"
stub mv "if [ \"\${STUB_MV_FAIL:-}\" = prev ]; then
  case \"\${1:-}\" in *.prev.*) echo \"mv: cannot move '\$1': Read-only file system\" >&2; exit 1 ;; esac
fi
exec \"${MV_REAL}\" \"\$@\""
# systemctl: logged; "<command>:<n>" in $STUB_HOLDS holds the nth such call until the harness lets
# it go, so a signal can arrive at a known point. Every unit is enabled unless $STUB_NOT_ENABLED.
# Each restart of the web service also logs the port the env file gives it then.
stub systemctl 'printf "%s\n" "$*" >> "$STUB_LOG/systemctl"
if [ "$*" = "restart boxpilot.service" ]; then
  { grep "BOXPILOT_PORT" "$STUB_ENV_FILE" 2>/dev/null | tail -n 1; } >> "$STUB_LOG/web-restarts"
fi
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

# The same release with the script that moves the backup destination (step 6 of the upgrade). It
# says what it did, as the real one does, and records each move and undo; /etc/fstab is never read.
mkdir -p "${WORK}/release-move"
cp -R "${WORK}/release/BoxPilot-2.0.0" "${WORK}/release-move/"
mkdir -p "${WORK}/release-move/BoxPilot-2.0.0/scripts"
cat > "${WORK}/release-move/BoxPilot-2.0.0/scripts/boxpilot-backup-mount-move.mjs" <<'MJS'
import { appendFileSync } from "node:fs";
const record = (line) => appendFileSync(`${process.env.STUB_LOG}/mount-move`, `${line}\n`);
if (process.argv[2] === "undo") {
  record(`undo ${process.argv[3]}`);
  console.log(`put the backup destination back from ${process.argv[3]}`);
} else {
  record("move");
  console.log("moved the backup destination from /mnt/boxpilot-backup to /mnt/boxpilot/backup");
  console.log("fstab-copy=/etc/fstab.boxpilot-stub");
}
MJS
tar -czf "${WORK}/release-move.tar.gz" -C "${WORK}/release-move" BoxPilot-2.0.0

# The tree the installer downloads: its upgrade script is a stand-in that says what it was handed
# and, like the real one, fails when the service it restarts does not answer there once enabled.
mkdir -p "${WORK}/installer/BoxPilot-2.0.0/scripts" "${WORK}/installer/BoxPilot-2.0.0/deploy"
cat > "${WORK}/installer/BoxPilot-2.0.0/scripts/boxpilot-upgrade.sh" <<'UPGRADE'
#!/bin/sh
printf 'health=%s\n' "${BOXPILOT_HEALTH_URL:-}" > "$STUB_LOG/upgrade"
systemctl is-enabled boxpilot.service >/dev/null 2>&1 || exit 0
curl -fsS --max-time 3 "${BOXPILOT_HEALTH_URL:-}" >/dev/null 2>&1 && exit 0
echo "[boxpilot-upgrade] health check at ${BOXPILOT_HEALTH_URL:-} failed; rolled back" >&2
exit 1
UPGRADE
tr -d '\r' < "${REPO}/deploy/boxpilot.env.example" > "${WORK}/installer/BoxPilot-2.0.0/deploy/boxpilot.env.example"
printf '{}\n' > "${WORK}/installer/BoxPilot-2.0.0/deploy/redaction.example.json"
tar -czf "${WORK}/installer.tar.gz" -C "${WORK}/installer" BoxPilot-2.0.0

# The same download with the real upgrade script in it (moved under $FAKE like the others) and the
# release it builds: for what the two scripts do together when they are stopped part way.
mkdir -p "${WORK}/installer-real"
cp -R "${WORK}/release/BoxPilot-2.0.0" "${WORK}/installer-real/"
cp -R "${WORK}/installer/BoxPilot-2.0.0/deploy" "${WORK}/installer-real/BoxPilot-2.0.0/"
mkdir -p "${WORK}/installer-real/BoxPilot-2.0.0/scripts"
cp "${WORK}/upgrade.sh" "${WORK}/installer-real/BoxPilot-2.0.0/scripts/boxpilot-upgrade.sh"
tar -czf "${WORK}/installer-real.tar.gz" -C "${WORK}/installer-real" BoxPilot-2.0.0

# The helper's socket, which the upgrade waits to see. Relative, from $WORK: a socket's path has a
# length limit a scratch directory can exceed.
(cd "$WORK" && exec perl -MIO::Socket::UNIX -e 'IO::Socket::UNIX->new(Type => SOCK_STREAM(), Local => $ARGV[0], Listen => 1) or die "socket: $!\n"; sleep 600' helper.sock) &
SOCKET_PID=$!
wait_for "${WORK}/helper.sock" || { echo "could not make the stand-in helper socket" >&2; exit 2; }

common_env=(PATH="${BIN}:${PATH}" STUB_LOG="$STUB_LOG" STUB_SLEEP="$(command -v sleep)" STUB_VERSION=2.0.0
  STUB_ENV_FILE="${FAKE}/etc/boxpilot/boxpilot.env" BOXPILOT_NODE_BIN="${BIN}/node" BOXPILOT_UPGRADE_LOCK="${FAKE}/run/boxpilot-upgrade.lock" BOXPILOT_HELPER_SOCKET=helper.sock)

# A box running BoxPilot 1.0.0 whose env file holds $1 (printf %b: \r, \t and \n are written as such).
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
# After the last daemon-reload: the rollback's restarts.
restarted_after_rollback() {
  local from
  from="$(grep -nx daemon-reload "${STUB_LOG}/systemctl" | tail -n 1 | cut -d: -f1)"
  [ -n "$from" ] && sed -n "${from},\$p" "${STUB_LOG}/systemctl" | grep -qx "restart boxpilot-helper.service" &&
    sed -n "${from},\$p" "${STUB_LOG}/systemctl" | grep -qx "restart boxpilot.service"
}

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
# systemd reads these the same as the plain lines: \r ends a line, blanks around = and after an
# unquoted value are dropped.
upgrade_case "CRLF, blanks around = and after the value" 'BOXPILOT_HOST = 192.0.2.10 \r\n  BOXPILOT_PORT= 9003\t\r' http://192.0.2.10:9003/api/v1/health
upgrade_case "CRLF, quoted after a blank" 'BOXPILOT_HOST = "0.0.0.0"\r\nBOXPILOT_PORT = "9004" \r' http://127.0.0.1:9004/api/v1/health
# The last line for a key is the one systemd gives the service (server/env-file.mjs reads it the same).
upgrade_case "a leading blank line, a port overridden further down" '\nBOXPILOT_PORT=8787\n# moved\n  BOXPILOT_PORT = 9006' http://127.0.0.1:9006/api/v1/health
# EnvironmentFile= has no inline comments: systemd gives the service `9000   # moved off 8787`, and
# the service takes the port with parseInt (9000). The upgrade asked
# `http://127.0.0.1:9000   # moved off 8787/api/v1/health` and rolled back a version already running.
upgrade_case "an inline comment after the port" 'BOXPILOT_HOST=127.0.0.1\nBOXPILOT_PORT=9000   # moved off 8787' http://127.0.0.1:9000/api/v1/health
# Quoted, what follows the closing quote is part of the value too: systemd gives `9001# web`.
upgrade_case "a quoted port with a comment after it" 'BOXPILOT_PORT="9001" # web' http://127.0.0.1:9001/api/v1/health
upgrade_case "CRLF, a comment after the port" 'BOXPILOT_HOST = 192.0.2.10\r\nBOXPILOT_PORT=9008 ; moved\r' http://192.0.2.10:9008/api/v1/health
upgrade_case "duplicates, the last with a comment" 'BOXPILOT_PORT=8787\nBOXPILOT_PORT = 9009 # moved' http://127.0.0.1:9009/api/v1/health
# systemd ignores a line whose name is not a variable name, `export BOXPILOT_PORT` among them.
upgrade_case "an export line after the port" 'BOXPILOT_PORT=9007\nexport BOXPILOT_PORT=9100' http://127.0.0.1:9007/api/v1/health
# A quote left open runs to the end of the file: the BOXPILOT_HOST line below it is part of the port.
upgrade_case "a quote left open" 'BOXPILOT_HOST=192.0.2.10\nBOXPILOT_PORT="9010\nBOXPILOT_HOST=0.0.0.0' http://192.0.2.10:9010/api/v1/health
upgrade_case "an empty address" 'BOXPILOT_HOST=\nBOXPILOT_PORT=9011' http://127.0.0.1:9011/api/v1/health
# Not a port at all: the service listens on 8787, as every other reader says.
upgrade_case "a port that is no number" 'BOXPILOT_PORT=web' http://127.0.0.1:8787/api/v1/health

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
  check "${what}: it restarted the old helper and web service" 'restarted_after_rollback'
}
signal_case "TERM" TERM no
signal_case "HUP (the SSH session dropped)" HUP no
signal_case "TERM, then TERM again during the rollback" TERM yes

echo "3. The same when nobody reads its output any more"
# pipe_case <what> <signal sent once the reader is gone, or none> <SIGPIPE on entry: default|ignored>
#           <release tarball> <expected: rollback|live>
# The upgrade writes into a FIFO, as into a terminal or a `| tee` that goes away; the reader is
# killed at the first daemon-reload (the service stopped, the new tree in place), then the signal.
# systemd starts a unit (the System page's update) with SIGPIPE ignored, so writes fail instead.
pipe_case() {
  local what="$1" signal="$2" sigpipe="$3" tarball="$4" expected="$5" pid reader
  fresh_box 'BOXPILOT_PORT=8787'
  rm -f "${WORK}/fifo" "${WORK}/out"; mkfifo "${WORK}/fifo"
  cat "${WORK}/fifo" > "${WORK}/out" &
  reader=$!
  (
    if [ "$sigpipe" = ignored ]; then trap '' PIPE; fi
    cd "$WORK" && exec env "${common_env[@]}" STUB_TARBALL="$tarball" STUB_LISTEN=http://127.0.0.1:8787/api/v1/health STUB_HOLDS=daemon-reload:1 "$SH" "${WORK}/upgrade.sh" v2.0.0 > "${WORK}/fifo" 2>&1
  ) &
  pid=$!
  if wait_for "${STUB_LOG}/held-1"; then
    kill "$reader" 2>/dev/null; wait "$reader" 2>/dev/null
    [ "$signal" = none ] || kill "-${signal}" "$pid"
  fi
  : > "${STUB_LOG}/release-1"
  wait "$pid"; status=$?
  show "$(cat "${WORK}/out")
(the reader is gone; the upgrade exited ${status})"
  if [ "$expected" = rollback ]; then
    check "${what}: the upgrade exited non-zero" '[ "$status" -ne 0 ]'
    check "${what}: the old tree is back in place" '[ "$(version_at "${FAKE}/opt/boxpilot")" = 1.0.0 ]'
    check "${what}: the new tree is kept as evidence" 'ls -d "${FAKE}"/opt/boxpilot.failed.* >/dev/null 2>&1'
    check "${what}: it restarted the old helper and web service" 'restarted_after_rollback'
    if [ "$tarball" = "${WORK}/release-move.tar.gz" ]; then
      # (Git Bash on Windows hands node the path as C:/Program Files/Git/etc/...: hence the .*)
      check "${what}: it put the backup destination back" '[ "$(sed -n 1p "${STUB_LOG}/mount-move" 2>/dev/null)" = move ] && [ "$(wc -l < "${STUB_LOG}/mount-move")" -eq 2 ] &&
        sed -n 2p "${STUB_LOG}/mount-move" | grep -q "^undo .*/etc/fstab\.boxpilot-stub$"'
    fi
  else
    check "${what}: the upgrade finished" '[ "$status" -eq 0 ]'
    check "${what}: the new tree is live" '[ "$(version_at "${FAKE}/opt/boxpilot")" = 2.0.0 ] && ! ls -d "${FAKE}"/opt/boxpilot.failed.* >/dev/null 2>&1'
    check "${what}: the backup destination was moved and stays moved" '[ "$(cat "${STUB_LOG}/mount-move" 2>/dev/null)" = move ]'
  fi
}
pipe_case "reader gone, then TERM" TERM default "${WORK}/release.tar.gz" rollback
pipe_case "reader gone with SIGPIPE ignored (a systemd unit), then TERM" TERM ignored "${WORK}/release.tar.gz" rollback
pipe_case "reader gone, no signal, the backup destination moved" none default "${WORK}/release-move.tar.gz" rollback
pipe_case "reader gone with SIGPIPE ignored, no signal, the backup destination moved" none ignored "${WORK}/release-move.tar.gz" live

echo "4. Re-running the installer keeps the port and access the env file holds"
example="$(tr -d '\r' < "${REPO}/deploy/boxpilot.env.example")"
backup_touched() { grep -q "mnt/boxpilot/backup" "${STUB_LOG}/install" 2>/dev/null; }
# An installed box: the example's env file on port $1 (Tailscale's loopback, cookies https-only
# unless $2 says false), the backup mount point already there.
installed_box() {
  fresh_box "${example}"
  sed -i -e "s/^BOXPILOT_PORT=.*/BOXPILOT_PORT=$1/" -e "s/^BOXPILOT_COOKIE_SECURE=.*/BOXPILOT_COOKIE_SECURE=${2:-true}/" "${FAKE}/etc/boxpilot/boxpilot.env"
  mkdir -p "${FAKE}/mnt/boxpilot/backup"
}

# A first install: the service is not enabled until the installer enables it.
fresh_box ""
rm -rf "${FAKE}/etc/boxpilot" "${FAKE}/mnt"
STUB_NOT_ENABLED=1 run_install http://127.0.0.1:9000/api/v1/health --port 9000 --access lan
show "$out"
check "fresh install with --port 9000 --access lan: it finished" '[ "$status" -eq 0 ] && grep -q "BoxPilot is installed and running" <<<"$out"'
check "fresh install: the env file has port 9000 on every address, cookies not https-only" '[ "$(env_line BOXPILOT_PORT)" = BOXPILOT_PORT=9000 ] && [ "$(env_line BOXPILOT_HOST)" = BOXPILOT_HOST=0.0.0.0 ] && [ "$(env_line BOXPILOT_COOKIE_SECURE)" = BOXPILOT_COOKIE_SECURE=false ]'
check "fresh install: it checked port 9000" 'grep -qx "http://127.0.0.1:9000/api/v1/health" "${STUB_LOG}/curl"'
check "fresh install: it made the backup mount point" 'backup_touched && [ -d "${FAKE}/mnt/boxpilot/backup" ]'
check "fresh install with ufw inactive: no rule added" '! grep -q "^allow" "${STUB_LOG}/ufw" 2>/dev/null'

# A Tailscale install on port 9000 whose owner then turned on the LAN in Settings.
installed_box 9000
sed -i -e 's/^BOXPILOT_HOST=.*/BOXPILOT_HOST=0.0.0.0/' "${FAKE}/etc/boxpilot/boxpilot.env"
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
installed_box 8787 false
run_install http://127.0.0.1:8787/api/v1/health
show "$out"
check "re-run of a local install: it finished" '[ "$status" -eq 0 ]'
check "re-run of a local install: it stays on loopback, not the LAN" '[ "$(env_line BOXPILOT_HOST)" = BOXPILOT_HOST=127.0.0.1 ] && [ "$(env_line BOXPILOT_COOKIE_SECURE)" = BOXPILOT_COOKIE_SECURE=false ]'

# A new --port on a re-run is written before the upgrade, which restarts the service on it and
# checks it there.
installed_box 9000 false
run_install http://127.0.0.1:9100/api/v1/health --port 9100
show "$out"
check "re-run with --port 9100: it finished" '[ "$status" -eq 0 ]'
check "re-run with --port 9100: the upgrade checked the new port" 'grep -qx "health=http://127.0.0.1:9100/api/v1/health" "${STUB_LOG}/upgrade"'
check "re-run with --port 9100: the env file says 9100 and the access is kept" '[ "$(env_line BOXPILOT_PORT)" = BOXPILOT_PORT=9100 ] && [ "$(env_line BOXPILOT_HOST)" = BOXPILOT_HOST=127.0.0.1 ]'
check "re-run with --port 9100: it checked 9100 and nothing else" '[ "$(sort -u "${STUB_LOG}/curl" 2>/dev/null)" = http://127.0.0.1:9100/api/v1/health ]'

# The env file's port is one the service cannot answer on (taken by something else, say): a re-run
# with a good --port used to check the bad one first, roll back, and stop before writing the new one.
installed_box 9000 false
run_install http://127.0.0.1:8787/api/v1/health --port 8787
show "$out"
check "env file on 9000, which does not answer; re-run with --port 8787: it finished" '[ "$status" -eq 0 ] && grep -q "BoxPilot is installed and running" <<<"$out"'
check "re-run with --port 8787: the upgrade checked 8787" 'grep -qx "health=http://127.0.0.1:8787/api/v1/health" "${STUB_LOG}/upgrade"'
check "re-run with --port 8787: the env file says 8787" '[ "$(env_line BOXPILOT_PORT)" = BOXPILOT_PORT=8787 ]'

# A new port the service does not come up on: the env file goes back to what it was, and the
# service is restarted on it.
installed_box 9000 false
cp "${FAKE}/etc/boxpilot/boxpilot.env" "${WORK}/env-before"
run_install http://127.0.0.1:9000/api/v1/health --port 9100
show "$out"
check "re-run with --port 9100, which does not answer: it failed and said where it checked" '[ "$status" -ne 0 ] && grep -q "was not installed (its health check was http://127.0.0.1:9100/api/v1/health)" <<<"$out"'
check "re-run with --port 9100, which does not answer: the env file is as it was" 'cmp -s "${WORK}/env-before" "${FAKE}/etc/boxpilot/boxpilot.env"'
check "re-run with --port 9100, which does not answer: the service was restarted on it, last" '[ "$(tail -n 1 "${STUB_LOG}/systemctl")" = "restart boxpilot.service" ] && [ "$(tail -n 1 "${STUB_LOG}/web-restarts")" = BOXPILOT_PORT=9000 ]'

# --port outside 1024-65535: refused before anything is downloaded, written or restarted.
for bad in 80 0 1023 65536 70000 08787 123456789012345678901234567890; do
  installed_box 9000 false
  cp "${FAKE}/etc/boxpilot/boxpilot.env" "${WORK}/env-before"
  run_install http://127.0.0.1:9000/api/v1/health --port "$bad"
  check "--port ${bad}: refused, nothing changed" '[ "$status" -ne 0 ] && grep -q -- "--port must be a number from 1024 to 65535" <<<"$out" && cmp -s "${WORK}/env-before" "${FAKE}/etc/boxpilot/boxpilot.env" && [ ! -s "${STUB_LOG}/systemctl" ] && [ ! -e "${STUB_LOG}/upgrade" ]'
done
for good in 1024 65535; do
  installed_box 9000 false
  run_install "http://127.0.0.1:${good}/api/v1/health" --port "$good"
  check "--port ${good}: accepted" '[ "$status" -eq 0 ] && [ "$(env_line BOXPILOT_PORT)" = "BOXPILOT_PORT=${good}" ]'
done
installed_box 9000 false
run_install http://127.0.0.1:9000/api/v1/health --access wan
check "--access wan: refused before anything changes" '[ "$status" -ne 0 ] && grep -q -- "--access must be tailscale, lan, or local" <<<"$out" && [ ! -s "${STUB_LOG}/systemctl" ]'

# A first install that stopped before it finished (the service never enabled) left the example's
# env file: running it again is still a first install, with the default access.
fresh_box "${example}"
STUB_NOT_ENABLED=1 run_install http://127.0.0.1:8787/api/v1/health
show "$out"
check "first install run again after it stopped early: it finished" '[ "$status" -eq 0 ]'
check "first install run again: it takes the default access (no Tailscale: the LAN), not the example's" '[ "$(env_line BOXPILOT_HOST)" = BOXPILOT_HOST=0.0.0.0 ] && [ "$(env_line BOXPILOT_COOKIE_SECURE)" = BOXPILOT_COOKIE_SECURE=false ]'

# --access on a re-run still changes it.
installed_box 9000
run_install http://127.0.0.1:9000/api/v1/health --access lan
show "$out"
check "re-run with --access lan: it finished on the port it had" '[ "$status" -eq 0 ] && [ "$(env_line BOXPILOT_PORT)" = BOXPILOT_PORT=9000 ]'
check "re-run with --access lan: the LAN is what it asked for" '[ "$(env_line BOXPILOT_HOST)" = BOXPILOT_HOST=0.0.0.0 ] && [ "$(env_line BOXPILOT_COOKIE_SECURE)" = BOXPILOT_COOKIE_SECURE=false ]'
check "re-run with --access lan, ufw inactive: no rule added" '! grep -q "^allow" "${STUB_LOG}/ufw" 2>/dev/null'

# ufw on: the LAN needs the port open, as Settings opens it (server/tasks/web-bind.mjs).
installed_box 9000
STUB_UFW=active run_install http://127.0.0.1:9100/api/v1/health --access lan --port 9100
show "$out"
check "re-run with --access lan --port 9100, ufw active: it finished" '[ "$status" -eq 0 ]'
check "re-run with --access lan --port 9100, ufw active: it opened 9100/tcp for BoxPilot" '[ "$(grep "^allow" "${STUB_LOG}/ufw")" = "allow 9100/tcp comment BoxPilot keeps BoxPilot reachable" ]'
installed_box 9000
STUB_UFW=active run_install http://127.0.0.1:9000/api/v1/health --access local
check "re-run with --access local, ufw active: nothing opened" '[ "$status" -eq 0 ] && ! grep -q "^allow" "${STUB_LOG}/ufw" 2>/dev/null'
installed_box 9000
STUB_UFW=active run_install http://127.0.0.1:9100/api/v1/health --access lan --port 9300
check "re-run with --access lan on a port that does not answer, ufw active: nothing opened" '[ "$status" -ne 0 ] && ! grep -q "^allow" "${STUB_LOG}/ufw" 2>/dev/null'

# An env file written by hand on Windows, or with blanks around "=": read as systemd reads it.
fresh_box 'NODE_ENV=production\r\n  BOXPILOT_HOST = 0.0.0.0 \r\nBOXPILOT_PORT= "9000"\t\r\nBOXPILOT_COOKIE_SECURE = false\r'
mkdir -p "${FAKE}/mnt/boxpilot/backup"
run_install http://127.0.0.1:9000/api/v1/health
show "$out"
check "re-run with a CRLF env file, blanks around =: it finished on 9000" '[ "$status" -eq 0 ] && grep -qx "health=http://127.0.0.1:9000/api/v1/health" "${STUB_LOG}/upgrade"'
check "re-run with a CRLF env file: it kept the LAN" 'grep -q "listening on 0.0.0.0" <<<"$out" && grep -q "^  BOXPILOT_HOST = 0.0.0.0" "${FAKE}/etc/boxpilot/boxpilot.env"'
check "re-run with a CRLF env file: one BOXPILOT_PORT line, 9000" '[ "$(grep -c "BOXPILOT_PORT" "${FAKE}/etc/boxpilot/boxpilot.env")" -eq 1 ] && [ "$(env_line BOXPILOT_PORT)" = BOXPILOT_PORT=9000 ]'

# A comment after the port: the service is on 9000 (systemd keeps the comment, parseInt drops it).
# The installer took the comment into the port, wrote it back and checked a URL with it in.
installed_box '9000   # moved off 8787'
run_install http://127.0.0.1:9000/api/v1/health
show "$out"
check "re-run with a comment after the port: it finished on 9000" '[ "$status" -eq 0 ] && grep -qx "health=http://127.0.0.1:9000/api/v1/health" "${STUB_LOG}/upgrade"'
check "re-run with a comment after the port: the env file says 9000" '[ "$(env_line BOXPILOT_PORT)" = BOXPILOT_PORT=9000 ]'
installed_box '"9000" # web'
run_install http://127.0.0.1:9100/api/v1/health --port 9100
check "re-run with a quoted port and a comment, --port 9100: it moved from 9000 to 9100" '[ "$status" -eq 0 ] && grep -qx "health=http://127.0.0.1:9100/api/v1/health" "${STUB_LOG}/upgrade" && [ "$(env_line BOXPILOT_PORT)" = BOXPILOT_PORT=9100 ]'

echo "5. The host doctor, run with sudo, checks the web service where its env file says it listens"
doctor_case() { # doctor_case <what> <env file> <the URL that answers> <host:port it reports>
  local what="$1" answering="$3" reported="$4"
  fresh_box "$2"
  out="$(cd "$WORK" && env "${common_env[@]}" STUB_LISTEN="$answering" "$SH" "${WORK}/doctor.sh" 2>&1)"
  show "$(grep -i "health" <<<"$out")"
  check "${what}: the doctor finds it answering on ${reported}" 'grep -q "^\[PASS\] BoxPilot health endpoint responds at ${reported}" <<<"$out"'
  check "${what}: it asked ${answering} and nothing else" '[ "$(sort -u "${STUB_LOG}/curl" 2>/dev/null)" = "$answering" ]'
}
doctor_case "installed with --port 9000" 'BOXPILOT_HOST=0.0.0.0\nBOXPILOT_PORT=9000' http://127.0.0.1:9000/api/v1/health 127.0.0.1:9000
doctor_case "CRLF, blanks around =" 'BOXPILOT_HOST = 192.0.2.10 \r\nBOXPILOT_PORT = "9005" \r' http://192.0.2.10:9005/api/v1/health 192.0.2.10:9005
# It warned that a healthy service on 9000 did not answer, having asked for the comment's URL.
doctor_case "an inline comment after the port" 'BOXPILOT_HOST=0.0.0.0\nBOXPILOT_PORT=9000   # moved off 8787' http://127.0.0.1:9000/api/v1/health 127.0.0.1:9000
doctor_case "a quoted port with a comment after it" "BOXPILOT_PORT='9001' ; web" http://127.0.0.1:9001/api/v1/health 127.0.0.1:9001
doctor_case "a quote left open" 'BOXPILOT_HOST=192.0.2.10\nBOXPILOT_PORT="9010\nBOXPILOT_HOST=0.0.0.0' http://192.0.2.10:9010/api/v1/health 192.0.2.10:9010

echo "6. An installer re-run stopped by a signal puts the env file back"
# hup_install_case <what> <where the run is held: build|swap>
# A re-run with --port 9100 on a box on 9000, with the real upgrade script. The installer runs in a
# process group of its own and the whole group gets HUP, as when the SSH session behind
# `curl | sudo sh` drops: at `npm ci` (the build), or at the upgrade's first daemon-reload (the
# service stopped, the new tree in place, so the upgrade rolls back). The env file used to keep 9100
# (the service moved there at its next restart, and the rollback restarted the old version on it)
# with neither ufw nor Tailscale Serve following it.
hup_install_case() {
  local what="$1" at="$2" pid holds="" npm_hold="" held
  installed_box 9000 false
  cp "${FAKE}/etc/boxpilot/boxpilot.env" "${WORK}/env-before"
  if [ "$at" = build ]; then npm_hold=1; held="${STUB_LOG}/npm-held"; else holds="daemon-reload:1"; held="${STUB_LOG}/held-1"; fi
  set -m
  (cd "$WORK" && exec env "${common_env[@]}" STUB_TARBALL="${WORK}/installer-real.tar.gz" STUB_LISTEN=http://127.0.0.1:9100/api/v1/health STUB_HOLDS="$holds" STUB_NPM_HOLD="$npm_hold" "$SH" "${WORK}/install.sh" --ref v2.0.0 --no-token --port 9100 > "${WORK}/out" 2>&1) &
  pid=$!
  set +m
  if wait_for "$held"; then kill -HUP -- "-${pid}"; else echo "    (never reached ${at})"; fi
  : > "${STUB_LOG}/npm-release"; : > "${STUB_LOG}/release-1"
  wait "$pid" 2>/dev/null; status=$?
  out="$(cat "${WORK}/out")"
  show "$out
(the installer exited ${status})"
  check "${what}: the installer exited non-zero" '[ "$status" -ne 0 ]'
  check "${what}: the env file is as it was" 'cmp -s "${WORK}/env-before" "${FAKE}/etc/boxpilot/boxpilot.env"'
  check "${what}: BoxPilot was restarted on port 9000, last" '[ "$(tail -n 1 "${STUB_LOG}/systemctl")" = "restart boxpilot.service" ] && [ "$(tail -n 1 "${STUB_LOG}/web-restarts" 2>/dev/null)" = BOXPILOT_PORT=9000 ]'
  check "${what}: the old tree is in place" '[ "$(version_at "${FAKE}/opt/boxpilot")" = 1.0.0 ]'
  check "${what}: nothing was opened or published" '! grep -q "^allow" "${STUB_LOG}/ufw" 2>/dev/null && ! grep -q "^serve" "${STUB_LOG}/tailscale" 2>/dev/null'
}
hup_install_case "HUP during the build" build
hup_install_case "HUP once the upgrade has stopped the service" swap

echo "7. An upgrade stopped during its build leaves no staging tree behind"
staging_left() { ls -d "${FAKE}"/opt/boxpilot.staging.* >/dev/null 2>&1; }
# build_signal_case <what> <signal>: the upgrade's process group gets the signal at `npm ci`, as an
# SSH session dropping (HUP) or systemd stopping the update unit (TERM) would send it. The staging
# tree was only ever removed when the build failed on its own, so each of these left a copy of
# BoxPilot in /opt that nothing came back for.
build_signal_case() {
  local what="$1" signal="$2" pid
  fresh_box 'BOXPILOT_PORT=8787'
  set -m
  (cd "$WORK" && exec env "${common_env[@]}" STUB_TARBALL="${WORK}/release.tar.gz" STUB_LISTEN=http://127.0.0.1:8787/api/v1/health STUB_NPM_HOLD=1 "$SH" "${WORK}/upgrade.sh" v2.0.0 > "${WORK}/out" 2>&1) &
  pid=$!
  set +m
  if wait_for "${STUB_LOG}/npm-held"; then kill "-${signal}" -- "-${pid}"; else echo "    (never reached the build)"; fi
  : > "${STUB_LOG}/npm-release"
  wait "$pid" 2>/dev/null; status=$?
  out="$(cat "${WORK}/out")"
  show "$out
(the upgrade exited ${status})"
  check "${what}: the upgrade exited non-zero" '[ "$status" -ne 0 ]'
  check "${what}: no staging tree is left" '! staging_left'
  check "${what}: the old tree is in place and the service was never stopped" '[ "$(version_at "${FAKE}/opt/boxpilot")" = 1.0.0 ] && ! grep -q "^stop" "${STUB_LOG}/systemctl"'
}
build_signal_case "HUP during the build" HUP
build_signal_case "TERM during the build" TERM

# What a run stopped outright left (SIGKILL, a power cut): the next upgrade, once it holds the lock,
# clears it. Housekeeping offers it too (server/housekeeping.mjs).
fresh_box 'BOXPILOT_PORT=8787'
mkdir -p "${FAKE}/opt/boxpilot.staging.20260101T000000Z/node_modules"
printf '{"name":"boxpilot","version":"1.5.0"}\n' > "${FAKE}/opt/boxpilot.staging.20260101T000000Z/package.json"
run_upgrade STUB_LISTEN=http://127.0.0.1:8787/api/v1/health
show "$out"
check "a staging tree an earlier run left: the upgrade went live" '[ "$status" -eq 0 ] && [ "$(version_at "${FAKE}/opt/boxpilot")" = 2.0.0 ]'
check "a staging tree an earlier run left: it is gone, and the upgrade said so" '! staging_left && grep -q "removed .*/opt/boxpilot.staging.20260101T000000Z" <<<"$out"'

echo "8. A new --port moves Tailscale Serve with it wherever Serve is in use"
served() { grep -x "serve --bg $1" "${STUB_LOG}/tailscale" 2>/dev/null | wc -l | tr -d ' '; }
# A Tailscale install on port 9000 (cookies https-only, which only the Tailscale access sets) whose
# owner then turned on the LAN in Settings: a re-run reads that as "lan", and Serve was re-pointed
# only for "tailscale", so --port 9100 left the tailnet address on 9000, where nothing answers.
installed_box 9000
sed -i -e 's/^BOXPILOT_HOST=.*/BOXPILOT_HOST=0.0.0.0/' "${FAKE}/etc/boxpilot/boxpilot.env"
STUB_TAILSCALE=running run_install http://127.0.0.1:9100/api/v1/health --port 9100
show "$out"
check "Tailscale install with the LAN on, re-run with --port 9100: it finished" '[ "$status" -eq 0 ]'
check "Tailscale install with the LAN on, re-run with --port 9100: Serve now forwards to 9100" '[ "$(served http://127.0.0.1:9100)" -eq 1 ]'
check "Tailscale install with the LAN on, re-run with --port 9100: the LAN and https-only cookies stay" '[ "$(env_line BOXPILOT_HOST)" = BOXPILOT_HOST=0.0.0.0 ] && [ "$(env_line BOXPILOT_COOKIE_SECURE)" = BOXPILOT_COOKIE_SECURE=true ]'
# The same box re-run without a new port: Serve already points where the service listens.
installed_box 9000
sed -i -e 's/^BOXPILOT_HOST=.*/BOXPILOT_HOST=0.0.0.0/' "${FAKE}/etc/boxpilot/boxpilot.env"
STUB_TAILSCALE=running run_install http://127.0.0.1:9000/api/v1/health
check "Tailscale install with the LAN on, re-run on the same port: Serve left alone" '[ "$status" -eq 0 ] && ! grep -q "^serve" "${STUB_LOG}/tailscale" 2>/dev/null'
# A LAN install (cookies not https-only) on a box that also runs Tailscale: Serve was never BoxPilot's.
installed_box 9000 false
sed -i -e 's/^BOXPILOT_HOST=.*/BOXPILOT_HOST=0.0.0.0/' "${FAKE}/etc/boxpilot/boxpilot.env"
STUB_TAILSCALE=running run_install http://127.0.0.1:9100/api/v1/health --port 9100
check "LAN install on a box running Tailscale, --port 9100: nothing published" '[ "$status" -eq 0 ] && ! grep -q "^serve" "${STUB_LOG}/tailscale" 2>/dev/null'
# A Tailscale install as such: Serve is pointed at the new port once.
installed_box 9000
STUB_TAILSCALE=running run_install http://127.0.0.1:9100/api/v1/health --port 9100
check "Tailscale install, re-run with --port 9100: Serve forwards to 9100, set once" '[ "$status" -eq 0 ] && [ "$(served http://127.0.0.1:9100)" -eq 1 ] && [ "$(grep -c "^serve" "${STUB_LOG}/tailscale")" -eq 1 ]'

echo "9. A rollback says whether the old version is really back"
# The rollback said "previous tree restored" whether or not the old tree had been moved back, and
# never asked the restarted service anything: its restarts' errors were silenced.
last_line() { printf '%s\n' "$out" | tail -n 1; }
# The new helper never comes up (its socket is not there), so the upgrade rolls back; the old
# version, back in place, answers as 1.0.0.
fresh_box 'BOXPILOT_PORT=8787'
run_upgrade STUB_LISTEN=http://127.0.0.1:8787/api/v1/health STUB_TREE="${FAKE}/opt/boxpilot" BOXPILOT_HELPER_SOCKET=missing.sock
show "$out"
check "rolled back, the old version answers: it failed, and its last line says 1.0.0 answers again" '[ "$status" -ne 0 ] && last_line | grep -q "ERROR: upgrade failed; previous tree restored, and BoxPilot 1.0.0 answers at http://127.0.0.1:8787/api/v1/health"'
check "rolled back, the old version answers: it asked once for 2.0.0 and once more after the rollback's restart" '[ "$(grep -cx http://127.0.0.1:8787/api/v1/health "${STUB_LOG}/curl")" -eq 2 ] && [ "$(version_at "${FAKE}/opt/boxpilot")" = 1.0.0 ]'
# Nothing answers, before or after.
fresh_box 'BOXPILOT_PORT=8787'
run_upgrade STUB_LISTEN=
show "$out"
check "rolled back, nothing answers: it says so rather than that all is well" '[ "$status" -ne 0 ] && last_line | grep -q "previous tree restored, but BoxPilot 1.0.0 did not answer at http://127.0.0.1:8787/api/v1/health" && ! grep -q "1.0.0 answers" <<<"$out"'
# The old tree cannot be moved back.
fresh_box 'BOXPILOT_PORT=8787'
run_upgrade STUB_LISTEN= STUB_MV_FAIL=prev
show "$out"
check "rolled back, the old tree cannot be moved back: it never claims it was restored" '[ "$status" -ne 0 ] && ! grep -q "restored" <<<"$out"'
check "rolled back, the old tree cannot be moved back: it says plainly where both trees are" 'last_line | grep -q "ERROR: upgrade failed and the previous tree could not be put back: it is at .*/opt/boxpilot\.prev\.[0-9TZ]*; .*/opt/boxpilot is missing, the new tree is at .*/opt/boxpilot\.failed\.[0-9TZ]*\." && [ -d "$(ls -d "${FAKE}"/opt/boxpilot.prev.* | head -n 1)" ]'

if [ "$failures" -gt 0 ]; then echo "${failures} check(s) failed"; exit 1; fi
echo "all checks passed"
