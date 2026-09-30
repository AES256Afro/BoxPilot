#!/bin/bash
# M39.2 on a real host: the DNS resilience check and the rehearsal against real dnsmasq, the resolver
# GL.iNet and OpenWrt routers run, and the lease reader against this machine's own DHCP lease.
# tests/ubuntu/dns-fallback-check.mjs does the work; this gives it dnsmasq and a dummy interface
# with four addresses (a "Pi-hole", a "public resolver", and two "routers", one with a fallback).
#
#   sudo bash tests/ubuntu/dns-fallback.sh /path/to/node-24
#
# DISPOSABLE MACHINES ONLY (CI runs it on GitHub's Ubuntu VMs): it installs dnsmasq-base and adds a
# network interface.
set -uo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run as root, on a disposable machine" >&2; exit 2; }
NODE="${1:-$(command -v node || true)}"
[ -x "$NODE" ] && [ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -ge 24 ] || { echo "pass a Node.js 24 binary as the first argument" >&2; exit 2; }
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

cleanup() { ip link del bpdns0 2>/dev/null || true; }
trap cleanup EXIT

if ! command -v dnsmasq >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq >/dev/null && apt-get install -y -qq dnsmasq-base >/dev/null || { echo "could not install dnsmasq-base" >&2; exit 1; }
fi
dnsmasq --version | head -n 1

ip link add bpdns0 type dummy
ip link set bpdns0 up
for last in 1 2 3 4; do ip addr add "10.53.0.${last}/24" dev bpdns0; done

"$NODE" "${ROOT}/tests/ubuntu/dns-fallback-check.mjs"
