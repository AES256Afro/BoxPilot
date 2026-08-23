#!/bin/sh
# Upgrade (or first-install the code for) a native BoxPilot deployment under /opt/boxpilot.
#
#   sudo sh scripts/boxpilot-upgrade.sh [git-ref]        # default: main
#   curl -fsSL https://raw.githubusercontent.com/AES256Afro/BoxPilot/main/scripts/boxpilot-upgrade.sh | sudo sh -s -- phase-0
#
# What it does:
#   1. Downloads the ref as a tarball from GitHub into /opt/boxpilot.staging.<stamp>
#   2. npm ci, npm run build, npm prune --omit=dev in the staging directory
#   3. Swaps /opt/boxpilot atomically (previous tree kept as /opt/boxpilot.prev.<stamp>)
#   4. Installs any changed deploy/*.service and *.timer units (old copies kept as *.pre-<stamp>)
#   5. daemon-reload, restarts boxpilot-helper and boxpilot, and checks /api/v1/health reports the new version
#   6. Rolls the directory swap back and restarts the old tree if the health check fails
#
# It does not touch /etc/boxpilot, /var/lib/boxpilot, systemd drop-ins, or the owner account.
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

[ "$(id -u)" -eq 0 ] || fail "run with sudo (root is required to replace ${INSTALL_DIR} and restart units)"
for tool in curl tar; do command -v "$tool" >/dev/null 2>&1 || fail "$tool is required"; done

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

# 3. Swap
HAD_PREVIOUS=0
if [ -d "$INSTALL_DIR" ]; then
  OLD_VERSION="$("$NODE_BIN" -p 'try { require(process.argv[1]).version } catch { "unknown" }' "${INSTALL_DIR}/package.json" 2>/dev/null || echo unknown)"
  log "stopping services and replacing ${INSTALL_DIR} (${OLD_VERSION} -> ${NEW_VERSION})"
  systemctl stop boxpilot.service 2>/dev/null || true
  mv "$INSTALL_DIR" "$PREVIOUS"; HAD_PREVIOUS=1
else
  log "no existing ${INSTALL_DIR}; installing fresh"
fi
mv "$STAGING" "$INSTALL_DIR"

# Units this run replaced, so a rollback can put the old ones back with the old tree.
REPLACED_UNITS=""

rollback() {
  trap - EXIT
  log "rolling back to previous tree"
  systemctl stop boxpilot.service 2>/dev/null || true
  if [ -d "$INSTALL_DIR" ]; then
    rm -rf "${INSTALL_DIR}.failed.${STAMP}"
    mv "$INSTALL_DIR" "${INSTALL_DIR}.failed.${STAMP}"
  fi
  [ -d "$PREVIOUS" ] && mv "$PREVIOUS" "$INSTALL_DIR"
  # Old code under new unit files would keep failing for the same reason the upgrade did.
  for name in $REPLACED_UNITS; do
    [ -f "/etc/systemd/system/${name}.pre-${STAMP}" ] || continue
    mv "/etc/systemd/system/${name}.pre-${STAMP}" "/etc/systemd/system/${name}"
    log "restored unit ${name}"
  done
  systemctl daemon-reload 2>/dev/null || true
  systemctl restart boxpilot-helper.service 2>/dev/null || true
  systemctl restart boxpilot.service 2>/dev/null || true
  fail "upgrade failed; previous tree restored (failed tree kept at ${INSTALL_DIR}.failed.${STAMP})"
}

# From here until the health check passes, any failure must put the old BoxPilot back rather than
# leave the service stopped. Without this a read-only /etc or a full disk stops BoxPilot for good.
if [ "$HAD_PREVIOUS" -eq 1 ]; then trap 'rollback' EXIT; fi

# 4. Units (only when changed; keep a copy of the old one)
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

# 5. Restart and verify
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

# 6. Prune old previous trees.
#
# Both kinds, because only pruning .prev.* is how this server accumulated sixty-nine leftover
# trees: every upgrade that failed its health check left a .failed.<stamp> copy behind and nothing
# ever came back for it. The most recent failure is kept as the evidence for why it did not start.
ls -d "${INSTALL_DIR}".prev.* 2>/dev/null | sort | head -n -"$KEEP_PREVIOUS" | while read -r old; do rm -rf "$old"; log "removed ${old}"; done
ls -d "${INSTALL_DIR}".failed.* 2>/dev/null | sort | head -n -1 | while read -r old; do rm -rf "$old"; log "removed ${old}"; done

log "BoxPilot ${NEW_VERSION} (${REF}) is live; ${UNITS_CHANGED} unit file(s) updated; previous tree at ${PREVIOUS}"
