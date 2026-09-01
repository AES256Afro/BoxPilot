import { describe, expect, it } from "vitest";
import { appFolders, buildStorageMap } from "./storageMap";

describe("storage map", () => {
  it("reduces installed apps to the data folders they actually mount", () => {
    const apps = appFolders([
      { manifest: { id: "plex", name: "Plex", volumes: [{ id: "config", hostPath: null }, { id: "media", hostPath: "/srv/media" }] }, live: { installed: true, state: { values: { volumes: { media: "/mnt/the-dump/" } } } } },
      { manifest: { id: "jellyfin", name: "Jellyfin", volumes: [{ id: "media", hostPath: "/srv/media" }] }, live: { installed: true, state: { values: { volumes: {} } } } },
      { manifest: { id: "ghost", name: "Ghost", volumes: [{ id: "media", hostPath: "/srv/media" }] }, live: { installed: false } },
    ]);
    // The chosen path wins over the manifest default, trailing slash dropped; uninstalled apps are out.
    expect(apps).toEqual([
      { id: "plex", name: "Plex", paths: ["/mnt/the-dump"] },
      { id: "jellyfin", name: "Jellyfin", paths: ["/srv/media"] },
    ]);
  });

  it("attaches apps and shares to the deepest containing mount, and the rest to the system disk", () => {
    const map = buildStorageMap({
      mounts: [
        { target: "/mnt/the-dump", source: "/dev/sda2", fstype: "exfat", sizeBytes: 16_000, availableBytes: 9_000 },
        { target: "/mnt/nas-media", source: "//nas/media", fstype: "cifs", sizeBytes: 8_000, availableBytes: 4_000 },
      ],
      apps: [
        { id: "qbittorrent", name: "qBittorrent", paths: ["/mnt/the-dump"] },
        { id: "plex", name: "Plex", paths: ["/mnt/the-dump/movies"] },
        { id: "paperless", name: "Paperless", paths: ["/srv/documents"] },
      ],
      sambaShares: [
        { name: "the-dump", path: "/mnt/the-dump", recycle: true, recycleBytes: 512 },
        { name: "docs", path: "/srv/documents/" },
      ],
      forecasts: [{ target: "/mnt/the-dump", daysToFull: 11 }, { target: "/", daysToFull: 63 }],
    });
    expect(map.map((entry) => `${entry.kind}:${entry.label}`)).toEqual(["network:/mnt/nas-media", "drive:/mnt/the-dump", "system:System disk"]);
    const dump = map[1];
    // Both attach to the containing drive, the subfolder included. With nothing measured they come
    // back in name order rather than catalog order, which is arbitrary to whoever is reading it.
    expect(dump.apps.map((app) => app.id).sort()).toEqual(["plex", "qbittorrent"]);
    expect(dump.shares).toEqual([{ name: "the-dump", recycle: true, recycleBytes: 512 }]);
    expect(dump.daysToFull).toBe(11);
    const system = map[2];
    expect(system.apps.map((app) => app.id)).toEqual(["paperless"]);
    expect(system.shares.map((share) => share.name)).toEqual(["docs"]);
    expect(system.daysToFull).toBe(63);
  });

  it("skips the system card when nothing lives there and no forecast exists", () => {
    const map = buildStorageMap({ mounts: [{ target: "/mnt/x", source: "/dev/sdb1", fstype: "ext4", sizeBytes: 1, availableBytes: 1 }] });
    expect(map).toHaveLength(1);
  });
});

describe("sizing what is on each drive", () => {
  const mounts = [{ target: "/mnt/the-dump", source: "/dev/sda1", fstype: "ext4", sizeBytes: 16e12, availableBytes: 2e12 }];
  const apps = [
    { id: "jellyfin", name: "Jellyfin", paths: ["/mnt/the-dump/media"] },
    { id: "qbittorrent", name: "qBittorrent", paths: ["/mnt/the-dump/torrents"] },
    { id: "nextcloud", name: "Nextcloud", paths: ["/mnt/the-dump/files"] },
  ];

  it("puts the biggest folder first, so a glance says what is on the drive", () => {
    const usage = [
      { appId: "jellyfin", path: "/mnt/the-dump/media", bytes: 2_100e9 },
      { appId: "qbittorrent", path: "/mnt/the-dump/torrents", bytes: 1_300e9 },
      { appId: "nextcloud", path: "/mnt/the-dump/files", bytes: 40e9 },
    ];
    const [drive] = buildStorageMap({ mounts, apps, usage });
    expect(drive.apps.map((app) => app.id)).toEqual(["jellyfin", "qbittorrent", "nextcloud"]);
    expect(drive.apps[0].bytes).toBe(2_100e9);
  });

  it("leaves a folder that was never measured unsized rather than calling it empty", () => {
    const usage = [{ appId: "jellyfin", path: "/mnt/the-dump/media", bytes: 2_100e9 }];
    const [drive] = buildStorageMap({ mounts, apps, usage });
    expect(drive.apps[0].id).toBe("jellyfin");
    // Unmeasured folders keep their place at the end; showing them as 0 would read as empty.
    expect(drive.apps.slice(1).every((app) => app.bytes === null)).toBe(true);
  });

  it("ignores a trailing slash when matching a measured folder to an app", () => {
    const usage = [{ appId: "jellyfin", path: "/mnt/the-dump/media/", bytes: 500e9 }];
    const [drive] = buildStorageMap({ mounts, apps, usage });
    expect(drive.apps.find((app) => app.id === "jellyfin")?.bytes).toBe(500e9);
  });

  it("adds nothing when no sweep has run yet", () => {
    const [drive] = buildStorageMap({ mounts, apps });
    expect(drive.apps.every((app) => app.bytes === null)).toBe(true);
  });
});
