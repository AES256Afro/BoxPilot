import { readFile } from "node:fs/promises";
import { defineOperation } from "./registry.mjs";
import { devicePattern, labelPattern, logicalVolumePattern, mountNamePattern, parseManagedFstab, uuidPattern } from "../tasks/storage.mjs";
import { fsSnapshotsInspect, snapshotKinds, snapshotNamePattern as fsSnapshotNamePattern } from "../tasks/fs-snapshots.mjs";

/** The LV name the Storage page shows for a snapshot path (device-mapper escapes "-" as "--"). */
function snapshotNameFromPath(devicePath) {
  const base = String(devicePath ?? "").split("/").pop() ?? "";
  const index = base.search(/(?<!-)-(?!-)/);
  return (index >= 0 ? base.slice(index + 1) : base).replaceAll("--", "-");
}

const minutes = (value) => value * 60_000;
const lsblk = "/usr/bin/lsblk";
const findmnt = process.env.BOXPILOT_FINDMNT_BINARY ?? "/usr/bin/findmnt";

/** Flatten lsblk's JSON tree into rows the page can render, children after their disk. */
export function parseLsblk(json) {
  let parsed;
  try { parsed = JSON.parse(json); } catch { return []; }
  const rows = [];
  const walk = (nodes, depth) => {
    for (const node of nodes ?? []) {
      rows.push({
        path: node.path ?? null, type: node.type ?? null, sizeBytes: node.size ?? null,
        fstype: node.fstype ?? null, uuid: node.uuid ?? null, label: node.label ?? null,
        model: node.model?.trim?.() || null, transport: node.tran ?? null,
        mountpoints: (node.mountpoints ?? []).filter(Boolean), readOnly: Boolean(node.ro), removable: Boolean(node.rm), depth,
      });
      walk(node.children, depth + 1);
    }
  };
  walk(parsed.blockdevices, 0);
  return rows;
}

/** Non-comment fstab entries, with the BoxPilot-managed name attached where present. */
export function parseFstab(content) {
  const managed = new Map(parseManagedFstab(content).map((entry) => [entry.line.trim(), entry.name]));
  return String(content ?? "").split("\n")
    .filter((line) => line.trim() && !line.trim().startsWith("#"))
    .map((line) => {
      const [device, mountpoint, fstype, options] = line.trim().split(/\s+/);
      return { device, mountpoint, fstype, options, managedName: managed.get(line.trim()) ?? null };
    });
}

/** findmnt --real -J rows with usage. */
export function parseFindmnt(json) {
  let parsed;
  try { parsed = JSON.parse(json); } catch { return []; }
  return (parsed.filesystems ?? []).map((entry) => ({
    target: entry.target, source: entry.source, fstype: entry.fstype,
    sizeBytes: Number(entry.size) || null, usedBytes: Number(entry.used) || null, availableBytes: Number(entry.avail) || null,
  }));
}

export function storageOperations() {
  return [
    defineOperation({
      id: "storage.inspect", title: "Read disks and mounts", risk: "low", readOnly: true, timeoutMs: 60_000,
      description: "Block devices with filesystems and UUIDs, the fstab entries, and mounted filesystems with usage.",
      run: async (_parameters, { run }) => {
        const [tree, mounts] = await Promise.all([
          run(lsblk, ["-J", "-b", "-o", "PATH,TYPE,SIZE,FSTYPE,UUID,LABEL,MODEL,TRAN,MOUNTPOINTS,RO,RM"], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }),
          run(findmnt, ["--real", "-J", "-b", "-o", "TARGET,SOURCE,FSTYPE,SIZE,USED,AVAIL"], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }),
        ]);
        const fstab = await readFile("/etc/fstab", "utf8").catch(() => "");
        return {
          devices: tree.ok ? parseLsblk(tree.stdout) : [],
          mounts: mounts.ok ? parseFindmnt(mounts.stdout) : [],
          fstab: parseFstab(fstab),
        };
      },
    }),
    defineOperation({
      id: "storage.mount", title: "Mount a filesystem", risk: "medium", timeoutMs: minutes(3),
      description: "Adds a nofail fstab entry by UUID, verifies fstab still parses, and mounts at /mnt/<name>. A missing disk never blocks boot.",
      parameters: { fields: {
        uuid: { type: "string", maxLength: 40, pattern: uuidPattern },
        name: { type: "string", maxLength: 32, pattern: mountNamePattern },
        fstype: { type: "string", optional: true, maxLength: 12, pattern: /^[a-z0-9]{2,12}$/ },
        readOnly: { type: "boolean", optional: true },
        // Hand the drive to the apps user (uid/gid 1000) so containers and network shares can write
        // to it: for exFAT/FAT/NTFS as a mount option, for a Linux filesystem by chowning its top.
        appWritable: { type: "boolean", optional: true },
      } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("storage.mount", { uuid: parameters.uuid, name: parameters.name, fstype: parameters.fstype ?? "auto", readOnly: parameters.readOnly ?? false, appWritable: parameters.appWritable ?? false }, { timeoutMs: minutes(2), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "storage.fs-snapshots.inspect", title: "Read filesystem snapshots", risk: "low", readOnly: true, timeoutMs: minutes(1),
      description: "Which btrfs filesystems and ZFS datasets exist on this server and the snapshots they hold. Empty on a server without either, which is the common case.",
      parameters: { fields: {} },
      run: (_parameters, { run }) => fsSnapshotsInspect({}, { run }),
    }),
    defineOperation({
      id: "storage.fs-snapshot.create", title: "Take a filesystem snapshot", risk: "medium", timeoutMs: minutes(2),
      description: "A read-only btrfs snapshot (under .boxpilot-snapshots on the filesystem) or a ZFS snapshot of a dataset. The target must be a filesystem this server actually mounts; a name it does not recognise is refused.",
      parameters: { fields: {
        kind: { type: "string", enum: [...snapshotKinds] },
        target: { type: "string", maxLength: 256, pattern: /^[A-Za-z0-9/][A-Za-z0-9._/-]{0,255}$/ },
        name: { type: "string", maxLength: 32, pattern: fsSnapshotNamePattern },
      } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("storage.fs-snapshot.create", { kind: parameters.kind, target: parameters.target, name: parameters.name }, { timeoutMs: minutes(1), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "storage.fs-snapshot.delete", title: "Delete a filesystem snapshot", risk: "medium", timeoutMs: minutes(2), confirm: (parameters) => String(parameters.name ?? ""),
      description: "Removes one snapshot: a btrfs snapshot under the managed .boxpilot-snapshots folder, or a ZFS snapshot by its @name. The filesystem's live data is untouched.",
      parameters: { fields: {
        kind: { type: "string", enum: [...snapshotKinds] },
        target: { type: "string", maxLength: 256, pattern: /^[A-Za-z0-9/][A-Za-z0-9._/-]{0,255}$/ },
        name: { type: "string", maxLength: 32, pattern: fsSnapshotNamePattern },
      } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("storage.fs-snapshot.delete", { kind: parameters.kind, target: parameters.target, name: parameters.name }, { timeoutMs: minutes(1), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "storage.remount", title: "Reconnect a drive", risk: "medium", timeoutMs: minutes(5),
      description: "Detaches a managed mount and mounts it again from its fstab entry, which finds the drive by UUID wherever the kernel has put it. This is the fix when a drive was unplugged for a moment and came back under a different name, leaving the old mount pointing at nothing. The fstab entry and everything on the drive are unchanged.",
      parameters: { fields: { name: { type: "string", maxLength: 32, pattern: mountNamePattern } } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("storage.remount", { name: parameters.name }, { timeoutMs: minutes(4), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "storage.unmount", title: "Unmount a managed filesystem", risk: "medium", timeoutMs: minutes(3),
      description: "Unmounts /mnt/<name> and removes the fstab entry BoxPilot added. Entries you created yourself are refused.",
      parameters: { fields: { name: { type: "string", maxLength: 32, pattern: mountNamePattern } } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("storage.unmount", { name: parameters.name }, { timeoutMs: minutes(2), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "storage.format", title: "Erase and format a disk", risk: "high", confirm: (parameters) => parameters.device, timeoutMs: minutes(35),
      description: "Wipes every filesystem signature on the device and creates a fresh ext4. Everything on it is destroyed. Refused while anything on the device is mounted.",
      parameters: { fields: {
        device: { type: "string", maxLength: 32, pattern: devicePattern },
        label: { type: "string", optional: true, nullable: true, maxLength: 16, pattern: labelPattern },
      } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("storage.format", { device: parameters.device, label: parameters.label ?? null }, { timeoutMs: minutes(32), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "storage.swapfile.set", title: "Create or remove the swap file", risk: "medium", timeoutMs: minutes(10),
      description: "Creates /swap.boxpilot with a nofail fstab entry and enables it, or removes the one BoxPilot created.",
      parameters: { fields: {
        sizeGiB: { type: "number", optional: true, nullable: true, validate: (value) => (Number.isInteger(value) && value >= 1 && value <= 64 ? null : "must be a whole number of GiB between 1 and 64") },
        remove: { type: "boolean", optional: true },
      } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("storage.swapfile", { sizeGiB: parameters.sizeGiB ?? null, remove: parameters.remove ?? false }, { timeoutMs: minutes(8), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "storage.lvm.extend", title: "Use the rest of the disk", risk: "medium", timeoutMs: minutes(12),
      description: "Grows a mounted LVM logical volume into all unallocated space of its volume group and resizes the filesystem online (lvextend -r). No reboot, no data loss.",
      parameters: { fields: { path: { type: "string", maxLength: 80, pattern: logicalVolumePattern }, reserveGiB: { type: "number", optional: true, validate: (value) => (Number.isInteger(value) && value >= 0 && value <= 1024 ? null : "must be a whole number of GiB between 0 and 1024") } } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("storage.lvm-extend", { path: parameters.path, reserveGiB: parameters.reserveGiB ?? 32 }, { timeoutMs: minutes(10), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "storage.lvm.snapshot.create", title: "Take a snapshot", risk: "medium", timeoutMs: minutes(6),
      description: "Creates a copy-on-write LVM snapshot of a logical volume (lvcreate -s), a restore point you can roll back to. It uses free space in the volume group and fills up as the origin changes.",
      parameters: { fields: {
        path: { type: "string", maxLength: 80, pattern: logicalVolumePattern },
        sizeGiB: { type: "number", optional: true, validate: (value) => (Number.isInteger(value) && value >= 1 && value <= 2048 ? null : "must be a whole number of GiB between 1 and 2048") },
        suffix: { type: "string", optional: true, nullable: true, maxLength: 24, pattern: /^[a-z0-9-]{1,24}$/ },
      } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("storage.lvm-snapshot-create", { path: parameters.path, sizeGiB: parameters.sizeGiB ?? 10, suffix: parameters.suffix ?? null }, { timeoutMs: minutes(5), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "storage.lvm.snapshot.delete", title: "Remove a snapshot", risk: "medium", timeoutMs: minutes(6),
      description: "Removes a BoxPilot snapshot and frees its space in the volume group.",
      parameters: { fields: { path: { type: "string", maxLength: 120, pattern: /^\/dev\/mapper\/[A-Za-z0-9._+-]+-boxpilot--snap--[A-Za-z0-9._+-]+$/ } } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("storage.lvm-snapshot-delete", { path: parameters.path }, { timeoutMs: minutes(5), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "storage.lvm.snapshot.rollback", title: "Roll back to a snapshot", risk: "high", confirm: (parameters) => snapshotNameFromPath(parameters.path), timeoutMs: minutes(6),
      description: "Schedules a merge of the snapshot into its origin (lvconvert --merge). Everything written since the snapshot is discarded. For the root volume the merge happens during the next reboot.",
      parameters: { fields: { path: { type: "string", maxLength: 120, pattern: /^\/dev\/mapper\/[A-Za-z0-9._+-]+-boxpilot--snap--[A-Za-z0-9._+-]+$/ } } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("storage.lvm-snapshot-rollback", { path: parameters.path }, { timeoutMs: minutes(5), logPath: jobLog?.path ?? null }),
    }),
  ];
}
