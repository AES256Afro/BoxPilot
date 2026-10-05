#!/bin/bash
# The upgrade script's database copy (M36), on a real install. Run by the install smoke test once
# BoxPilot is installed from this commit and an owner exists, so the database holds a row that
# matters and the web service is writing to it while the copy is taken.
#
#   sudo bash tests/ubuntu/upgrade-db-copy.sh <git-ref>
#
# DISPOSABLE MACHINES ONLY (CI runs it on GitHub's Ubuntu VMs): it upgrades /opt/boxpilot several
# times, mounts a full filesystem, makes one upgrade fail its health check on purpose, starts two at
# once, moves the web service to another port and re-runs the installer.
#
#   1. A copy that cannot be made refuses the upgrade. The copy goes to a full tmpfs: the script
#      exits non-zero and says why, and nothing moved - the same tree, no new .prev tree, no
#      staging tree, no partial copy, and the running version still answering.
#   2. A normal upgrade copies the database before the swap: boxpilot-rollback-<version>-<stamp>
#      .sqlite3 beside it, with the live file's owner and mode (0600), passing an integrity check
#      and holding the owner account.
#   3. An upgrade whose health check fails rolls back and names the copy that matches the old code.
#   4. Two upgrades at once (as happened on the owner's server): the second refuses and names the
#      first by its process, downloads and stops nothing, and the first finishes with one copy.
#   5. A helper that does not come up rolls the upgrade back.
#   6. On a port other than 8787 (as --port leaves the env file) the upgrade checks that port with
#      nothing telling it so, and re-running the installer with no options keeps the port, the
#      access mode, and the backup mount point's owner.
#   7. With the env file on a port something else holds (the service cannot start), re-running the
#      installer with a free --port moves it there; asking for the held port fails and puts the env
#      file back as it was, with BoxPilot answering where it did.
set -uo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run as root, on a disposable machine" >&2; exit 2; }
REF="${1:?pass the git ref to upgrade to}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="${ROOT}/scripts/boxpilot-upgrade.sh"
NODE=/usr/local/bin/node
DB=/var/lib/boxpilot/boxpilot.sqlite3
HEALTH=http://127.0.0.1:8787/api/v1/health
VERSION="$("$NODE" -p 'require(process.argv[1]).version' /opt/boxpilot/package.json)"
FULL="$(mktemp -d /var/tmp/bp-full-copy.XXXXXX)"
failures=0

check() {
  if eval "$2"; then echo "ok   - $1"; else echo "FAIL - $1"; failures=$((failures + 1)); fi
}
show() { printf '%s\n' "$1" | sed 's/^/    | /'; }
answers() { curl -fsS --retry 10 --retry-connrefused --retry-delay 1 --max-time 3 "$HEALTH" 2>/dev/null | grep -q "\"version\":\"$1\""; }
newest_copy() { ls -t /var/lib/boxpilot/boxpilot-rollback-"${VERSION}"-*.sqlite3 2>/dev/null | head -n 1; }
cleanup() { umount "$FULL" 2>/dev/null; rmdir "$FULL" 2>/dev/null; }
trap cleanup EXIT

[ -f "$DB" ] || { echo "no database at ${DB}; install BoxPilot and bootstrap an owner first" >&2; exit 2; }
answers "$VERSION" || { echo "BoxPilot ${VERSION} is not answering at ${HEALTH}" >&2; exit 2; }
echo "BoxPilot ${VERSION} installed; upgrading to ${REF}"

echo "1. The copy cannot be made: the upgrade is refused and nothing changes"
# Owned by the database's user, who makes the copy: what stops it must be the full disk, not a permission.
mount -t tmpfs -o "size=256k,mode=0700,uid=$(stat -c %u "$DB"),gid=$(stat -c %g "$DB")" tmpfs "$FULL"
dd if=/dev/zero of="${FULL}/filler" bs=4k count=1024 2>/dev/null || true
prev_before="$(ls -d /opt/boxpilot.prev.* 2>/dev/null | wc -l)"
inode_before="$(stat -c %i /opt/boxpilot)"
out="$(BOXPILOT_NODE_BIN="$NODE" BOXPILOT_DB_COPY_DIR="$FULL" sh "$SCRIPT" "$REF" 2>&1)"; status=$?
show "$out"
check "the upgrade exited non-zero" '[ "$status" -ne 0 ]'
check "it said the database could not be copied, and why" 'grep -Eq "ERROR: could not copy the database to ${FULL}: [a-z].*(full|space|I/O)" <<<"$out"'
check "it said nothing was changed" 'grep -q "Nothing was changed: BoxPilot ${VERSION} is still running" <<<"$out"'
check "it refused before stopping anything" '! grep -q "stopping services" <<<"$out"'
check "/opt/boxpilot is the same tree" '[ "$(stat -c %i /opt/boxpilot)" = "$inode_before" ]'
check "no previous tree was made" '[ "$(ls -d /opt/boxpilot.prev.* 2>/dev/null | wc -l)" -eq "$prev_before" ]'
check "no staging tree was left" '! ls -d /opt/boxpilot.staging.* >/dev/null 2>&1'
check "no partial copy was left" '! ls "$FULL"/boxpilot-rollback-* >/dev/null 2>&1'
check "the web service kept running" 'systemctl is-active --quiet boxpilot.service'
check "${VERSION} still answers" 'answers "$VERSION"'
umount "$FULL"

echo "2. A normal upgrade copies the database before the swap"
before="$(newest_copy)"
out="$(BOXPILOT_NODE_BIN="$NODE" sh "$SCRIPT" "$REF" 2>&1)"; status=$?
show "$out"
copy="$(newest_copy)"
check "the upgrade succeeded" '[ "$status" -eq 0 ]'
check "a new copy named for ${VERSION} is beside the database" '[ -n "$copy" ] && [ "$copy" != "$before" ]'
check "the log names it with its size and integrity" 'grep -q "database copy: ${copy} ([0-9]* bytes, integrity ok)" <<<"$out"'
check "the copy was taken before the services stopped" '[ "$(grep -n "database copy:" <<<"$out" | cut -d: -f1)" -lt "$(grep -n "stopping services" <<<"$out" | cut -d: -f1)" ]'
check "the copy has the database's owner" '[ "$(stat -c %U:%G "$copy")" = "$(stat -c %U:%G "$DB")" ]'
check "the copy left no -wal or -shm file owned by root beside the database" '[ -z "$(find "$(dirname "$DB")" -maxdepth 1 -name "$(basename "$DB")-*" -user root 2>/dev/null)" ]'
check "the copy is mode 0600, like the database" '[ "$(stat -c %a "$copy")" = 600 ] && [ "$(stat -c %a "$DB")" = 600 ]'
check "the copy passes an integrity check and holds the owner account" '"$NODE" --no-warnings -e "
  const { DatabaseSync } = require(\"node:sqlite\");
  const copy = new DatabaseSync(process.argv[1], { readOnly: true });
  const verdict = Object.values(copy.prepare(\"PRAGMA integrity_check\").get())[0];
  const owners = copy.prepare(\"SELECT COUNT(*) AS n FROM owners\").get().n;
  if (verdict !== \"ok\" || owners < 1) { console.error(verdict, owners); process.exit(1); }
" "$copy"'
check "the success line says the copy stays" 'grep -q "the database as ${VERSION} left it stays at ${copy}" <<<"$out"'
check "the upgraded BoxPilot answers" 'answers "$VERSION"'

echo "3. A failed health check rolls back and names the copy that matches the old code"
out="$(BOXPILOT_NODE_BIN="$NODE" BOXPILOT_HEALTH_URL=http://127.0.0.1:9/api/v1/health sh "$SCRIPT" "$REF" 2>&1)"; status=$?
show "$out"
copy3="$(newest_copy)"
check "the upgrade failed" '[ "$status" -ne 0 ]'
check "it took a copy of its own first" '[ -n "$copy3" ] && [ "$copy3" != "$copy" ]'
check "it rolled back" 'grep -q "rolling back to previous tree" <<<"$out"'
check "the rollback named the copy that matches ${VERSION}" 'grep -q "the database as ${VERSION} left it is ${copy3}" <<<"$out"'
check "the rollback said how to put it back" 'grep -q "copy that file over ${DB}" <<<"$out"'
check "the previous tree answers again" 'answers "$VERSION"'
check "no copy was ever deleted" '[ -f "$copy" ] && [ -f "$copy3" ]'

echo "4. Two upgrades at once: the second refuses, names the first, and changes nothing"
copies_before="$(ls /var/lib/boxpilot/boxpilot-rollback-*.sqlite3 2>/dev/null | wc -l)"
first_log="$(mktemp)"
BOXPILOT_NODE_BIN="$NODE" sh "$SCRIPT" "$REF" > "$first_log" 2>&1 &
first=$!
# The first holds the lock from before it downloads anything.
for _ in $(seq 1 60); do grep -q "downloading" "$first_log" && break; sleep 1; done
out="$(BOXPILOT_NODE_BIN="$NODE" sh "$SCRIPT" "$REF" 2>&1)"; status=$?
show "$out"
check "the second upgrade was refused" '[ "$status" -ne 0 ]'
check "it named the first by its process and ref" 'grep -q "ERROR: another BoxPilot update is already running (pid=${first} ref=${REF} started=" <<<"$out"'
check "it said nothing was changed" 'grep -q "Nothing was changed" <<<"$out"'
check "it downloaded nothing and stopped nothing" '! grep -Eq "downloading|stopping services" <<<"$out"'
wait "$first"; first_status=$?
show "$(cat "$first_log")"
check "the first ran to the end on its own" '[ "$first_status" -eq 0 ] && grep -q " is live;" "$first_log"'
check "one database copy came of the two, not two" '[ "$(ls /var/lib/boxpilot/boxpilot-rollback-*.sqlite3 | wc -l)" -eq $((copies_before + 1)) ]'
check "the upgraded BoxPilot answers" 'answers "$VERSION"'
check "the lock is free again" 'flock -n /run/boxpilot-upgrade.lock true'

echo "5. A helper that does not come up rolls the upgrade back, though the web service answers"
# Looking for its socket where it never is stands in for a helper that fails at start: its restart
# exits 0 either way, and the web service's health check cannot see it.
out="$(BOXPILOT_NODE_BIN="$NODE" BOXPILOT_HELPER_SOCKET=/run/boxpilot/not-the-helper.sock sh "$SCRIPT" "$REF" 2>&1)"; status=$?
show "$out"
check "the upgrade failed" '[ "$status" -ne 0 ]'
check "it said the helper did not stay up" 'grep -q "boxpilot-helper did not stay up with its socket at /run/boxpilot/not-the-helper.sock" <<<"$out"'
check "it rolled back" 'grep -q "rolling back to previous tree" <<<"$out"'
check "the rollback asked the restored version, and said it answers" 'grep -q "ERROR: upgrade failed; previous tree restored, and BoxPilot ${VERSION} answers at http://127.0.0.1:8787/api/v1/health" <<<"$out"'
check "the previous tree answers again" 'answers "$VERSION"'
check "the helper is up again, with its socket" 'systemctl is-active --quiet boxpilot-helper.service && [ -S /run/boxpilot/helper.sock ]'

echo "6. On another port the upgrade checks that port, and a re-run installer keeps it and the access"
# The upgrade's check used to be 127.0.0.1:8787 whatever the port, so on a box installed with --port
# every update rolled back; and a re-run of the installer put 8787 and the default access back.
ENV_FILE=/etc/boxpilot/boxpilot.env
env_line() { grep -x "$1=.*" "$ENV_FILE" | tail -n 1; }
cp -p "$ENV_FILE" "${ENV_FILE}.before-port-test"
sed -i 's/^BOXPILOT_PORT=.*/BOXPILOT_PORT=9087/' "$ENV_FILE"
systemctl restart boxpilot.service
HEALTH=http://127.0.0.1:9087/api/v1/health
check "BoxPilot ${VERSION} answers on port 9087" 'answers "$VERSION"'
out="$(BOXPILOT_NODE_BIN="$NODE" sh "$SCRIPT" "$REF" 2>&1)"; status=$?
show "$out"
check "the upgrade succeeded, told nothing about the port" '[ "$status" -eq 0 ] && grep -q " is live;" <<<"$out"'
check "it did not roll back" '! grep -q "rolling back" <<<"$out"'
check "the upgraded BoxPilot answers on 9087" 'answers "$VERSION"'
host_before="$(env_line BOXPILOT_HOST)"; cookie_before="$(env_line BOXPILOT_COOKIE_SECURE)"
# As a NAS share's folder would be: not root's. A re-run used to hand it to root (and with the NAS
# off, wait out its automount and fail).
chown nobody:nogroup /mnt/boxpilot/backup
out="$(sh "${ROOT}/scripts/boxpilot-install.sh" --ref "$REF" --no-token 2>&1)"; status=$?
show "$out"
check "the installer re-run with no options finished" '[ "$status" -eq 0 ] && grep -q "BoxPilot is installed and running" <<<"$out"'
check "the port stays 9087" '[ "$(env_line BOXPILOT_PORT)" = BOXPILOT_PORT=9087 ]'
check "the access stays as it was (${host_before}, ${cookie_before})" '[ "$(env_line BOXPILOT_HOST)" = "$host_before" ] && [ "$(env_line BOXPILOT_COOKIE_SECURE)" = "$cookie_before" ]'
check "the backup mount point keeps its owner" '[ "$(stat -c %U /mnt/boxpilot/backup)" = nobody ]'
check "BoxPilot answers on 9087" 'answers "$VERSION"'
# Back as the smoke test installed it.
mv "${ENV_FILE}.before-port-test" "$ENV_FILE"
chown root:root /mnt/boxpilot/backup
systemctl restart boxpilot.service
HEALTH=http://127.0.0.1:8787/api/v1/health
check "BoxPilot answers on 8787 again" 'answers "$VERSION"'

echo "7. A re-run with a new --port is checked on that port; one the service cannot listen on is put back"
# The installer used to write a new --port only after the upgrade, which restarted the service on the
# port the env file already named and checked that: a box stuck on a held port rolled back and
# stopped before the good port was ever written.
"$NODE" -e 'require("net").createServer().listen(9088, "127.0.0.1")' &
holder=$!
for _ in $(seq 1 50); do (exec 3<>/dev/tcp/127.0.0.1/9088) 2>/dev/null && break; sleep 0.1; done
cp -p "$ENV_FILE" "${ENV_FILE}.before-port-test"
sed -i 's/^BOXPILOT_PORT=.*/BOXPILOT_PORT=9088/' "$ENV_FILE"
systemctl restart boxpilot.service || true
out="$(sh "${ROOT}/scripts/boxpilot-install.sh" --ref "$REF" --port 8787 --no-token 2>&1)"; status=$?
show "$out"
check "env file on a held port; the installer re-run with --port 8787 finished" '[ "$status" -eq 0 ] && grep -q "BoxPilot is installed and running" <<<"$out"'
check "the env file says 8787" '[ "$(env_line BOXPILOT_PORT)" = BOXPILOT_PORT=8787 ]'
check "BoxPilot answers on 8787" 'answers "$VERSION"'
cp -p "$ENV_FILE" "${ENV_FILE}.before-held-port"
out="$(sh "${ROOT}/scripts/boxpilot-install.sh" --ref "$REF" --port 9088 --no-token 2>&1)"; status=$?
show "$out"
check "the installer re-run with the held --port 9088 failed" '[ "$status" -ne 0 ]'
check "it put the env file back as it was" 'cmp -s "${ENV_FILE}.before-held-port" "$ENV_FILE" && grep -q "back as it was" <<<"$out"'
check "BoxPilot answers on 8787 again" 'answers "$VERSION"'
kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null
mv "${ENV_FILE}.before-port-test" "$ENV_FILE"
rm -f "${ENV_FILE}.before-held-port"
systemctl restart boxpilot.service
check "BoxPilot answers on 8787 at the end" 'answers "$VERSION"'

if [ "$failures" -gt 0 ]; then echo "${failures} check(s) failed"; exit 1; fi
echo "all checks passed"
