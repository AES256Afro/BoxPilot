#!/bin/sh

set -u

boxpilot_failures=0
boxpilot_uri="${BOXPILOT_LIBVIRT_URI:-qemu:///system}"
boxpilot_iso_directory="${BOXPILOT_ISO_DIRECTORY:-/var/lib/libvirt/boot}"
boxpilot_state_directory="${BOXPILOT_STATE_DIRECTORY:-/var/lib/boxpilot}"
boxpilot_port="${BOXPILOT_PORT:-8787}"
boxpilot_helper_socket="${BOXPILOT_HELPER_SOCKET:-/run/boxpilot/helper.sock}"

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

boxpilot_service_user="${BOXPILOT_SERVICE_USER:-boxpilot}"

printf 'BoxPilot host doctor\n'
printf 'Connection: %s\n' "$boxpilot_uri"
printf 'ISO library: %s\n\n' "$boxpilot_iso_directory"
printf 'State directory: %s\n\n' "$boxpilot_state_directory"

if [ "$(uname -s)" = "Linux" ]; then
  boxpilot_pass "Linux host detected: $(uname -r)"
else
  boxpilot_fail "This native deployment requires Linux; detected $(uname -s)"
fi

# Access checks answer for whoever runs this script. Only root and the service account can answer
# for the service; from an ordinary admin login the honest answer is "present, not verifiable here",
# because the socket is deliberately closed to everyone else.
boxpilot_whoami="$(id -un 2>/dev/null || echo unknown)"
if [ "$boxpilot_whoami" = root ] || [ "$boxpilot_whoami" = "$boxpilot_service_user" ]; then
  if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
    boxpilot_pass "/dev/kvm is readable and writable for this host-side doctor session"
  elif [ -S "$boxpilot_helper_socket" ] && [ -w "$boxpilot_helper_socket" ]; then
    boxpilot_pass "KVM and libvirt inspection is delegated to the restricted helper socket"
  else
    boxpilot_fail "neither direct KVM access nor the restricted helper socket is available"
  fi
elif [ -S "$boxpilot_helper_socket" ]; then
  boxpilot_pass "the restricted helper socket is present (only root and $boxpilot_service_user may open it, so this check cannot go further as $boxpilot_whoami)"
elif boxpilot_has_command systemctl && systemctl is-active --quiet boxpilot-helper.service 2>/dev/null; then
  # The socket's own directory is closed to other accounts, so its absence here proves nothing.
  # systemd can still say whether the helper that owns it is running.
  boxpilot_pass "the helper service is running; its socket directory is closed to $boxpilot_whoami, which is how it should be"
elif [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
  boxpilot_pass "/dev/kvm is readable and writable for this host-side doctor session"
else
  boxpilot_fail "the helper service is not running and /dev/kvm is not available to $boxpilot_whoami"
fi

# node is required. virsh/virt-install matter only with virtualization, tailscale only with tailnet
# access — a LAN-only box without them is a supported configuration, not a failure.
for boxpilot_command in node; do
  if boxpilot_has_command "$boxpilot_command"; then
    boxpilot_pass "$boxpilot_command is installed at $(command -v "$boxpilot_command")"
  else
    boxpilot_fail "$boxpilot_command is not installed or not in PATH"
  fi
done
for boxpilot_command in virsh virt-install tailscale; do
  if boxpilot_has_command "$boxpilot_command"; then
    boxpilot_pass "$boxpilot_command is installed at $(command -v "$boxpilot_command")"
  else
    boxpilot_warn "$boxpilot_command is not installed (only needed for $([ "$boxpilot_command" = tailscale ] && echo "tailnet access" || echo "virtual machines"))"
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

# What matters is the service account's reach, not the admin's: a person who administers this box
# is expected to be in libvirt, and warning about that taught nothing.
if id "$boxpilot_service_user" >/dev/null 2>&1; then
  case " $(id -nG "$boxpilot_service_user" 2>/dev/null) " in
    *" libvirt "*|*" kvm "*) boxpilot_warn "the $boxpilot_service_user service account has direct libvirt or kvm group access; it should reach virtualization only through the helper socket" ;;
    *) boxpilot_pass "the $boxpilot_service_user service account has no direct libvirt or kvm group membership" ;;
  esac
else
  boxpilot_warn "the $boxpilot_service_user service account does not exist on this host"
fi

if boxpilot_has_command virsh; then
  if virsh --connect "$boxpilot_uri" uri >/dev/null 2>&1; then
    boxpilot_pass "libvirt system connection is reachable"
  elif [ -S "$boxpilot_helper_socket" ] && [ -w "$boxpilot_helper_socket" ]; then
    boxpilot_pass "direct libvirt access is absent and the restricted helper socket is reachable"
  else
    boxpilot_fail "cannot reach libvirt directly or through the helper boundary"
  fi

  if virsh --connect "$boxpilot_uri" net-info default >/dev/null 2>&1; then
    boxpilot_pass "default libvirt network is defined"
  elif [ -S "$boxpilot_helper_socket" ] && [ -w "$boxpilot_helper_socket" ]; then
    boxpilot_warn "default network inspection is available through the authenticated BoxPilot interface"
  else
    boxpilot_fail "default libvirt network is not defined"
  fi

  if virsh --connect "$boxpilot_uri" pool-info default >/dev/null 2>&1; then
    boxpilot_pass "default libvirt storage pool is defined"
  elif [ -S "$boxpilot_helper_socket" ] && [ -w "$boxpilot_helper_socket" ]; then
    boxpilot_warn "default pool inspection is available through the authenticated BoxPilot interface"
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
elif [ -d "$boxpilot_state_directory" ] && [ "$boxpilot_whoami" != root ] && [ "$boxpilot_whoami" != "$boxpilot_service_user" ]; then
  # 0700 and owned by the service account is what it should be; $boxpilot_whoami not being able to
  # write it is the design, not a fault.
  boxpilot_pass "state directory exists and is closed to other accounts: $boxpilot_state_directory"
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
