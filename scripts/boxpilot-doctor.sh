#!/bin/sh

set -u

boxpilot_failures=0
boxpilot_uri="${BOXPILOT_LIBVIRT_URI:-qemu:///system}"
boxpilot_iso_directory="${BOXPILOT_ISO_DIRECTORY:-/var/lib/libvirt/boot}"
boxpilot_state_directory="${BOXPILOT_STATE_DIRECTORY:-/var/lib/boxpilot}"
boxpilot_port="${BOXPILOT_PORT:-8787}"

boxpilot_pass() {
  printf '[PASS] %s\n' "$1"
}

boxpilot_warn() {
  printf '[WARN] %s\n' "$1"
}

boxpilot_fail() {
  printf '[FAIL] %s\n' "$1"
  boxpilot_failures=$((boxpilot_failures + 1))
}

boxpilot_has_command() {
  command -v "$1" >/dev/null 2>&1
}

printf 'BoxPilot host doctor\n'
printf 'Connection: %s\n' "$boxpilot_uri"
printf 'ISO library: %s\n\n' "$boxpilot_iso_directory"
printf 'State directory: %s\n\n' "$boxpilot_state_directory"

if [ "$(uname -s)" = "Linux" ]; then
  boxpilot_pass "Linux host detected: $(uname -r)"
else
  boxpilot_fail "This native deployment requires Linux; detected $(uname -s)"
fi

if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
  boxpilot_pass "/dev/kvm is readable and writable by $(id -un)"
else
  boxpilot_fail "/dev/kvm access is unavailable for $(id -un)"
fi

for boxpilot_command in node virsh virt-install tailscale; do
  if boxpilot_has_command "$boxpilot_command"; then
    boxpilot_pass "$boxpilot_command is installed at $(command -v "$boxpilot_command")"
  else
    boxpilot_fail "$boxpilot_command is not installed or not in PATH"
  fi
done

if boxpilot_has_command node; then
  boxpilot_node_major="$(node --version | tr -d 'v' | cut -d. -f1)"
  if [ "$boxpilot_node_major" -ge 24 ] 2>/dev/null; then
    boxpilot_pass "Node.js $(node --version) satisfies the version requirement"
  else
    boxpilot_fail "Node.js 24 or newer is required; detected $(node --version)"
  fi
fi

case " $(id -nG) " in
  *" libvirt "*) boxpilot_pass "$(id -un) belongs to libvirt" ;;
  *) boxpilot_fail "$(id -un) does not belong to libvirt" ;;
esac

case " $(id -nG) " in
  *" kvm "*) boxpilot_pass "$(id -un) belongs to kvm" ;;
  *) boxpilot_fail "$(id -un) does not belong to kvm" ;;
esac

if boxpilot_has_command virsh; then
  if virsh --connect "$boxpilot_uri" uri >/dev/null 2>&1; then
    boxpilot_pass "libvirt system connection is reachable"
  else
    boxpilot_fail "cannot connect to libvirt at $boxpilot_uri"
  fi

  if virsh --connect "$boxpilot_uri" net-info default >/dev/null 2>&1; then
    boxpilot_pass "default libvirt network is defined"
  else
    boxpilot_fail "default libvirt network is not defined"
  fi

  if virsh --connect "$boxpilot_uri" pool-info default >/dev/null 2>&1; then
    boxpilot_pass "default libvirt storage pool is defined"
  else
    boxpilot_fail "default libvirt storage pool is not defined"
  fi
fi

if [ -d "$boxpilot_iso_directory" ] && [ -r "$boxpilot_iso_directory" ]; then
  boxpilot_iso_count="$(find "$boxpilot_iso_directory" -maxdepth 1 -type f -name '*.iso' -print 2>/dev/null | wc -l | tr -d ' ')"
  boxpilot_pass "managed ISO directory is readable with $boxpilot_iso_count ISO file(s)"
else
  boxpilot_warn "managed ISO directory is missing or unreadable: $boxpilot_iso_directory"
fi

if [ -d "$boxpilot_state_directory" ] && [ -w "$boxpilot_state_directory" ]; then
  boxpilot_pass "state directory is writable for redacted audit events"
else
  boxpilot_warn "state directory is missing or not writable: $boxpilot_state_directory"
fi

if boxpilot_has_command curl && curl --max-time 3 --fail --silent "http://127.0.0.1:${boxpilot_port}/api/v1/health" >/dev/null 2>&1; then
  boxpilot_pass "BoxPilot health endpoint responds on loopback port $boxpilot_port"
elif boxpilot_has_command wget && wget -qO- "http://127.0.0.1:${boxpilot_port}/api/v1/health" >/dev/null 2>&1; then
  boxpilot_pass "BoxPilot health endpoint responds on loopback port $boxpilot_port"
else
  boxpilot_warn "BoxPilot health endpoint is not responding on loopback port $boxpilot_port"
fi

if boxpilot_has_command tailscale; then
  if tailscale status >/dev/null 2>&1; then
    boxpilot_pass "Tailscale is connected"
  else
    boxpilot_warn "Tailscale is installed but not connected"
  fi
  if tailscale serve status 2>/dev/null | grep -q 'https://'; then
    boxpilot_pass "Tailscale Serve reports a private HTTPS URL"
  else
    boxpilot_warn "Tailscale Serve does not report a private HTTPS URL"
  fi
fi

printf '\n'
if [ "$boxpilot_failures" -eq 0 ]; then
  printf 'Doctor result: ready for BoxPilot virtualization checks.\n'
  exit 0
fi

printf 'Doctor result: %s required check(s) failed. Correct them and run this script again.\n' "$boxpilot_failures"
exit 1
