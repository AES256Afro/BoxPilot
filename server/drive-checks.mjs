/**
 * "This server can check its drives" (M26.3): the evidence behind that setup checklist item.
 *
 * Three things have to be true. smartctl is here, so every disk's SMART health is read. fsck.exfat
 * is here, so an exFAT drive can be checked after it drops off USB - Ubuntu does not install it,
 * and the check before writing again is the whole point (M26.2). And every USB drive BoxPilot
 * mounts answers SMART, directly or through its bridge with -d sat (the storage scan asks both
 * ways). A USB enclosure whose bridge passes no SMART through at all is a limit of that enclosure:
 * it is reported, and it does not hold the item open, because nothing on this server changes it.
 *
 * Pure except for the two readers at the bottom, which only look.
 */
import { access } from "node:fs/promises";
import { collectStorage } from "./storage-inventory.mjs";

/** Where Ubuntu puts each tool. /sbin is /usr/sbin on a merged-/usr install; both are asked. */
export const driveToolPaths = Object.freeze({
  smartctl: Object.freeze(["/usr/sbin/smartctl", "/sbin/smartctl"]),
  fsckExfat: Object.freeze(["/usr/sbin/fsck.exfat", "/sbin/fsck.exfat"]),
});

/** The package that brings each tool, which is what the owner is asked to install. */
const toolPackages = Object.freeze({ smartctl: "smartmontools", fsckExfat: "exfatprogs" });

/**
 * The USB disks under BoxPilot's own drive mounts. Each managed fstab line is found on a device by
 * the UUID it names, wherever the kernel has put that drive today, and followed up to its disk. A
 * drive that is not plugged in has no disk to ask; the reconnect findings on Repair cover that.
 * Network shares and the swap file share the fstab marker scheme and are not drives.
 */
export function managedUsbDisks(storage) {
  const devices = Array.isArray(storage?.devices) ? storage.devices : [];
  const indexOfPath = (file) => devices.findIndex((device) => device.path === file);
  const disks = new Map();
  for (const row of Array.isArray(storage?.fstab) ? storage.fstab : []) {
    const name = row?.managedName;
    if (!name || name.startsWith("share-") || name === "swap") continue;
    const uuid = /^UUID=(.+)$/.exec(row.device ?? "")?.[1] ?? null;
    let index = uuid ? devices.findIndex((device) => device.uuid === uuid) : -1;
    if (index < 0 && row.device?.startsWith("/dev/")) index = indexOfPath(row.device);
    if (index < 0) {
      const mounted = (Array.isArray(storage?.mounts) ? storage.mounts : []).find((mount) => mount.target === row.mountpoint);
      if (mounted?.source) index = indexOfPath(mounted.source);
    }
    if (index < 0) continue;
    // The device list is parent-first, so the nearest top-level row above a partition is its disk.
    while (index > 0 && (devices[index].depth ?? 0) > 0) index -= 1;
    const disk = devices[index];
    if (disk?.type !== "disk" || disk.transport !== "usb" || !disk.path) continue;
    const entry = disks.get(disk.path) ?? { device: disk.path, model: disk.model ?? null, targets: [] };
    if (row.mountpoint && !entry.targets.includes(row.mountpoint)) entry.targets.push(row.mountpoint);
    disks.set(disk.path, entry);
  }
  return [...disks.values()];
}

/**
 * How one disk answered the last SMART scan: `answers`, `answers-through-bridge` (only with -d sat),
 * `bridge-unsupported` (the enclosure passes no SMART through), or `unread` - no current reading,
 * because the scan is stale, has not run since the drive appeared, or could not open it.
 */
export function usbSmartState(device, smart) {
  if (!smart || smart.stale !== false || !Array.isArray(smart.disks)) return "unread";
  const reading = smart.disks.find((disk) => disk.device === device);
  if (!reading) return "unread";
  if (reading.health !== "unavailable") return reading.deviceType === "sat" ? "answers-through-bridge" : "answers";
  return reading.reason === "usb-bridge-unsupported" ? "bridge-unsupported" : "unread";
}

/**
 * Everything the checklist item needs, or null when the tools could not be looked for. `storage`
 * null means the drives could not be listed; the tools are still known.
 */
export function assessDriveChecks({ tools = null, storage = null, smart = null } = {}) {
  if (!tools) return null;
  const missingPackages = Object.entries(toolPackages).filter(([tool]) => !tools[tool]).map(([, name]) => name).sort();
  const disks = storage ? managedUsbDisks(storage).map((disk) => ({ ...disk, smart: usbSmartState(disk.device, smart) })) : [];
  return { tools: { smartctl: Boolean(tools.smartctl), fsckExfat: Boolean(tools.fsckExfat) }, missingPackages, disksKnown: storage !== null, disks };
}

/** Whether each drive-check tool is on this server, asked of the filesystem rather than of apt. */
export async function detectDriveTools({ exists = (file) => access(file).then(() => true, () => false) } = {}) {
  const found = await Promise.all(Object.entries(driveToolPaths).map(async ([tool, paths]) => [tool, (await Promise.all(paths.map((file) => exists(file)))).some(Boolean)]));
  return Object.fromEntries(found);
}

/**
 * The evidence, gathered. `smart` is the inventory's normalized SMART reading, or a promise of it,
 * so the drive listing does not wait for the inventory. Every read tolerates failure.
 */
export async function gatherDriveChecks({ smart = null, collect = collectStorage, detect = detectDriveTools } = {}) {
  const [tools, storage, reading] = await Promise.all([detect().catch(() => null), collect().catch(() => null), Promise.resolve(smart).catch(() => null)]);
  return assessDriveChecks({ tools, storage, smart: reading });
}
