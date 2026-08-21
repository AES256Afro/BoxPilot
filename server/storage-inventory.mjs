/**
 * Storage inventory collected in the web process.
 *
 * The helper runs with PrivateDevices=true and cannot see device-mapper nodes, so LVM
 * logical volumes (including the root filesystem on a default Ubuntu install) never showed
 * up there and their physical volume looked like a free partition. The web service shares
 * the host's device and mount namespaces and lsblk/findmnt need no privileges, so the
 * Storage page reads from here. Mutations still go through root tasks.
 */
import { access, readFile as readFileDefault } from "node:fs/promises";
import { fixedRun } from "./exec.mjs";
import { parseFindmnt, parseFstab, parseLsblk } from "./ops/storage.mjs";

export const lsblkBinary = process.env.BOXPILOT_LSBLK_BINARY ?? "/usr/bin/lsblk";
export const findmntBinary = process.env.BOXPILOT_FINDMNT_BINARY ?? "/usr/bin/findmnt";
export const lsblkColumns = "PATH,TYPE,SIZE,FSTYPE,UUID,LABEL,MODEL,TRAN,MOUNTPOINTS,RO,RM";

/** Filesystem signatures that mean "this device belongs to something else; never mount or format it directly". */
export const memberFstypes = Object.freeze(["LVM2_member", "linux_raid_member", "crypto_LUKS", "bcache", "ceph_bluestore", "zfs_member"]);
/** Mountpoints that make the device they live on a system disk. */
export const systemMountpoints = Object.freeze(["/", "/boot", "/boot/efi", "/usr", "/var", "/home", "/efi"]);

/** Device-mapper names escape "-" as "--": `ubuntu--vg-ubuntu--lv` → { vg: "ubuntu-vg", lv: "ubuntu-lv" }. */
export function splitDmName(name) {
  const parts = [];
  let current = "";
  for (let index = 0; index < name.length; index += 1) {
    if (name[index] === "-" && name[index + 1] === "-") { current += "-"; index += 1; continue; }
    if (name[index] === "-") { parts.push(current); current = ""; continue; }
    current += name[index];
  }
  parts.push(current);
  return parts.length >= 2 ? { vg: parts[0], lv: parts.slice(1).join("-") } : { vg: null, lv: name };
}

/** Rows nested under `index` in the flattened lsblk list (deeper rows until the depth returns). */
export function descendantsOf(devices, index) {
  const parent = devices[index];
  const out = [];
  for (let cursor = index + 1; cursor < devices.length; cursor += 1) {
    if (devices[cursor].depth <= parent.depth) break;
    out.push(devices[cursor]);
  }
  return out;
}

/**
 * Annotate the flattened device list so the UI (and anyone else) can tell at a glance what
 * must never be touched: member devices, anything with mounted descendants, system disks.
 */
export function annotateDevices(devices) {
  return devices.map((device, index) => {
    const descendants = descendantsOf(devices, index);
    const mountedBelow = descendants.flatMap((row) => row.mountpoints);
    const allMounts = [...device.mountpoints, ...mountedBelow];
    const member = memberFstypes.includes(device.fstype ?? "");
    const system = allMounts.some((target) => systemMountpoints.includes(target));
    const dm = device.type === "lvm" && device.path?.startsWith("/dev/mapper/") ? splitDmName(device.path.slice("/dev/mapper/".length)) : null;
    const holds = member && device.fstype === "LVM2_member" ? [...new Set(descendants.filter((row) => row.type === "lvm").map((row) => splitDmName(row.path.slice("/dev/mapper/".length)).vg).filter(Boolean))] : [];
    let reason = null;
    if (system) reason = "system disk";
    else if (member) reason = device.fstype === "LVM2_member" ? `LVM physical volume${holds.length ? ` (${holds.join(", ")})` : ""}` : device.fstype === "crypto_LUKS" ? "encrypted container" : device.fstype === "linux_raid_member" ? "RAID member" : "member of another device";
    else if (mountedBelow.length) reason = `holds mounted filesystems (${mountedBelow.join(", ")})`;
    return {
      ...device,
      protected: Boolean(reason),
      protectedReason: reason,
      volumeGroup: dm?.vg ?? null,
      logicalVolume: dm?.lv ?? null,
      holdsVolumeGroups: holds,
      mountedBelow,
    };
  });
}

/**
 * Volume groups estimated from lsblk alone (vgs/lvs need root): size = sum of member PVs,
 * used = sum of logical volumes carved from them. Good enough to say "850 GB unallocated".
 */
export function volumeGroupsFrom(devices) {
  const groups = new Map();
  devices.forEach((device, index) => {
    if (device.fstype !== "LVM2_member") return;
    const volumes = descendantsOf(devices, index).filter((row) => row.type === "lvm" && row.path?.startsWith("/dev/mapper/"));
    const names = [...new Set(volumes.map((row) => splitDmName(row.path.slice("/dev/mapper/".length)).vg).filter(Boolean))];
    const name = names[0] ?? null;
    const key = name ?? `pv:${device.path}`;
    const group = groups.get(key) ?? { name, physicalVolumes: [], sizeBytes: 0, usedBytes: 0, freeBytes: 0, logicalVolumes: [] };
    group.physicalVolumes.push(device.path);
    group.sizeBytes += device.sizeBytes ?? 0;
    for (const volume of volumes) {
      if (group.logicalVolumes.some((entry) => entry.path === volume.path)) continue;
      const { lv } = splitDmName(volume.path.slice("/dev/mapper/".length));
      group.logicalVolumes.push({ path: volume.path, name: lv, sizeBytes: volume.sizeBytes ?? 0, fstype: volume.fstype ?? null, mountpoints: volume.mountpoints, growable: ["ext4", "ext3", "ext2", "xfs"].includes(volume.fstype ?? "") && volume.mountpoints.length > 0 });
      group.usedBytes += volume.sizeBytes ?? 0;
    }
    groups.set(key, group);
  });
  return [...groups.values()].map((group) => ({ ...group, freeBytes: Math.max(0, group.sizeBytes - group.usedBytes) }));
}

/** Network shares BoxPilot mounted: fstab entries marked `# boxpilot:share-<name>`. */
export function sharesFrom(fstab, mounts) {
  return fstab
    .filter((row) => row.managedName?.startsWith("share-") && ["cifs", "nfs", "nfs4"].includes(row.fstype))
    .map((row) => {
      const mount = mounts.find((entry) => entry.target === row.mountpoint) ?? null;
      const options = row.options.split(",");
      return {
        name: row.managedName.slice("share-".length),
        kind: row.fstype === "cifs" ? "smb" : "nfs",
        source: row.device,
        mountpoint: row.mountpoint,
        readOnly: options.includes("ro"),
        automount: options.includes("x-systemd.automount"),
        mounted: Boolean(mount),
        sizeBytes: mount?.sizeBytes ?? null,
        usedBytes: mount?.usedBytes ?? null,
        availableBytes: mount?.availableBytes ?? null,
      };
    });
}

export async function collectStorage({ run = fixedRun, readFile = readFileDefault, exists = (file) => access(file).then(() => true, () => false) } = {}) {
  const [lsblkResult, findmntResult, fstabContent, cifs, nfs, smbclient, showmount] = await Promise.all([
    run(lsblkBinary, ["-J", "-b", "-o", lsblkColumns], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }),
    run(findmntBinary, ["--real", "-J", "-b", "-o", "TARGET,SOURCE,FSTYPE,SIZE,USED,AVAIL"], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }),
    readFile("/etc/fstab", "utf8").catch(() => ""),
    exists("/sbin/mount.cifs"),
    exists("/sbin/mount.nfs"),
    exists("/usr/bin/smbclient"),
    exists("/usr/sbin/showmount"),
  ]);
  if (!lsblkResult.ok) throw new Error(`lsblk failed: ${lsblkResult.stderr.split("\n").filter(Boolean).at(-1) ?? "unknown error"}`);
  const devices = annotateDevices(parseLsblk(lsblkResult.stdout));
  const mounts = findmntResult.ok ? parseFindmnt(findmntResult.stdout) : [];
  const fstab = parseFstab(fstabContent);
  return {
    devices,
    mounts,
    fstab,
    volumeGroups: volumeGroupsFrom(devices),
    shares: sharesFrom(fstab, mounts),
    tools: { cifs, nfs, smbclient, showmount },
  };
}
