#!/bin/sh
# BoxPilot installer for a fresh Ubuntu Server (also safe to re-run: it upgrades in place).
#
#   curl -fsSL https://raw.githubusercontent.com/AES256Afro/BoxPilot/main/scripts/boxpilot-install.sh | sudo sh -s -- [options]
#
# Options:
#   --ref <branch|tag>        BoxPilot ref to install (default: main)
#   --access <tailscale|lan|local>
#                             tailscale: bind to loopback and publish https://<host>.<tailnet>.ts.net via Tailscale Serve (default when tailscaled is running)
#                             lan:       bind to all interfaces over plain HTTP, allowing the port in ufw when it is on (default when Tailscale is not running)
#                             local:     bind to loopback only (reach it with an SSH tunnel)
#   --port <n>                web port, 1024-65535 (default 8787)
#   --node-version <v24.x.y>  pin the Node.js release to install (default: latest v24 LTS)
#   --no-token                do not print a first-owner bootstrap token at the end
#
# Re-running it upgrades in place. An option not given again keeps what /etc/boxpilot/boxpilot.env
# already says: the port and access the box was installed with, and a LAN choice made in Settings.
#
# What it does: installs curl/tar/xz, Node.js 24 under /opt/node-v<ver> (+ /usr/local/bin symlinks),
# creates the boxpilot system user and /etc/boxpilot, builds the chosen ref into /opt/boxpilot with
# scripts/boxpilot-upgrade.sh, installs and enables the systemd units, configures access, checks
# health, and prints the URL plus a one-time owner bootstrap token.
set -eu
# sudo keeps the caller's umask: a strict one would make /opt and node_modules unreadable to the service user.
umask 022

REPO="${BOXPILOT_REPO:-AES256Afro/BoxPilot}"
REF="main"; ACCESS=""; PORT=""; PORT_GIVEN=0; NODE_PIN=""; PRINT_TOKEN=1

# Reading help out of "$0" fails under `curl | sh`, where $0 is "sh".
usage() {
  cat <<'USAGE'
Install BoxPilot on a fresh Ubuntu Server.

  --ref <tag|branch>     release tag or branch to install (default: main)
  --access <lan|tailscale|local>
                         how the web UI is reachable (default: tailscale when it
                         is running, otherwise lan; a re-run keeps the current one)
  --port <number>        port for the web UI, 1024-65535 (default: 8787; a re-run keeps the
                         current one)
  --node-version <ver>   pin a Node.js 24 release instead of the newest
  --no-token             do not print the one-time owner token
  -h, --help             show this message

Re-run this installer at any time to upgrade an existing install.
USAGE
}

need_value() {
  [ $# -ge 2 ] || { printf 'Option %s needs a value\n' "$1" >&2; exit 64; }
}
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) need_value "$@"; REF="$2"; shift 2 ;;
    --access) need_value "$@"; ACCESS="$2"; shift 2 ;;
    --port) need_value "$@"; PORT="$2"; PORT_GIVEN=1; shift 2 ;;
    --node-version) need_value "$@"; NODE_PIN="$2"; shift 2 ;;
    --no-token) PRINT_TOKEN=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 64 ;;
  esac
done

log() { printf '[boxpilot-install] %s\n' "$*"; }
fail() { printf '[boxpilot-install] ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "run with sudo"
[ -f /etc/debian_version ] || fail "this installer targets Ubuntu/Debian"
command -v systemctl >/dev/null 2>&1 || fail "systemd is required"
# Both checked before anything is downloaded or changed. The web service runs as the boxpilot user
# with no capabilities, so it cannot listen below 1024; --port 80 (or 0, or 70000) used to be
# written to the env file anyway, leaving a service that could not start.
port_ok() { # port_ok N: N is a port the web service can listen on
  case "$1" in [1-9][0-9][0-9][0-9]|[1-9][0-9][0-9][0-9][0-9]) [ "$1" -ge 1024 ] && [ "$1" -le 65535 ] ;; *) return 1 ;; esac
}
[ "$PORT_GIVEN" -eq 0 ] || port_ok "$PORT" || fail "--port must be a number from 1024 to 65535 (got '${PORT}')"
case "$ACCESS" in ''|tailscale|lan|local) ;; *) fail "--access must be tailscale, lan, or local" ;; esac

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
  # npm decides completeness, not node: an extraction interrupted after bin/node would otherwise
  # satisfy the guard forever and never be repaired by re-running.
  if [ ! -x "/opt/node-${NODE_VERSION}/bin/node" ] || [ ! -d "/opt/node-${NODE_VERSION}/lib/node_modules/npm" ]; then
    log "installing Node.js ${NODE_VERSION} (${NODE_ARCH})"
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT
    curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/${TARBALL}" -o "$TMP/$TARBALL"
    curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
    (cd "$TMP" && grep " ${TARBALL}\$" SHASUMS256.txt | sha256sum -c - >/dev/null) || fail "Node.js tarball checksum mismatch"
    # Unpack aside and move into place in one step, so a half-extracted tree is never left behind.
    mkdir -p "$TMP/tree"
    tar -xJf "$TMP/$TARBALL" -C "$TMP/tree" --strip-components=1
    [ -x "$TMP/tree/bin/node" ] && [ -d "$TMP/tree/lib/node_modules/npm" ] || fail "the Node.js tarball did not contain a complete runtime"
    rm -rf "/opt/node-${NODE_VERSION}.partial"
    mv "$TMP/tree" "/opt/node-${NODE_VERSION}.partial"
    rm -rf "/opt/node-${NODE_VERSION}"
    mv "/opt/node-${NODE_VERSION}.partial" "/opt/node-${NODE_VERSION}"
    rm -rf "$TMP"
    trap - EXIT
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
# The helper's sandbox is given /mnt/boxpilot at start and skips it when it is missing; the backup
# destination (a NAS share or a drive) is mounted below it, at /mnt/boxpilot/backup. That mount point
# is made only when it is missing: on a re-run it is the destination itself, and `install -d` on it
# opened it - waking its automount (thirty seconds, then "No such device" with the NAS off, which
# stopped the installer), failing on a root-squashed NFS share, or handing the NAS's folder to root.
# `[ -e ]` is a stat, which does not wake an automount.
install -d -o root -g root -m 0755 /mnt/boxpilot
[ -e /mnt/boxpilot/backup ] || install -d -o root -g root -m 0755 /mnt/boxpilot/backup

install -d -m 0755 /etc/boxpilot
# A re-run finds the env file it wrote, saying how this box is reached now: the --port and --access
# it was installed with, and a LAN choice made in Settings since. An option not given again keeps them.
# Only after an install that finished (it enables the service last): a first run that stopped before
# that left the example's settings, which are not a choice anyone made.
ENV_FILE=/etc/boxpilot/boxpilot.env
if [ -f "$ENV_FILE" ] && systemctl is-enabled boxpilot.service >/dev/null 2>&1; then REINSTALL=1; else REINSTALL=0; fi
# env_value KEY: the value of the env file's last KEY= line, read as systemd reads it (a CR ends the
# line; blanks before the key, around "=" and after the value are not part of it), quotes dropped.
env_value() {
  tr -d '\r' < "$ENV_FILE" | sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" | tail -n 1 | sed "s/[[:space:]]*\$//; s/^[\"']//; s/[\"']\$//"
}
# set_env KEY VALUE: KEY's lines (however they are written) become KEY=VALUE; appended when it has none.
set_env() {
  if grep -q "^[[:space:]]*$1[[:space:]]*=" "$ENV_FILE"; then
    sed -i "s|^[[:space:]]*$1[[:space:]]*=.*|$1=$2|" "$ENV_FILE"
  else
    # A file edited by hand may not end in a newline; the new line must not join its last one.
    [ -z "$(tail -c 1 "$ENV_FILE")" ] || printf '\n' >> "$ENV_FILE"
    printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
  fi
}
health_url() { # health_url HOST PORT: the web service's health check, as this machine reaches it
  case "$1" in ''|0.0.0.0|::) set -- 127.0.0.1 "$2" ;; *:*) set -- "[$1]" "$2" ;; esac
  printf 'http://%s:%s/api/v1/health' "$1" "${2:-8787}"
}

# 4. Download the chosen ref (its upgrade script builds and installs it, step 6)
WORK="$(mktemp -d)"
log "fetching ${REPO}@${REF}"
curl -fsSL "https://codeload.github.com/${REPO}/tar.gz/${REF}" | tar -xz -C "$WORK" --strip-components=1 || fail "could not download ${REPO}@${REF}"
[ -f "$WORK/scripts/boxpilot-upgrade.sh" ] || fail "ref ${REF} has no scripts/boxpilot-upgrade.sh"
[ -f "$ENV_FILE" ] || install -m 0600 "$WORK/deploy/boxpilot.env.example" "$ENV_FILE"
[ -f /etc/boxpilot/redaction.json ] || install -m 0640 -o root -g boxpilot "$WORK/deploy/redaction.example.json" /etc/boxpilot/redaction.json
LIVE_PORT="$(env_value BOXPILOT_PORT)"; LIVE_PORT="${LIVE_PORT:-8787}"
LIVE_HOST="$(env_value BOXPILOT_HOST)"
[ "$PORT_GIVEN" -eq 1 ] || PORT="$LIVE_PORT"

# 5. Port and access mode → env file, before the upgrade restarts the service on it.
#
# They used to be written after it, so the upgrade restarted the service on the old port and
# checked that: a box whose env file named a port the service could not answer on (taken by
# something else) rolled back and stopped there, and re-running with a good --port never got as far
# as writing it. What the env file said is kept, and put back if the box does not come up on the
# new settings, so a bad choice leaves it as it was.
ENV_BEFORE="$(mktemp)"
cat "$ENV_FILE" > "$ENV_BEFORE"
put_env_back() {
  # Once only: the copy is gone after the first, and `cat` of a missing copy would empty the env file.
  [ -f "$ENV_BEFORE" ] || return 0
  # Not cut short by a second signal, nor by a terminal that has gone: it is what puts the box back.
  trap '' HUP INT TERM PIPE
  # A first install has nothing to go back to: the example's settings were never anyone's choice.
  if [ "$REINSTALL" -eq 1 ] && ! cmp -s "$ENV_BEFORE" "$ENV_FILE"; then
    cat "$ENV_BEFORE" > "$ENV_FILE"
    systemctl restart boxpilot.service || true
    log "put ${ENV_FILE} back as it was (port ${LIVE_PORT}, listening on ${LIVE_HOST:-127.0.0.1}) and restarted BoxPilot on it" || true
  fi
  rm -f "$ENV_BEFORE"
}
# From here until BoxPilot answers on the new settings, a signal puts the old ones back too: an SSH
# session dropping during `curl | sudo sh -s -- --port 9100` (HUP), Ctrl-C, a TERM, or a write to a
# terminal or pipe that has gone (PIPE). It used to leave 9100 in the env file, where the service
# moved at its next restart (or at once, when the upgrade's rollback restarted the old version), with
# neither ufw nor Tailscale Serve following it. dash runs a trap once the command it waits for has
# finished, so an upgrade that is rolling back finishes first.
trap 'put_env_back; rm -rf "$WORK"; exit 1' HUP INT TERM PIPE
set_env BOXPILOT_PORT "$PORT"
if [ -z "$ACCESS" ] && [ "$REINSTALL" -eq 1 ]; then
  # A re-run without --access: BOXPILOT_HOST and BOXPILOT_COOKIE_SECURE stay as the env file has them.
  # It used to put the default back, turning a local install into a LAN one and undoing a LAN choice
  # made in Settings. The name is only for the address printed below.
  case "$LIVE_HOST" in
    ''|127.0.0.1|localhost|::1) if [ "$(env_value BOXPILOT_COOKIE_SECURE)" = true ]; then ACCESS=tailscale; else ACCESS=local; fi ;;
    *) ACCESS=lan ;;
  esac
  log "keeping how BoxPilot is reached (listening on ${LIVE_HOST:-127.0.0.1}); pass --access to change it"
else
  if [ -z "$ACCESS" ]; then
    if command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1; then ACCESS=tailscale; else ACCESS=lan; fi
  fi
  case "$ACCESS" in
    tailscale) set_env BOXPILOT_HOST 127.0.0.1; set_env BOXPILOT_COOKIE_SECURE true ;;
    lan)       set_env BOXPILOT_HOST 0.0.0.0;   set_env BOXPILOT_COOKIE_SECURE false ;;
    local)     set_env BOXPILOT_HOST 127.0.0.1; set_env BOXPILOT_COOKIE_SECURE false ;;
  esac
fi
WEB_HOST="$(env_value BOXPILOT_HOST)"
HEALTH_URL="$(health_url "$WEB_HOST" "$PORT")"

# 6. Build and install the code (delegates to the upgrade script from the same ref). Re-running the
# installer is the documented upgrade path: the upgrade restarts the service on the env file as it
# is now, so the port and address written above are the ones it checks.
if ! BOXPILOT_REPO="$REPO" BOXPILOT_NODE_BIN=/usr/local/bin/node BOXPILOT_HEALTH_URL="$HEALTH_URL" sh "$WORK/scripts/boxpilot-upgrade.sh" "$REF"; then
  rm -rf "$WORK"
  put_env_back
  fail "BoxPilot ${REF} was not installed (its health check was ${HEALTH_URL}); the upgrade's lines above say why"
fi
rm -rf "$WORK"

# 7. Enable and start
systemctl daemon-reload
systemctl enable --now boxpilot-helper.service boxpilot.service boxpilot-storage-scan.timer >/dev/null 2>&1 || true
systemctl restart boxpilot.service || true
attempt=0; HEALTHY=0
while [ "$attempt" -lt 30 ]; do
  attempt=$((attempt + 1))
  if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then HEALTHY=1; break; fi
  sleep 1
done
if [ "$HEALTHY" -ne 1 ]; then
  journalctl -u boxpilot.service -n 20 --no-pager || true
  put_env_back
  fail "BoxPilot did not answer on port ${PORT}"
fi
rm -f "$ENV_BEFORE"
trap - HUP INT TERM PIPE

# On every address, with ufw on, the port has to be open for the LAN to reach it: Settings opens it
# when it turns the LAN on (server/tasks/web-bind.mjs), and the installer did not.
case "$WEB_HOST" in
  0.0.0.0|::)
    if command -v ufw >/dev/null 2>&1 && LC_ALL=C ufw status 2>/dev/null | grep -q '^Status: active'; then
      if ufw allow "${PORT}/tcp" comment "BoxPilot keeps BoxPilot reachable" >/dev/null 2>&1; then
        log "ufw is on: allowed ${PORT}/tcp for BoxPilot"
      else
        log "ufw is on and ${PORT}/tcp could not be allowed; the LAN cannot reach BoxPilot until it is (sudo ufw allow ${PORT}/tcp)"
      fi
    fi ;;
esac

# 8. Publish
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

# 9. First owner token
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
