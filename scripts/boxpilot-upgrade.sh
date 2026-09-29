#!/bin/sh
# Upgrade (or first-install the code for) a native BoxPilot deployment under /opt/boxpilot.
#
#   sudo sh scripts/boxpilot-upgrade.sh [git-ref]        # default: main
#   curl -fsSL https://raw.githubusercontent.com/AES256Afro/BoxPilot/main/scripts/boxpilot-upgrade.sh | sudo sh -s -- phase-0
#
# What it does:
#   0. Holds /run/boxpilot-upgrade.lock for the whole run: a second upgrade started meanwhile refuses
#      and says which one to wait for
#   1. Downloads the ref as a tarball from GitHub into /opt/boxpilot.staging.<stamp>
#   2. npm ci, npm run build, npm prune --omit=dev in the staging directory
#   3. Copies the database the running version wrote (VACUUM INTO, integrity-checked, the live
#      file's owner and mode) to /var/lib/boxpilot/boxpilot-rollback-<old version>-<stamp>.sqlite3,
#      and refuses to go on if that copy cannot be made
#   4. Swaps /opt/boxpilot atomically (previous tree kept as /opt/boxpilot.prev.<stamp>)
#   5. Installs any changed deploy/*.service and *.timer units (old copies kept as *.pre-<stamp>)
#   6. Moves a backup destination still mounted at /mnt/boxpilot-backup to /mnt/boxpilot/backup
#      (one fstab entry, saved first as /etc/fstab.boxpilot-<stamp>; see scripts/boxpilot-backup-mount-move.mjs)
#   7. daemon-reload, restarts boxpilot-helper and boxpilot, and checks /api/v1/health reports the new version
#   8. Rolls the directory swap, the units and that move back and restarts the old tree if the health check
#      fails, and names the database copy that matches the old tree
#
# It does not touch /etc/boxpilot, systemd drop-ins, or the owner account. In /var/lib/boxpilot it only
# adds the database copy: it never changes the database itself, and never deletes a copy (the System
# page's housekeeping lets the owner choose which old copies go).
set -eu
# sudo keeps the caller's umask: a strict one would make /opt and node_modules unreadable to the service user.
umask 022

REPO="${BOXPILOT_REPO:-AES256Afro/BoxPilot}"
REF="${1:-main}"
INSTALL_DIR="${BOXPILOT_INSTALL_DIR:-/opt/boxpilot}"
HEALTH_URL="${BOXPILOT_HEALTH_URL:-http://127.0.0.1:8787/api/v1/health}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
STAGING="${INSTALL_DIR}.staging.${STAMP}"
PREVIOUS="${INSTALL_DIR}.prev.${STAMP}"
KEEP_PREVIOUS="${BOXPILOT_KEEP_PREVIOUS:-2}"

log() { printf '[boxpilot-upgrade] %s\n' "$*"; }
fail() { printf '[boxpilot-upgrade] ERROR: %s\n' "$*" >&2; exit 1; }

# The database the running BoxPilot keeps its state in: where the service's environment file says,
# otherwise the default. BOXPILOT_DATABASE and BOXPILOT_DB_COPY_DIR override both for a test or an
# unusual layout; the copy goes beside the database unless told otherwise.
STATE_DIR="${BOXPILOT_STATE_DIRECTORY:-}"
if [ -z "$STATE_DIR" ] && [ -f /etc/boxpilot/boxpilot.env ]; then
  STATE_DIR="$(sed -n 's/^BOXPILOT_STATE_DIRECTORY=//p' /etc/boxpilot/boxpilot.env | tail -n 1 | sed "s/^[\"']//; s/[\"']\$//")"
fi
STATE_DIR="${STATE_DIR:-/var/lib/boxpilot}"
DATABASE="${BOXPILOT_DATABASE:-${STATE_DIR}/boxpilot.sqlite3}"
DB_COPY_DIR="${BOXPILOT_DB_COPY_DIR:-$(dirname "$DATABASE")}"
# The copy this run made, once it has made one; the rollback names it.
DB_COPY=""

# Read-only open, VACUUM INTO (one consistent file, WAL included, while the service keeps running),
# then an integrity check of the copy. Prints the copy's size in bytes, or one line saying why not
# on stderr with a non-zero exit. Runs under the Node the service uses.
DB_COPY_JS='
import { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";
const [source, target] = process.argv.slice(1);
try {
  const live = new DatabaseSync(source, { readOnly: true });
  try {
    live.exec("PRAGMA busy_timeout = 15000");
    live.prepare("VACUUM INTO ?").run(target);
  } finally { live.close(); }
  const copy = new DatabaseSync(target, { readOnly: true });
  let verdict;
  try { verdict = copy.prepare("PRAGMA integrity_check").all().map((row) => String(Object.values(row)[0])); } finally { copy.close(); }
  if (verdict.length !== 1 || verdict[0] !== "ok") throw new Error(`the copy failed its integrity check (${verdict.slice(0, 3).join("; ")})`);
  process.stdout.write(`${statSync(target).size}\n`);
} catch (error) {
  process.stderr.write(`${String(error?.message ?? error).split("\n")[0]}\n`);
  process.exitCode = 1;
}
'

[ "$(id -u)" -eq 0 ] || fail "run with sudo (root is required to replace ${INSTALL_DIR} and restart units)"
for tool in curl tar flock; do command -v "$tool" >/dev/null 2>&1 || fail "$tool is required"; done

# One upgrade at a time, for the whole run. Two started two seconds apart on the owner's server: two
# previous trees (one of them the new version itself), two database copies, the service started
# twice, and a healthy end only by luck. The lock lives in /run, so a reboot never leaves one behind,
# and it is released when this shell exits, however it exits. Who holds it is written into the lock
# file, so a second run can say who to wait for. The System page's update checks the same lock
# before it starts one (server/tasks/update.mjs).
UPGRADE_LOCK="${BOXPILOT_UPGRADE_LOCK:-/run/boxpilot-upgrade.lock}"
exec 9>>"$UPGRADE_LOCK"
if ! flock -n 9; then
  holder="$(tr '\n' ' ' < "$UPGRADE_LOCK" 2>/dev/null | sed 's/ *$//')"
  fail "another BoxPilot update is already running (${holder:-it holds ${UPGRADE_LOCK}}). Nothing was changed; wait for it to finish, then run this again if it is still needed."
fi
: > "$UPGRADE_LOCK"
printf 'pid=%s ref=%s started=%s by=%s\n' "$$" "$REF" "$STAMP" "${BOXPILOT_UPDATE_UNIT:-hand}" > "$UPGRADE_LOCK"

# Resolve the Node.js runtime. Prefer an explicit override, then the unit drop-in, then PATH, then the documented path.
NODE_BIN="${BOXPILOT_NODE_BIN:-}"
if [ -z "$NODE_BIN" ]; then
  for conf in /etc/systemd/system/boxpilot.service.d/*.conf; do
    [ -f "$conf" ] || continue
    candidate="$(sed -n 's|^ExecStart=\([^ ]*node\) .*|\1|p' "$conf" | tail -n 1)"
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then NODE_BIN="$candidate"; break; fi
  done
fi
if [ -z "$NODE_BIN" ]; then
  if command -v node >/dev/null 2>&1; then NODE_BIN="$(command -v node)"; elif [ -x /usr/local/bin/node ]; then NODE_BIN=/usr/local/bin/node; fi
fi
[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || fail "could not find a Node.js runtime; set BOXPILOT_NODE_BIN=/path/to/node"
NODE_DIR="$(dirname "$NODE_BIN")"
PATH="${NODE_DIR}:${PATH}"; export PATH
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 24 ] || fail "Node.js 24 or newer is required (found $("$NODE_BIN" --version) at ${NODE_BIN})"
command -v npm >/dev/null 2>&1 || fail "npm was not found next to ${NODE_BIN}"
log "using $("$NODE_BIN" --version) at ${NODE_BIN}"

cleanup_staging() { [ -d "$STAGING" ] && rm -rf "$STAGING"; }

# 1. Download
log "downloading ${REPO}@${REF}"
mkdir -p "$STAGING"
if ! curl -fsSL "https://codeload.github.com/${REPO}/tar.gz/${REF}" | tar -xz -C "$STAGING" --strip-components=1; then
  cleanup_staging; fail "download or extraction failed for ${REPO}@${REF} (does the ref exist?)"
fi
[ -f "${STAGING}/package.json" ] || { cleanup_staging; fail "downloaded tree has no package.json"; }
NEW_VERSION="$("$NODE_BIN" -p 'require(process.argv[1]).version' "${STAGING}/package.json")"
log "building BoxPilot ${NEW_VERSION} in ${STAGING}"

# 2. Build
set +e
(
  cd "$STAGING" &&
  npm ci --no-audit --no-fund --loglevel=error &&
  npm run build --silent &&
  npm prune --omit=dev --no-audit --no-fund --loglevel=error
)
BUILD_STATUS=$?
set -e
[ "$BUILD_STATUS" -eq 0 ] || { cleanup_staging; fail "build failed; ${INSTALL_DIR} was not touched"; }
[ -f "${STAGING}/server/index.mjs" ] && [ -f "${STAGING}/dist/index.html" ] || { cleanup_staging; fail "build output incomplete"; }
chown -R root:root "$STAGING"
chmod 0755 "$STAGING"

OLD_VERSION=""
if [ -d "$INSTALL_DIR" ]; then
  OLD_VERSION="$("$NODE_BIN" -p 'try { require(process.argv[1]).version } catch { "unknown" }' "${INSTALL_DIR}/package.json" 2>/dev/null || echo unknown)"
fi

# 3. A copy of the database, before anything changes.
#
# A release can migrate or rewrite the database (new settings, the stored-secret scrub), and the
# rollback below only puts the old code back. The old code with a database the new one changed is
# not the old BoxPilot, so the copy is taken here, from the version still running, as late as
# possible (after the build) so it misses as little as it can. No copy, no upgrade: a server
# without room for one is also a server where the upgrade is the riskiest.
if [ -n "$OLD_VERSION" ]; then
  if [ ! -f "$DATABASE" ]; then
    log "no database at ${DATABASE}; nothing to copy"
  else
    DB_COPY="${DB_COPY_DIR}/boxpilot-rollback-${OLD_VERSION}-${STAMP}.sqlite3"
    log "copying the database ${OLD_VERSION} wrote to ${DB_COPY}"
    # umask 077 in the subshell: VACUUM INTO creates the file 0644, and a copy of the database holds
    # everything the database does. It gets the live file's owner and mode below.
    # Opened as the database's own user, the way the service opens it: root opening it while the
    # service is stopped could create its -wal/-shm files owned by root, and the service could then
    # not open its own database. From /, so root's home not being readable to that user is no matter.
    DB_OWNER="$(stat -c %U "$DATABASE")"
    AS_OWNER=""
    if [ "$DB_OWNER" != root ]; then
      command -v runuser >/dev/null 2>&1 || fail "runuser is required to copy the database as ${DB_OWNER}"
      AS_OWNER="runuser -u ${DB_OWNER} --"
    fi
    COPY_OK=0; reason=""
    # shellcheck disable=SC2086 # AS_OWNER is a command prefix, empty or three words.
    if ! copied="$(cd / && umask 077 && $AS_OWNER "$NODE_BIN" --no-warnings --input-type=module -e "$DB_COPY_JS" "$DATABASE" "$DB_COPY" 2>&1)"; then
      reason="$(printf '%s\n' "$copied" | tail -n 1)"
    elif ! chown --reference="$DATABASE" "$DB_COPY" || ! chmod --reference="$DATABASE" "$DB_COPY"; then
      reason="the copy could not be given the database's owner and mode"
    else
      COPY_OK=1
    fi
    if [ "$COPY_OK" -ne 1 ]; then
      rm -f "$DB_COPY" "${DB_COPY}-journal" "${DB_COPY}-wal" "${DB_COPY}-shm"
      DB_COPY=""
      cleanup_staging
      fail "could not copy the database to ${DB_COPY_DIR}: ${reason:-no reason given}. Nothing was changed: BoxPilot ${OLD_VERSION} is still running from ${INSTALL_DIR}. Make room in ${DB_COPY_DIR} (or fix what the reason names) and run the update again."
    fi
    log "database copy: ${DB_COPY} ($(printf '%s\n' "$copied" | tail -n 1) bytes, integrity ok)"
  fi
fi

# 4. Swap
#
# Units this run replaced, so a rollback can put the old ones back with the old tree.
REPLACED_UNITS=""
# The fstab copy a backup-destination move saved, so a rollback can put the old mount point back.
BACKUP_MOUNT_UNDO=""

# Put the old BoxPilot back. Safe to fire at any point from the moment the service is stopped: if
# the swap has not happened yet, the current tree IS the old one and is left where it is; if the
# old tree has been moved aside, it is moved back; if the new tree is in place, it is kept as
# evidence and the old one restored.
rollback() {
  trap - EXIT
  log "rolling back to previous tree"
  systemctl stop boxpilot.service 2>/dev/null || true
  # The old helper looks for the backup destination where it used to be. Undone while the new tree,
  # which made the move, is still at INSTALL_DIR; the move only ever happens after the swap.
  if [ -n "$BACKUP_MOUNT_UNDO" ]; then
    systemctl stop boxpilot-helper.service 2>/dev/null || true
    if "$NODE_BIN" "${INSTALL_DIR}/scripts/boxpilot-backup-mount-move.mjs" undo "$BACKUP_MOUNT_UNDO"; then
      log "moved the backup destination back to /mnt/boxpilot-backup"
    else
      log "could not move the backup destination back; fstab from before the upgrade is ${BACKUP_MOUNT_UNDO}"
    fi
  fi
  if [ -d "$PREVIOUS" ]; then
    if [ -d "$INSTALL_DIR" ]; then
      rm -rf "${INSTALL_DIR}.failed.${STAMP}"
      mv "$INSTALL_DIR" "${INSTALL_DIR}.failed.${STAMP}"
    fi
    mv "$PREVIOUS" "$INSTALL_DIR"
  fi
  # Old code under new unit files would keep failing for the same reason the upgrade did.
  for name in $REPLACED_UNITS; do
    [ -f "/etc/systemd/system/${name}.pre-${STAMP}" ] || continue
    mv "/etc/systemd/system/${name}.pre-${STAMP}" "/etc/systemd/system/${name}"
    log "restored unit ${name}"
  done
  systemctl daemon-reload 2>/dev/null || true
  systemctl restart boxpilot-helper.service 2>/dev/null || true
  systemctl restart boxpilot.service 2>/dev/null || true
  # The code is back; the database is whatever the new version left. Usually that is fine - most
  # releases change nothing in it - but if the old version cannot read it, this is the way back.
  if [ -n "$DB_COPY" ]; then
    log "the database as ${OLD_VERSION} left it is ${DB_COPY}"
    log "if ${OLD_VERSION} misbehaves on the current database: systemctl stop boxpilot, copy that file over ${DATABASE} (keeping its owner and mode), delete ${DATABASE}-wal and ${DATABASE}-shm, and start boxpilot. Anything recorded after ${STAMP} is not in the copy."
  fi
  if [ -d "${INSTALL_DIR}.failed.${STAMP}" ]; then
    fail "upgrade failed; previous tree restored (failed tree kept at ${INSTALL_DIR}.failed.${STAMP})"
  fi
  fail "upgrade failed before the new tree was in place; the previous BoxPilot was left as it was"
}

HAD_PREVIOUS=0
if [ -d "$INSTALL_DIR" ]; then
  log "stopping services and replacing ${INSTALL_DIR} (${OLD_VERSION} -> ${NEW_VERSION})"
  HAD_PREVIOUS=1
  # Armed BEFORE the service is stopped and the tree moved, not after. It used to be armed only
  # once the new tree was in place, which left a window - the old tree moved aside, the new one not
  # yet moved in - where a failure exited with no /opt/boxpilot at all and the service stopped,
  # and nothing to put it back. From here until the health check passes, any failure must restore
  # the old BoxPilot rather than leave the box without one.
  trap 'rollback' EXIT
  systemctl stop boxpilot.service 2>/dev/null || true
  mv "$INSTALL_DIR" "$PREVIOUS"
else
  log "no existing ${INSTALL_DIR}; installing fresh"
fi
mv "$STAGING" "$INSTALL_DIR"

# 5. Units (only when changed; keep a copy of the old one)
UNITS_CHANGED=0
for unit in "${INSTALL_DIR}"/deploy/*.service "${INSTALL_DIR}"/deploy/*.timer; do
  [ -f "$unit" ] || continue
  name="$(basename "$unit")"
  target="/etc/systemd/system/${name}"
  if [ -f "$target" ] && cmp -s "$unit" "$target"; then continue; fi
  if [ -f "$target" ]; then cp -p "$target" "${target}.pre-${STAMP}"; REPLACED_UNITS="${REPLACED_UNITS} ${name}"; fi
  install -m 0644 "$unit" "$target"
  UNITS_CHANGED=$((UNITS_CHANGED + 1))
  log "installed unit ${name}"
done
systemctl daemon-reload

# 6. The backup destination's new place. The helper's sandbox is given /mnt/boxpilot, never an
# automount point, so a NAS that is off can no longer stop the helper from starting; a destination
# still at /mnt/boxpilot-backup is moved under it. Nothing to move is the common case. A move that
# cannot happen (the share is in use) leaves fstab as it was and the upgrade goes on: the helper
# starts either way, and Repair offers the same move (storage.backup.relocate) for later.
install -d -o root -g root -m 0755 /mnt/boxpilot
if [ -f "${INSTALL_DIR}/scripts/boxpilot-backup-mount-move.mjs" ]; then
  # Restarted just below anyway; stopped first so its own view of the old mount does not hold it.
  systemctl stop boxpilot-helper.service 2>/dev/null || true
  if moved="$("$NODE_BIN" "${INSTALL_DIR}/scripts/boxpilot-backup-mount-move.mjs" 2>&1)"; then
    printf '%s\n' "$moved" | sed 's/^/[boxpilot-upgrade] /'
    BACKUP_MOUNT_UNDO="$(printf '%s\n' "$moved" | sed -n 's/^fstab-copy=//p' | tail -n 1)"
  else
    printf '%s\n' "$moved" | sed 's/^/[boxpilot-upgrade] /'
    log "the backup destination stays at /mnt/boxpilot-backup for now; Repair offers to move it"
  fi
fi

# 7. Restart and verify
WEB_RESTARTED=0
systemctl restart boxpilot-helper.service || { [ "$HAD_PREVIOUS" -eq 1 ] && rollback || fail "helper failed to start"; }
if systemctl is-enabled boxpilot.service >/dev/null 2>&1; then
  systemctl restart boxpilot.service || { [ "$HAD_PREVIOUS" -eq 1 ] && rollback || fail "boxpilot failed to start"; }
  WEB_RESTARTED=1
else
  log "boxpilot.service is not enabled yet; skipping web restart and health check (the installer enables it next)"
fi

attempt=0; HEALTHY=0
[ "$WEB_RESTARTED" -eq 1 ] || HEALTHY=1
while [ "$HEALTHY" -ne 1 ] && [ "$attempt" -lt 20 ]; do
  attempt=$((attempt + 1))
  body="$(curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null || true)"
  case "$body" in *"\"version\":\"${NEW_VERSION}\""*) HEALTHY=1; break ;; esac
  sleep 1
done
if [ "$HEALTHY" -ne 1 ]; then
  log "health check at ${HEALTH_URL} did not report version ${NEW_VERSION}; last response: ${body:-<none>}"
  journalctl -u boxpilot.service -u boxpilot-helper.service -n 20 --no-pager 2>/dev/null || true
  if [ "$HAD_PREVIOUS" -eq 1 ]; then rollback; else fail "service unhealthy"; fi
fi
trap - EXIT

# The old unit files are only stale once the new version is answering.
for name in $REPLACED_UNITS; do rm -f "/etc/systemd/system/${name}.pre-${STAMP}"; done

# 8. Prune old previous trees.
#
# Both kinds, because only pruning .prev.* is how this server accumulated sixty-nine leftover
# trees: every upgrade that failed its health check left a .failed.<stamp> copy behind and nothing
# ever came back for it. The most recent failure is kept as the evidence for why it did not start.
ls -d "${INSTALL_DIR}".prev.* 2>/dev/null | sort | head -n -"$KEEP_PREVIOUS" | while read -r old; do rm -rf "$old"; log "removed ${old}"; done
ls -d "${INSTALL_DIR}".failed.* 2>/dev/null | sort | head -n -1 | while read -r old; do rm -rf "$old"; log "removed ${old}"; done

# Kept, never pruned here: which old copies to let go of is the owner's call (System, Housekeeping).
if [ -n "$DB_COPY" ]; then log "the database as ${OLD_VERSION} left it stays at ${DB_COPY}"; fi
log "BoxPilot ${NEW_VERSION} (${REF}) is live; ${UNITS_CHANGED} unit file(s) updated; previous tree at ${PREVIOUS}"
