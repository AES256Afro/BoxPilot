#!/bin/bash
# Every reader of /etc/boxpilot/boxpilot.env against systemd itself: for each env file in a table
# (inline comments, quotes with text after them, export lines, CRLF, duplicates, a quote left open,
# an empty address, ...) and for seeded random ones, a transient unit started with EnvironmentFile=
# on it says what systemd gave it. The port and address the web service takes from that must be what
# the upgrade's, the installer's and the doctor's shell readers say, what server/env-file.mjs says,
# and what the agents runner uses. tests/ubuntu/env-file-parity.mjs has the table.
#
# systemd has no inline comments: `BOXPILOT_PORT=9000   # moved off 8787` gives the service that
# whole string (it listens on 9000: parseInt), and the readers that used it raw rolled back every
# update, restart-looped the agents runner and protected the wrong port in the firewall.
#
#   sudo bash tests/ubuntu/env-file-parity.sh /path/to/node-24
#
# It changes nothing on the machine: transient units only (systemd-run --wait --pipe --collect), and
# a scratch directory it removes. It needs root to start system units, and no npm dependencies.
set -uo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run as root (systemd-run starts system units)" >&2; exit 2; }
NODE="${1:-$(command -v node || true)}"
[ -x "$NODE" ] && [ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -ge 24 ] || { echo "pass a Node.js 24 binary as the first argument" >&2; exit 2; }
command -v systemd-run >/dev/null 2>&1 || { echo "systemd-run is required" >&2; exit 2; }
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
printf 'systemd %s, sh is %s, awk is %s\n' "$(systemctl --version | head -n 1 | cut -d' ' -f2)" "$(readlink -f "$(command -v sh)")" "$(readlink -f "$(command -v awk)")"
exec "$NODE" "${ROOT}/tests/ubuntu/env-file-parity.mjs"
