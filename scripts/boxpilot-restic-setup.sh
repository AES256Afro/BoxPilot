#!/bin/sh

set -eu

boxpilot_mount="${BOXPILOT_VM_BACKUP_MOUNT:-/mnt/boxpilot-backup}"
boxpilot_repository="$boxpilot_mount/restic-vm"
boxpilot_secret_directory="/etc/boxpilot/secrets"
boxpilot_password_file="$boxpilot_secret_directory/vm-backup-restic-password"

if [ "$(id -u)" -ne 0 ]; then
  printf 'Run this setup from the server terminal with sudo.\n' >&2
  exit 1
fi

case "$boxpilot_mount" in
  /mnt/?*|/media/?*) ;;
  *) printf 'The backup mount must be a dedicated path below /mnt or /media.\n' >&2; exit 1 ;;
esac

if [ -L "$boxpilot_mount" ] || [ ! -d "$boxpilot_mount" ]; then
  printf 'The backup mount must be an existing real directory, not a symbolic link.\n' >&2
  exit 1
fi

for boxpilot_command in restic findmnt stat; do
  if ! command -v "$boxpilot_command" >/dev/null 2>&1; then
    printf '%s is required. Install it before continuing.\n' "$boxpilot_command" >&2
    exit 1
  fi
done

boxpilot_exact_mount="$(findmnt --mountpoint "$boxpilot_mount" --noheadings --output TARGET 2>/dev/null || true)"
if [ "$boxpilot_exact_mount" != "$boxpilot_mount" ]; then
  printf '%s is not an active exact mountpoint. Mount an external disk or NAS first.\n' "$boxpilot_mount" >&2
  exit 1
fi

boxpilot_destination_device="$(stat -c %d "$boxpilot_mount")"
boxpilot_state_device="$(stat -c %d /var/lib/boxpilot-managed)"
boxpilot_image_device="$(stat -c %d /var/lib/libvirt/images)"
if [ "$boxpilot_destination_device" = "$boxpilot_state_device" ] || [ "$boxpilot_destination_device" = "$boxpilot_image_device" ]; then
  printf 'The destination is on the same filesystem as this server\047s data, so it is not independent.\n' >&2
  exit 1
fi

install -d -o root -g root -m 0700 "$boxpilot_secret_directory"

if [ -L "$boxpilot_password_file" ]; then
  printf 'The restic password file cannot be a symbolic link.\n' >&2
  exit 1
fi

if [ ! -f "$boxpilot_password_file" ]; then
  if [ ! -t 0 ]; then
    printf 'Run this script from an interactive terminal so the password is not passed as an argument.\n' >&2
    exit 1
  fi
  trap 'stty echo 2>/dev/null || true' EXIT HUP INT TERM
  printf 'Create a restic repository password with at least 16 characters: '
  stty -echo
  IFS= read -r boxpilot_password_one
  stty echo
  printf '\nRepeat the password: '
  stty -echo
  IFS= read -r boxpilot_password_two
  stty echo
  printf '\n'
  if [ "$boxpilot_password_one" != "$boxpilot_password_two" ] || [ "${#boxpilot_password_one}" -lt 16 ]; then
    unset boxpilot_password_one boxpilot_password_two
    printf 'Passwords did not match or were shorter than 16 characters. No secret was written.\n' >&2
    exit 1
  fi
  umask 077
  boxpilot_temporary_password="$(mktemp "$boxpilot_secret_directory/vm-backup-restic-password.tmp.XXXXXX")"
  printf '%s\n' "$boxpilot_password_one" > "$boxpilot_temporary_password"
  unset boxpilot_password_one boxpilot_password_two
  chown root:root "$boxpilot_temporary_password"
  chmod 0600 "$boxpilot_temporary_password"
  mv "$boxpilot_temporary_password" "$boxpilot_password_file"
fi

boxpilot_password_size="$(stat -c %s "$boxpilot_password_file")"
if [ "$(stat -c %U:%G "$boxpilot_password_file")" != "root:root" ] || [ "$(stat -c %a "$boxpilot_password_file")" != "600" ] || [ "$boxpilot_password_size" -lt 16 ] || [ "$boxpilot_password_size" -gt 4096 ]; then
  printf 'The restic password file must be root:root mode 0600 and contain 16 to 4096 bytes.\n' >&2
  exit 1
fi

if [ -e "$boxpilot_repository/config" ]; then
  restic --repo "$boxpilot_repository" --password-file "$boxpilot_password_file" snapshots >/dev/null
  printf 'The encrypted restic repository is already initialized and readable.\n'
else
  restic --repo "$boxpilot_repository" --password-file "$boxpilot_password_file" init
fi

printf 'Store a separate recovery copy of the repository password outside this server.\n'
printf 'Restart BoxPilot, then verify the destination in Virtual Machines.\n'
