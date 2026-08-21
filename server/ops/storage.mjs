import { readFile } from "node:fs/promises";
import { defineOperation } from "./registry.mjs";
import { devicePattern, labelPattern, logicalVolumePattern, mountNamePattern, parseManagedFstab, uuidPattern } from "../tasks/storage.mjs";

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
      } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("storage.mount", { uuid: parameters.uuid, name: parameters.name, fstype: parameters.fstype ?? "auto", readOnly: parameters.readOnly ?? false }, { timeoutMs: minutes(2), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "storage.unmount", title: "Unmount a managed filesystem", risk: "medium", timeoutMs: minutes(3),
      description: "Unmounts /mnt/<name> and removes the fstab entry BoxPilot added. Entries you created yourself are refused.",
      parameters: { fields: { name: { type: "string", maxLength: 32, pattern: mountNamePattern } } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("storage.unmount", { name: parameters.name }, { timeoutMs: minutes(2), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "storage.format", title: "Erase and format a disk", risk: "high", timeoutMs: minutes(35),
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
      id: "storage.lvm.snapshot.rollback", title: "Roll back to a snapshot", risk: "high", timeoutMs: minutes(6),
      description: "Schedules a merge of the snapshot into its origin (lvconvert --merge). Everything written since the snapshot is discarded. For the root volume the merge happens during the next reboot.",
      parameters: { fields: { path: { type: "string", maxLength: 120, pattern: /^\/dev\/mapper\/[A-Za-z0-9._+-]+-boxpilot--snap--[A-Za-z0-9._+-]+$/ } } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("storage.lvm-snapshot-rollback", { path: parameters.path }, { timeoutMs: minutes(5), logPath: jobLog?.path ?? null }),
    }),
  ];
}
