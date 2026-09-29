#!/bin/bash
# The upgrade script's database copy (M36), on a real install. Run by the install smoke test once
# BoxPilot is installed from this commit and an owner exists, so the database holds a row that
# matters and the web service is writing to it while the copy is taken.
#
#   sudo bash tests/ubuntu/upgrade-db-copy.sh <git-ref>
#
# DISPOSABLE MACHINES ONLY (CI runs it on GitHub's Ubuntu VMs): it upgrades /opt/boxpilot three
# times, mounts a full filesystem, and makes one upgrade fail its health check on purpose.
#
#   1. A copy that cannot be made refuses the upgrade. The copy goes to a full tmpfs: the script
#      exits non-zero and says why, and nothing moved - the same tree, no new .prev tree, no
#      staging tree, no partial copy, and the running version still answering.
#   2. A normal upgrade copies the database before the swap: boxpilot-rollback-<version>-<stamp>
#      .sqlite3 beside it, with the live file's owner and mode (0600), passing an integrity check
#      and holding the owner account.
#   3. An upgrade whose health check fails rolls back and names the copy that matches the old code.
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
mount -t tmpfs -o size=256k,mode=0700 tmpfs "$FULL"
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

if [ "$failures" -gt 0 ]; then echo "${failures} check(s) failed"; exit 1; fi
echo "all checks passed"
