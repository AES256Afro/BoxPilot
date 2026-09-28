/**
 * Where the backup destination is mounted.
 *
 * Every other drive and share BoxPilot mounts sits at /mnt/<name>. The backup destination is the
 * exception because it is the one mount the root helper writes to, so the helper's sandbox has to
 * be given it (ReadWritePaths= in deploy/boxpilot-helper.service), and a network share's
 * automount point cannot be given to a sandbox: setting the sandbox up resolves the path, which
 * fires the automount, and with the NAS off that mount fails with "No such device" and so does
 * the helper, at every restart for as long as the NAS stays off. systemd 258 and later resolve
 * those paths through automounts on purpose; 255 fires them too, from the pass that sets nosuid,
 * and waits. A folder above the mount point is not an automount point, so the helper is given
 * /mnt/boxpilot and the destination lives at /mnt/boxpilot/backup, where a NAS that is off is a
 * door that does not open yet instead of a helper that does not start. tests/ubuntu/
 * helper-automount.sh shows both on real systemd.
 *
 * It used to live at /mnt/boxpilot-backup; server/tasks/backup-mount-move.mjs moves an existing one.
 */
export const backupMountName = "boxpilot-backup";
export const backupMountParent = "/mnt/boxpilot";
export const backupMountpoint = "/mnt/boxpilot/backup";
export const legacyBackupMountpoint = "/mnt/boxpilot-backup";

/** A drive mounted at /mnt/boxpilot would sit where the helper may write, over the destination. */
export const reservedMountNames = Object.freeze(["boxpilot"]);

/** Where a mount of this name is: /mnt/<name>, or the backup destination's own place. */
export function mountpointFor(name) {
  return name === backupMountName ? backupMountpoint : `/mnt/${name}`;
}

/**
 * The mount name whose mount point this is, or null: the exact inverse of mountpointFor, so the
 * old /mnt/boxpilot-backup is nobody's (the name boxpilot-backup is mounted somewhere else now).
 */
export function mountNameFor(target) {
  const name = target === backupMountpoint ? backupMountName : /^\/mnt\/([a-z0-9][a-z0-9-]{0,31})$/.exec(String(target ?? ""))?.[1] ?? null;
  return name && !reservedMountNames.includes(name) && mountpointFor(name) === target ? name : null;
}
