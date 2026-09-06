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
 */

export const severities = Object.freeze(["critical", "warning", "info"]);

/** A finding, in the shape the Repair page renders. `fix` is a registry operation, when there is one. */
function finding({ id, severity, title, detail, evidence = [], fix = null, manual = null }) {
  return { id, severity, title, detail, evidence, fix, manual };
}

/**
 * A mount whose backing device has gone. The drive dropped off the bus (USB re-enumeration is the
 * usual cause) and came back under another kernel name; the old mount stayed, pointing at nothing.
 * findmnt still lists it and df still prints the size it cached, so every check short of a real
 * read passes, while shares and bind mounts serve an empty folder.
 */
export function staleMounts({ mounts = [], devices = [] } = {}) {
  const present = new Set(devices.map((device) => device.path).filter(Boolean));
  return mounts
    .filter((mount) => mount.managedName && mount.source?.startsWith("/dev/") && !present.has(mount.source))
    .map((mount) => finding({
      id: `stale-mount:${mount.managedName}`,
      severity: "critical",
      title: `${mount.target} is mounted from a drive that is gone`,
      detail: `The mount still points at ${mount.source}, which no longer exists — the drive was disconnected and came back under a different name. Anything reading this folder gets an error or sees it empty, including network shares and any app that uses it.`,
      evidence: [`mounted from ${mount.source}`, `${mount.source} is not a device on this server`, ...(mount.sizeBytes ? [`${Math.round(mount.sizeBytes / 1024 ** 4 * 10) / 10} TiB filesystem`] : [])],
      fix: {
        operationId: "storage.remount",
        parameters: { name: mount.managedName },
        label: "Reconnect the drive",
        preview: `Detaches the dead mount at ${mount.target} and mounts it again from fstab, which finds the drive by its UUID wherever the kernel has put it, then restarts the containers using this folder. Nothing on the drive is touched.`,
      },
    }));
}

/**
 * A managed mount the kernel has turned read-only on its own. exFAT and ext4 both do this when the
 * device throws I/O errors (errors=remount-ro): the drive dropped off USB for a few seconds, or the
 * cable is marginal. The mount stays listed, df still prints numbers from cache, and every write
 * from a share or a container fails - the owner sees "I/O error" on their laptop and nothing at
 * all on the server. A mount fstab itself asked to be read-only is not this.
 */
export function readOnlyRemounts({ mounts = [] } = {}) {
  return mounts
    .filter((mount) => mount.managedName && mount.readOnly === true && !(mount.options ?? "").split(",").includes("ro"))
    .map((mount) => finding({
      id: `read-only-remount:${mount.managedName}`,
      severity: "critical",
      title: `${mount.target} has gone read-only`,
      detail: `The filesystem hit errors and protected itself by refusing every write since. That is what a drive dropping off USB for a moment does, and it is why saving to this folder from another computer fails with an I/O error while the folder still appears to be there. Reconnecting it mounts the drive again as it is now; if it keeps happening, the cable, port or enclosure is the thing to change.`,
      evidence: [`mounted from ${mount.source} with ro`, `fstab asks for it read-write`, ...(mount.fstype ? [`${mount.fstype} filesystem`] : [])],
      fix: {
        operationId: "storage.remount",
        parameters: { name: mount.managedName },
        label: "Reconnect the drive",
        preview: `Detaches the read-only mount at ${mount.target} and mounts it again from fstab, read-write, finding the drive by its UUID wherever the kernel has put it. Nothing on the drive is touched, and the containers using this folder are restarted so they see it again.`,
      },
    }));
}

/**
 * An exFAT drive on a server with no way to check it. exFAT is what every large external drive
 * ships with, and after an unclean disconnect it is the filesystem most worth checking before it
 * is written to again - but Ubuntu does not install fsck.exfat by default, so "check the drive"
 * is not something this server can do until it has exfatprogs.
 */
export function exfatCheckerMissing({ mounts = [], tools = null } = {}) {
  if (!tools || tools.fsckExfat !== false) return [];
  const exfat = mounts.filter((mount) => mount.fstype === "exfat");
  if (!exfat.length) return [];
  return [finding({
    id: "exfat-checker-missing",
    severity: "warning",
    title: "This server cannot check its exFAT drives",
    detail: `${exfat.map((mount) => mount.target).join(", ")} ${exfat.length === 1 ? "is" : "are"} exFAT, and fsck.exfat is not installed. After a drive drops off and comes back, a check before writing to it again is the difference between a scare and a corrupted folder table. Installing exfatprogs adds the checker; it changes nothing on the drives.`,
    evidence: [`${exfat.length} exFAT mount${exfat.length === 1 ? "" : "s"}`, "fsck.exfat not found in /usr/sbin or /sbin"],
    fix: {
      operationId: "apt.install",
      parameters: { packages: ["exfatprogs"] },
      label: "Install the exFAT checker",
      preview: "Installs the exfatprogs package (fsck.exfat, tune.exfat). No drive is touched or checked by this step.",
    },
  })];
}

/**
 * A drive that keeps dropping off USB. One drop is a knock; two in a month on the same port is a
 * cable, a port, or an enclosure that cannot hold the bus - and each one leaves a dead mount behind
 * until somebody notices. The kernel names the port and the device; this says it before the third.
 */
export function flakyDrives({ usb = null } = {}) {
  if (!usb?.available || !Array.isArray(usb.ports)) return [];
  return usb.ports.filter((entry) => entry.drops.length >= 2).map((entry) => finding({
    id: `flaky-drive:${entry.port}`,
    severity: "warning",
    title: `${entry.product ?? "A USB drive"} keeps dropping off USB port ${entry.port}`,
    detail: `It disconnected ${entry.drops.length} times in the last ${usb.days ?? 30} days, most recently ${new Date(entry.lastDropAt).toLocaleString()}, and came back on its own each time. Every drop leaves whatever was mounted from it pointing at nothing until it is reconnected. ${entry.powerFaults ? "The port reported a power fault, so the enclosure is drawing more than it can supply: use a powered hub or a different port." : "No power fault was logged, which points at the cable or the port: try a different, shorter cable first, then a port directly on the motherboard."}`,
    evidence: [`${entry.drops.length} disconnects on port ${entry.port}`, ...(entry.vendorId ? [`device ${entry.vendorId}:${entry.productId}`] : []), ...(entry.powerFaults ? [`${entry.powerFaults} over-current event(s)`] : []), ...(entry.resets ? [`${entry.resets} bus reset(s)`] : [])],
    fix: null,
  }));
}


/**
 * A USB drive that has dropped since it was last checked. The drop is in the kernel log, the last
 * check (if any) in the recorded verdicts; a drop newer than the last clean check earns the offer.
 * A drive that has never been checked after a drop is exactly the case where the directory table
 * is worth reading before anything writes to it again.
 */
export function drivesNeedingCheck({ mounts = [], devices = [], usb = null, driveChecks = {} } = {}) {
  if (!usb?.available || !Array.isArray(usb.ports) || !usb.ports.length) return [];
  const lastDrop = usb.ports.reduce((latest, port) => (port.lastDropAt && (!latest || port.lastDropAt > latest) ? port.lastDropAt : latest), null);
  if (!lastDrop) return [];
  const onUsb = new Set(devices.filter((device) => device.transport === "usb").map((device) => device.path));
  return mounts
    .filter((mount) => mount.managedName && mount.source?.startsWith("/dev/") && (onUsb.size === 0 || onUsb.has(mount.source) || [...onUsb].some((disk) => mount.source.startsWith(disk))))
    .filter((mount) => { const last = driveChecks?.[mount.managedName]; return !(last?.clean && last.checkedAt > lastDrop); })
    .map((mount) => finding({
      id: `drive-check:${mount.managedName}`,
      severity: "warning",
      title: `${mount.target} has not been checked since its drive dropped`,
      detail: `A drive that drops off USB mid-write can be left with a damaged directory table that only shows up later, as files that vanish or a folder that will not open. The filesystem's own checker can read the whole table without changing anything. The apps using the drive are paused for the check and started again after it.`,
      evidence: [`last drop ${new Date(lastDrop).toLocaleString()}`, driveChecks?.[mount.managedName] ? `last check ${new Date(driveChecks[mount.managedName].checkedAt).toLocaleString()}${driveChecks[mount.managedName].clean ? " (clean)" : " (problems found)"}` : "never checked"],
      fix: { operationId: "storage.check", parameters: { name: mount.managedName }, label: "Check the drive", preview: `Stops the containers using ${mount.target}, unmounts it, runs the read-only checker, mounts it again and starts them. Nothing is repaired or written.` },
    }));
}

/**
 * A container still bound to a mount that has since been re-attached. Docker resolves a bind at
 * start; remounting underneath it leaves the container looking at the old, empty filesystem, so
 * fixing the mount appears not to have worked.
 */
export function containersOnStaleMounts({ containers = [], staleTargets = [], remountedTargets = [] } = {}) {
  const suspect = new Set([...staleTargets, ...remountedTargets]);
  if (suspect.size === 0) return [];
  const affected = containers.filter((container) => (container.binds ?? []).some((bind) => [...suspect].some((target) => bind === target || bind.startsWith(`${target}/`))));
  return affected.map((container) => finding({
    id: `stale-bind:${container.name}`,
    severity: "warning",
    title: `${container.name} is still using the old copy of that folder`,
    detail: "Docker attaches a folder when the container starts, so this one is still looking at the filesystem that was mounted then, not the one that is there now. It needs restarting before it sees the files again.",
    evidence: [`${container.name} uses ${(container.binds ?? []).find((bind) => [...suspect].some((target) => bind === target || bind.startsWith(`${target}/`)))}`],
    fix: {
      operationId: "app.action",
      parameters: { id: container.appId ?? container.name.replace(/^bp-/, ""), action: "restart" },
      label: `Restart ${container.name}`,
      preview: `Restarts ${container.name} so it picks up the folder as it is mounted now. Its data and settings are untouched.`,
    },
  }));
}

/**
 * A share that is served read-write out of a folder owned by root, with no user to write as. The
 * connection succeeds and every write fails, which reads as a permissions muddle on the client and
 * is invisible on the server.
 */
export function unwritableShares({ shares = [] } = {}) {
  return shares
    .filter((share) => !share.readOnly && share.ownerUid === 0 && !share.forceUser)
    .map((share) => finding({
      id: `share-unwritable:${share.name}`,
      severity: "warning",
      title: `Nobody can write to the ${share.name} share`,
      detail: `${share.path} is owned by root, so everyone connecting is read-only there however the share is configured. Opening it works, saving into it does not.`,
      evidence: [`${share.path} is owned by root`, "the share is set read-write"],
      manual: "Hand the folder to a user on the Storage page (mount it as writable by your apps, or change its owner), then apply the shares again.",
    }));
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
    fix: {
      operationId: "samba.discovery.set",
      parameters: { enabled: true },
      label: "Show it in Windows",
      preview: "Installs wsdd, runs it, and allows the two discovery ports (3702/udp, 5357/tcp) so File Explorer lists this server. Shares and permissions are unchanged.",
    },
  })];
}

/**
 * A drive whose filesystem carries no permissions of its own (exFAT, NTFS, FAT) mounted without a
 * uid, so everything on it belongs to root and every app that runs as a normal user is read-only.
 * This is the same failure as a root-owned folder, arriving by a different route.
 */
export function permissionlessMounts({ mounts = [] } = {}) {
  const permissionless = ["exfat", "vfat", "ntfs", "ntfs3", "msdos"];
  return mounts
    .filter((mount) => mount.managedName && permissionless.includes((mount.fstype ?? "").toLowerCase()) && !/(^|,)uid=/.test(mount.options ?? ""))
    .map((mount) => finding({
      id: `permissionless-mount:${mount.managedName}`,
      severity: "warning",
      title: `Only root can write to ${mount.target}`,
      detail: `${mount.fstype} does not store owners, so everything on this drive belongs to root unless the mount says otherwise. Apps that run as a normal user cannot write there, and a share of it is read-only in practice.`,
      evidence: [`${mount.fstype} mounted without uid=`, `at ${mount.target}`],
      fix: {
        operationId: "storage.remount",
        parameters: { name: mount.managedName },
        label: "Remount it",
        preview: `Remounts ${mount.target} from its fstab entry. If the entry still lacks a uid, mount it again from the Storage page with "writable by your apps" ticked.`,
      },
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
    manual: "If they are meant to share files, point them at folders on the same drive from each app's Settings, and move any existing files across first.",
  })];
}

/** Apps that cannot write to a data folder, folded in from the catalog's own per-app check. */
export function unwritableAppFolders({ apps = [] } = {}) {
  return apps.flatMap((app) => (app.folderProblems ?? []).slice(0, 1).map((problem) => finding({
    id: `app-folder:${app.id}`,
    severity: "warning",
    title: `${app.name} cannot write to its data folder`,
    detail: `${problem.path} is ${problem.reason}. Downloads, uploads, and anything else this app saves there will fail without saying why.`,
    evidence: [`${problem.volume}: ${problem.path}`, problem.reason],
    fix: {
      operationId: "app.reconfigure",
      parameters: { id: app.id, values: {} },
      label: "Fix folder access",
      preview: `Redeploys ${app.name} with its current settings; the deploy hands its data folders to the user the app runs as. Nothing else changes.`,
    },
  })));
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
      fix: {
        operationId: "app.vpn.killswitch.drill",
        parameters: { id: app.id },
        label: "Drill it again",
        preview: `Forces ${app.name}'s tunnel down again and re-checks whether anything escapes. Downloads pause for a few seconds and resume by themselves.`,
      },
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
      fix: {
        operationId: "app.backup",
        parameters: { id: app.id },
        label: "Take a fresh backup",
        preview: `Stops ${app.name} briefly, archives its data and configuration, and starts it again. Rehearse the new copy afterwards to confirm it opens.`,
      },
    }));
}

/**
 * BoxPilot watching for problems with nowhere to send them. Every other check here, and every
 * health condition the watcher tracks, ends at a notification target; without one they are all
 * silently true and nobody hears any of it. The drive that dropped off this server went unnoticed
 * for hours for exactly this reason.
 */
export function nothingCanReachYou({ notifications = null, apps = [] } = {}) {
  if (notifications?.configured !== false) return [];
  if (apps.length === 0) return [];   // nothing installed yet: there is nothing to be told about
  return [finding({
    id: "no-notification-target",
    severity: "warning",
    title: "Nothing BoxPilot notices can reach you",
    detail: "BoxPilot watches for failing disks, filesystems filling up, containers crash-looping, backups that stopped running, and drives that drop off — but it has nowhere to send any of it, so all of that watching is silent.",
    evidence: ["no notification target is set"],
    manual: "Set a target under Settings, Notifications. A self-hosted ntfy server or the ntfy.sh app both work, and there is a Send test button to prove it arrives.",
  })];
}

/** Everything, worst first, with a stable order inside a severity so the list does not shuffle. */
export function detectRemediations(facts = {}) {
  // Containers bound to a dead OR read-only mount are on a filesystem that will be replaced by the
  // fix, so both kinds feed the "restart this container" findings.
  const staleTargets = [
    ...staleMounts(facts).map((entry) => entry.id.replace("stale-mount:", "")),
    ...readOnlyRemounts(facts).map((entry) => entry.id.replace("read-only-remount:", "")),
  ].map((name) => `/mnt/${name}`);
  const findings = [
    ...staleMounts(facts),
    ...readOnlyRemounts(facts),
    ...exfatCheckerMissing(facts),
    ...flakyDrives(facts),
    ...drivesNeedingCheck(facts),
    ...containersOnStaleMounts({ ...facts, staleTargets }),
    ...vpnLeaks(facts),
    ...failedRehearsals(facts),
    ...unwritableAppFolders(facts),
    ...splitDataFolders(facts),
    ...unwritableShares(facts),
    ...permissionlessMounts(facts),
    ...nothingCanReachYou(facts),
    ...windowsCannotDiscover(facts),
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
