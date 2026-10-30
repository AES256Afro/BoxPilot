#!/bin/bash
# M39.2 for a server with a hand-set address: the real Pi-hole image the catalog pins, asked by eight
# "devices" and a "router" from their own addresses on a dummy interface, then its own database read
# the way the helper reads it. tests/ubuntu/pihole-askers-check.mjs does the asking and checking.
#
#   sudo bash tests/ubuntu/pihole-askers.sh /path/to/node-24
#
# DISPOSABLE MACHINES ONLY (CI runs it on GitHub's Ubuntu VMs): it adds a network interface and runs
# a container named bp-pi-hole on the host's network.
set -uo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run as root, on a disposable machine" >&2; exit 2; }
NODE="${1:-$(command -v node || true)}"
[ -x "$NODE" ] && [ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -ge 24 ] || { echo "pass a Node.js 24 binary as the first argument" >&2; exit 2; }
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="$(awk '/^  reference:/ { print $2; exit }' "${ROOT}/catalog/pi-hole.yaml")"
[ -n "$IMAGE" ] || { echo "could not read Pi-hole's image from catalog/pi-hole.yaml" >&2; exit 1; }

cleanup() {
  docker logs --tail 30 bp-pi-hole 2>&1 | sed 's/^/    pihole: /' || true
  docker rm -f bp-pi-hole >/dev/null 2>&1 || true
  ip link del bpask0 2>/dev/null || true
}
trap cleanup EXIT

ip link add bpask0 type dummy
ip link set bpask0 up
for last in 1 2 11 12 13 14 15 16 17 18; do ip addr add "10.54.0.${last}/24" dev bpask0; done

echo "Pi-hole image: ${IMAGE}"
docker pull -q "$IMAGE"
# As BoxPilot runs it (host network), answering only on the dummy interface so the runner's own
# resolver keeps port 53 on loopback; the database is written every ten seconds instead of sixty.
docker run -d --name bp-pi-hole --network host \
  -e TZ=Etc/UTC -e FTLCONF_webserver_api_password=boxpilot-test -e FTLCONF_dns_upstreams=9.9.9.9 \
  -e FTLCONF_dns_listeningMode=BIND -e FTLCONF_dns_interface=bpask0 \
  -e FTLCONF_webserver_port=18084 -e FTLCONF_database_DBinterval=10 \
  "$IMAGE" >/dev/null

"$NODE" "${ROOT}/tests/ubuntu/pihole-askers-check.mjs"
