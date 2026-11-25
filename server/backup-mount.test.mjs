import { describe, expect, it } from "vitest";
import { backupDestinationPaths, backupMountName, backupMountParent, backupMountpoint, isBackupDestinationPath, legacyBackupMountpoint, mountNameFor, mountpointFor, reservedMountNames } from "./backup-mount.mjs";
import { BACKUP_MOUNT_NAME, BACKUP_MOUNTPOINT, mountpointFor as uiMountpointFor } from "../src/mountpoints.ts";

describe("where a mount of a given name lands", () => {
  it("is /mnt/<name>, except the backup destination, which sits in a folder of its own", () => {
    expect(mountpointFor("media")).toBe("/mnt/media");
    expect(mountpointFor("share-nas")).toBe("/mnt/share-nas");
    expect(mountpointFor(backupMountName)).toBe("/mnt/boxpilot/backup");
    // The helper's sandbox is given the folder, and the folder is not itself a mount point BoxPilot makes.
    expect(backupMountParent).toBe("/mnt/boxpilot");
    expect(backupMountpoint.startsWith(`${backupMountParent}/`)).toBe(true);
    expect(reservedMountNames).toContain("boxpilot");
    expect(legacyBackupMountpoint).toBe("/mnt/boxpilot-backup");
  });

  it("names a mount point only when that name really mounts there", () => {
    for (const name of ["media", "the-dump", backupMountName]) expect(mountNameFor(mountpointFor(name))).toBe(name);
    expect(mountNameFor("/mnt/boxpilot-backup")).toBeNull();   // where the destination used to be
    expect(mountNameFor("/mnt/boxpilot")).toBeNull();          // the folder it lives in
    expect(mountNameFor("/mnt/media/deeper")).toBeNull();
    expect(mountNameFor("/srv/data")).toBeNull();
    expect(mountNameFor(undefined)).toBeNull();
  });

  it("agrees with the copy the interface uses", () => {
    expect(BACKUP_MOUNT_NAME).toBe(backupMountName);
    expect(BACKUP_MOUNTPOINT).toBe(backupMountpoint);
    for (const name of ["media", "share-nas", backupMountName]) expect(uiMountpointFor(name)).toBe(mountpointFor(name));
  });
});

// M72: the Samba and NFS deny lists named /mnt/boxpilot and not the old /mnt/boxpilot-backup.
describe("where the backups are kept, for a deny list", () => {
  it("is the folder the destination lives in now and where it used to be mounted", () => {
    expect(backupDestinationPaths).toEqual([backupMountParent, legacyBackupMountpoint]);
    expect(Object.isFrozen(backupDestinationPaths)).toBe(true);
  });

  it("is reached by either, anything inside them, and any folder that holds them", () => {
    for (const folder of [backupMountpoint, `${backupMountpoint}/apps`, "/mnt/boxpilot/", legacyBackupMountpoint, `${legacyBackupMountpoint}/apps/x`, "/mnt", "/mnt/", "/"]) expect(isBackupDestinationPath(folder), folder).toBe(true);
    for (const folder of ["/mnt/media", "/mnt/boxpilot2", "/mnt/boxpilot-backups", "/srv/files", "/media/usb", undefined, null, 7]) expect(isBackupDestinationPath(folder), String(folder)).toBe(false);
  });
});
