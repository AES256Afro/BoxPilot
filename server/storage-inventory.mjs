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
import { parseFindmnt, parseFstab } from "./ops/storage.mjs";

export const lsblkBinary = process.env.BOXPILOT_LSBLK_BINARY ?? "/usr/bin/lsblk";
export const findmntBinary = process.env.BOXPILOT_FINDMNT_BINARY ?? "/usr/bin/findmnt";
export const lsblkColumns = "PATH,KNAME,PKNAME,TYPE,SIZE,FSTYPE,UUID,LABEL,MODEL,TRAN,MOUNTPOINTS,RO,RM";

/**
 * Flatten lsblk JSON into parent-first order with a `depth`. lsblk only nests children when
 * NAME is the tree column; otherwise (and for device-mapper holders in some setups) it prints
 * a flat list, so the hierarchy is rebuilt from PKNAME and only falls back to the nesting.
 */
export function parseLsblkTree(json) {
  let parsed;
  try { parsed = JSON.parse(json); } catch { return []; }
  const rows = [];
  const visit = (node, visitParent) => {
    const size = Number(node.size);
    const row = {
      path: node.path ?? null, type: node.type ?? null, sizeBytes: Number.isFinite(size) ? size : null, fstype: node.fstype ?? null, uuid: node.uuid ?? null, label: node.label ?? null,
      model: node.model?.trim?.() || null, transport: node.tran ?? null, mountpoints: (node.mountpoints ?? []).filter(Boolean), readOnly: Boolean(node.ro), removable: Boolean(node.rm),
      kname: node.kname ?? null, pkname: node.pkname ?? null, visitParent,
    };
    rows.push(row);
    for (const child of node.children ?? []) visit(child, row);
  };
  for (const node of parsed?.blockdevices ?? []) visit(node, null);
  const byKname = new Map(rows.filter((row) => row.kname).map((row) => [row.kname, row]));
  const children = new Map();
  const roots = [];
  const seen = new Set();
  // LVM snapshots add internal device-mapper nodes (<lv>-real, <snap>-cow) that are not
  // devices anyone should see; hide them and attach their children to the next real parent.
  const internal = (row) => /-(real|cow)$/.test(row.path ?? "");
  for (const row of rows) {
    if (row.path && seen.has(row.path)) {
      // An LV over several PVs is listed once per PV: keep the extra parent → LV link so the group can be rebuilt.
      const parent = row.pkname ? byKname.get(row.pkname) : null;
      if (parent && row.type === "lvm") (parent.lvmVolumes ??= []).push(row.path);
      continue;
    }
    if (row.path) seen.add(row.path);
    if (internal(row)) continue;
    let parent = (row.pkname ? byKname.get(row.pkname) : null) ?? row.visitParent ?? null;
    while (parent && internal(parent)) parent = (parent.pkname ? byKname.get(parent.pkname) : null) ?? parent.visitParent ?? null;
    if (parent && parent !== row) {
      if (!children.has(parent.path)) children.set(parent.path, []);
      children.get(parent.path).push(row);
    } else roots.push(row);
  }
  const ordered = [];
  const walk = (row, depth) => {
    const { kname, pkname, visitParent, ...device } = row;
    void kname; void pkname; void visitParent;
    ordered.push({ ...device, depth });
    for (const child of children.get(row.path) ?? []) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  return ordered;
}

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
    const snapshot = Boolean(dm?.lv?.startsWith("boxpilot-snap-"));
    let reason = null;
    if (snapshot) reason = "LVM snapshot";
    else if (system) reason = "system disk";
    else if (member) reason = device.fstype === "LVM2_member" ? `LVM physical volume${holds.length ? ` (${holds.join(", ")})` : ""}` : device.fstype === "crypto_LUKS" ? "encrypted container" : device.fstype === "linux_raid_member" ? "RAID member" : "member of another device";
    else if (mountedBelow.length) reason = `holds mounted filesystems (${mountedBelow.join(", ")})`;
    return {
      ...device,
      protected: Boolean(reason),
      protectedReason: reason,
      volumeGroup: dm?.vg ?? null,
      logicalVolume: dm?.lv ?? null,
      snapshot,
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
    const direct = descendantsOf(devices, index).filter((row) => row.type === "lvm" && row.path?.startsWith("/dev/mapper/"));
    const linked = (device.lvmVolumes ?? []).map((volumePath) => devices.find((row) => row.path === volumePath)).filter(Boolean);
    const volumes = [...direct, ...linked.filter((row) => !direct.includes(row))];
    const names = [...new Set(volumes.map((row) => splitDmName(row.path.slice("/dev/mapper/".length)).vg).filter(Boolean))];
    const name = names[0] ?? null;
    const key = name ?? `pv:${device.path}`;
    const group = groups.get(key) ?? { name, physicalVolumes: [], sizeBytes: 0, usedBytes: 0, freeBytes: 0, logicalVolumes: [] };
    group.physicalVolumes.push(device.path);
    group.sizeBytes += device.sizeBytes ?? 0;
    for (const volume of volumes) {
      if (group.logicalVolumes.some((entry) => entry.path === volume.path)) continue;
      const { lv } = splitDmName(volume.path.slice("/dev/mapper/".length));
      const snapshot = lv.startsWith("boxpilot-snap-");
      group.logicalVolumes.push({ path: volume.path, name: lv, sizeBytes: volume.sizeBytes ?? 0, fstype: volume.fstype ?? null, mountpoints: volume.mountpoints, snapshot, growable: !snapshot && ["ext4", "ext3", "ext2", "xfs"].includes(volume.fstype ?? "") && volume.mountpoints.length > 0 });
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
  const devices = annotateDevices(parseLsblkTree(lsblkResult.stdout));
  const mounts = findmntResult.ok ? parseFindmnt(findmntResult.stdout) : [];
  const fstab = parseFstab(fstabContent);
  const volumeGroups = volumeGroupsFrom(devices);
  return {
    devices,
    mounts,
    fstab,
    volumeGroups,
    snapshots: volumeGroups.flatMap((group) => group.logicalVolumes.filter((volume) => volume.snapshot).map((volume) => ({ path: volume.path, name: volume.name, volumeGroup: group.name, sizeBytes: volume.sizeBytes }))),
    shares: sharesFrom(fstab, mounts),
    tools: { cifs, nfs, smbclient, showmount },
  };
}
