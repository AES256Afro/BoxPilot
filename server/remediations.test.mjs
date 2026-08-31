import { describe, expect, it } from "vitest";
import { containersOnStaleMounts, detectRemediations, mountFor, nothingCanReachYou, splitDataFolders, failedRehearsals, permissionlessMounts, staleMounts, unwritableShares, vpnLeaks, windowsCannotDiscover } from "./remediations.mjs";

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
  it("names the container that needs restarting after a remount", () => {
    // Plex bind-mounts /mnt/the-dump; remounting underneath it leaves it on the empty filesystem.
    const containers = [
      { name: "bp-plex", appId: "plex", binds: ["/mnt/the-dump", "/var/lib/boxpilot-managed/catalog/plex/config"] },
      { name: "bp-jellyfin", appId: "jellyfin", binds: ["/srv/media"] },
    ];
    const found = containersOnStaleMounts({ containers, staleTargets: ["/mnt/the-dump"] });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: "stale-bind:bp-plex", severity: "warning" });
    expect(found[0].fix).toMatchObject({ operationId: "app.action", parameters: { id: "plex", action: "restart" } });
  });

  it("matches a bind below the mount, not just the mount itself", () => {
    const containers = [{ name: "bp-plex", appId: "plex", binds: ["/mnt/the-dump/movies"] }];
    expect(containersOnStaleMounts({ containers, staleTargets: ["/mnt/the-dump"] })).toHaveLength(1);
  });

  it("does not match a folder that merely starts with the same letters", () => {
    const containers = [{ name: "bp-x", appId: "x", binds: ["/mnt/the-dump-backup"] }];
    expect(containersOnStaleMounts({ containers, staleTargets: ["/mnt/the-dump"] })).toEqual([]);
  });

  it("says nothing when no mount is suspect", () => {
    expect(containersOnStaleMounts({ containers: [{ name: "bp-plex", binds: ["/mnt/the-dump"] }] })).toEqual([]);
  });
});

describe("shares and drives nobody can write to", () => {
  it("catches the root-owned read-write share", () => {
    const [found] = unwritableShares({ shares: [{ name: "the-dump", path: "/mnt/the-dump", readOnly: false, ownerUid: 0, forceUser: null }] });
    expect(found.severity).toBe("warning");
    expect(found.title).toContain("Nobody can write");
    expect(found.manual).toContain("Storage page");
  });

  it("accepts a share with a force user, and a read-only one", () => {
    expect(unwritableShares({ shares: [{ name: "a", path: "/mnt/a", readOnly: false, ownerUid: 0, forceUser: "bigbox" }] })).toEqual([]);
    expect(unwritableShares({ shares: [{ name: "b", path: "/mnt/b", readOnly: true, ownerUid: 0, forceUser: null }] })).toEqual([]);
  });

  it("catches exFAT mounted with no uid, which is the same failure by another route", () => {
    const [found] = permissionlessMounts({ mounts: [{ ...theDump, source: "/dev/sdb2", options: "rw,relatime" }] });
    expect(found.title).toContain("Only root can write");
    expect(found.fix.operationId).toBe("storage.remount");
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
    // The container finding is derived from the stale mount detected in the same pass.
    expect(findings.some((entry) => entry.id === "stale-bind:bp-plex")).toBe(true);

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
