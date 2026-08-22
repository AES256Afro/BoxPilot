#!/bin/sh
# BoxPilot installer for a fresh Ubuntu Server (also safe to re-run: it upgrades in place).
#
#   curl -fsSL https://raw.githubusercontent.com/AES256Afro/BoxPilot/main/scripts/boxpilot-install.sh | sudo sh -s -- [options]
#
# Options:
#   --ref <branch|tag>        BoxPilot ref to install (default: main)
#   --access <tailscale|lan|local>
#                             tailscale: bind to loopback and publish https://<host>.<tailnet>.ts.net via Tailscale Serve (default when tailscaled is running)
#                             lan:       bind to all interfaces on port 8787 over plain HTTP (default when Tailscale is not running)
#                             local:     bind to loopback only (reach it with an SSH tunnel)
#   --port <n>                web port (default 8787)
#   --node-version <v24.x.y>  pin the Node.js release to install (default: latest v24 LTS)
#   --no-token                do not print a first-owner bootstrap token at the end
#
# What it does: installs curl/tar/xz, Node.js 24 under /opt/node-v<ver> (+ /usr/local/bin symlinks),
# creates the boxpilot system user and /etc/boxpilot, builds the chosen ref into /opt/boxpilot with
# scripts/boxpilot-upgrade.sh, installs and enables the systemd units, configures access, checks
# health, and prints the URL plus a one-time owner bootstrap token.
set -eu
# sudo keeps the caller's umask: a strict one would make /opt and node_modules unreadable to the service user.
umask 022

REPO="${BOXPILOT_REPO:-AES256Afro/BoxPilot}"
REF="main"; ACCESS=""; PORT="8787"; NODE_PIN=""; PRINT_TOKEN=1
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --access) ACCESS="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --node-version) NODE_PIN="$2"; shift 2 ;;
    --no-token) PRINT_TOKEN=0; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 64 ;;
  esac
done

log() { printf '[boxpilot-install] %s\n' "$*"; }
fail() { printf '[boxpilot-install] ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "run with sudo"
[ -f /etc/debian_version ] || fail "this installer targets Ubuntu/Debian"
command -v systemctl >/dev/null 2>&1 || fail "systemd is required"
case "$PORT" in ''|*[!0-9]*) fail "--port must be a number" ;; esac

# 1. Base packages
export DEBIAN_FRONTEND=noninteractive
if ! command -v curl >/dev/null 2>&1 || ! command -v xz >/dev/null 2>&1; then
  log "installing curl, ca-certificates, tar, xz-utils"
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates tar xz-utils >/dev/null
fi

# 2. Node.js 24 (official tarball, SHA-256 verified)
ARCH="$(uname -m)"
case "$ARCH" in x86_64) NODE_ARCH=x64 ;; aarch64|arm64) NODE_ARCH=arm64 ;; *) fail "unsupported architecture $ARCH" ;; esac
have_node_24() { [ -x /usr/local/bin/node ] && [ "$(/usr/local/bin/node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 24 ]; }
if have_node_24 && [ -z "$NODE_PIN" ]; then
  log "Node.js $(/usr/local/bin/node --version) already present at /usr/local/bin/node"
else
  if [ -n "$NODE_PIN" ]; then NODE_VERSION="$NODE_PIN"; else
    NODE_VERSION="$(curl -fsSL https://nodejs.org/dist/index.json | tr -d '\n' | sed 's/},{/}\n{/g' | grep '"version":"v24\.' | grep -v '"lts":false' | head -n 1 | sed 's/.*"version":"\(v24\.[0-9.]*\)".*/\1/')"
    [ -n "$NODE_VERSION" ] || NODE_VERSION="$(curl -fsSL https://nodejs.org/dist/index.json | tr -d '\n' | sed 's/},{/}\n{/g' | grep '"version":"v24\.' | head -n 1 | sed 's/.*"version":"\(v24\.[0-9.]*\)".*/\1/')"
  fi
  [ -n "$NODE_VERSION" ] || fail "could not determine a Node.js 24 release; pass --node-version"
  case "$NODE_VERSION" in v*) ;; *) NODE_VERSION="v$NODE_VERSION" ;; esac
  TARBALL="node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  if [ ! -x "/opt/node-${NODE_VERSION}/bin/node" ]; then
    log "installing Node.js ${NODE_VERSION} (${NODE_ARCH})"
    TMP="$(mktemp -d)"
    curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/${TARBALL}" -o "$TMP/$TARBALL"
    curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
    (cd "$TMP" && grep " ${TARBALL}\$" SHASUMS256.txt | sha256sum -c - >/dev/null) || fail "Node.js tarball checksum mismatch"
    mkdir -p "/opt/node-${NODE_VERSION}"
    tar -xJf "$TMP/$TARBALL" -C "/opt/node-${NODE_VERSION}" --strip-components=1
    rm -rf "$TMP"
  fi
  for bin in node npm npx; do ln -sfn "/opt/node-${NODE_VERSION}/bin/$bin" "/usr/local/bin/$bin"; done
  log "Node.js $(/usr/local/bin/node --version) linked at /usr/local/bin/node"
fi

# 3. Service user, state, config
if ! id boxpilot >/dev/null 2>&1; then
  log "creating the boxpilot system user"
  useradd --system --create-home --home-dir /var/lib/boxpilot --shell /usr/sbin/nologin boxpilot
fi
install -d -m 0700 -o boxpilot -g boxpilot /var/lib/boxpilot
# The helper binds this at start: it must exist, or an independent backup disk mounted later
# stays invisible inside the helper's namespace.
install -d -o root -g root -m 0755 /mnt/boxpilot-backup

install -d -m 0755 /etc/boxpilot

# 4. Build and install the code (delegates to the upgrade script from the same ref)
WORK="$(mktemp -d)"
log "fetching ${REPO}@${REF}"
curl -fsSL "https://codeload.github.com/${REPO}/tar.gz/${REF}" | tar -xz -C "$WORK" --strip-components=1 || fail "could not download ${REPO}@${REF}"
[ -f "$WORK/scripts/boxpilot-upgrade.sh" ] || fail "ref ${REF} has no scripts/boxpilot-upgrade.sh"
[ -f /etc/boxpilot/boxpilot.env ] || install -m 0600 "$WORK/deploy/boxpilot.env.example" /etc/boxpilot/boxpilot.env
[ -f /etc/boxpilot/redaction.json ] || install -m 0640 -o root -g boxpilot "$WORK/deploy/redaction.example.json" /etc/boxpilot/redaction.json
# Re-running the installer is the documented upgrade path, so the health check must use this box's port.
BOXPILOT_REPO="$REPO" BOXPILOT_NODE_BIN=/usr/local/bin/node BOXPILOT_HEALTH_URL="http://127.0.0.1:${PORT}/api/v1/health" sh "$WORK/scripts/boxpilot-upgrade.sh" "$REF"
rm -rf "$WORK"

# 5. Access mode → env file
if [ -z "$ACCESS" ]; then
  if command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1; then ACCESS=tailscale; else ACCESS=lan; fi
fi
set_env() { # set_env KEY VALUE
  if grep -q "^$1=" /etc/boxpilot/boxpilot.env; then sed -i "s|^$1=.*|$1=$2|" /etc/boxpilot/boxpilot.env; else printf '%s=%s\n' "$1" "$2" >> /etc/boxpilot/boxpilot.env; fi
}
set_env BOXPILOT_PORT "$PORT"
case "$ACCESS" in
  tailscale) set_env BOXPILOT_HOST 127.0.0.1; set_env BOXPILOT_COOKIE_SECURE true ;;
  lan)       set_env BOXPILOT_HOST 0.0.0.0;   set_env BOXPILOT_COOKIE_SECURE false ;;
  local)     set_env BOXPILOT_HOST 127.0.0.1; set_env BOXPILOT_COOKIE_SECURE false ;;
  *) fail "--access must be tailscale, lan, or local" ;;
esac

# 6. Enable and start
systemctl daemon-reload
systemctl enable --now boxpilot-helper.service boxpilot.service boxpilot-storage-scan.timer >/dev/null 2>&1 || true
systemctl restart boxpilot.service
attempt=0; HEALTHY=0
while [ "$attempt" -lt 30 ]; do
  attempt=$((attempt + 1))
  if curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/api/v1/health" >/dev/null 2>&1; then HEALTHY=1; break; fi
  sleep 1
done
[ "$HEALTHY" -eq 1 ] || { journalctl -u boxpilot.service -n 20 --no-pager || true; fail "BoxPilot did not answer on port ${PORT}"; }

# 7. Publish
URL=""
case "$ACCESS" in
  tailscale)
    if tailscale serve --bg "http://127.0.0.1:${PORT}" >/dev/null 2>&1; then
      HOST_DNS="$(tailscale status --json 2>/dev/null | sed -n 's/.*"DNSName": *"\([^"]*\)\.".*/\1/p' | head -n 1)"
      URL="https://${HOST_DNS:-<this-host>.<tailnet>.ts.net}"
    else
      log "tailscale serve failed; falling back to an SSH tunnel: ssh -N -L ${PORT}:127.0.0.1:${PORT} <user>@<host> then open http://127.0.0.1:${PORT}"
      URL="http://127.0.0.1:${PORT} (via SSH tunnel)"
    fi ;;
  lan)
    LAN_IP="$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n 1)"
    URL="http://${LAN_IP:-<lan-ip>}:${PORT}" ;;
  local)
    URL="http://127.0.0.1:${PORT} (via SSH tunnel: ssh -N -L ${PORT}:127.0.0.1:${PORT} <user>@<host>)" ;;
esac

# 8. First owner token
TOKEN_LINE=""
if [ "$PRINT_TOKEN" -eq 1 ]; then
  TOKEN_LINE="$(sudo -u boxpilot env BOXPILOT_STATE_DIRECTORY=/var/lib/boxpilot /usr/local/bin/node /opt/boxpilot/scripts/boxpilot-owner.mjs create-bootstrap-token 2>/dev/null | sed -n '2p' || true)"
fi

printf '\n'
log "BoxPilot is installed and running."
log "Open:   ${URL}"
if [ -n "$TOKEN_LINE" ]; then
  log "First-owner bootstrap token (valid 15 minutes; paste it on the setup screen):"
  printf '        %s\n' "$TOKEN_LINE"
elif [ "$PRINT_TOKEN" -eq 1 ]; then
  log "An owner already exists (or the token could not be created). Sign in with your existing account."
fi
log "Re-run this installer any time to upgrade; logs: journalctl -u boxpilot -u boxpilot-helper"
