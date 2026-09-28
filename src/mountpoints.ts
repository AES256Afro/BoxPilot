/**
 * Where a mount of a given name lands: /mnt/<name>, except the backup destination, which sits under
 * /mnt/boxpilot so the root helper can be given the folder instead of the share's automount point.
 * Mirrors server/backup-mount.mjs; server/backup-mount.test.mjs fails if the two disagree.
 */
export const BACKUP_MOUNT_NAME = "boxpilot-backup";
export const BACKUP_MOUNTPOINT = "/mnt/boxpilot/backup";

export function mountpointFor(name: string): string {
  return name === BACKUP_MOUNT_NAME ? BACKUP_MOUNTPOINT : `/mnt/${name}`;
}
