import { describe, expect, it } from "vitest";
import { appsWithoutContainer, backupDestinationToMove, backupsDue, containersOnStaleMounts, detectRemediations, fingerprintOf, mountFor, nothingCanReachYou, splitDataFolders, failedRehearsals, permissionlessMounts, portConflicts, staleMounts, unwritableAppFolders, unwritableShares, vpnLeaks, windowsCannotDiscover, readOnlyRemounts, exfatCheckerMissing, flakyDrives, drivesNeedingCheck, installDriveToolsFix, drivesNotOrderedAroundDocker } from "./remediations.mjs";

/**
 * The situation each of these was written from, on a real server:
 * a 15 TB Seagate on USB dropped off the bus at 06:46, came back two seconds later as /dev/sdb,
 * and /mnt/the-dump stayed mounted from /dev/sda2 — which no longer existed. findmnt still listed
 * it, df still printed 15T with 1.9T used, and the Windows share showed "This folder is empty".
 */
const theDump = { target: "/mnt/the-dump", source: "/dev/sda2", fstype: "exfat", options: "rw,uid=1000,gid=1000", managedName: "the-dump", sizeBytes: 16 * 1024 ** 4 };
const afterReconnect = [{ path: "/dev/sdb" }, { path: "/dev/sdb1" }, { path: "/dev/sdb2" }, { path: "/dev/nvme0n1" }];

describe("a mount whose drive has gone", () => {
  it("finds it, and offers the remount that fixes it", () => {
    const [found] = staleMounts({ mounts: [theDump], devices: afterReconnect });
    expect(found).toMatchObject({ id: "stale-mount:the-dump", severity: "critical" });
    expect(found.title).toContain("/mnt/the-dump");
    expect(found.detail).toContain("no longer exists");
    expect(found.fix).toMatchObject({ operationId: "storage.remount", parameters: { name: "the-dump" } });
  });

  it("says nothing once the drive is back under its new name", () => {
    const healthy = { ...theDump, source: "/dev/sdb2" };
    expect(staleMounts({ mounts: [healthy], devices: afterReconnect })).toEqual([]);
  });

  it("leaves mounts BoxPilot does not manage alone, and ignores non-device sources", () => {
    const foreign = { target: "/mnt/other", source: "/dev/sdz1", fstype: "ext4", managedName: null };
    const network = { target: "/mnt/nas", source: "//nas.local/Public", fstype: "cifs", managedName: "nas" };
    const overlay = { target: "/var/lib/docker/overlay2/x", source: "overlay", fstype: "overlay", managedName: null };
    expect(staleMounts({ mounts: [foreign, network, overlay], devices: afterReconnect })).toEqual([]);
  });
});

describe("a container left holding the old folder", () => {
  it("names the container that started before its drive was last mounted", () => {
    // Plex bind-mounts /mnt/the-dump; a remount by hand underneath it leaves it on the old filesystem.
    const containers = [
      { name: "bp-plex", appId: "plex", appName: "Plex", binds: ["/mnt/the-dump", "/var/lib/boxpilot-managed/catalog/plex/config"], startedAt: "2026-09-28T06:00:00Z" },
      { name: "bp-jellyfin", appId: "jellyfin", binds: ["/srv/media"] },
    ];
    const found = containersOnStaleMounts({ containers, remountedTargets: ["/mnt/the-dump"] });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: "stale-bind:bp-plex", severity: "warning", title: "Plex is still using the old copy of its folder" });
    expect(found[0].fix).toMatchObject({ operationId: "app.action", parameters: { id: "plex", action: "restart" }, label: "Restart Plex" });
  });

  it("matches a bind below the mount, not just the mount itself", () => {
    const containers = [{ name: "bp-plex", appId: "plex", binds: ["/mnt/the-dump/movies"] }];
    expect(containersOnStaleMounts({ containers, remountedTargets: ["/mnt/the-dump"] })).toHaveLength(1);
  });

  it("does not match a folder that merely starts with the same letters", () => {
    const containers = [{ name: "bp-x", appId: "x", binds: ["/mnt/the-dump-backup"] }];
    expect(containersOnStaleMounts({ containers, remountedTargets: ["/mnt/the-dump"] })).toEqual([]);
  });

  it("says nothing when no mount is suspect", () => {
    expect(containersOnStaleMounts({ containers: [{ name: "bp-plex", binds: ["/mnt/the-dump"] }] })).toEqual([]);
  });

  it("leaves a drive that is still dead or read-only to its Reconnect, which restarts the apps as part of the fix", () => {
    // "Fix the safe ones" would otherwise restart Plex on the broken mount, which changes nothing.
    const containers = [{ name: "bp-plex", appId: "plex", binds: ["/mnt/the-dump"] }];
    const { findings } = detectRemediations({ mounts: [theDump], devices: afterReconnect, containers, remountedTargets: ["/mnt/the-dump"] });
    expect(findings.map((entry) => entry.id)).toContain("stale-mount:the-dump");
    expect(findings.some((entry) => entry.id.startsWith("stale-bind:"))).toBe(false);
  });
});

describe("shares and drives nobody can write to", () => {
  it("catches the root-owned read-write share, and hands its folder over rather than describing how", () => {
    const [found] = unwritableShares({ shares: [{ name: "Media", path: "/srv/media", readOnly: false, ownerUid: 0, forceUser: null }] });
    expect(found.severity).toBe("warning");
    expect(found.title).toContain("Nobody can write");
    expect(found.fix).toMatchObject({ operationId: "samba.share.writable", parameters: { share: "Media" }, label: "Let people write to it" });
    expect(found.fix.preview).toContain("not the folders inside it");
    expect(found.manual).toBeNull();
  });

  it("fixes a share on an exFAT drive mounted without an owner through the drive, which is what decides it", () => {
    const exfat = { target: "/mnt/the-dump", source: "/dev/sdb2", fstype: "exfat", options: "rw,nofail", managedName: "the-dump" };
    const [found] = unwritableShares({ mounts: [exfat], shares: [{ name: "Media", path: "/mnt/the-dump/media", readOnly: false, ownerUid: 0, forceUser: null }] });
    expect(found.fix).toMatchObject({ operationId: "storage.writable", parameters: { name: "the-dump" } });
    expect(found.evidence).toContain("/mnt/the-dump is exfat, mounted without uid=");
  });

  it("offers no fix it would refuse for a share on an exFAT drive BoxPilot did not mount, and says what to do", () => {
    // samba.share.writable refuses a folder on a drive that keeps no owners and points at
    // storage.writable, which changes only drives BoxPilot mounted: pressed, it failed every time.
    const foreign = { target: "/media/usb", source: "/dev/sdc1", fstype: "exfat", options: "rw,nosuid,nodev", managedName: null };
    const [found] = unwritableShares({ mounts: [foreign], shares: [{ name: "Stick", path: "/media/usb/share", readOnly: false, ownerUid: 0, forceUser: null }] });
    expect(found).toMatchObject({ id: "share-unwritable:Stick", fix: null, fixes: [] });
    expect(found.detail).toContain("add uid=1000,gid=1000 to its line in /etc/fstab");
    // A drive BoxPilot mounted is still fixed through the drive, and a Linux folder by handing it over.
    expect(unwritableShares({ mounts: [{ ...foreign, managedName: "stick" }], shares: [{ name: "Stick", path: "/media/usb/share", readOnly: false, ownerUid: 0, forceUser: null }] })[0].fix).toMatchObject({ operationId: "storage.writable" });
    expect(unwritableShares({ mounts: [{ ...foreign, fstype: "ext4" }], shares: [{ name: "Stick", path: "/media/usb/share", readOnly: false, ownerUid: 0, forceUser: null }] })[0].fix).toMatchObject({ operationId: "samba.share.writable" });
  });

  it("needs the real owner, not one inferred from whether a force user exists", () => {
    // Deriving ownerUid from `forceUser ? 1000 : 0` made every force-user-less read-write share
    // report "nobody can write to it", whoever actually owned the folder.
    const ownedByAUser = { name: "torrents", path: "/mnt/the-dump/torrents", readOnly: false, ownerUid: 1000, forceUser: null };
    expect(unwritableShares({ shares: [ownedByAUser] })).toEqual([]);
    const rootOwned = { ...ownedByAUser, ownerUid: 0 };
    expect(unwritableShares({ shares: [rootOwned] })).toHaveLength(1);
  });

  it("accepts a share with a force user, and a read-only one", () => {
    expect(unwritableShares({ shares: [{ name: "a", path: "/mnt/a", readOnly: false, ownerUid: 0, forceUser: "homebox" }] })).toEqual([]);
    expect(unwritableShares({ shares: [{ name: "b", path: "/mnt/b", readOnly: true, ownerUid: 0, forceUser: null }] })).toEqual([]);
  });

  it("catches exFAT mounted with no uid, which is the same failure by another route, and changes the mount", () => {
    // "Remount it" mounted the same fstab line again and changed nothing.
    const [found] = permissionlessMounts({ mounts: [{ ...theDump, source: "/dev/sdb2", options: "rw,relatime" }], containers: [{ name: "bp-plex", appName: "Plex", binds: ["/mnt/the-dump"] }], sambaShares: [{ name: "Media", path: "/mnt/the-dump/media" }] });
    expect(found.title).toContain("Only root can write");
    expect(found.fix).toMatchObject({ operationId: "storage.writable", parameters: { name: "the-dump" }, label: "Let apps write to the drive" });
    expect(found.fix.preview).toContain("uid=1000,gid=1000");
    expect(found.fix.preview).toContain("stops Plex");
    expect(found.fix.preview).toContain("the Media share");
    // A drive mounted read-only on purpose is not this.
    expect(permissionlessMounts({ mounts: [{ ...theDump, options: "ro,nofail" }] })).toEqual([]);
    // With uid= present it is fine, and an ext4 drive is never flagged.
    expect(permissionlessMounts({ mounts: [{ ...theDump, source: "/dev/sdb2" }] })).toEqual([]);
    expect(permissionlessMounts({ mounts: [{ target: "/mnt/m", fstype: "ext4", options: "rw", managedName: "m" }] })).toEqual([]);
  });
});

describe("things that are working but cannot be found or trusted", () => {
  it("explains an invisible-in-Windows share only when sharing on the LAN", () => {
    const sharing = { configured: true, scope: "lan", shareCount: 2, discoveryRunning: false };
    const [found] = windowsCannotDiscover({ samba: sharing });
    expect(found.severity).toBe("info");          // it works, it just cannot be browsed to
    expect(found.fix.operationId).toBe("samba.discovery.set");
    expect(windowsCannotDiscover({ samba: { ...sharing, discoveryRunning: true } })).toEqual([]);
    expect(windowsCannotDiscover({ samba: { ...sharing, scope: "tailscale" } })).toEqual([]);
    expect(windowsCannotDiscover({ samba: { ...sharing, shareCount: 0 } })).toEqual([]);
    expect(windowsCannotDiscover({})).toEqual([]);
  });

  it("raises a VPN leak and a backup that would not restore as critical", () => {
    const [leak] = vpnLeaks({ apps: [{ id: "qbittorrent", name: "qBittorrent", killSwitchDrill: { leaked: true, at: "2026-08-30T04:00:00Z" } }] });
    expect(leak.severity).toBe("critical");
    const [rehearsal] = failedRehearsals({ apps: [{ id: "jellyfin", name: "Jellyfin", backupVerification: { verified: false, backup: "x.tar.gz", reason: "The archive could not be unpacked.", checkedAt: "2026-08-29T03:30:00Z" } }] });
    expect(rehearsal.severity).toBe("critical");
    expect(rehearsal.fix.operationId).toBe("app.backup");
    // A drill that held and a rehearsal that passed are not findings.
    expect(vpnLeaks({ apps: [{ id: "q", killSwitchDrill: { leaked: false } }] })).toEqual([]);
    expect(failedRehearsals({ apps: [{ id: "j", backupVerification: { verified: true } }] })).toEqual([]);
  });

  it("asks for the new backup to be rehearsed once its fix has taken one, rather than for another backup", () => {
    const app = { id: "jellyfin", name: "Jellyfin", backupVerification: { verified: false, backup: "x.tar.gz", reason: "The archive could not be unpacked.", checkedAt: "2026-08-29T03:30:00Z" } };
    const protection = (newestAt) => ({ available: true, apps: [{ id: "jellyfin", name: "Jellyfin", protectable: true, backups: 3, newestAt }] });
    const [after] = failedRehearsals({ apps: [app], protection: protection("2026-08-29T09:00:00Z") });
    expect(after).toMatchObject({ id: "backup-rehearsal:jellyfin", severity: "warning", title: "Jellyfin's new backup has not been rehearsed yet", fix: { operationId: "app.backup.verify", parameters: { id: "jellyfin" }, label: "Rehearse the new backup" } });
    // The newest backup is the one that failed, or older: still critical, still "take a fresh one".
    expect(failedRehearsals({ apps: [app], protection: protection("2026-08-29T03:00:00Z") })[0]).toMatchObject({ severity: "critical", fix: { operationId: "app.backup" } });
    expect(failedRehearsals({ apps: [app], protection: { available: false } })[0].severity).toBe("critical");
  });
});

describe("the whole sweep", () => {
  it("puts the worst first and is quiet on a healthy server", () => {
    const facts = {
      mounts: [theDump],
      devices: afterReconnect,
      containers: [{ name: "bp-plex", appId: "plex", binds: ["/mnt/the-dump"] }],
      samba: { configured: true, scope: "lan", shareCount: 1, discoveryRunning: false },
      apps: [{ id: "qbittorrent", name: "qBittorrent", killSwitchDrill: { leaked: true, at: "2026-08-30T04:00:00Z" } }],
    };
    const { findings, counts } = detectRemediations(facts);
    expect(counts).toEqual({ critical: 2, warning: 1, info: 1 });
    expect(findings.map((entry) => entry.severity)).toEqual(["critical", "critical", "warning", "info"]);
    // Plex is restarted by the stale mount's own Reconnect, so it is not a finding of its own.
    expect(findings.some((entry) => entry.id === "stale-bind:bp-plex")).toBe(false);
    expect(findings.find((entry) => entry.id === "stale-mount:the-dump").fix.preview).toContain("stops bp-plex");
    // And a drive mounted before the Docker ordering existed, with an app on it, is offered it.
    expect(findings.some((entry) => entry.id === "drive-order")).toBe(true);
    // Every finding lists its fixes, the first of which is its fix.
    for (const entry of findings) expect(entry.fix).toEqual(entry.fixes[0] ?? null);

    expect(detectRemediations({}).findings).toEqual([]);
    expect(detectRemediations({}).counts).toEqual({ critical: 0, warning: 0, info: 0 });
  });

  it("gives every finding something to do about it", () => {
    const { findings } = detectRemediations({
      mounts: [theDump], devices: afterReconnect,
      shares: [{ name: "s", path: "/mnt/s", readOnly: false, ownerUid: 0, forceUser: null }],
      apps: [{ id: "a", name: "A", folderProblems: [{ path: "/srv/a", volume: "data", reason: "owned by user root, while the app runs as user 1000" }] }],
    });
    expect(findings.length).toBeGreaterThan(0);
    for (const entry of findings) expect(Boolean(entry.fix) || Boolean(entry.manual)).toBe(true);
  });
});

describe("apps saving to different drives", () => {
  // The real one: qBittorrent wrote into /srv/media on the 500 GB system disk while Plex read
  // /mnt/the-dump on the 15 TB drive. Both healthy, both configured as asked, neither able to see
  // the other's files, and nothing anywhere said so.
  const mounts = [
    { target: "/", source: "/dev/mapper/ubuntu--vg-ubuntu--lv" },
    { target: "/mnt/the-dump", source: "/dev/sdb2" },
  ];

  it("works out which drive a folder is actually on, deepest mount wins", () => {
    expect(mountFor("/srv/media/torrents", mounts).target).toBe("/");
    expect(mountFor("/mnt/the-dump/torrents/media", mounts).target).toBe("/mnt/the-dump");
    expect(mountFor("/mnt/the-dump", mounts).target).toBe("/mnt/the-dump");
    // A folder that merely shares a prefix belongs to the root mount, not the drive.
    expect(mountFor("/mnt/the-dump-backup", mounts).target).toBe("/");
    expect(mountFor("/srv/x", [])).toBe(null);
  });

  it("names the split, with each app and the drive it is really on", () => {
    const [found] = splitDataFolders({ mounts, apps: [
      { id: "qbittorrent", name: "qBittorrent", dataFolders: ["/srv/media"] },
      { id: "plex", name: "Plex", dataFolders: ["/mnt/the-dump"] },
    ] });
    expect(found.severity).toBe("info");            // it may be deliberate; it is never invisible
    expect(found.evidence).toEqual(["qBittorrent uses /srv/media on /", "Plex uses /mnt/the-dump on /mnt/the-dump"]);
    expect(found.manual).toContain("same drive");
  });

  it("stays quiet when everything is on one drive", () => {
    expect(splitDataFolders({ mounts, apps: [
      { id: "qbittorrent", name: "qBittorrent", dataFolders: ["/mnt/the-dump/torrents"] },
      { id: "plex", name: "Plex", dataFolders: ["/mnt/the-dump"] },
    ] })).toEqual([]);
  });

  it("ignores private config folders, which are supposed to be private", () => {
    // Every app has one of these; reporting them all would be noise, not a finding.
    expect(splitDataFolders({ mounts, apps: [
      { id: "vaultwarden", name: "Vaultwarden", dataFolders: ["/var/lib/boxpilot-managed/catalog/vaultwarden/data"] },
      { id: "pi-hole", name: "Pi-hole", dataFolders: ["/var/lib/boxpilot-managed/catalog/pi-hole/etc"] },
    ] })).toEqual([]);
  });

  it("needs at least two folders before there is anything to compare", () => {
    expect(splitDataFolders({ mounts, apps: [{ id: "plex", name: "Plex", dataFolders: ["/mnt/the-dump"] }] })).toEqual([]);
    expect(splitDataFolders({ mounts, apps: [] })).toEqual([]);
  });
});

describe("a watcher with nowhere to send anything", () => {
  const apps = [{ id: "plex", name: "Plex" }];

  it("says so, because it makes every other alert silent", () => {
    const [found] = nothingCanReachYou({ notifications: { configured: false }, apps });
    expect(found.severity).toBe("warning");
    expect(found.title).toContain("reach you");
    expect(found.manual).toContain("Notifications");
  });

  it("is quiet when a target is set, or when it cannot tell", () => {
    expect(nothingCanReachYou({ notifications: { configured: true }, apps })).toEqual([]);
    expect(nothingCanReachYou({ notifications: null, apps })).toEqual([]);   // unknown is not "missing"
    expect(nothingCanReachYou({ apps })).toEqual([]);
  });

  it("does not nag a server with nothing installed on it yet", () => {
    expect(nothingCanReachYou({ notifications: { configured: false }, apps: [] })).toEqual([]);
  });
});


describe("a mount the kernel turned read-only", () => {
  // The BlackBox incident of 2026-09-05: the-dump dropped off USB for eight seconds, came back as a
  // different device, and exFAT remounted the dead mount read-only. Saving from another computer
  // failed with an I/O error while the folder still appeared in every listing.
  const dump = { target: "/mnt/the-dump", source: "/dev/sdb2", fstype: "exfat", managedName: "the-dump", readOnly: true, options: "defaults,nofail,uid=1000,gid=1000" };

  it("is a critical finding with the reconnect as its fix", () => {
    const [found] = readOnlyRemounts({ mounts: [dump] });
    expect(found).toMatchObject({ id: "read-only-remount:the-dump", severity: "critical", fix: { operationId: "storage.remount", parameters: { name: "the-dump" } } });
    expect(found.title).toBe("/mnt/the-dump has gone read-only");
  });

  it("is not a finding when fstab itself asked for read-only", () => {
    expect(readOnlyRemounts({ mounts: [{ ...dump, options: "ro,nofail" }] })).toEqual([]);
  });

  it("leaves mounts BoxPilot does not manage alone", () => {
    expect(readOnlyRemounts({ mounts: [{ ...dump, managedName: null }] })).toEqual([]);
  });

  it("names the apps its reconnect stops and starts, and the shares it disconnects, since the fix replaces the filesystem under them", () => {
    // The owner's refusals: Plex held one copy of the read-only filesystem and a PC held the share.
    const facts = { mounts: [dump], devices: [{ path: "/dev/sdb2" }], containers: [{ name: "bp-plex", appId: "plex", appName: "Plex", binds: ["/mnt/the-dump"] }, { name: "bp-ntfy", appId: "ntfy", appName: "ntfy", binds: ["/srv/ntfy"] }], sambaShares: [{ name: "Media", path: "/mnt/the-dump" }, { name: "Docs", path: "/srv/docs" }] };
    const { findings } = detectRemediations(facts);
    expect(findings.map((entry) => entry.id).filter((id) => id !== "drive-order")).toEqual(["read-only-remount:the-dump"]);
    const { preview } = findings[0].fix;
    expect(preview).toContain("stops Plex (it uses this folder)");
    expect(preview).toContain("disconnects anyone using the Media share from other computers");
    expect(preview).toContain("starts Plex again");
    expect(preview).toContain("First checks the drive is connected");
    expect(preview).not.toContain("ntfy");
    expect(preview).not.toContain("Docs");
    expect(findings[0].evidence).toContain("Plex uses it");
    expect(findings[0].manual).toContain("check the drive next");
  });

  // The backup destination is a network share (share-boxpilot-backup) at /mnt/boxpilot/backup.
  // Repair offered it the drive fixes, and both refused it: "share-boxpilot-backup is a network
  // share; use the share operations for it" and "Only a drive BoxPilot mounts under /mnt can be
  // reconnected automatically".
  const backupShare = { target: "/mnt/boxpilot/backup", source: "//nas.example/BoxPilot-Backup", fstype: "cifs", managedName: "share-boxpilot-backup", readOnly: true, options: "credentials=/etc/boxpilot/secrets/share-boxpilot-backup.cred,uid=1000,nofail,_netdev,x-systemd.automount" };

  it("offers a read-only network share the share reconnect, never the drive operations", () => {
    const [found] = readOnlyRemounts({ mounts: [backupShare] });
    expect(found).toMatchObject({ id: "read-only-remount:share-boxpilot-backup", severity: "critical", title: "/mnt/boxpilot/backup has gone read-only", fix: { operationId: "share.reconnect", parameters: { name: "boxpilot-backup" }, label: "Reconnect the share" } });
    expect(found.detail).not.toMatch(/USB|drive/);
  });

  it("names the apps on a read-only share at the share's own mount point, which its reconnect restarts", () => {
    const { findings } = detectRemediations({ mounts: [backupShare], devices: [], containers: [{ name: "bp-duplicati", appId: "duplicati", appName: "Duplicati", binds: ["/mnt/boxpilot/backup/duplicati"] }] });
    const found = findings.find((entry) => entry.id === "read-only-remount:share-boxpilot-backup");
    expect(found.fix.preview).toContain("restarts Duplicati");
    expect(findings.some((entry) => entry.id === "stale-bind:bp-duplicati")).toBe(false);
  });
});

describe("a drive the kernel found not cleanly unmounted (M26)", () => {
  // The owner's reboot: no USB drop, just the kernel's line as it mounted the drive at boot.
  const mounts = [{ target: "/mnt/the-dump", source: "/dev/sda2", fstype: "exfat", managedName: "the-dump", readOnly: false, options: "defaults,nofail,uid=1000,gid=1000" }];
  const devices = [{ path: "/dev/sda", transport: "usb" }, { path: "/dev/sda2", transport: "usb" }];
  const unclean = { available: true, events: [{ device: "/dev/sda2", driver: "exFAT-fs", at: "2026-09-27T21:14:09.000Z", message: "exFAT-fs (sda2): Volume was not properly unmounted. Some data may be corrupt. Please run fsck." }] };

  it("offers the check with no USB drop at all, quoting the kernel", () => {
    const [found] = drivesNeedingCheck({ mounts, devices, usb: { available: true, ports: [] }, unclean, driveChecks: { "the-dump": { checkedAt: "2026-09-06T10:00:00.000Z", clean: true } } });
    expect(found).toMatchObject({ id: "drive-check:the-dump", severity: "warning", title: "/mnt/the-dump was not unmounted cleanly and has not been checked since", fix: { operationId: "storage.check", parameters: { name: "the-dump" } } });
    expect(found.evidence[0]).toContain("exFAT-fs (sda2): Volume was not properly unmounted");
    expect(found.evidence).toContain(`last check ${new Date("2026-09-06T10:00:00.000Z").toLocaleString()} (clean)`);
    // A viewer's scan, or a journal that could not be read, gives no events and so no offer.
    expect(drivesNeedingCheck({ mounts, devices, unclean: null })).toEqual([]);
    expect(drivesNeedingCheck({ mounts, devices, unclean: { available: false, events: unclean.events } })).toEqual([]);
  });

  it("is satisfied by a clean check after the kernel's line, and asks again after one that found problems", () => {
    expect(drivesNeedingCheck({ mounts, devices, unclean, driveChecks: { "the-dump": { checkedAt: "2026-09-28T08:00:00.000Z", clean: true } } })).toEqual([]);
    expect(drivesNeedingCheck({ mounts, devices, unclean, driveChecks: { "the-dump": { checkedAt: "2026-09-28T08:00:00.000Z", clean: false } } })).toHaveLength(1);
  });

  it("offers no check it would refuse: an NTFS drive is said to need one elsewhere", () => {
    // storage.check has no read-only checker for NTFS and refuses it, so "Check the drive" failed
    // the same way every time, and the finding never cleared.
    const ntfs = [{ ...mounts[0], fstype: "ntfs3" }];
    const ntfsLine = { available: true, events: [{ device: "/dev/sda2", driver: "ntfs3", at: "2026-09-27T21:14:09.000Z", message: "ntfs3 (sda2): volume is dirty and \"force\" flag is not set!" }] };
    const [found] = drivesNeedingCheck({ mounts: ntfs, devices, unclean: ntfsLine });
    expect(found).toMatchObject({ id: "drive-check:the-dump", fix: null, fixes: [] });
    expect(found.detail).toContain("BoxPilot has no read-only checker for ntfs3 filesystems");
    for (const fstype of ["exfat", "vfat", "ext4"]) expect(drivesNeedingCheck({ mounts: [{ ...mounts[0], fstype }], devices, unclean })[0].fix).toMatchObject({ operationId: "storage.check" });
  });

  it("matches the kernel's device to the drive mounted from it, not to any other", () => {
    expect(drivesNeedingCheck({ mounts: [{ ...mounts[0], source: "/dev/sdb2" }], devices, unclean })).toEqual([]);
  });

  it("offers the checker's install first when fsck.exfat is missing", () => {
    const [found] = drivesNeedingCheck({ mounts, devices, unclean, tools: { fsckExfat: false } });
    expect(found.fix.operationId).toBe("apt.install");
  });

  it("offers to clear a mark Linux keeps, instead of the same check after every reboot", () => {
    // The check after the first warning found the table consistent and the mark still set. The
    // kernel repeats the mark at the next mount; a second read-only check cannot change it.
    const checked = { "the-dump": { checkedAt: "2026-09-26T08:00:00.000Z", clean: true, markedDirty: true } };
    const [found] = drivesNeedingCheck({ mounts, devices, unclean, driveChecks: checked });
    expect(found).toMatchObject({ id: "drive-mark:the-dump", severity: "info", fix: { operationId: "storage.dirty-mark.clear", parameters: { name: "the-dump" } } });
    expect(found.fix.preview).toContain("changes the not-properly-unmounted mark and nothing else");
    // A drop after that check is news, though, and earns the check again.
    const usb = { available: true, ports: [{ port: "6-1", drops: ["2026-09-27T01:00:00.000Z"], lastDropAt: "2026-09-27T01:00:00.000Z" }] };
    expect(drivesNeedingCheck({ mounts, devices, usb, unclean, driveChecks: checked })[0].id).toBe("drive-check:the-dump");
  });
});

describe("what a drive's own filesystem says, over the kernel's old lines (M26)", () => {
  // The owner checked the drive by hand and cleared the mark (fsck.exfat -y), and the remount after
  // it printed nothing - but this boot's log still held the warnings from 18:02 and 18:47.
  const mounts = [{ target: "/mnt/the-dump", source: "/dev/sda2", fstype: "exfat", managedName: "the-dump", readOnly: false, options: "defaults,nofail" }];
  const warnings = (at) => ({ available: true, events: [{ device: "/dev/sda2", driver: "exFAT-fs", at, message: "exFAT-fs (sda2): Volume was not properly unmounted. Some data may be corrupt. Please run fsck." }] });
  const volume = (fields) => ({ available: true, readAt: "2026-09-28T20:00:00.000Z", drives: [{ name: "the-dump", mountpoint: "/mnt/the-dump", device: "/dev/sda2", fstype: "exfat", mounted: true, ...fields }] });

  it("ignores a warning printed at a mount since undone, even with the mark set by writes since", () => {
    const facts = { mounts, unclean: warnings("2026-09-28T18:47:10.000Z"), volumes: volume({ mountedAt: "2026-09-28T19:30:00.000Z", exfat: { dirty: true } }) };
    expect(drivesNeedingCheck(facts)).toEqual([]);
  });

  it("believes a clear mark over any warning", () => {
    expect(drivesNeedingCheck({ mounts, unclean: warnings("2026-09-28T19:30:01.000Z"), volumes: volume({ mountedAt: "2026-09-28T19:30:00.000Z", exfat: { dirty: false } }) })).toEqual([]);
  });

  it("offers the check for a warning printed at the current mount", () => {
    const [found] = drivesNeedingCheck({ mounts, unclean: warnings("2026-09-28T19:29:59.000Z"), volumes: volume({ mountedAt: "2026-09-28T19:30:00.000Z", exfat: { dirty: true } }) });
    expect(found).toMatchObject({ id: "drive-check:the-dump", fix: { operationId: "storage.check" } });
    expect(found.evidence).toContain("the drive's not-properly-unmounted mark is set");
  });

  it("takes an ext4 drive's word from its superblock: a replayed journal is not damage, errors are", () => {
    const ext = [{ ...mounts[0], fstype: "ext4", source: "/dev/sdb1", target: "/mnt/media", managedName: "media" }];
    const recovery = { available: true, events: [{ device: "/dev/sdb1", driver: "EXT4-fs", at: "2026-09-28T19:30:00.000Z", message: "EXT4-fs (sdb1): recovery complete" }] };
    const state = (text) => ({ available: true, drives: [{ name: "media", mountpoint: "/mnt/media", device: "/dev/sdb1", fstype: "ext4", mounted: true, mountedAt: "2026-09-28T19:30:00.000Z", ext: { state: text } }] });
    expect(drivesNeedingCheck({ mounts: ext, unclean: recovery, volumes: state("clean") })).toEqual([]);
    const [found] = drivesNeedingCheck({ mounts: ext, unclean: recovery, volumes: state("clean with errors") });
    expect(found).toMatchObject({ id: "drive-check:media" });
    expect(found.evidence[0]).toBe('the filesystem says it is "clean with errors"');
    // Without a kernel line, the superblock alone is enough, placed at the start of this mount.
    expect(drivesNeedingCheck({ mounts: ext, volumes: state("not clean") })).toHaveLength(1);
    expect(drivesNeedingCheck({ mounts: ext, volumes: state("not clean"), driveChecks: { media: { checkedAt: "2026-09-28T19:45:00.000Z", clean: true } } })).toEqual([]);
  });

  it("goes from check to clearing the mark to nothing, as the owner works through it", () => {
    // 1. Mounted at boot with the mark: the warning is this mount's, and nothing has checked it.
    const boot = { mounts, unclean: warnings("2026-09-28T07:12:44.000Z"), volumes: volume({ mountedAt: "2026-09-28T07:12:45.000Z", exfat: { dirty: true } }) };
    expect(drivesNeedingCheck(boot)[0].id).toBe("drive-check:the-dump");
    // 2. The check remounted it (the mark made the kernel warn again) and found it consistent but marked.
    const checked = { ...boot, unclean: warnings("2026-09-28T08:00:30.000Z"), volumes: volume({ mountedAt: "2026-09-28T08:00:31.000Z", exfat: { dirty: true } }), driveChecks: { "the-dump": { checkedAt: "2026-09-28T08:00:40.000Z", clean: true, markedDirty: true } } };
    expect(drivesNeedingCheck(checked)[0]).toMatchObject({ id: "drive-mark:the-dump", fix: { operationId: "storage.dirty-mark.clear" } });
    // 3. Clearing it remounted it once more, and that mount printed nothing.
    const cleared = { ...checked, volumes: volume({ mountedAt: "2026-09-28T08:10:00.000Z", exfat: { dirty: false } }) };
    expect(drivesNeedingCheck(cleared)).toEqual([]);
    // ...and stays that way once the apps write to it again (which sets the mark while mounted).
    expect(drivesNeedingCheck({ ...cleared, volumes: volume({ mountedAt: "2026-09-28T08:10:00.000Z", exfat: { dirty: true } }) })).toEqual([]);
  });
});

describe("drives not ordered around Docker (M26)", () => {
  // The owner's line as it was when the reboot left the drive flagged as not properly unmounted.
  const dump = { target: "/mnt/the-dump", source: "/dev/sda2", fstype: "exfat", managedName: "the-dump", options: "defaults,nofail,uid=1000,gid=1000" };
  const plex = { name: "bp-plex", appId: "plex", binds: ["/mnt/the-dump/media"] };
  const qbit = { name: "bp-qbittorrent", appId: "qbittorrent", binds: ["/mnt/the-dump"] };

  it("offers the migration for a drive an app uses, naming the apps", () => {
    const [found] = drivesNotOrderedAroundDocker({ mounts: [dump], containers: [plex, qbit, { name: "bp-ntfy", binds: ["/srv/ntfy"] }] });
    expect(found).toMatchObject({ id: "drive-order", severity: "warning", title: "/mnt/the-dump can be unmounted while apps are still using it", fix: { operationId: "storage.docker-order.apply", parameters: {} } });
    expect(found.evidence).toEqual(["bp-plex uses /mnt/the-dump/media", "bp-qbittorrent uses /mnt/the-dump"]);
  });

  it("is quiet once the entry has the ordering, when no app uses the drive, and for shares, swap and hand-made entries", () => {
    expect(drivesNotOrderedAroundDocker({ mounts: [{ ...dump, options: `${dump.options},x-systemd.before=docker.service,x-systemd.device-timeout=30s` }], containers: [plex] })).toEqual([]);
    expect(drivesNotOrderedAroundDocker({ mounts: [dump], containers: [{ name: "bp-ntfy", binds: ["/srv/ntfy"] }] })).toEqual([]);
    // A prefix is not a parent: /mnt/the-dump-2 is not on /mnt/the-dump.
    expect(drivesNotOrderedAroundDocker({ mounts: [dump], containers: [{ name: "bp-x", binds: ["/mnt/the-dump-2"] }] })).toEqual([]);
    expect(drivesNotOrderedAroundDocker({ mounts: [{ ...dump, managedName: "share-the-dump" }], containers: [plex] })).toEqual([]);
    expect(drivesNotOrderedAroundDocker({ mounts: [{ ...dump, fstype: "cifs" }], containers: [plex] })).toEqual([]);
    expect(drivesNotOrderedAroundDocker({ mounts: [{ ...dump, managedName: null }], containers: [plex] })).toEqual([]);
    expect(drivesNotOrderedAroundDocker({ mounts: [{ ...dump, options: null }], containers: [plex] })).toEqual([]);
  });

  it("is one finding for several drives", () => {
    const media = { ...dump, target: "/mnt/media", managedName: "media", source: "/dev/sdc1", fstype: "ext4", options: "defaults,nofail" };
    const found = drivesNotOrderedAroundDocker({ mounts: [dump, media], containers: [plex, { name: "bp-jellyfin", binds: ["/mnt/media/films"] }] });
    expect(found).toHaveLength(1);
    expect(found[0].title).toBe("/mnt/the-dump, /mnt/media can be unmounted while apps are still using them");
  });
});

describe("a server that cannot check its exFAT drives", () => {
  const exfat = { target: "/mnt/the-dump", source: "/dev/sda2", fstype: "exfat", managedName: "the-dump", readOnly: false, options: "defaults" };

  it("offers to install the checker when an exFAT drive is mounted and fsck.exfat is absent", () => {
    const [found] = exfatCheckerMissing({ mounts: [exfat], tools: { fsckExfat: false } });
    expect(found).toMatchObject({ id: "exfat-checker-missing", severity: "warning", fix: { operationId: "apt.install", parameters: { packages: ["exfatprogs"] } } });
  });

  it("says nothing when the checker is present, when there is no exFAT, or when it does not know", () => {
    expect(exfatCheckerMissing({ mounts: [exfat], tools: { fsckExfat: true } })).toEqual([]);
    expect(exfatCheckerMissing({ mounts: [{ ...exfat, fstype: "ext4" }], tools: { fsckExfat: false } })).toEqual([]);
    expect(exfatCheckerMissing({ mounts: [exfat] })).toEqual([]);
  });

  it("uses the pinned drive-tools install when the helper said what is on offer", () => {
    const driveTools = { installed: false, missing: ["exfatprogs"], candidatePackages: { exfatprogs: "1.2.2-1" }, repairAvailable: true };
    const [found] = exfatCheckerMissing({ mounts: [exfat], tools: { fsckExfat: false }, driveTools });
    expect(found.fix).toEqual({
      operationId: "prerequisite.drive-tools.install",
      parameters: { expectedPackages: { exfatprogs: "1.2.2-1" } },
      label: "Install the drive check tools",
      preview: "Installs exfatprogs 1.2.2-1 from Ubuntu's archive, then confirms fsck.exfat and smartctl answer and reads every disk's SMART health again. No drive is touched or checked by this step.",
    });
    // Nothing on offer: the package install, which refreshes the lists first, still works.
    expect(installDriveToolsFix({ ...driveTools, candidatePackages: {}, repairAvailable: false })).toMatchObject({ operationId: "apt.install", parameters: { packages: ["exfatprogs"] } });
  });
});


describe("a drive that keeps dropping off USB", () => {
  const twice = { available: true, days: 30, ports: [{ port: "6-1", product: "Expansion HDD", vendorId: "0bc2", productId: "2038", drops: ["2026-09-01T06:46:02.000Z", "2026-09-05T16:01:11.000Z"], returns: [], powerFaults: 0, resets: 0, lastDropAt: "2026-09-05T16:01:11.000Z" }] };

  it("is named after the second drop, with the cable as the first suspect when no power fault was logged", () => {
    const [found] = flakyDrives({ usb: twice });
    expect(found.title).toBe("Expansion HDD keeps dropping off USB port 6-1");
    expect(found.detail).toContain("cable");
    expect(found.severity).toBe("warning");
    expect(found.fix).toBeNull();   // nothing BoxPilot can run fixes a cable
    // ...so it says the one thing to do by hand, and what to turn on until then.
    expect(found.manual).toContain("shorter one");
    expect(found.manual).toContain("reconnecting it automatically");
  });

  it("blames power when the port reported a fault", () => {
    const [found] = flakyDrives({ usb: { ...twice, ports: [{ ...twice.ports[0], powerFaults: 2 }] } });
    expect(found.detail).toContain("powered hub");
  });

  it("says nothing after a single drop, or when the kernel log could not be read", () => {
    expect(flakyDrives({ usb: { ...twice, ports: [{ ...twice.ports[0], drops: ["2026-09-05T16:01:11.000Z"] }] } })).toEqual([]);
    expect(flakyDrives({ usb: { available: false, ports: [] } })).toEqual([]);
    expect(flakyDrives({})).toEqual([]);
  });
});

describe("a USB drive that dropped and has not been checked since", () => {
  const mounts = [{ target: "/mnt/the-dump", source: "/dev/sda2", fstype: "exfat", managedName: "the-dump", readOnly: false, options: "defaults" }];
  const devices = [{ path: "/dev/sda", transport: "usb" }, { path: "/dev/sda2", transport: "usb" }, { path: "/dev/nvme0n1", transport: "nvme" }];
  const usb = { available: true, days: 30, ports: [{ port: "6-1", drops: ["2026-09-05T16:01:11.000Z"], lastDropAt: "2026-09-05T16:01:11.000Z", powerFaults: 0, resets: 0, returns: [] }] };

  it("offers the read-only check after a drop with no check on record", () => {
    const [found] = drivesNeedingCheck({ mounts, devices, usb, driveChecks: {} });
    expect(found).toMatchObject({ id: "drive-check:the-dump", severity: "warning", fix: { operationId: "storage.check", parameters: { name: "the-dump" } } });
    expect(found.evidence).toContain("never checked");
  });

  it("is satisfied by a clean check newer than the drop", () => {
    expect(drivesNeedingCheck({ mounts, devices, usb, driveChecks: { "the-dump": { checkedAt: "2026-09-05T20:00:00.000Z", clean: true } } })).toEqual([]);
  });

  it("asks again after a check that found problems, or one older than the latest drop", () => {
    expect(drivesNeedingCheck({ mounts, devices, usb, driveChecks: { "the-dump": { checkedAt: "2026-09-05T20:00:00.000Z", clean: false } } })).toHaveLength(1);
    expect(drivesNeedingCheck({ mounts, devices, usb, driveChecks: { "the-dump": { checkedAt: "2026-09-01T00:00:00.000Z", clean: true } } })).toHaveLength(1);
  });

  it("says nothing when no drive has dropped, and leaves non-USB drives alone", () => {
    expect(drivesNeedingCheck({ mounts, devices, usb: { available: true, ports: [] } })).toEqual([]);
    const internal = [{ ...mounts[0], source: "/dev/nvme0n1p3", managedName: "fast" }];
    expect(drivesNeedingCheck({ mounts: internal, devices, usb })).toEqual([]);
  });

  it("offers the checker's install instead of a check that could not run when fsck.exfat is missing", () => {
    const driveTools = { installed: false, missing: ["exfatprogs"], candidatePackages: { exfatprogs: "1.2.2-1" }, repairAvailable: true };
    const [found] = drivesNeedingCheck({ mounts, devices, usb, driveChecks: {}, tools: { fsckExfat: false }, driveTools });
    expect(found).toMatchObject({ id: "drive-check:the-dump", fix: { operationId: "prerequisite.drive-tools.install", parameters: { expectedPackages: { exfatprogs: "1.2.2-1" } } } });
    expect(found.detail).toContain("fsck.exfat is not installed, so the checker comes first");
    expect(found.evidence).toContain("fsck.exfat not found in /usr/sbin or /sbin");
    // Once it is there, the same finding is the check again; an ext4 drive never needed exfatprogs.
    expect(drivesNeedingCheck({ mounts, devices, usb, tools: { fsckExfat: true }, driveTools })[0].fix.operationId).toBe("storage.check");
    expect(drivesNeedingCheck({ mounts: [{ ...mounts[0], fstype: "ext4" }], devices, usb, tools: { fsckExfat: false }, driveTools })[0].fix.operationId).toBe("storage.check");
  });
});

describe("a backup destination still where it used to be", () => {
  // The helper is given /mnt/boxpilot, not the automount point under it; one left at
  // /mnt/boxpilot-backup gets no copies until it moves (deploy/boxpilot-helper.service).
  const fstab = [
    { device: "UUID=1111-2222", mountpoint: "/mnt/media", managedName: "media" },
    { device: "//nas.local/backups", mountpoint: "/mnt/boxpilot-backup", managedName: "share-boxpilot-backup" },
  ];

  it("offers the move, and says what stays the same", () => {
    const [found] = detectRemediations({ fstab }).findings;
    expect(found).toMatchObject({ id: "backup-destination-moved", severity: "warning", fix: { operationId: "storage.backup.relocate", parameters: {} } });
    expect(found.title).toContain("/mnt/boxpilot/backup");
    expect(found.evidence).toEqual(["//nas.local/backups is mounted at /mnt/boxpilot-backup (share-boxpilot-backup)"]);
    expect(found.detail).toContain("everything on it stay as they are");
  });

  it("says nothing once it has moved, or when there is none", () => {
    expect(backupDestinationToMove({ fstab: [fstab[0], { ...fstab[1], mountpoint: "/mnt/boxpilot/backup" }] })).toEqual([]);
    expect(backupDestinationToMove({})).toEqual([]);
  });
});

describe("apps listed as installed with no container (M35)", () => {
  // The owner's server listed six apps as installed while Docker had no container for any of them.
  const record = (id) => ({ record: `/var/lib/boxpilot-managed/catalog/${id}/boxpilot.json`, project: `/var/lib/boxpilot-managed/catalog/${id}/compose.yaml`, projectPresent: true, container: `bp-${id}` });
  const apps = [
    { id: "homepage", name: "Homepage", installedAt: "2026-08-01T10:00:00.000Z", missingContainer: record("homepage") },
    { id: "it-tools", name: "IT-Tools", installedAt: "2026-09-20T10:00:00.000Z", missingContainer: { ...record("it-tools"), projectPresent: false } },
    { id: "jellyfin", name: "Jellyfin", installedAt: "2026-08-01T10:00:00.000Z", missingContainer: null },
  ];

  const when = (iso) => new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const nightly = { at: "2026-09-29T03:00:40.000Z", scheduled: true, frequency: "daily" };

  it("says the nightly clean-up removed an app the owner had stopped, and brings it back stopped in one click", () => {
    // Plex was stopped at 22:10 and gone by morning: the 03:00 prune deletes every stopped container.
    const plex = { id: "plex", name: "Plex", installedAt: "2026-08-01T10:00:00.000Z", stoppedAt: "2026-09-28T22:10:20.000Z", missingContainer: record("plex") };
    const [found] = appsWithoutContainer({ apps: [plex], pruneRuns: [{ at: "2026-09-20T03:00:00.000Z", scheduled: true, frequency: "daily" }, nightly] });
    expect(found).toMatchObject({ id: "app-missing:plex", severity: "warning", title: "Plex was removed by the nightly clean-up; your data is intact" });
    expect(found.detail).toContain(`You stopped Plex ${when(plex.stoppedAt)}, and the nightly clean-up ran ${when(nightly.at)}`);
    expect(found.detail).toContain("it no longer removes containers. It never touched volumes or folders");
    // The stop and the clean-up that followed it, not an earlier one.
    expect(found.evidence.slice(0, 2)).toEqual([`you stopped it ${when(plex.stoppedAt)}`, `the nightly clean-up (docker system prune) ran ${when(nightly.at)}, on its schedule`]);
    expect(found.fixes.map((fix) => [fix.operationId, fix.label, fix.parameters])).toEqual([
      ["app.reinstall", "Recreate (stays stopped)", { id: "plex", start: false }],
      ["app.uninstall", "Uninstall", { id: "plex" }],
    ]);
    // Uninstall keeps the data: nothing on this finding deletes anything.
    expect(found.fixes[1].preview).toContain("Its data folder is kept");
    expect(found.fixes[1].preview).toContain("Nothing is deleted");
  });

  it("offers Start for an app that was not stopped on purpose, which builds the container again", () => {
    const found = appsWithoutContainer({ apps, pruneRuns: [{ at: "2026-09-10T03:00:00.000Z", scheduled: false, frequency: null }] });
    expect(found.map((entry) => entry.id)).toEqual(["app-missing:homepage", "app-missing:it-tools"]);
    const [homepage, tools] = found;
    expect(homepage.title).toBe("Homepage was most likely removed by Docker's clean-up; your data is intact");
    expect(homepage.fixes.map((fix) => [fix.operationId, fix.label, fix.parameters])).toEqual([["app.action", "Start", { id: "homepage", action: "start" }], ["app.uninstall", "Uninstall", { id: "homepage" }]]);
    expect(homepage.evidence).toContain("Docker has no container named bp-homepage");
    expect(homepage.evidence).toContain("/var/lib/boxpilot-managed/catalog/homepage/boxpilot.json still says installed");
    // IT-Tools was installed after that clean-up, so the clean-up is not its story; and with its
    // compose project gone too, Start writes it again from the saved settings.
    expect(tools.title).toBe("The container for IT-Tools was removed outside BoxPilot; its data folder is still here");
    expect(tools.evidence.some((line) => line.includes("docker system prune"))).toBe(false);
    expect(tools.fixes[0]).toMatchObject({ operationId: "app.reinstall", label: "Start", parameters: { id: "it-tools" } });
    expect(tools.fixes[0].preview).toContain("the file is gone too");
  });
});

describe("apps that have not been backed up lately (M35)", () => {
  const now = Date.parse("2026-09-29T12:00:00.000Z");
  const daysAgo = (days) => new Date(now - days * 86_400_000).toISOString();
  const protection = { available: true, apps: [
    { id: "audhdmap", name: "AuDHDMAP", protectable: true, backups: 2, newestAt: daysAgo(23) },
    { id: "protec", name: "Protec", protectable: true, backups: 0, newestAt: null },
    { id: "jellyfin", name: "Jellyfin", protectable: true, backups: 9, newestAt: daysAgo(1) },
    { id: "it-tools", name: "IT-Tools", protectable: false, backups: 0, newestAt: null },
  ] };

  it("is one finding for all of them, with Back up now in one job and Back up nightly for those without a schedule", () => {
    const [found] = backupsDue({ protection, schedules: [{ operationId: "app.backup", parameters: { id: "audhdmap" }, enabled: true }], now });
    expect(found).toMatchObject({ id: "backups-due", severity: "warning", title: "AuDHDMAP and Protec have not been backed up recently" });
    expect(found.evidence).toEqual(["AuDHDMAP: newest backup 23 days old, scheduled", "Protec: never backed up, no schedule"]);
    expect(found.fixes[0]).toMatchObject({ operationId: "app.backup.many", parameters: { ids: ["audhdmap", "protec"] }, label: "Back up now" });
    expect(found.fixes[1]).toMatchObject({ kind: "schedule", operationId: "app.backup", label: "Back up nightly", schedules: [{ parameters: { id: "protec" }, frequency: "daily", hour: 2, minute: 0 }] });
  });

  it("backs up one app with the ordinary backup, spreads the nightly schedules out, and needs no schedule it already has", () => {
    const [one] = backupsDue({ protection: { available: true, apps: [protection.apps[1]] }, now });
    expect(one.fixes[0]).toMatchObject({ operationId: "app.backup", parameters: { id: "protec" } });
    expect(one.title).toBe("Protec has never been backed up");
    const [both] = backupsDue({ protection, now });
    expect(both.fixes[1].schedules.map((schedule) => `${schedule.hour}:${schedule.minute}`)).toEqual(["2:0", "3:0"]);
    const [scheduled] = backupsDue({ protection, schedules: ["audhdmap", "protec"].map((id) => ({ operationId: "app.backup", parameters: { id }, enabled: true })), now });
    expect(scheduled.fixes.map((fix) => fix.label)).toEqual(["Back up now"]);
    // A paused schedule protects nothing.
    const [paused] = backupsDue({ protection, schedules: [{ operationId: "app.backup", parameters: { id: "protec" }, enabled: false }], now });
    expect(paused.fixes[1].schedules.map((schedule) => schedule.parameters.id)).toEqual(["audhdmap", "protec"]);
  });

  it("is quiet when every app has a recent backup, when none is worth backing up, or when it could not be read", () => {
    expect(backupsDue({ protection: { available: true, apps: [protection.apps[2], protection.apps[3]] }, now })).toEqual([]);
    expect(backupsDue({ protection: { available: false, apps: [] }, now })).toEqual([]);
    expect(backupsDue({ protection: null, now })).toEqual([]);
  });
});

describe("somewhere for alerts to go (M35)", () => {
  const apps = [{ id: "plex", name: "Plex" }];

  it("sends them to the ntfy already running on this server, in one high-risk step", () => {
    // The owner's server ran ntfy from the catalog while this said only "set a target under Settings".
    const [found] = nothingCanReachYou({ notifications: { configured: false }, apps, ntfy: { installed: true, running: true } });
    expect(found.fix).toMatchObject({ operationId: "notifications.ntfy.connect", parameters: {}, label: "Send alerts to ntfy here" });
    expect(found.fix.preview).toContain("topic nobody can guess");
    expect(found.fix.preview).toContain("subscribe to that topic in the ntfy app on your phone");
    expect(found.evidence).toContain("ntfy is installed here and running");
  });

  it("starts ntfy first when it is stopped, installs it when it is not there, and keeps Settings as the other way", () => {
    expect(nothingCanReachYou({ notifications: { configured: false }, apps, ntfy: { installed: true, running: false } })[0].fix).toMatchObject({ operationId: "app.action", parameters: { id: "ntfy", action: "start" } });
    expect(nothingCanReachYou({ notifications: { configured: false }, apps, ntfy: { installed: false, running: false } })[0].fix).toMatchObject({ operationId: "app.install", parameters: { id: "ntfy", values: {} } });
    const [unknown] = nothingCanReachYou({ notifications: { configured: false }, apps });
    expect(unknown.fix).toBeNull();
    expect(unknown.manual).toContain("Settings, Notifications");
  });
});

describe("an app that cannot write to its folder (M35)", () => {
  const exfat = { target: "/mnt/the-dump", source: "/dev/sdb2", fstype: "exfat", options: "rw,nofail", managedName: "the-dump" };
  const problem = (fields) => ({ path: "/srv/media", volume: "Media folder", reason: "owned by user root, while the app runs as user 1000", ownerUid: 0, appUid: 1000, ...fields });

  it("redeploys an app whose folder root owns, which hands it over", () => {
    const [found] = unwritableAppFolders({ apps: [{ id: "qbittorrent", name: "qBittorrent", folderProblems: [problem()] }] });
    expect(found.fix).toMatchObject({ operationId: "app.reconfigure", parameters: { id: "qbittorrent", values: {} } });
    expect(found.fix.preview).toContain("hands /srv/media, which root owns, to the user qBittorrent runs as");
  });

  it("changes the drive's mount for a folder on exFAT, where no owner can be set on the folder", () => {
    const [found] = unwritableAppFolders({ mounts: [exfat], apps: [{ id: "qbittorrent", name: "qBittorrent", folderProblems: [problem({ path: "/mnt/the-dump/torrents" })] }] });
    expect(found.fix).toMatchObject({ operationId: "storage.writable", parameters: { name: "the-dump" } });
  });

  it("leaves somebody's own folder to them, and says the one thing to do", () => {
    const [found] = unwritableAppFolders({ apps: [{ id: "qbittorrent", name: "qBittorrent", folderProblems: [problem({ ownerUid: 1001, reason: "owned by user 1001, while the app runs as user 1000" })] }] });
    expect(found.fix).toBeNull();
    expect(found.manual).toContain("belongs to user 1001");
    expect(found.manual).toContain("in its Settings");
  });
});

/**
 * The Dockge port trap, on the owner's server (2026-09-29): Dockge on the home network (0.0.0.0:5001) and served
 * on the tailnet at the same port, so tailscaled held 100.x.y.z:5001. The clean-up had removed
 * Dockge's container, and Repair's Start failed with Docker's "address already in use".
 */
describe("ports something else holds (the Dockge port trap, 2026-09-29)", () => {
  const record = (id) => ({ record: `/var/lib/boxpilot-managed/catalog/${id}/boxpilot.json`, project: `/var/lib/boxpilot-managed/catalog/${id}/compose.yaml`, projectPresent: true, container: `bp-${id}` });
  const web = (host, bind) => ({ id: "web", host, protocol: "tcp", bind, fixed: false, web: true });
  const serve = (port) => ({ dnsName: "homebox.tailXXXX.ts.net", port, target: `http://127.0.0.1:${port}` });
  const dockge = { id: "dockge", name: "Dockge", installedAt: "2026-08-01T10:00:00.000Z", missingContainer: record("dockge"), container: { exists: false, running: false }, published: [web(5001, "0.0.0.0")] };
  const facts = { apps: [dockge], serves: [serve(5001)], listeners: [{ protocol: "tcp", address: "100.64.0.10", port: 5001, scope: "address" }], lanAddress: "192.168.1.10" };

  it("names Serve holding Dockge's own port, and offers the two ways in, each of which starts it", () => {
    const [found] = portConflicts(facts);
    expect(found).toMatchObject({ id: "port-conflict:dockge", severity: "warning", title: "Dockge cannot start: Tailscale Serve holds port 5001" });
    expect(found.detail).toContain("Tailscale Serve also publishes it on your tailnet at https://homebox.tailXXXX.ts.net:5001");
    expect(found.detail).toContain("Tailscale has it now, so Dockge cannot start.");
    expect(found.evidence).toEqual([
      "Dockge publishes 0.0.0.0:5001/tcp (every address)",
      "tailscale serve: https://homebox.tailXXXX.ts.net:5001 forwards to http://127.0.0.1:5001, and tailscaled is listening on 100.64.0.10:5001",
      "Dockge has no container",
    ]);
    expect(found.fixes.map((fix) => [fix.operationId, fix.label, fix.parameters])).toEqual([
      ["app.exposure.set", "Serve Dockge only through Tailscale", { id: "dockge", mode: "tailnet" }],
      ["app.serve.set", "Stop serving it on the tailnet", { id: "dockge", enabled: false, start: true }],
    ]);
    // Each says which address stays and which one stops.
    expect(found.fixes[0].preview).toContain("Its address stays https://homebox.tailXXXX.ts.net:5001");
    expect(found.fixes[0].preview).toContain("it stops answering on your home network at http://192.168.1.10:5001");
    expect(found.fixes[1].preview).toContain("stays on your home network at http://192.168.1.10:5001, and devices on your tailnet still reach it at http://homebox:5001, over plain HTTP: https://homebox.tailXXXX.ts.net:5001 stops working");
    expect(found.fixes[1].preview).toContain("Then it starts Dockge, building its container again.");
  });

  it("takes Start off the missing-container finding, which would fail, and points at the choices", () => {
    const { findings } = detectRemediations(facts);
    const missing = findings.find((entry) => entry.id === "app-missing:dockge");
    expect(missing.fixes.map((fix) => fix.operationId)).toEqual(["app.uninstall"]);
    expect(missing.manual).toBe('Dockge cannot start again until its port is free. "Dockge cannot start: Tailscale Serve holds port 5001" has the choices, and each one also builds its container again and starts it.');
    expect(findings.some((entry) => entry.id === "port-conflict:dockge")).toBe(true);
    // Created stopped, it binds no port: that one stays.
    const stopped = detectRemediations({ ...facts, apps: [{ ...dockge, stoppedAt: "2026-09-28T22:10:20.000Z" }] }).findings;
    expect(stopped.find((entry) => entry.id === "app-missing:dockge").fixes[0]).toMatchObject({ operationId: "app.reinstall", parameters: { id: "dockge", start: false } });
    // And the stop-serving fix leaves an app stopped on purpose stopped.
    expect(stopped.find((entry) => entry.id === "port-conflict:dockge").fixes[1].parameters).toEqual({ id: "dockge", enabled: false });
  });

  it("finds the trap set on a running app too: nothing holds the port against it yet", () => {
    const running = { ...dockge, missingContainer: null, container: { exists: true, running: true, status: "running" } };
    const [found] = portConflicts({ apps: [running], serves: [serve(5001)], listeners: [{ protocol: "tcp", address: "0.0.0.0", port: 5001, scope: "wildcard" }] });
    expect(found.title).toBe("Dockge and Tailscale Serve both claim port 5001");
    expect(found.detail).toContain("Dockge has it now; after a restart or a reboot it can be Tailscale");
    expect(found.fixes[1].parameters).toEqual({ id: "dockge", enabled: false });
  });

  it("leaves alone every served app on loopback, which is how Serve is meant to front one", () => {
    const vaultwarden = { id: "vaultwarden", name: "Vaultwarden", container: { exists: true, running: true }, published: [web(8222, "127.0.0.1")] };
    expect(portConflicts({ apps: [vaultwarden], serves: [serve(8222)], listeners: [{ protocol: "tcp", address: "100.64.0.10", port: 8222, scope: "address" }, { protocol: "tcp", address: "127.0.0.1", port: 8222, scope: "loopback" }] })).toEqual([]);
    // Nor is a stopped loopback app held by Serve on the tailnet address: two addresses.
    expect(portConflicts({ apps: [{ ...vaultwarden, container: { exists: true, running: false } }], serves: [serve(8222)], listeners: [{ protocol: "tcp", address: "100.64.0.10", port: 8222, scope: "address" }] })).toEqual([]);
  });

  it("moves an app whose port another app's container holds to the nearest free one, and says its address changes", () => {
    const uptime = { id: "uptime-kuma", name: "Uptime Kuma", container: { exists: true, running: false, status: "exited" }, published: [web(3001, "0.0.0.0")] };
    const other = { id: "gatus", name: "Gatus", container: { exists: true, running: true }, published: [web(3001, "0.0.0.0"), web(3002, "0.0.0.0")] };
    const [found] = portConflicts({
      apps: [uptime, other],
      listeners: [{ protocol: "tcp", address: "0.0.0.0", port: 3001, scope: "wildcard" }, { protocol: "tcp", address: "0.0.0.0", port: 3003, scope: "wildcard" }],
      dockerContainers: [{ name: "bp-gatus", ports: "0.0.0.0:3001->8080/tcp", app: "gatus" }],
      lanAddress: "192.168.1.10",
    });
    expect(found.title).toBe("Uptime Kuma cannot start: port 3001 is taken");
    expect(found.detail).toContain("Port 3001 is taken on every address by container bp-gatus (Gatus).");
    expect(found.fixes.map((fix) => [fix.operationId, fix.label, fix.parameters])).toEqual([["app.reconfigure", "Move it to port 3004", { id: "uptime-kuma", values: { ports: { web: 3004 } }, checkpoint: false }]]);
    expect(found.fixes[0].preview).toContain("http://192.168.1.10:3001 becomes http://192.168.1.10:3004");
    expect(found.manual).toBe("Or stop container bp-gatus if it should not be running, then start Uptime Kuma.");
  });

  it("offers only to stop serving an app on the host's own network, which binds every address itself", () => {
    const assistant = { id: "home-assistant", name: "Home Assistant", container: { exists: true, running: true }, published: [{ id: "web", host: 8123, protocol: "tcp", bind: "*", fixed: true, web: true, hostNetwork: true }] };
    const [found] = portConflicts({ apps: [assistant], serves: [serve(8123)], listeners: [] });
    expect(found.detail).toContain("on this server's own network and listens on every address at port 8123 itself");
    expect(found.fixes.map((fix) => [fix.operationId, fix.parameters])).toEqual([["app.serve.set", { id: "home-assistant", enabled: false }]]);
  });

  it("offers to withdraw an old Serve entry nothing answers behind, and never moves a fixed port", () => {
    const pihole = { id: "pi-hole", name: "Pi-hole", container: { exists: true, running: false }, published: [{ id: "web", host: 8084, protocol: "tcp", bind: "0.0.0.0", fixed: true, web: true }] };
    const [found] = portConflicts({ apps: [pihole], serves: [{ dnsName: "homebox.tailXXXX.ts.net", port: 8084, target: "http://127.0.0.1:9001" }], listeners: [{ protocol: "tcp", address: "100.64.0.10", port: 8084, scope: "address" }] });
    expect(found.fixes.map((fix) => [fix.operationId, fix.parameters])).toEqual([["app.serve.withdraw", { port: 8084 }]]);
    expect(found.manual).toContain("port 8084 is fixed");
  });
});

describe("what a dismissal holds on to (M35)", () => {
  it("is the same for a finding that says the same, and different when it says anything else", () => {
    const [first] = appsWithoutContainer({ apps: [{ id: "homepage", name: "Homepage", missingContainer: { record: "r", project: "p", projectPresent: true, container: "bp-homepage" } }] });
    const [again] = appsWithoutContainer({ apps: [{ id: "homepage", name: "Homepage", missingContainer: { record: "r", project: "p", projectPresent: true, container: "bp-homepage" } }] });
    expect(fingerprintOf(first)).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprintOf(again)).toBe(fingerprintOf(first));
    expect(fingerprintOf({ ...first, evidence: [...first.evidence, "one more line"] })).not.toBe(fingerprintOf(first));
    expect(fingerprintOf({ ...first, severity: "critical" })).not.toBe(fingerprintOf(first));
  });
});
