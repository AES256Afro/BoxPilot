#!/bin/bash
# The file server's limits on a real Samba (the security audit's file-sharing fix): the root tasks
# samba.apply and samba.user.set, run as the root task runs them, against the runner's own smbd.
#
#   sudo bash tests/ubuntu/samba-boundaries.sh /path/to/node-24
#
# DISPOSABLE MACHINES ONLY (CI runs it on GitHub's Ubuntu VMs): it installs Samba and rewrites
# /etc/samba/smb.conf.
#
#   1. A share whose folder leads into /etc through a link, and one whose path is spelled to reach
#      /etc, are refused before smb.conf is written.
#   2. root and a system account BoxPilot did not make get no Samba password.
#   3. An ordinary share applies: testparm accepts what BoxPilot writes, smbd - started by the
#      package, listening everywhere - ends up listening only where smb.conf says, and a user
#      BoxPilot made lists the share.
#   4. root cannot sign in even with a Samba password someone set by hand: smb.conf names it an
#      invalid user.
set -uo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run as root, on a disposable machine" >&2; exit 2; }
NODE="${1:-$(command -v node || true)}"
[ -x "$NODE" ] && [ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -ge 24 ] || { echo "pass a Node.js 24 binary as the first argument" >&2; exit 2; }
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SHARE=/srv/bp-audit-share
LINK=/srv/bp-audit-link
USER_NAME=bpaudit
USER_PASSWORD="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)"
ROOT_PASSWORD="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)"
FAILED=0

section() { printf '\n== %s\n' "$*"; }
pass() { printf '   ok: %s\n' "$*"; }
failed() { printf '   FAILED: %s\n' "$*"; FAILED=1; }

section "Prepare: Samba on 127.0.0.1"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
# samba-vfs-modules: the fruit and streams_xattr modules BoxPilot's smb.conf names.
apt-get install -y -qq --no-install-recommends samba samba-vfs-modules smbclient >/dev/null
systemctl stop nmbd 2>/dev/null; systemctl disable nmbd 2>/dev/null
install -d -m 0755 "$SHARE"
echo "served" > "${SHARE}/hello.txt"
ln -sfn /etc "$LINK"
printf '   %s\n' "$(smbd --version)"

section "1-3. The root tasks, as boxpilot-run runs them"
BP_ROOT="$ROOT" BP_SHARE="$SHARE" BP_LINK="$LINK" BP_USER="$USER_NAME" BP_PASSWORD="$USER_PASSWORD" "$NODE" --input-type=module -e '
const { sambaApply, sambaUserSet } = await import(`${process.env.BP_ROOT}/server/tasks/samba.mjs`);
let failures = 0;
const refused = async (what, work, pattern) => {
  try { await work(); console.log(`   FAILED: ${what} was not refused`); failures += 1; }
  catch (error) { if (pattern.test(error.message)) console.log(`   ok: ${what} refused (${error.message.slice(0, 120)})`); else { console.log(`   FAILED: ${what}: ${error.message}`); failures += 1; } }
};
const log = (line) => console.log(`      task: ${line}`);
await refused("a share whose folder links into /etc", () => sambaApply({ shares: [{ name: "Linked", path: process.env.BP_LINK }] }, { log }), /leads to \/etc/);
await refused("a share whose path is spelled to reach /etc", () => sambaApply({ shares: [{ name: "Dotted", path: "/./etc" }] }, { log }), /system locations/);
await refused("a Samba password for root", () => sambaUserSet({ username: "root", password: "long enough pw" }, { log }), /system account/);
await refused("a Samba password for daemon", () => sambaUserSet({ username: "daemon", password: "long enough pw" }, { log }), /system account/);
const applied = await sambaApply({ shares: [{ name: "Audit", path: process.env.BP_SHARE, readOnly: false }] }, { log });
console.log(`   ok: applied ${JSON.stringify(applied.shares)} listening on ${JSON.stringify(applied.listening)}`);
// Tailnet scope: loopback and tailscale0 only (this runner has no tailscale0), never every address.
if (applied.listening.some((address) => /^(0\.0\.0\.0|\[::\]|\*):445$/.test(address))) { console.log("   FAILED: smbd listens on every address after a tailnet-only apply"); failures += 1; }
else console.log("   ok: smbd listens only where smb.conf says");
await sambaUserSet({ username: process.env.BP_USER, password: process.env.BP_PASSWORD }, { log });
console.log(`   ok: made ${process.env.BP_USER} a file-server user`);
process.exitCode = failures ? 1 : 0;
' || FAILED=1

if grep -q '^   invalid users = root$' /etc/samba/smb.conf; then pass "smb.conf names root an invalid user"; else failed "smb.conf does not name root an invalid user"; fi
if testparm -s --suppress-prompt /etc/samba/smb.conf >/dev/null 2>&1; then pass "testparm accepts BoxPilot's smb.conf"; else failed "testparm rejects BoxPilot's smb.conf"; fi
if listing="$(smbclient "//127.0.0.1/Audit" -U "${USER_NAME}%${USER_PASSWORD}" -m SMB3 -c ls 2>&1)" && grep -q hello.txt <<<"$listing"; then
  pass "${USER_NAME} lists the share"
else
  failed "${USER_NAME} could not list the share: $(tail -n 2 <<<"$listing")"
fi

section "4. root, with a Samba password set by hand"
printf '%s\n%s\n' "$ROOT_PASSWORD" "$ROOT_PASSWORD" | smbpasswd -a -s root >/dev/null
if answer="$(smbclient "//127.0.0.1/Audit" -U "root%${ROOT_PASSWORD}" -m SMB3 -c ls 2>&1)"; then
  failed "root signed in: $(tail -n 2 <<<"$answer")"
else
  pass "root is refused: $(grep -o 'NT_STATUS_[A-Z_]*' <<<"$answer" | head -n 1)"
fi

section "Clean up"
smbpasswd -x root >/dev/null 2>&1
smbpasswd -x "$USER_NAME" >/dev/null 2>&1
userdel "$USER_NAME" 2>/dev/null
rm -f "$LINK"
rm -rf "$SHARE"
systemctl stop smbd 2>/dev/null

[ "$FAILED" -eq 0 ] && { echo; echo "samba-boundaries: all checks passed"; exit 0; }
echo; echo "samba-boundaries: FAILED" >&2
exit 1
