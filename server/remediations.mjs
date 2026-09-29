/**
 * Things that are wrong right now, each with the thing that fixes it.
 *
 * Every detector here exists because the failure it finds actually happened on a real server and
 * took a kernel-log dig or a shell session to explain. They share a shape: the server looks
 * healthy from every angle the owner can see, so nothing is reported, and the only symptom is
 * something further away being empty, read-only, or silently not running.
 *
 * Detection is pure — it reads a snapshot of facts and returns findings — so each of these is
 * checked against the situation that produced it rather than against a machine that has to be
 * broken on purpose first.
 *
 * M35, "Repair that fixes": a finding's fix must do everything needed to succeed, or the finding
 * says exactly why it cannot and the one thing the owner does (`manual`). A finding may offer more
 * than one fix (`fixes`, the first of which is `fix`): Reinstall or Uninstall, Back up now or Back up
 * nightly. Each preview names what it will stop, disconnect and restart, because the owner reads it
 * before approving and a fix that surprises them is one they stop halfway.
 */
import { createHash } from "node:crypto";
import { backupMountpoint, legacyBackupMountpoint, mountpointFor } from "./backup-mount.mjs";
import { coversEveryAddress, findPortConflicts, freePortNear, holderWords, portHolders, serveTargetPort, serveUrl } from "./ports.mjs";

export const severities = Object.freeze(["critical", "warning", "info"]);

/** The user apps run as, and the owner a drive or share folder is handed to (server/tasks/storage.mjs). */
const appUser = 1000;
/** Filesystems that keep no owners: their mount decides who owns every file on them. */
const ownerless = ["exfat", "vfat", "ntfs", "ntfs3", "msdos"];

/**
 * A finding, in the shape the Repair page renders. `fixes` are the registry operations that fix it,
 * best first; `fix` is the first, which Home and Ops offer. A fix of `kind: "schedule"` is a
 * schedule to create rather than a job to run (Back up nightly). `manual` is the one thing the owner
 * does when nothing here can do it, or says what a fix cannot.
 */
function finding({ id, severity, title, detail, evidence = [], fixes = [], manual = null }) {
  const offered = fixes.filter(Boolean);
  return { id, severity, title, detail, evidence, fix: offered[0] ?? null, fixes: offered, manual };
}

/** "A", "A and B", "A, B and C". */
export function listOf(names) {
  const unique = [...new Set(names)];
  return unique.length <= 1 ? unique.join("") : `${unique.slice(0, -1).join(", ")} and ${unique.at(-1)}`;
}

const under = (child, parent) => child === parent || child.startsWith(`${parent.replace(/\/+$/, "")}/`);

/** The apps with a folder at or under `target`, by name. */
function appsOn(target, containers = []) {
  return containers.filter((container) => (container.binds ?? []).some((bind) => under(bind, target))).map((container) => container.appName ?? container.name);
}

/** File shares that reach into `target`: served from a folder on it, or from one above it. */
function sharesOn(target, sambaShares = []) {
  return sambaShares.filter((share) => typeof share.path === "string" && (under(share.path, target) || under(target, share.path))).map((share) => share.name);
}

/**
 * What reconnecting a drive does, said about this drive: the apps it stops and starts, the shares it
 * disconnects. The same words for every fix that reconnects one (storage.remount, storage.writable).
 */
function reconnectSteps(target, facts, { readWrite = true } = {}) {
  const apps = appsOn(target, facts.containers);
  const shares = sharesOn(target, facts.sambaShares);
  const stops = apps.length ? `stops ${listOf(apps)} (${apps.length === 1 ? "it uses" : "they use"} this folder)` : "stops any app using this folder";
  const disconnects = shares.length
    ? `disconnects anyone using the ${listOf(shares)} share${shares.length === 1 ? "" : "s"} from other computers (they reconnect by themselves)`
    : "disconnects any file-sharing clients";
  return `First checks the drive is connected; if it is not, nothing is stopped. Then it ${stops}, ${disconnects}, unmounts ${target} and mounts it again from fstab, which finds the drive by its UUID wherever the kernel has put it. It checks the folder reads${readWrite ? " and is writable" : ""}, and starts ${apps.length ? listOf(apps) : "the apps"} again.`;
}

function remountFix(mount, facts, why) {
  return {
    operationId: "storage.remount",
    parameters: { name: mount.managedName },
    label: "Reconnect the drive",
    preview: `${why} ${reconnectSteps(mount.target, facts)} If something other than an app still holds the drive, it is left mounted as it was and the job names what holds it. Nothing on the drive is touched.`,
  };
}

function writableFix(mount, facts) {
  return {
    operationId: "storage.writable",
    parameters: { name: mount.managedName },
    label: "Let apps write to the drive",
    preview: `Adds uid=${appUser},gid=${appUser} to ${mount.target}'s fstab entry, so every file on this ${mount.fstype ?? "drive"} belongs to the user apps run as, then reconnects it. ${reconnectSteps(mount.target, facts)} fstab is copied first and checked with findmnt --verify, and the old entry is put back if the drive will not mount with the new one. Nothing on the drive is written.`,
  };
}

/**
 * A mount whose backing device has gone. The drive dropped off the bus (USB re-enumeration is the
 * usual cause) and came back under another kernel name; the old mount stayed, pointing at nothing.
 * findmnt still lists it and df still prints the size it cached, so every check short of a real
 * read passes, while shares and bind mounts serve an empty folder.
 */
export function staleMounts(facts = {}) {
  const { mounts = [], devices = [] } = facts;
  const present = new Set(devices.map((device) => device.path).filter(Boolean));
  return mounts
    .filter((mount) => mount.managedName && mount.source?.startsWith("/dev/") && !present.has(mount.source))
    .map((mount) => finding({
      id: `stale-mount:${mount.managedName}`,
      severity: "critical",
      title: `${mount.target} is mounted from a drive that is gone`,
      detail: `The mount still points at ${mount.source}, which no longer exists — the drive was disconnected and came back under a different name. Anything reading this folder gets an error or sees it empty, including network shares and any app that uses it.`,
      evidence: [`mounted from ${mount.source}`, `${mount.source} is not a device on this server`, ...(mount.sizeBytes ? [`${Math.round(mount.sizeBytes / 1024 ** 4 * 10) / 10} TiB filesystem`] : []), ...appsOn(mount.target, facts.containers).map((name) => `${name} uses it`)],
      fixes: [remountFix(mount, facts, `Detaches the dead mount at ${mount.target} and mounts the drive again.`)],
    }));
}

/**
 * A managed mount the kernel has turned read-only on its own. exFAT and ext4 both do this when the
 * device throws I/O errors (errors=remount-ro): the drive dropped off USB for a few seconds, or the
 * cable is marginal. The mount stays listed, df still prints numbers from cache, and every write
 * from a share or a container fails - the owner sees "I/O error" on their laptop and nothing at
 * all on the server. A mount fstab itself asked to be read-only is not this.
 */
export function readOnlyRemounts(facts = {}) {
  const { mounts = [] } = facts;
  return mounts
    .filter((mount) => mount.managedName && mount.readOnly === true && !(mount.options ?? "").split(",").includes("ro"))
    .map((mount) => (mount.managedName.startsWith("share-") ? readOnlyShare(mount, facts) : finding({
      id: `read-only-remount:${mount.managedName}`,
      severity: "critical",
      title: `${mount.target} has gone read-only`,
      detail: `The filesystem hit errors and protected itself by refusing every write since. That is what a drive dropping off USB for a moment does, and it is why saving to this folder from another computer fails with an I/O error while the folder still appears to be there. Reconnecting it mounts the drive afresh; if it keeps happening, the cable, port or enclosure is the thing to change.`,
      evidence: [`mounted from ${mount.source} with ro`, `fstab asks for it read-write`, ...(mount.fstype ? [`${mount.fstype} filesystem`] : []), ...appsOn(mount.target, facts.containers).map((name) => `${name} uses it`)],
      fixes: [remountFix(mount, facts, `Mounts ${mount.target} again, read-write, as a fresh filesystem: the apps holding the read-only one have to let go of it first, or the kernel hands the same read-only filesystem back.`)],
      manual: "If it comes back read-only, the kernel found errors on the drive while mounting it: check the drive next (Repair offers the check once it is mounted).",
    })));
}

/**
 * The same finding for a network share. A share is not a drive: nothing dropped off USB, the drive
 * operations refuse it, and it cannot be reconnected automatically. Its fix is share.reconnect,
 * which mounts it again from its own fstab line through systemd.
 */
function readOnlyShare(mount, facts) {
  const name = mount.managedName.slice("share-".length);
  const apps = appsOn(mount.target, facts.containers);
  return finding({
    id: `read-only-remount:${mount.managedName}`,
    severity: "critical",
    title: `${mount.target} has gone read-only`,
    detail: `The network share at ${mount.target} is mounted read-only although its fstab entry asks for read-write, so every write to it fails. That usually follows the NAS restarting or its connection dropping while the share was in use. Mounting it again from its fstab entry connects afresh.`,
    evidence: [`mounted from ${mount.source} with ro`, `fstab asks for it read-write`, ...(mount.fstype ? [`${mount.fstype} network share`] : []), ...apps.map((app) => `${app} uses it`)],
    fixes: [{
      operationId: "share.reconnect",
      parameters: { name },
      label: "Reconnect the share",
      preview: `Takes the share at ${mount.target} off this server and mounts it again from its fstab entry, read-write, with the stored credentials, then restarts ${apps.length ? listOf(apps) : "the apps using this folder"} so ${apps.length === 1 ? "it sees" : "they see"} it again. It is left alone if something other than an app is using it. Nothing on the NAS is touched.`,
    }],
    manual: "If it comes back read-only again, the NAS is serving it read-only to this server: check the share's permissions for this user on the NAS.",
  });
}

/**
 * The fix for a server that cannot check its drives: the same pinned drive-tools install the setup
 * checklist's "This server can check its drives" leads to (M26.3), at the exact versions the helper
 * found on offer. When the helper could not say - it was busy, or the package lists offer nothing
 * yet - the plain package install still works, since it refreshes the lists first.
 */
export function installDriveToolsFix(driveTools = null) {
  const offered = driveTools?.repairAvailable ? driveTools.candidatePackages ?? {} : {};
  if (Object.keys(offered).length) {
    const listed = Object.entries(offered).map(([name, version]) => `${name} ${version}`).join(" and ");
    return {
      operationId: "prerequisite.drive-tools.install",
      parameters: { expectedPackages: { ...offered } },
      label: "Install the drive check tools",
      preview: `Installs ${listed} from Ubuntu's archive, then confirms fsck.exfat and smartctl answer and reads every disk's SMART health again. No drive is touched or checked by this step.`,
    };
  }
  return {
    operationId: "apt.install",
    parameters: { packages: ["exfatprogs"] },
    label: "Install the exFAT checker",
    preview: "Installs the exfatprogs package (fsck.exfat, tune.exfat). No drive is touched or checked by this step.",
  };
}

/**
 * An exFAT drive on a server with no way to check it. exFAT is what every large external drive
 * ships with, and after an unclean disconnect it is the filesystem most worth checking before it
 * is written to again - but Ubuntu does not install fsck.exfat by default, so "check the drive"
 * is not something this server can do until it has exfatprogs.
 */
export function exfatCheckerMissing({ mounts = [], tools = null, driveTools = null } = {}) {
  if (!tools || tools.fsckExfat !== false) return [];
  const exfat = mounts.filter((mount) => mount.fstype === "exfat");
  if (!exfat.length) return [];
  return [finding({
    id: "exfat-checker-missing",
    severity: "warning",
    title: "This server cannot check its exFAT drives",
    detail: `${exfat.map((mount) => mount.target).join(", ")} ${exfat.length === 1 ? "is" : "are"} exFAT, and fsck.exfat is not installed. After a drive drops off and comes back, a check before writing to it again is the difference between a scare and a corrupted folder table. Installing exfatprogs adds the checker; it changes nothing on the drives.`,
    evidence: [`${exfat.length} exFAT mount${exfat.length === 1 ? "" : "s"}`, "fsck.exfat not found in /usr/sbin or /sbin"],
    fixes: [installDriveToolsFix(driveTools)],
  })];
}

/**
 * A drive that keeps dropping off USB. One drop is a knock; two in a month on the same port is a
 * cable, a port, or an enclosure that cannot hold the bus - and each one leaves a dead mount behind
 * until somebody notices. The kernel names the port and the device; this says it before the third.
 * No operation fixes a cable, so this is one of the few findings whose answer is a thing to do by
 * hand; Repair offers to reconnect the drive automatically in the meantime.
 */
export function flakyDrives({ usb = null } = {}) {
  if (!usb?.available || !Array.isArray(usb.ports)) return [];
  return usb.ports.filter((entry) => entry.drops.length >= 2).map((entry) => finding({
    id: `flaky-drive:${entry.port}`,
    severity: "warning",
    title: `${entry.product ?? "A USB drive"} keeps dropping off USB port ${entry.port}`,
    detail: `It disconnected ${entry.drops.length} times in the last ${usb.days ?? 30} days, most recently ${new Date(entry.lastDropAt).toLocaleString()}, and came back on its own each time. Every drop leaves whatever was mounted from it pointing at nothing until it is reconnected. ${entry.powerFaults ? "The port reported a power fault, so the enclosure is drawing more than it can supply: use a powered hub or a different port." : "No power fault was logged, which points at the cable or the port: try a different, shorter cable first, then a port directly on the motherboard."}`,
    evidence: [`${entry.drops.length} disconnects on port ${entry.port}`, ...(entry.vendorId ? [`device ${entry.vendorId}:${entry.productId}`] : []), ...(entry.powerFaults ? [`${entry.powerFaults} over-current event(s)`] : []), ...(entry.resets ? [`${entry.resets} bus reset(s)`] : [])],
    manual: entry.powerFaults
      ? "Plug the drive into a powered USB hub, or a port directly on the motherboard. Until then, turn on reconnecting it automatically so a drop is mended before anything reads the empty folder."
      : "Swap the drive's USB cable for a shorter one, or move it to a port directly on the motherboard. Until then, turn on reconnecting it automatically so a drop is mended before anything reads the empty folder.",
  }));
}


/**
 * A USB drive that has dropped since it was last checked, or any drive the kernel found not cleanly
 * unmounted when it last mounted it. Both are in the kernel log, the last check (if any) in the
 * recorded verdicts; either newer than the last clean check earns the offer. A drive that has never
 * been checked after one is exactly the case where the directory table is worth reading before
 * anything writes to it again.
 *
 * The second came from the owner's reboot: the kernel said "Volume was not properly unmounted",
 * nothing had dropped, and so nothing offered the check - the owner reconnected the drive instead,
 * which never reads the table.
 *
 * An exFAT drive on a server without fsck.exfat cannot be checked yet, and offering the check would
 * stop its apps for a job that cannot run. The offer is the install instead, and becomes the check
 * once the checker is there.
 */
export function drivesNeedingCheck(facts = {}) {
  const { mounts = [], devices = [], usb = null, unclean = null, volumes = null, driveChecks = {}, tools = null, driveTools = null } = facts;
  const lastDrop = usb?.available && Array.isArray(usb.ports) ? usb.ports.reduce((latest, port) => (port.lastDropAt && (!latest || port.lastDropAt > latest) ? port.lastDropAt : latest), null) : null;
  // The other way a drive comes to need a check (M26): mounted after it was not unmounted cleanly.
  // A reboot or a power cut does this without any USB drop.
  const uncleanByDevice = new Map((unclean?.available && Array.isArray(unclean.events) ? unclean.events : []).map((event) => [event.device, event]));
  const volumeByTarget = new Map((volumes?.available && Array.isArray(volumes.drives) ? volumes.drives : []).map((volume) => [volume.mountpoint, volume]));
  if (!lastDrop && uncleanByDevice.size === 0 && volumeByTarget.size === 0) return [];
  const onUsb = new Set(devices.filter((device) => device.transport === "usb").map((device) => device.path));
  const droppedWith = (mount) => (lastDrop && (onUsb.size === 0 || onUsb.has(mount.source) || [...onUsb].some((disk) => mount.source.startsWith(disk))) ? lastDrop : null);
  return mounts
    .filter((mount) => mount.managedName && mount.source?.startsWith("/dev/"))
    .flatMap((mount) => {
      const name = mount.managedName;
      const last = driveChecks?.[name];
      const checkedCleanSince = (at) => Boolean(last?.clean && at && last.checkedAt > at);
      const drop = droppedWith(mount);
      const evidence = uncleanEvidence(uncleanByDevice.get(mount.source) ?? null, volumeByTarget.get(mount.target) ?? null);
      const checkerMissing = mount.fstype === "exfat" && tools?.fsckExfat === false;
      const lastCheck = last ? `last check ${new Date(last.checkedAt).toLocaleString()}${last.clean ? (last.markedDirty ? " (clean, still marked)" : " (clean)") : " (problems found)"}` : "never checked";
      // The exFAT mark a clean check already found: Linux keeps it until a repairing check and
      // repeats its warning at every mount, so a later warning is that mark again, not news, and a
      // second read-only check would only say "clean" again. Clearing it is what is left.
      const knownMark = Boolean(evidence && mount.fstype === "exfat" && last?.clean && last.markedDirty);
      const uncleanDue = Boolean(evidence && !checkedCleanSince(evidence.at) && !knownMark);
      const dropDue = Boolean(drop && !checkedCleanSince(drop));
      const apps = appsOn(mount.target, facts.containers);
      const shares = sharesOn(mount.target, facts.sambaShares);
      const pauses = `${apps.length ? `Stops ${listOf(apps)} (${apps.length === 1 ? "it uses" : "they use"} ${mount.target})` : `Stops the apps using ${mount.target}`}, disconnects ${shares.length ? `anyone using the ${listOf(shares)} share${shares.length === 1 ? "" : "s"}` : "file-sharing clients"} (they reconnect by themselves), unmounts it`;
      if (uncleanDue || dropDue) {
        const unclean = Boolean(uncleanDue && (!dropDue || evidence.at >= drop));
        return [finding({
          id: `drive-check:${name}`,
          severity: "warning",
          title: unclean ? `${mount.target} was not unmounted cleanly and has not been checked since` : `${mount.target} has not been checked since its drive dropped`,
          detail: `${unclean
            ? "This drive was not unmounted cleanly before it was last mounted - after a power cut, a reboot that did not wait for it, or an unplug - and its filesystem says so. Whatever was being written then may have left the directory table damaged, which shows up later as files that vanish or a folder that will not open."
            : "A drive that drops off USB mid-write can be left with a damaged directory table that only shows up later, as files that vanish or a folder that will not open."} The filesystem's own checker can read the whole table without changing anything. ${checkerMissing
            ? "This drive is exFAT and fsck.exfat is not installed, so the checker comes first: install it, and this becomes the check itself."
            : "The apps using the drive are paused for the check and started again after it."}`,
          evidence: [...(uncleanDue ? evidence.lines : []), ...(drop ? [`last drop ${new Date(drop).toLocaleString()}`] : []), lastCheck, ...(checkerMissing ? ["fsck.exfat not found in /usr/sbin or /sbin"] : [])],
          fixes: [checkerMissing
            ? installDriveToolsFix(driveTools)
            : { operationId: "storage.check", parameters: { name }, label: "Check the drive", preview: `${pauses}, runs the read-only checker, mounts it again and starts ${apps.length ? listOf(apps) : "them"} again. Nothing is repaired or written.` }],
        })];
      }
      if (knownMark) {
        return [finding({
          id: `drive-mark:${name}`,
          severity: "info",
          title: `${mount.target} still carries an old "not properly unmounted" mark`,
          detail: `The check on ${new Date(last.checkedAt).toLocaleString()} found the folder table consistent and the mark still set. Linux keeps that mark until a repairing check clears it and repeats its warning every time the drive is mounted, so the warning is about the same old mark, not a new problem. Clearing it changes the mark and nothing else, since the table is consistent.`,
          evidence: [...evidence.lines, lastCheck],
          fixes: [{
            operationId: "storage.dirty-mark.clear",
            parameters: { name },
            label: "Clear the mark",
            preview: `${pauses} and runs the read-only check again. Only if that still finds nothing wrong does it run fsck.exfat -y, which on a consistent drive changes the not-properly-unmounted mark and nothing else. Then it mounts the drive and starts ${apps.length ? listOf(apps) : "them"} again. A drive with real damage is left as it is.`,
          }],
        })];
      }
      return [];
    });
}

/**
 * Whether a drive was not unmounted cleanly before its current mount, and what says so; null when
 * nothing does.
 *
 * The filesystem is the source of truth where it can be one: an ext superblock's state, and an
 * exFAT mark that is clear. A set exFAT mark on a mounted drive is not conclusive - the first write
 * after mounting sets it - so there the kernel's warning decides, and only a warning printed at
 * the current mount: this boot's log keeps every warning it ever printed, including ones from
 * mounts since undone by a check, a repair by hand or a reconnect. Without the filesystem's word
 * (a viewer's scan, or a server that could not be read), the kernel's line is all there is.
 */
function uncleanEvidence(event, volume) {
  const kernelLine = (entry) => `kernel, ${new Date(entry.at).toLocaleString()}: ${entry.message}`;
  const mountedAt = volume?.mountedAt ? Date.parse(volume.mountedAt) : null;
  const atThisMount = event && (mountedAt === null || Date.parse(event.at) >= mountedAt - 30_000) ? event : null;
  if (volume?.ext?.state) {
    if (!/not clean|error/i.test(volume.ext.state)) return null;
    const at = atThisMount?.at ?? volume.mountedAt;
    return at ? { at, lines: [`the filesystem says it is "${volume.ext.state}"`, ...(atThisMount ? [kernelLine(atThisMount)] : [])] } : null;
  }
  if (volume?.exfat?.dirty === false) return null;
  if (!atThisMount) return null;
  return { at: atThisMount.at, lines: [kernelLine(atThisMount), ...(volume?.exfat?.dirty ? ["the drive's not-properly-unmounted mark is set"] : [])] };
}

/**
 * Drives BoxPilot mounted before their fstab entries were ordered around Docker (M26).
 *
 * `nofail` keeps a missing drive from blocking boot, and in doing so leaves nothing ordering the
 * drive against docker.service. At boot the apps can start before the drive is mounted: they see
 * the empty folder underneath, a library looks wiped and downloads land on the system disk. At
 * shutdown the drive can be unmounted while Docker is still stopping them. Drives mounted since
 * carry the ordering; this offers it to the ones that do not, where an app actually uses them.
 */
export function drivesNotOrderedAroundDocker({ mounts = [], containers = [] } = {}) {
  const network = ["cifs", "smb3", "nfs", "nfs4"];
  const users = (target) => containers.filter((container) => (container.binds ?? []).some((bind) => bind === target || bind.startsWith(`${target}/`)));
  const drives = mounts
    .filter((mount) => mount.managedName && !mount.managedName.startsWith("share-") && mount.managedName !== "swap" && mount.target === mountpointFor(mount.managedName))
    .filter((mount) => typeof mount.options === "string" && !network.includes(mount.fstype) && !mount.options.split(",").includes("x-systemd.before=docker.service"))
    .map((mount) => ({ mount, users: users(mount.target) }))
    .filter((entry) => entry.users.length > 0);
  if (drives.length === 0) return [];
  const targets = drives.map((entry) => entry.mount.target);
  const one = drives.length === 1;
  return [finding({
    id: "drive-order",
    severity: "warning",
    title: `${targets.join(", ")} can be unmounted while apps are still using ${one ? "it" : "them"}`,
    detail: `Nothing tells the system to wait for ${one ? "this drive" : "these drives"} before starting Docker, or to stop Docker before unmounting ${one ? "it" : "them"}: the nofail option that keeps a missing drive from blocking boot also takes that ordering away. So a boot can start the apps before the drive is mounted, when they see an empty folder and anything they save lands on the system disk, and a shutdown can unmount it while they are still stopping.`,
    evidence: drives.flatMap((entry) => entry.users.map((container) => `${container.name} uses ${(container.binds ?? []).find((bind) => bind === entry.mount.target || bind.startsWith(`${entry.mount.target}/`))}`)),
    fixes: [{
      operationId: "storage.docker-order.apply",
      parameters: {},
      label: "Order the drives around Docker",
      preview: "Adds x-systemd.before=docker.service and x-systemd.device-timeout=30s to each drive BoxPilot mounted, so Docker waits up to 30 seconds for them at boot and stops before they are unmounted. fstab is copied first, checked with findmnt --verify before it replaces the old one, and put back if systemd does not take the change. Nothing is unmounted or restarted, and network shares and entries you wrote yourself are left alone.",
    }],
  })];
}

/**
 * A container still bound to a filesystem that has since been replaced under it. Docker resolves a
 * bind when a container starts, so one started before its drive was last mounted is looking at
 * whatever was there then - the empty folder underneath, or a mount since detached - and fixing the
 * mount appears not to have worked.
 *
 * `remountedTargets` are the drives mounted after one of their apps started (the route works them
 * out from each drive's mount time and each container's start). A drive that is itself still dead or
 * read-only is not one: its Reconnect restarts the apps as part of the fix, and restarting them on
 * the broken mount first would change nothing.
 */
export function containersOnStaleMounts({ containers = [], remountedTargets = [] } = {}) {
  const suspect = new Set(remountedTargets);
  if (suspect.size === 0) return [];
  const affected = containers.filter((container) => (container.binds ?? []).some((bind) => [...suspect].some((target) => under(bind, target))));
  return affected.map((container) => finding({
    id: `stale-bind:${container.name}`,
    severity: "warning",
    title: `${container.appName ?? container.name} is still using the old copy of its folder`,
    detail: "Docker attaches a folder when the container starts, and this one started before the drive under it was last mounted. So it is still looking at what was there then, not the drive that is there now, and it needs restarting before it sees the files.",
    evidence: [`${container.name} uses ${(container.binds ?? []).find((bind) => [...suspect].some((target) => under(bind, target)))}`, ...(container.startedAt ? [`${container.name} started ${new Date(container.startedAt).toLocaleString()}`] : [])],
    fixes: [{
      operationId: "app.action",
      parameters: { id: container.appId ?? container.name.replace(/^bp-/, ""), action: "restart" },
      label: `Restart ${container.appName ?? container.name}`,
      preview: `Restarts ${container.appName ?? container.name} so it picks up the folder as it is mounted now. Its data and settings are untouched.`,
    }],
  }));
}

/** The managed drive a path sits on, when that drive keeps no owners and was mounted without one. */
function ownerlessDriveUnder(path, mounts = []) {
  const mount = mountFor(path, mounts);
  if (!mount?.managedName || mount.managedName.startsWith("share-")) return null;
  if (!ownerless.includes(String(mount.fstype ?? "").toLowerCase())) return null;
  return /(^|,)uid=/.test(mount.options ?? "") ? null : mount;
}

/**
 * A share that is served read-write out of a folder owned by root, with no user to write as. The
 * connection succeeds and every write fails, which reads as a permissions muddle on the client and
 * is invisible on the server. Samba writes as the folder's owner, so the fix hands the folder to the
 * user apps run as; on an exFAT drive, which keeps no owners, it is the drive's mount that changes.
 */
export function unwritableShares(facts = {}) {
  const { shares = [], mounts = [] } = facts;
  return shares
    .filter((share) => !share.readOnly && share.ownerUid === 0 && !share.forceUser)
    .map((share) => {
      const drive = ownerlessDriveUnder(share.path, mounts);
      return finding({
        id: `share-unwritable:${share.name}`,
        severity: "warning",
        title: `Nobody can write to the ${share.name} share`,
        detail: drive
          ? `${share.path} is on ${drive.target}, a ${drive.fstype} drive mounted without an owner, so everything on it belongs to root and everyone connecting is read-only there however the share is configured. Opening it works, saving into it does not.`
          : `${share.path} is owned by root, so everyone connecting is read-only there however the share is configured. Opening it works, saving into it does not.`,
        evidence: [`${share.path} is owned by root`, "the share is set read-write", ...(drive ? [`${drive.target} is ${drive.fstype}, mounted without uid=`] : [])],
        fixes: [drive ? writableFix(drive, facts) : {
          operationId: "samba.share.writable",
          parameters: { share: share.name },
          label: "Let people write to it",
          preview: `Hands ${share.path} itself (not the folders inside it, which keep their owners) to user ${appUser}, the user apps run as, and applies the shares again so ${share.name} writes as that user. Nothing in the folder is changed.`,
        }],
      });
    });
}

/**
 * Sharing on the LAN without WS-Discovery. Windows browses with WS-Discovery, which Samba does not
 * speak, and the NetBIOS browsing it does speak has been off in Windows for years. The share works
 * if you type its address, so nothing is broken — it just cannot be found.
 */
export function windowsCannotDiscover({ samba = null } = {}) {
  if (!samba?.configured || samba.scope !== "lan" || samba.shareCount === 0) return [];
  if (samba.discoveryRunning) return [];
  return [finding({
    id: "windows-discovery",
    severity: "info",
    title: "Windows will not list this server under Network",
    detail: "Windows finds file servers with WS-Discovery, which Samba does not answer. The shares work if you type the address; they just never appear on their own.",
    evidence: ["sharing on the LAN", "wsdd is not running"],
    fixes: [{
      operationId: "samba.discovery.set",
      parameters: { enabled: true },
      label: "Show it in Windows",
      preview: "Installs wsdd, runs it, and allows the two discovery ports (3702/udp, 5357/tcp) so File Explorer lists this server. Shares and permissions are unchanged.",
    }],
  })];
}

/**
 * A drive whose filesystem carries no permissions of its own (exFAT, NTFS, FAT) mounted without a
 * uid, so everything on it belongs to root and every app that runs as a normal user is read-only.
 * This is the same failure as a root-owned folder, arriving by a different route. Its fix used to
 * be "Remount it", which mounted the same line again and changed nothing; now it changes the line.
 */
export function permissionlessMounts(facts = {}) {
  const { mounts = [] } = facts;
  return mounts
    .filter((mount) => mount.managedName && !mount.managedName.startsWith("share-") && ownerless.includes((mount.fstype ?? "").toLowerCase()) && !/(^|,)uid=/.test(mount.options ?? "") && !(mount.options ?? "").split(",").includes("ro"))
    .map((mount) => finding({
      id: `permissionless-mount:${mount.managedName}`,
      severity: "warning",
      title: `Only root can write to ${mount.target}`,
      detail: `${mount.fstype} does not store owners, so everything on this drive belongs to root unless the mount says otherwise. Apps that run as a normal user cannot write there, and a share of it is read-only in practice.`,
      evidence: [`${mount.fstype} mounted without uid=`, `at ${mount.target}`, ...appsOn(mount.target, facts.containers).map((name) => `${name} uses it`)],
      fixes: [writableFix(mount, facts)],
    }));
}

/** Which mount a path actually sits on: the deepest mount point that is a prefix of it. */
export function mountFor(target, mounts = []) {
  const candidates = mounts
    .filter((mount) => mount.target && (target === mount.target || target.startsWith(mount.target === "/" ? "/" : `${mount.target}/`)))
    .sort((left, right) => right.target.length - left.target.length);
  return candidates[0] ?? null;
}

/**
 * Apps that were each pointed at a big data folder by the owner, but at folders on different
 * drives, so nothing one writes is visible to another.
 *
 * The case this is written from: qBittorrent saved into /srv/media on the 500 GB system disk while
 * Plex read /mnt/the-dump on the 15 TB drive. Both were healthy, both were configured exactly as
 * asked, and neither could see the other's files. Nothing anywhere said so, because from each app's
 * side nothing is wrong. Only owner-chosen folders under /mnt or /srv are compared: an app's own
 * private config directory is supposed to be private, and saying so about every app would be noise.
 * Which drive they should share, and moving the files already written, is the owner's decision.
 */
export function splitDataFolders({ apps = [], mounts = [] } = {}) {
  const placed = [];
  for (const app of apps) {
    for (const folder of app.dataFolders ?? []) {
      if (!/^\/(mnt|srv)\//.test(folder) && !["/mnt", "/srv"].includes(folder)) continue;
      const mount = mountFor(folder, mounts);
      placed.push({ app: app.name ?? app.id, folder, mount: mount?.target ?? "/", source: mount?.source ?? null });
    }
  }
  const drives = [...new Set(placed.map((entry) => entry.mount))];
  if (placed.length < 2 || drives.length < 2) return [];
  return [finding({
    id: "split-data-folders",
    severity: "info",
    title: "Your apps are saving to different drives",
    detail: "These apps were each given a folder to work in, but on different drives, so none of them can see what the others write. That is fine if it was deliberate; it is the usual reason a download appears nowhere and a library stays empty.",
    evidence: placed.map((entry) => `${entry.app} uses ${entry.folder} on ${entry.mount}`),
    manual: "If they are meant to share files, point them at folders on the same drive from each app's Settings, and move any existing files across first. If it is deliberate, dismiss this.",
  })];
}

/**
 * Apps that cannot write to a data folder, folded in from the catalog's own per-app check. What
 * fixes it depends on whose the folder is: one root owns is handed over by a redeploy, one on an
 * exFAT drive changes with the drive's mount, and one that belongs to somebody else's account is
 * theirs, which BoxPilot does not take over.
 */
export function unwritableAppFolders(facts = {}) {
  const { apps = [], mounts = [] } = facts;
  return apps.flatMap((app) => (app.folderProblems ?? []).slice(0, 1).map((problem) => {
    const drive = ownerlessDriveUnder(problem.path, mounts);
    const someoneElses = !drive && Number.isInteger(problem.ownerUid) && problem.ownerUid !== 0;
    return finding({
      id: `app-folder:${app.id}`,
      severity: "warning",
      title: `${app.name} cannot write to its data folder`,
      detail: `${problem.path} is ${problem.reason}. Downloads, uploads, and anything else this app saves there will fail without saying why.${drive ? ` It is on ${drive.target}, a ${drive.fstype} drive mounted without an owner, so the drive's mount is what has to change.` : ""}`,
      evidence: [`${problem.volume}: ${problem.path}`, problem.reason, ...(drive ? [`${drive.target} is ${drive.fstype}, mounted without uid=`] : [])],
      fixes: drive ? [writableFix(drive, facts)] : someoneElses ? [] : [{
        operationId: "app.reconfigure",
        parameters: { id: app.id, values: {} },
        label: "Fix folder access",
        preview: `Takes a checkpoint of ${app.name}'s data, then redeploys it with its current settings; the deploy hands ${problem.path}, which root owns, to the user ${app.name} runs as. Only that folder's owner changes, not what is inside it. Nothing else changes.`,
      }],
      manual: someoneElses ? `${problem.path} belongs to user ${problem.ownerUid}, somebody's own folder, which BoxPilot does not take over. Point ${app.name} at a folder of its own in its Settings, or give user ${problem.appUid ?? appUser} write access to this one.` : null,
    });
  }));
}

/** An app that leaked outside its VPN during a kill-switch drill: containment actually failed. */
export function vpnLeaks({ apps = [] } = {}) {
  return apps
    .filter((app) => app.killSwitchDrill?.leaked)
    .map((app) => finding({
      id: `vpn-leak:${app.id}`,
      severity: "critical",
      title: `${app.name} leaked outside its VPN`,
      detail: "During the last kill-switch drill, traffic reached the internet while the tunnel was down. Preventing exactly that is what the kill switch is for, so this needs looking at before the app is trusted with anything private.",
      evidence: [`drill on ${app.killSwitchDrill.at}`, "traffic escaped while the tunnel was down"],
      fixes: [{
        operationId: "app.vpn.killswitch.drill",
        parameters: { id: app.id },
        label: "Drill it again",
        preview: `Forces ${app.name}'s tunnel down again and re-checks whether anything escapes. Downloads pause for a few seconds and resume by themselves. A drill that holds clears this.`,
      }, {
        operationId: "app.action",
        parameters: { id: app.id, action: "stop" },
        label: `Stop ${app.name} for now`,
        preview: `Stops ${app.name}, so nothing it does can leave outside the tunnel until the kill switch is proven. It stays stopped until you start it.`,
      }],
      manual: "If the drill leaks again, check the VPN settings in the app's Settings (the provider's kill switch and the LAN ranges it allows) before starting it.",
    }));
}

/** A backup whose last restore rehearsal failed: it would not restore if it were needed. */
export function failedRehearsals({ apps = [] } = {}) {
  return apps
    .filter((app) => app.backupVerification && app.backupVerification.verified === false)
    .map((app) => finding({
      id: `backup-rehearsal:${app.id}`,
      severity: "critical",
      title: `${app.name}'s backup would not restore`,
      detail: `The last rehearsal could not unpack it: ${app.backupVerification.reason} A backup that cannot be opened is not a backup, so take a fresh one and rehearse that.`,
      evidence: [`${app.backupVerification.backup} failed on ${app.backupVerification.checkedAt}`],
      fixes: [{
        operationId: "app.backup",
        parameters: { id: app.id },
        label: "Take a fresh backup",
        preview: `Stops ${app.name} briefly, archives its data and configuration, and starts it again. Rehearse the new copy afterwards to confirm it opens.`,
      }],
    }));
}

/**
 * BoxPilot watching for problems with nowhere to send them. Every other check here, and every
 * health condition the watcher tracks, ends at a notification target; without one they are all
 * silently true and nobody hears any of it. The drive that dropped off this server went unnoticed
 * for hours for exactly this reason.
 *
 * On the owner's server ntfy was already running as a BoxPilot app while this said only "set a
 * target under Settings". So the fix is that ntfy: point the alerts at it (a new private topic and a
 * test sent to it), or start it, or install it, whichever is the next step from here.
 */
export function nothingCanReachYou({ notifications = null, apps = [], ntfy = null } = {}) {
  if (notifications?.configured !== false) return [];
  if (apps.length === 0) return [];   // nothing installed yet: there is nothing to be told about
  const connect = {
    operationId: "notifications.ntfy.connect",
    parameters: {},
    label: "Send alerts to ntfy here",
    preview: "Makes a new topic nobody can guess on the ntfy running on this server, sends a test message to it from this server, and once ntfy accepts it makes it BoxPilot's notification target. Then subscribe to that topic in the ntfy app on your phone, and every alert arrives there. Changing where alerts go needs your password, as it does in Settings.",
  };
  const fixes = ntfy?.installed && ntfy.running ? [connect]
    : ntfy?.installed ? [{ operationId: "app.action", parameters: { id: "ntfy", action: "start" }, label: "Start ntfy", preview: "Starts the ntfy app on this server. Once it is up, this offers to send BoxPilot's alerts to it." }]
      : ntfy ? [{ operationId: "app.install", parameters: { id: "ntfy", values: {} }, label: "Install ntfy here", preview: "Installs ntfy from the catalog with its default settings (web UI on port 8093), so this server has somewhere of its own to send alerts. Once it is up, this offers to send BoxPilot's alerts to it." }]
        : [];
  return [finding({
    id: "no-notification-target",
    severity: "warning",
    title: "Nothing BoxPilot notices can reach you",
    detail: `BoxPilot watches for failing disks, filesystems filling up, containers crash-looping, backups that stopped running, and drives that drop off — but it has nowhere to send any of it, so all of that watching is silent.${ntfy?.installed ? " ntfy is installed on this server, so it can go there." : ""}`,
    evidence: ["no notification target is set", ...(ntfy ? [ntfy.installed ? `ntfy is installed here${ntfy.running ? " and running" : ", but stopped"}` : "ntfy is not installed here"] : [])],
    fixes,
    manual: "Or set any other target under Settings, Notifications: an ntfy server elsewhere, Gotify, or a webhook. There is a Send test button to prove it arrives.",
  })];
}

/**
 * A backup destination still mounted where it used to be. The helper looks for it at
 * /mnt/boxpilot/backup, the one place its sandbox can be given a network share without the NAS
 * having to be on for the helper to start (server/backup-mount.mjs). The upgrade moves it; this is
 * for an install whose upgrade could not, because the share was in use or an older upgrade script
 * ran. Until it moves, copies to the NAS or drive stop with "nothing is mounted there".
 */
export function backupDestinationToMove({ fstab = [] } = {}) {
  const entry = fstab.find((row) => row.mountpoint === legacyBackupMountpoint);
  if (!entry) return [];
  return [finding({
    id: "backup-destination-moved",
    severity: "warning",
    title: `Backups look for their NAS or drive at ${backupMountpoint} now`,
    detail: `fstab still mounts the backup destination at ${legacyBackupMountpoint}. BoxPilot copies its backups to ${backupMountpoint}, so nothing is copied there until it moves. Moving it changes only where it is mounted: the share or drive, its login and everything on it stay as they are.`,
    evidence: [`${entry.device} is mounted at ${legacyBackupMountpoint}${entry.managedName ? ` (${entry.managedName})` : " by an entry you wrote"}`],
    fixes: [{
      operationId: "storage.backup.relocate",
      parameters: {},
      label: "Move the backup destination",
      preview: `Mounts ${entry.device} at ${backupMountpoint} instead of ${legacyBackupMountpoint}: releases the old mount point (and leaves it alone if something is using it), changes that one fstab entry after saving a copy beside it, and puts everything back if the new mount point does not come up.`,
    }],
  })];
}

/**
 * Apps BoxPilot lists as installed that have no container at all (M35). The owner's server had six:
 * each app's record (catalog/<id>/boxpilot.json) said installed, its compose project and data were
 * there, and Docker had no container by the name BoxPilot gives it. Start had nothing to start and
 * install refused an app already installed, so Home could only point at the catalog.
 *
 * The cause was the nightly "Clean up Docker disk space": it ran `docker system prune`, which deletes
 * every stopped container, so every app the owner stopped was gone by morning (ten on 2026-09-29).
 * So the finding says what happened, with the stop and the clean-up as its evidence, and that the
 * data is intact: a prune never touches volumes or folders. Each app gets one click back: one the
 * owner stopped on purpose (server/app-stops.mjs) is recreated and left stopped, as it was left;
 * any other is started, which builds the container again. Or Uninstall, for one no longer wanted.
 */
export function appsWithoutContainer({ apps = [], pruneRuns = [], portBlocked = new Map() } = {}) {
  const runs = pruneRuns
    .map((run) => (typeof run === "string" ? { at: run, scheduled: false, frequency: null } : run))
    .filter((run) => run?.at && Number.isFinite(Date.parse(run.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return apps
    .filter((app) => app.missingContainer)
    .map((app) => {
      const missing = app.missingContainer;
      const installedAt = app.installedAt ? Date.parse(app.installedAt) : Number.NaN;
      const stoppedAt = app.stoppedAt ? Date.parse(app.stoppedAt) : Number.NaN;
      const stopped = Number.isFinite(stoppedAt);
      // The clean-up that removed it: the first one after the owner stopped it. Without a stop on
      // record, the latest one since the install (the app had stopped or crashed by then).
      const prune = stopped
        ? runs.find((run) => Date.parse(run.at) > stoppedAt) ?? null
        : runs.filter((run) => !Number.isFinite(installedAt) || Date.parse(run.at) > installedAt).at(-1) ?? null;
      const cleanup = prune?.scheduled ? (prune.frequency === "daily" ? "the nightly clean-up" : "the scheduled clean-up") : "Docker's clean-up";
      const certain = Boolean(prune) && stopped;
      const title = prune
        ? `${app.name} was ${certain ? "" : "most likely "}removed by ${cleanup}; your data is intact`
        : `The container for ${app.name} was removed outside BoxPilot; its data folder is still here`;
      const kept = missing.projectPresent ? "its settings, its data and its compose project" : "its settings and its data";
      const detail = prune
        ? `${certain ? `You stopped ${app.name} ${when(app.stoppedAt)}, and ${cleanup} ran ${when(prune.at)}` : `${cleanup[0].toUpperCase()}${cleanup.slice(1)} ran ${when(prune.at)}, after ${app.name} had stopped`}. It ran "docker system prune" then, which deletes every stopped container, and so it deleted ${app.name}'s; it no longer removes containers. It never touched volumes or folders: ${kept} are all still here, so ${app.name} can be put back exactly as it was.${stopped ? " It comes back stopped, as you left it." : ""}`
        : `BoxPilot's record says ${app.name} is installed, and ${kept} are still here, but Docker has no container for it, so it is not running. A container goes like this when it is removed by hand or by another Docker tool while the app is stopped. It can be put back from what was saved.`;
      const recreate = stopped
        ? {
          operationId: "app.reinstall",
          parameters: { id: app.id, start: false },
          label: "Recreate (stays stopped)",
          preview: `Builds ${app.name}'s container again from its ${missing.projectPresent ? "saved compose project, as it was last deployed" : "saved settings, on the image it last ran, since its compose project is gone too"}, and leaves it stopped, as you left it: start it whenever you want it. Its data is used as it is; nothing is reset or deleted.`,
        }
        : missing.projectPresent
          ? {
            operationId: "app.action",
            parameters: { id: app.id, action: "start" },
            label: "Start",
            preview: `Starts ${app.name}: with no container to start, it builds the container again from its saved compose project, as it was last deployed, and starts it. Its data is used as it is; nothing is reset or deleted.`,
          }
          : {
            operationId: "app.reinstall",
            parameters: { id: app.id },
            label: "Start",
            preview: `Writes ${app.name}'s compose project again from its saved settings, on the image it last ran (the file is gone too), builds its container, starts it and waits for it to be healthy. Its data is used as it is; nothing is reset or deleted. If it does not come up, what started is taken down again.`,
          };
      // Starting it again would fail on a port something else holds: Dockge's Start (2026-09-29) failed
      // exactly so. That finding carries the fixes, and each one also starts it; creating the
      // container stopped binds no port, so that one stays.
      const blocked = portBlocked.get(app.id) ?? null;
      const startsIt = recreate.operationId === "app.action" || recreate.parameters?.start !== false;
      return finding({
        id: `app-missing:${app.id}`,
        severity: "warning",
        title,
        detail,
        evidence: [
          ...(stopped ? [`you stopped it ${when(app.stoppedAt)}`] : []),
          ...(prune ? [`${cleanup} (docker system prune) ran ${when(prune.at)}${prune.scheduled ? ", on its schedule" : ""}`] : []),
          `Docker has no container named ${missing.container}`,
          `${missing.record} still says installed`,
          missing.projectPresent ? `${missing.project} is there` : `${missing.project} is gone too`,
          ...(blocked ? [`its port is taken: see "${blocked.title}"`] : []),
        ],
        manual: blocked && startsIt ? `${app.name} cannot start again until its port is free. "${blocked.title}" has the choices, and each one also builds its container again and starts it.` : null,
        fixes: [...(blocked && startsIt ? [] : [recreate]), {
          operationId: "app.uninstall",
          parameters: { id: app.id },
          label: "Uninstall",
          preview: `Removes ${app.name} from BoxPilot's installed apps, for an app you no longer want: takes down whatever is left of its compose project and marks it uninstalled. Its data folder is kept, so installing it again from the catalog picks it back up. Nothing is deleted.`,
        }],
      });
    });
}

/**
 * Apps whose ports something else holds, or will take (the Dockge port trap, 2026-09-29).
 *
 * The case this is written from: Dockge was published on the home network on every address
 * (0.0.0.0:5001) and served on the tailnet by Tailscale Serve at the same port, so tailscaled held
 * 100.x.y.z:5001. On Linux a publish on every address fails while any one address holds the port,
 * so whichever of the two bound first after a restart kept it. The nightly clean-up had removed
 * Dockge's container; Start built it again and Docker failed with "address already in use", and
 * Repair could only show Docker's sentence.
 *
 * Two ways to be found here:
 *   - served on the tailnet at a port the app publishes on every address, whether it runs or not:
 *     the trap is set either way, and a restart or a reboot springs it;
 *   - an app that is not running, whose port a listener on the host holds (a container of another
 *     app, a process, tailscaled): it cannot start until that changes.
 *
 * `facts.listeners` are the host's listening sockets (the web service's `ss`, which cannot name
 * root's processes), `facts.serves` what Serve publishes, `facts.dockerContainers` Docker's running
 * containers, and each app's `published` the ports its compose file binds. The fixes:
 *   - Serve fronting this very app: serve it only through Tailscale (its port moves to 127.0.0.1,
 *     which Serve reaches and which does not collide), or stop serving it (it stays on the home
 *     network, and reaches the tailnet over plain HTTP);
 *   - anything else holding it: move the app to a port nothing uses.
 */
export function portConflicts({ apps = [], listeners = null, serves = [], dockerContainers = null, lanAddress = null } = {}) {
  const taken = new Set(apps.flatMap((app) => (app.published ?? []).map((port) => `${port.host}/${port.protocol}`)));
  const nameOf = (id) => apps.find((app) => app.id === id)?.name ?? null;
  const findings = [];
  for (const app of apps) {
    const published = (app.published ?? []).filter((port) => Number.isInteger(port.host));
    if (!published.length) continue;
    // Paused and restarting containers hold their ports too.
    const running = Boolean(app.container?.running);
    const project = `bp-${app.id}`;
    const own = (container) => container.app === app.id || container.name === project || String(container.name ?? "").startsWith(`${project}-`);
    const selfPorts = [...new Set(published.map((port) => port.host))];
    const conflicts = new Map();
    const add = (port, holder) => {
      const key = `${port.host}/${port.protocol}`;
      if (!conflicts.has(key)) conflicts.set(key, { port, holders: [] });
      conflicts.get(key).holders.push(holder);
    };
    if (!running && Array.isArray(listeners)) {
      for (const conflict of findPortConflicts(published.map((port) => ({ id: port.id, host: port.host, protocol: port.protocol, bind: port.bind })), listeners)) {
        const port = published.find((entry) => entry.host === conflict.port && entry.protocol === conflict.protocol);
        for (const holder of portHolders(conflict, { serves, containers: dockerContainers, own, selfPorts })) add(port, holder);
      }
    }
    for (const port of published) {
      if (port.protocol !== "tcp" || !coversEveryAddress(port.bind)) continue;
      const serve = serves.find((entry) => entry.port === port.host);
      if (!serve || conflicts.get(`${port.host}/tcp`)?.holders.some((holder) => holder.kind === "serve")) continue;
      const targetPort = serveTargetPort(serve);
      add(port, { kind: "serve", address: null, serve, url: serveUrl(serve), targetPort, self: targetPort === null || selfPorts.includes(targetPort), armed: true });
    }
    if (!conflicts.size) continue;
    // A Serve target that is another app's port names that app.
    for (const holder of [...conflicts.values()].flatMap((entry) => entry.holders)) {
      if (holder.kind === "serve" && !holder.self && holder.targetPort) holder.targetApp = apps.find((other) => other.id !== app.id && (other.published ?? []).some((port) => port.host === holder.targetPort))?.id ?? null;
    }
    findings.push(portConflictFinding(app, [...conflicts.values()], { running, listeners, serves, taken, nameOf, lanAddress }));
  }
  return findings;
}

function portConflictFinding(app, conflicts, { running, listeners, serves, taken, nameOf, lanAddress }) {
  const name = app.name ?? app.id;
  const holders = conflicts.flatMap((conflict) => conflict.holders);
  const selfServe = conflicts.find((conflict) => conflict.holders.some((holder) => holder.kind === "serve" && holder.self)) ?? null;
  const first = selfServe ?? conflicts[0];
  const port = first.port;
  const serve = first.holders.find((holder) => holder.kind === "serve")?.serve ?? null;
  const tailnetName = String(serve?.dnsName ?? serves[0]?.dnsName ?? "").split(".")[0] || null;
  const home = lanAddress ? `http://${lanAddress}:${port.host}` : `port ${port.host} on your home network`;
  const plainTailnet = tailnetName ? `http://${tailnetName}:${port.host}` : `port ${port.host} over Tailscale`;
  const sentences = conflicts.map((conflict) => {
    const verb = conflict.holders.every((holder) => holder.armed) ? "is also claimed" : "is taken";
    return `Port ${conflict.port.host}${conflict.port.protocol === "udp" ? "/udp" : ""} ${verb} ${conflict.holders.map((holder) => holderWords(holder, { appName: name, nameOf })).join(", and ")}.`;
  });
  const evidence = [
    ...conflicts.map((conflict) => `${name} publishes ${conflict.port.bind === "*" ? "" : `${conflict.port.bind}:`}${conflict.port.host}/${conflict.port.protocol}${coversEveryAddress(conflict.port.bind) ? " (every address)" : ""}`),
    ...holders.map((holder) => (holder.kind === "serve"
      ? `tailscale serve: ${holder.url ?? `port ${holder.serve?.port}`} forwards to ${holder.serve?.target ?? "?"}${holder.armed ? "" : `, and tailscaled is listening on ${holder.address}:${holder.serve?.port}`}`
      : holder.kind === "container" ? `container ${holder.container.name} publishes port ${port.host}`
        : `listening on ${holder.address}:${port.host}${holder.process ? ` (${holder.process.name})` : ""}`)),
    running ? `${name} is running` : app.missingContainer ? `${name} has no container` : `${name} is not running`,
  ];
  const restartNote = running ? "" : app.stoppedAt ? " It stays stopped, as you left it." : ` Then it starts ${name}${app.missingContainer ? ", building its container again" : ""}.`;

  if (selfServe) {
    const url = serveUrl(serve) ?? `its tailnet address at port ${port.host}`;
    // app.serve.set withdraws the app's first web port; any other served port is withdrawn by number.
    const firstWeb = (app.published ?? []).find((entry) => entry.web)?.host ?? null;
    const stopServing = firstWeb === port.host
      ? { operationId: "app.serve.set", parameters: { id: app.id, enabled: false, ...(!running && !app.stoppedAt ? { start: true } : {}) } }
      : { operationId: "app.serve.withdraw", parameters: { port: port.host } };
    // On the host's own network the app binds the port itself: there is nothing to move to 127.0.0.1.
    const tailnetOnly = port.hostNetwork ? [] : [{
      operationId: "app.exposure.set",
      parameters: { id: app.id, mode: "tailnet" },
      label: `Serve ${name} only through Tailscale`,
      preview: `Moves ${name}'s port ${port.host} to this server only (127.0.0.1), where Tailscale Serve reaches it and where it does not collide with Tailscale, and keeps publishing it at ${url}. Its address stays ${url} on every device on your tailnet; it stops answering on your home network at ${home}. It recreates ${name}'s container ${running ? "and starts it again" : `and starts it${app.stoppedAt ? " (you had stopped it)" : ""}`}. Its data and settings are untouched.`,
    }];
    return finding({
      id: `port-conflict:${app.id}`,
      severity: "warning",
      title: running ? `${name} and Tailscale Serve both claim port ${port.host}` : `${name} cannot start: Tailscale Serve holds port ${port.host}`,
      detail: `${name} is ${port.hostNetwork ? `on this server's own network and listens on every address at port ${port.host} itself` : `on your home network, published on every address at port ${port.host}`}, and Tailscale Serve also publishes it on your tailnet at ${url}. On Linux, a port held on every address and the same port held on the tailnet address cannot both be had, so whichever of the two starts first keeps it and the other fails. ${running ? `${name} has it now; after a restart or a reboot it can be Tailscale, and then ${name} will not start.` : `Tailscale has it now, so ${name} cannot start.`} Pick one way in.`,
      evidence,
      fixes: [...tailnetOnly, {
        ...stopServing,
        label: "Stop serving it on the tailnet",
        preview: `Stops Tailscale Serve publishing ${url}, so port ${port.host} is ${name}'s alone. ${name} stays on your home network at ${home}, and devices on your tailnet still reach it at ${plainTailnet}, over plain HTTP: ${url} stops working.${stopServing.operationId === "app.serve.set" ? restartNote : ` Then start ${name} from its card.`} Its data and settings are untouched.`,
      }],
    });
  }

  const holder = first.holders[0];
  const free = port.id && !port.fixed ? freePortNear(port.host, { protocol: port.protocol, listeners: listeners ?? [], taken, serves }) : null;
  const stranded = holders.find((entry) => entry.kind === "serve" && !entry.self && !entry.targetApp) ?? null;
  const fixes = [];
  if (free) {
    fixes.push({
      operationId: "app.reconfigure",
      parameters: { id: app.id, values: { ports: { [port.id]: free } }, checkpoint: false },
      label: `Move it to port ${free}`,
      preview: `Changes ${name}'s port ${port.host} to ${free}, which nothing on this server uses, and recreates its container there${running ? "" : app.stoppedAt ? " (it starts; you had stopped it)" : ", which starts it"}. Its address changes: ${lanAddress ? `http://${lanAddress}:${port.host} becomes http://${lanAddress}:${free}` : `port ${port.host} becomes ${free}`}, so update any bookmarks. Whatever holds ${port.host} keeps it. Its data and other settings are untouched.`,
    });
  }
  if (stranded) {
    fixes.push({
      operationId: "app.serve.withdraw",
      parameters: { port: port.host },
      label: "Stop publishing the old tailnet address",
      preview: `Withdraws ${stranded.url ?? `the tailnet address at port ${port.host}`}, which forwards to port ${stranded.targetPort ?? "?"}, where no app BoxPilot installed answers. Nothing about any app changes. Then start ${name} from its card.`,
    });
  }
  const what = holder.kind === "container" ? `container ${holder.container.name}` : holder.kind === "process" ? `${holder.process.name}` : holder.kind === "serve" ? "that Serve entry" : holder.kind === "tailscale" ? "Tailscale" : "the program holding it";
  return finding({
    id: `port-conflict:${app.id}`,
    severity: "warning",
    title: running ? `${name} and ${what} both claim port ${port.host}` : `${name} cannot start: port ${port.host} is taken`,
    detail: `${sentences.join(" ")} ${running ? `${name} holds it now; after a restart or a reboot it may not.` : `${name} cannot start until it is free: Docker would fail with "address already in use".`}`,
    evidence,
    fixes,
    manual: port.fixed
      ? `${name}'s port ${port.host} is fixed. Stop ${what} if it should not be running, then start ${name}.`
      : holder.kind === "process" || holder.kind === "unknown"
        ? `Or stop ${what} if it should not be running (\`sudo ss -ltnup 'sport = :${port.host}'\` names it), then start ${name}.`
        : holder.kind === "container" ? `Or stop ${what} if it should not be running, then start ${name}.` : null,
  });
}

/** A moment in the server's own locale, as the owner's clock would say it. */
function when(iso) {
  return new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/**
 * Apps with data worth keeping that have not been backed up in two weeks, or ever (M35). Home said
 * "AuDHDMAP and Protec have not been backed up recently" and offered nothing to press. This is one
 * finding for all of them, with the two answers: back them up now, in one job, and back them up
 * every night from now on (a schedule for each one that has none).
 *
 * The same judgement as src/backupProtection.ts: a backup older than `staleAfterDays` is stale, and
 * an app whose volumes are all caches is never counted.
 */
export function backupsDue({ protection = null, schedules = [], now = Date.now(), staleAfterDays = 14 } = {}) {
  if (!protection?.available || !Array.isArray(protection.apps)) return [];
  const scheduled = new Set(schedules.filter((schedule) => schedule.operationId === "app.backup" && schedule.enabled !== false).map((schedule) => schedule.parameters?.id ?? schedule.parameters?.subject).filter((id) => typeof id === "string"));
  const due = protection.apps.filter((app) => app.protectable).map((app) => {
    const newest = app.newestAt ? Date.parse(app.newestAt) : Number.NaN;
    const ageDays = Number.isFinite(newest) ? Math.floor((now - newest) / 86_400_000) : null;
    return { ...app, ageDays, never: app.backups === 0 || ageDays === null, scheduled: scheduled.has(app.id) };
  }).filter((app) => app.never || app.ageDays > staleAfterDays);
  if (due.length === 0) return [];
  const never = due.filter((app) => app.never);
  const naming = (list) => (list.length <= 2 ? list.map((app) => app.name).join(" and ") : `${list.slice(0, 2).map((app) => app.name).join(", ")} and ${list.length - 2} more`);
  const title = never.length === due.length
    ? `${naming(due)} ${due.length === 1 ? "has" : "have"} never been backed up`
    : `${naming(due)} ${due.length === 1 ? "has" : "have"} not been backed up recently`;
  const unscheduled = due.filter((app) => !app.scheduled);
  const names = listOf(due.map((app) => app.name));
  const slot = (index, total) => { const offset = Math.round((index * 119) / Math.max(total, 1)); return { hour: 2 + Math.floor(offset / 60), minute: offset % 60 }; };
  return [finding({
    id: "backups-due",
    severity: "warning",
    title,
    detail: `${due.length === 1 ? "This app holds" : "These apps hold"} data worth keeping, and ${due.length === 1 ? "its newest backup is" : "their newest backups are"} more than ${staleAfterDays} days old or missing. If the server's disk failed today, whatever changed since would be gone.${unscheduled.length ? ` ${listOf(unscheduled.map((app) => app.name))} ${unscheduled.length === 1 ? "has" : "have"} no backup schedule.` : " Each has a schedule, so check why it has not been running."}`,
    evidence: due.map((app) => `${app.name}: ${app.never ? "never backed up" : `newest backup ${app.ageDays} days old`}, ${app.scheduled ? "scheduled" : "no schedule"}`),
    fixes: [
      due.length === 1
        ? { operationId: "app.backup", parameters: { id: due[0].id }, label: "Back up now", preview: `Stops ${due[0].name} briefly, archives its data and configuration, starts it again, and keeps the newest 5 copies.` }
        : { operationId: "app.backup.many", parameters: { ids: due.map((app) => app.id) }, label: "Back up now", preview: `Backs up ${names} in one job, one at a time: each is stopped briefly, its data and configuration archived, and started again, keeping the newest 5 copies of each. One that fails does not stop the others.` },
      unscheduled.length ? {
        kind: "schedule",
        operationId: "app.backup",
        label: "Back up nightly",
        schedules: unscheduled.map((app, index) => ({ parameters: { id: app.id }, frequency: "daily", ...slot(index, unscheduled.length) })),
        preview: `Schedules a nightly backup of ${listOf(unscheduled.map((app) => app.name))} between 02:00 and 04:00, spread out so only one is stopped at a time. Each runs as a normal backup job you can see in Activity, and the first runs tonight.`,
      } : null,
    ],
  })];
}

/** Everything, worst first, with a stable order inside a severity so the list does not shuffle. */
export function detectRemediations(facts = {}) {
  // Drives mounted after one of the apps using them started: those apps hold what was there before.
  // A drive that is dead or read-only now is left to its own Reconnect, which restarts its apps.
  const broken = new Set([
    ...staleMounts(facts).map((entry) => entry.id.replace("stale-mount:", "")),
    ...readOnlyRemounts(facts).map((entry) => entry.id.replace("read-only-remount:", "")),
  ].map((name) => mountpointFor(name.startsWith("share-") ? name.slice("share-".length) : name)));
  const remountedTargets = (facts.remountedTargets ?? []).filter((target) => !broken.has(target));
  const ports = portConflicts(facts);
  const portBlocked = new Map(ports.map((entry) => [entry.id.slice("port-conflict:".length), entry]));
  const findings = [
    ...staleMounts(facts),
    ...readOnlyRemounts(facts),
    ...exfatCheckerMissing(facts),
    ...flakyDrives(facts),
    ...drivesNeedingCheck(facts),
    ...containersOnStaleMounts({ ...facts, remountedTargets }),
    ...drivesNotOrderedAroundDocker(facts),
    ...vpnLeaks(facts),
    ...failedRehearsals(facts),
    ...appsWithoutContainer({ ...facts, portBlocked }),
    ...ports,
    ...backupsDue(facts),
    ...unwritableAppFolders(facts),
    ...splitDataFolders(facts),
    ...unwritableShares(facts),
    ...permissionlessMounts(facts),
    ...nothingCanReachYou(facts),
    ...windowsCannotDiscover(facts),
    ...backupDestinationToMove(facts),
  ];
  const rank = (entry) => severities.indexOf(entry.severity);
  return {
    findings: findings.sort((left, right) => rank(left) - rank(right) || left.id.localeCompare(right.id)),
    counts: {
      critical: findings.filter((entry) => entry.severity === "critical").length,
      warning: findings.filter((entry) => entry.severity === "warning").length,
      info: findings.filter((entry) => entry.severity === "info").length,
    },
  };
}

/**
 * What a finding says, as a short hash: its severity, title and evidence. A dismissal records it,
 * and a finding whose fingerprint has changed since - another app, another drop, worse - comes back.
 */
export function fingerprintOf(entry) {
  const text = JSON.stringify([entry?.severity ?? null, entry?.title ?? null, [...(entry?.evidence ?? [])].map(String).sort()]);
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
