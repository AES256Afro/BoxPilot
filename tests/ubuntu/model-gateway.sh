#!/bin/bash
# The model gateway on real systemd (M45.3): deploy/boxpilot-model-gateway.service as shipped, the
# real gateway (server/model-gateway/main.mjs), and a key Anthropic will refuse. It checks what only
# systemd can show:
#
#   1. The unit starts from the key file alone (LoadCredential), as its own user in the web
#      service's group, and runs only while the key file exists.
#   2. Its socket opens for the web service's user and for no one else.
#   3. Inside its sandbox the web service's data, the helper's credential store and the root secrets
#      are not there, though systemd handed it the key.
#   4. A call goes out to api.anthropic.com and comes back refused as `auth` (the key is not real,
#      so nothing is billed), and the gateway's ledger gives the reservation back.
#
#   sudo bash tests/ubuntu/model-gateway.sh /path/to/node-24
#
# DISPOSABLE MACHINES ONLY (CI runs it on GitHub's Ubuntu VMs): it creates system users and writes
# /opt/boxpilot, /etc/boxpilot and a unit into /etc/systemd/system.
set -uo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run as root, on a disposable machine" >&2; exit 2; }
NODE="${1:-$(command -v node || true)}"
[ -x "$NODE" ] && [ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -ge 24 ] || { echo "pass a Node.js 24 binary as the first argument" >&2; exit 2; }
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
UNIT=boxpilot-model-gateway.service
KEY_FILE=/etc/boxpilot/secrets/anthropic-api-key
SOCKET=/run/boxpilot-model-gateway/gateway.sock
FAILURES=0

section() { printf '\n==== %s ====\n' "$*"; }
record() { printf '  %s  %s\n' "$1" "$2"; [ "$1" = PASS ] || FAILURES=$((FAILURES + 1)); }
check() { local what="$1"; shift; if "$@"; then record PASS "$what"; else record FAIL "$what"; fi; }
wait_for() { local seconds="$1"; shift; for _ in $(seq 1 "$seconds"); do "$@" && return 0; sleep 1; done; return 1; }

cleanup() {
  systemctl stop "$UNIT" >/dev/null 2>&1 || true
  journalctl -u "$UNIT" -n 30 --no-pager 2>/dev/null | sed 's/^/    journal: /'
}
trap cleanup EXIT

# Ask the gateway as a user: `ask <user> <op>` prints the reply (or the error) as one JSON line.
ask() {
  runuser -u "$1" -- "$NODE" --input-type=module -e "
    import { createGatewayClient } from '/opt/boxpilot/server/model-gateway/socket.mjs';
    const client = createGatewayClient({ socketPath: '${SOCKET}' });
    const request = { model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'Say OK.' }], maxTokens: 16 };
    const asked = '$2' === 'chat' ? client.chat(request, { timeoutMs: 30000 }) : client['$2']();
    asked.then((result) => console.log(JSON.stringify({ ok: true, result })), (error) => console.log(JSON.stringify({ ok: false, code: error.code ?? null, message: error.message })));
  "
}
field() { "$NODE" -e 'const v=JSON.parse(process.argv[1]); const path=process.argv[2].split("."); let x=v; for (const k of path) x=x?.[k]; process.stdout.write(String(x))' "$1" "$2"; }

section "Setting up the gateway as it ships"
id -u boxpilot >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/boxpilot --shell /usr/sbin/nologin boxpilot
id -u boxpilot-model-gateway >/dev/null 2>&1 || useradd --system --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin --user-group boxpilot-model-gateway
[ -x /usr/local/bin/node ] || ln -sf "$NODE" /usr/local/bin/node
rm -rf /opt/boxpilot && install -d -m 0755 /opt/boxpilot
cp -r "${ROOT}/server" "${ROOT}/packages" "${ROOT}/package.json" "${ROOT}/package-lock.json" /opt/boxpilot/
(cd /opt/boxpilot && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null) || { echo "npm ci failed" >&2; exit 1; }
chmod -R a+rX /opt/boxpilot
install -d -m 0755 /etc/boxpilot && install -d -m 0700 /etc/boxpilot/secrets
# A key in Anthropic's shape that Anthropic will refuse: nothing is billed.
printf 'sk-ant-api03-%s\n' "$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-60)" >"$KEY_FILE" && chmod 0600 "$KEY_FILE"
printf '{"capUsd":5}\n' >/etc/boxpilot/model-gateway.json && chmod 0644 /etc/boxpilot/model-gateway.json
# What the sandbox must hide: the web service's data and the helper's store.
install -d -m 0750 -o boxpilot -g boxpilot /var/lib/boxpilot && echo secret >/var/lib/boxpilot/marker
install -d -m 0700 /var/lib/boxpilot-managed && echo secret >/var/lib/boxpilot-managed/credentials.json
install -m 0644 "${ROOT}/deploy/${UNIT}" "/etc/systemd/system/${UNIT}"
systemctl daemon-reload

section "1. It starts from the key file, as its own user"
systemctl start "$UNIT"
check "the unit is active" wait_for 20 systemctl is-active --quiet "$UNIT"
check "the socket is there" wait_for 20 test -S "$SOCKET"
PID="$(systemctl show -p MainPID --value "$UNIT")"
check "it runs as boxpilot-model-gateway" test "$(ps -o user= -p "$PID" | tr -d ' ')" = "boxpilot-model-gateway"
check "in the web service's group" test "$(ps -o group= -p "$PID" | tr -d ' ')" = "boxpilot"
check "with no capabilities" test "$(awk '/^CapEff/ {print $2}' "/proc/${PID}/status")" = "0000000000000000"

section "2. Only the web service's user may open the socket"
STATUS="$(ask boxpilot status)"
echo "    as boxpilot: ${STATUS}"
check "the web service's user reads its status" test "$(field "$STATUS" ok)" = "true"
check "and it says a key is set" test "$(field "$STATUS" result.connected)" = "true"
check "and the cap the owner set" test "$(field "$STATUS" result.capUsd)" = "5"
OTHER="$(ask nobody status)"
echo "    as nobody: ${OTHER}"
check "anyone else is refused" test "$(field "$OTHER" ok)" = "false"
check "the socket is 0660 in the web service's group" test "$(stat -c '%a %G' "$SOCKET")" = "660 boxpilot"

section "3. Inside its sandbox, no one else's secrets"
check "the web service's data is not there" bash -c "! nsenter --target $PID --mount -- cat /var/lib/boxpilot/marker >/dev/null 2>&1"
check "the helper's credential store is not there" bash -c "! nsenter --target $PID --mount -- cat /var/lib/boxpilot-managed/credentials.json >/dev/null 2>&1"
# InaccessiblePaths leaves an empty, unreadable folder in each place: what was in it is gone.
check "the root secrets are not there, its own key file included" bash -c "! nsenter --target $PID --mount -- test -e $KEY_FILE"
# As root inside its mount namespace, so only the read-only mount can refuse the write.
check "and /opt/boxpilot is read-only there, even to root" bash -c "! nsenter --target $PID --mount -- touch /opt/boxpilot/written 2>/dev/null"

section "4. A call reaches Anthropic and is refused for the key"
CHAT="$(ask boxpilot chat)"
echo "    chat: ${CHAT}"
check "refused as auth (the key is not real)" test "$(field "$CHAT" code)" = "auth"
AFTER="$(ask boxpilot status)"
check "nothing counted against the month" test "$(field "$AFTER" result.spentUsd)" = "0"

section "5. Without the key file it does not start"
systemctl stop "$UNIT"
rm -f "$KEY_FILE"
systemctl start "$UNIT" 2>/dev/null || true
check "the unit stays inactive" bash -c "! systemctl is-active --quiet $UNIT"

printf '\n%s\n' "$([ "$FAILURES" -eq 0 ] && echo "every check passed" || echo "${FAILURES} checks failed")"
exit "$([ "$FAILURES" -eq 0 ] && echo 0 || echo 1)"
