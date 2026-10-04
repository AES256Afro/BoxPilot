// @vitest-environment node
/**
 * The read tools state their facts outright (M40). The owner asked "List the drives connected to
 * BoxPilot" and got "/dev/sda (primary drive): 528 GB total, 31% used", because storage.health had
 * said "Root disk: 31% used, 366 GB free of 528 GB" and named no device. On "where does Pi-hole run"
 * the model twice planned apps.list over where.runs. These hold the tools' words to what a small
 * model needs, on a server laid out like the owner's (placeholders: test/fixtures/agents-storage.mjs).
 */
import { describe, expect, it } from "vitest";
import { ownerLikeStorage } from "../../test/fixtures/agents-storage.mjs";
import { plannerMessages, planMessage } from "./intent.mjs";
import { actToolIds, plannerLine, toolById, toolCatalog, toolsForQuestion } from "./tool-catalog.mjs";
import { createToolRunner } from "./tools.mjs";
import { describeApps, describeServer, describeStorage, drivesOf, locate, osVersion, sizeWords, stopReasonOf, stoppedAppsOf, storageModel } from "./tool-text.mjs";

const snapshot = {
  host: { hostname: "example-box", operatingSystem: "Ubuntu 24.04.3 LTS", kernel: "6.8.0-64-generic", architecture: "x64", uptimeSeconds: 19 * 86_400 + 4 * 3_600 },
  compute: { cpuCount: 16, cpuModel: "Example 8-core processor", load1: 0.84, loadPercent: 5, totalMemoryBytes: 32e9, usedMemoryBytes: 11e9, memoryUsedPercent: 34 },
  network: { addresses: [{ interface: "eno1", address: "192.0.2.20" }], tailscale: { installed: true, connected: true, dnsName: "example-box.example.ts.net" } },
  services: [{ unit: "docker.service", active: "active" }],
  storage: ownerLikeStorage(),
  docker: { containers: [] },
};

describe("storage.health, on a server like the owner's", () => {
  const text = describeStorage(snapshot);
  const lines = text.split("\n");

  it("starts with the drives - each device, how it is attached, its size, which is the system disk - then the root filesystem", () => {
    expect(lines[0]).toBe("2 drives connected: /dev/nvme0n1 (NVMe SSD, 1.02 TB, the system disk) and /dev/sda (USB drive (spinning disk), 16.0 TB).");
    // lsblk in the web service's sandbox lists no LVM volume: the root is found through its partition.
    expect(lines[1]).toBe("/ (the root filesystem): on /dev/nvme0n1 (NVMe SSD, the system disk) through LVM volume /dev/mapper/ubuntu--vg-ubuntu--lv on /dev/nvme0n1p3, ext4, 528 GB in total, 162 GB used (31%), 366 GB free.");
    // lsblk outside the sandbox lists the volume under its partition.
    expect(describeStorage({ storage: ownerLikeStorage({ mapperListed: true }) }).split("\n")[1]).toBe("/ (the root filesystem): on /dev/nvme0n1 (NVMe SSD, the system disk) through LVM volume /dev/mapper/ubuntu--vg-ubuntu--lv, ext4, 528 GB in total, 162 GB used (31%), 366 GB free.");
  });

  it("gives each drive a line of its own facts, and says outright which is not the system disk", () => {
    const nvme = lines.find((line) => line.startsWith("- /dev/nvme0n1:"));
    const usb = lines.find((line) => line.startsWith("- /dev/sda:"));
    expect(nvme).toMatch(/NVMe SSD, 1\.02 TB, model Example NVMe SSD 1TB\. The system disk: it holds \/ \(the root filesystem\)\. Holds \/, \/boot, \/boot\/efi\. SMART: healthy/);
    expect(usb).toMatch(/USB drive \(spinning disk\), 16\.0 TB, model Example USB HDD 16TB\. Not the system disk\. Holds \/mnt\/archive\. SMART: not readable through its USB enclosure/);
    // Nothing about the root's size is on /dev/sda's line.
    expect(usb).not.toMatch(/528|31%/);
  });

  it("says where each other filesystem is, through what, its type, size, use and free space, on one line", () => {
    expect(lines.filter((line) => line.startsWith("/ (the root filesystem)") || line.startsWith("- / "))).toHaveLength(1);
    expect(lines).toContain("Other filesystems mounted: 3.");
    expect(lines.find((line) => line.startsWith("- /mnt/archive"))).toBe("- /mnt/archive: on /dev/sda (USB drive (spinning disk)) through partition /dev/sda1, exfat, 16.0 TB in total, 2.40 TB used (15%), 13.6 TB free.");
    // Snaps' loop devices and tmpfs are not drives or filesystems anyone asked about.
    expect(text).not.toMatch(/loop0|tmpfs|\/run\b|\/snap\//);
  });

  it("names what it could not read rather than guessing", () => {
    const withoutLsblk = describeStorage({ storage: { ...ownerLikeStorage(), blockDevices: { available: false, devices: [] } } });
    expect(withoutLsblk).toMatch(/^2 drives connected: \/dev\/nvme0n1 \(NVMe SSD, an unknown size\) and \/dev\/sda \(USB drive, an unknown size\)\./);
    expect(withoutLsblk).toMatch(/Which drive holds \/ could not be worked out\./);
    const noScan = describeStorage({ storage: { ...ownerLikeStorage(), filesystems: { available: false, mounts: [] } } });
    // Without the root scan, / is found from statfs and lsblk's own mountpoints (the volume listed).
    const noScanListed = describeStorage({ storage: { ...ownerLikeStorage({ mapperListed: true }), filesystems: { available: false, mounts: [] } } });
    expect(noScanListed).toMatch(/\n\/ \(the root filesystem\): on \/dev\/nvme0n1 \(NVMe SSD, the system disk\) through LVM volume \/dev\/mapper\/ubuntu--vg-ubuntu--lv, ext4, 528 GB in total, 162 GB used \(31%\), 366 GB free\./);
    // With neither the scan nor the volume in lsblk, / is not placed on a drive, and it says so.
    expect(noScan).toMatch(/\n\/ \(the root filesystem\): on a device that was not read, type unknown, 528 GB in total/);
    expect(noScan).toMatch(/Which drive holds \/ could not be worked out\./);
    expect(noScan).toMatch(/- \/mnt\/archive: on \/dev\/sda \(USB drive \(spinning disk\)\) through partition \/dev\/sda1, exfat, how full it is was not read \(the storage scan has not run in the last day\); the device is 16\.0 TB\./);
    expect(describeStorage({})).toBe("Storage could not be read.");
  });

  it("gives the evaluation the drives as facts", () => {
    expect(drivesOf(snapshot)).toEqual([
      { device: "/dev/nvme0n1", transport: "nvme", system: true, sizeBytes: 1_024.2e9, mounts: ["/", "/boot", "/boot/efi"] },
      { device: "/dev/sda", transport: "usb", system: false, sizeBytes: 16_000.9e9, mounts: ["/mnt/archive"] },
    ]);
    expect(storageModel(snapshot).root).toMatchObject({ mountpoint: "/", usedPercent: 31, disks: ["/dev/nvme0n1"], layer: "LVM volume" });
  });

  it("reads sizes the way BoxPilot writes them elsewhere", () => {
    expect([sizeWords(1_024.2e9), sizeWords(16_000.9e9), sizeWords(528e9), sizeWords(2.1e9), sizeWords(6e6), sizeWords(null)]).toEqual(["1.02 TB", "16.0 TB", "528 GB", "2.1 GB", "6 MB", "an unknown size"]);
  });
});

describe("the other reads say their facts outright", () => {
  it("server.facts names the operating system and its version", () => {
    const text = describeServer(snapshot);
    expect(text).toMatch(/^Hostname: example-box\.\nOperating system: Ubuntu 24\.04\.3 LTS \(Ubuntu, version 24\.04\.3\)\.\nKernel: 6\.8\.0-64-generic \(x64\)\./);
    expect(text).toMatch(/Processor: Example 8-core processor, 16 logical processors/);
    expect(osVersion("Debian GNU/Linux 13 (trixie)")).toEqual({ name: "Debian", version: "13", pretty: "Debian GNU/Linux 13 (trixie)" });
  });

  it("apps.list says which apps are stopped before anything else", () => {
    const applications = [
      { id: "pi-hole", name: "Pi-hole", installed: true, container: { running: true, status: "running", health: "healthy", restarts: 0 }, urls: [{ host: 8080 }] },
      { id: "nextcloud", name: "Nextcloud", installed: true, container: { running: false, status: "exited", health: "none", restarts: 2 } },
      { id: "immich", name: "Immich", installed: true, container: { exists: false, running: false, status: "absent" } },
      { id: "jellyfin", name: "Jellyfin", installed: true, container: { running: true, status: "running", health: "unhealthy", restarts: 3 } },
      { id: "gitea", name: "Gitea", installed: false, container: { running: false } },
    ];
    const text = describeApps(applications, [{ name: "portainer", image: "portainer/portainer-ce", state: "running", health: "none" }]);
    expect(text.split("\n")[0]).toBe("BoxPilot apps installed: 4. Running: 2. Stopped or not running: 2 (nextcloud, immich). Of those, stopped on purpose (by the owner, or never started): none; not running for another reason: nextcloud, immich. Unhealthy: jellyfin.");
    expect(text).toMatch(/- nextcloud: stopped \(exited\), 2 restarts; container bp-nextcloud\. No stop is recorded in BoxPilot: it may have crashed, or been stopped outside BoxPilot\./);
    expect(text).toMatch(/- immich: stopped \(no container\), 0 restarts; container bp-immich\./);
    expect(text).toMatch(/- pi-hole: running, health healthy, 0 restarts, web port 8080; container bp-pi-hole\./);
    expect(describeApps([{ id: "home-assistant", name: "Home Assistant", installed: true, container: { running: true, status: "running" } }])).toMatch(/- home-assistant \(Home Assistant\): running/);
    expect(text).toMatch(/Other Docker containers, not installed by BoxPilot: portainer \(image portainer\/portainer-ce, running\)\./);
    expect(stoppedAppsOf(applications)).toEqual(["nextcloud", "immich"]);
  });

  it("apps.list tells an app the owner stopped, or one never started, from one that is down (M44)", () => {
    const applications = [
      { id: "plex", name: "Plex", installed: true, container: { running: false, status: "exited", restarts: 0 } },
      { id: "qbittorrent", name: "qBittorrent", installed: true, container: { running: false, status: "created", restarts: 0 } },
      { id: "nextcloud", name: "Nextcloud", installed: true, container: { running: false, status: "exited", restarts: 4 } },
      // A stop on record does not make an app that keeps restarting fine.
      { id: "immich", name: "Immich", installed: true, container: { running: false, status: "restarting", restarts: 9 } },
      { id: "pi-hole", name: "Pi-hole", installed: true, container: { running: true, status: "running", health: "healthy" } },
    ];
    const stops = { plex: { at: "2026-09-28T22:10:20.000Z", by: "owner-1" }, immich: { at: "2026-09-01T00:00:00.000Z", by: "owner-1" }, "pi-hole": { at: "2026-08-01T00:00:00.000Z" } };
    expect(stopReasonOf(applications[0], stops)).toEqual({ kind: "owner", at: "2026-09-28T22:10:20.000Z" });
    expect(stopReasonOf(applications[1], stops)).toEqual({ kind: "never-started", at: null });
    expect(stopReasonOf(applications[2], stops)).toEqual({ kind: "unknown", at: null });
    expect([stopReasonOf(applications[3], stops), stopReasonOf(applications[4], stops)]).toEqual([null, null]);

    const text = describeApps(applications, [], { stops });
    const [summary, ...lines] = text.split("\n");
    expect(summary).toBe("BoxPilot apps installed: 5. Running: 1. Stopped or not running: 4 (plex, qbittorrent, nextcloud, immich). Of those, stopped on purpose (by the owner, or never started): plex, qbittorrent; not running for another reason: nextcloud, immich. Unhealthy: none.");
    // Down for no recorded reason first, then the ones stopped on purpose, then the rest.
    expect(lines.map((line) => /^- ([a-z-]+)/.exec(line)?.[1])).toEqual(["nextcloud", "immich", "plex", "qbittorrent", "pi-hole"]);
    expect(text).toMatch(/- plex: stopped \(exited\), 0 restarts; container bp-plex\. Stopped on purpose: the owner stopped it from BoxPilot on 2026-09-28; not a fault\./);
    expect(text).toMatch(/- qbittorrent: stopped \(created\), 0 restarts; container bp-qbittorrent\. Stopped on purpose: never started since its container was made; not a fault\./);
    expect(text).toMatch(/- immich: restarting, 9 restarts; container bp-immich\.$/m);
    // The evaluation's stopped apps are every app not running, on purpose or not.
    expect(stoppedAppsOf(applications)).toEqual(["plex", "qbittorrent", "nextcloud", "immich"]);
    // Without a record (an older server), nothing is called on purpose but a container never started.
    expect(describeApps(applications).split("\n")[0]).toMatch(/stopped on purpose \(by the owner, or never started\): qbittorrent; not running for another reason: plex, nextcloud, immich\./);
  });

  it("where.runs says where, in its first line, and that a BoxPilot app is not on the host", async () => {
    const helper = { request: async (operation) => (operation === "app.inspect" ? { applications: [{ id: "pi-hole", name: "Pi-hole", installed: true, container: { running: true, status: "running" } }] } : { units: [{ unit: "docker.service", active: "active", sub: "running" }] }) };
    const tools = createToolRunner({ state: {}, store: {}, registry: { get: () => null }, helper, inventory: { inspect: async () => snapshot } });
    const text = await tools.run("where.runs", { name: "pihole" }, { spec: {}, readRole: "owner" });
    expect(text.split("\n")[0]).toBe("Where \"pihole\" runs: pi-hole runs as a BoxPilot app, in the Docker container bp-pi-hole on this server (not natively on the host).");
    expect(await tools.run("where.runs", { name: "postgres" }, { spec: {}, readRole: "owner" })).toMatch(/^Nothing called "postgres" runs on this server/);
    expect(locate("pihole", { units: [{ unit: "pihole-FTL.service", active: "active", sub: "running" }] })).toEqual([{ kind: "host", id: "pihole-FTL.service", state: "active (running)" }]);
  });
});

describe("the tool a request's words point at", () => {
  const offered = toolCatalog.map((tool) => tool.id);

  it("is where.runs for where something runs, and storage.health for the drives", () => {
    expect(toolsForQuestion("Where does Pi-hole run?", offered)).toContain("where.runs");
    expect(toolsForQuestion("where does pihole run", offered)).not.toContain("apps.list");
    expect(toolsForQuestion("Is Pi-hole running natively on the host or in a container?", offered)).toContain("where.runs");
    expect(toolsForQuestion("List the drives connected to BoxPilot", offered)).toEqual(["storage.health"]);
    expect(toolsForQuestion("How full is the root disk?", offered)).toEqual(["storage.health"]);
    expect(toolsForQuestion("Which apps are stopped?", offered)).toEqual(["apps.list"]);
    expect(toolsForQuestion("Which OS version is this?", offered)).toEqual(["server.facts"]);
    expect(toolsForQuestion("Is Pi-hole blocking?", offered)).toEqual(["pihole.stats"]);
    // Only tools the run was offered, and nothing for words that point nowhere.
    expect(toolsForQuestion("Where does Pi-hole run?", ["apps.list"])).toEqual([]);
    expect(toolsForQuestion("Good morning", offered)).toEqual([]);
  });

  it("is listed for the planner with what each tool is for, and named after the request", () => {
    expect(plannerLine(toolById("where.runs"))).toBe("- where_runs: Where does it run?. For: where does X run; is X a container, a BoxPilot app or on the host; is X installed");
    const tools = ["apps.list", "where.runs"].map((id) => toolById(id)).map((tool) => ({ fn: tool.fn, title: tool.title, use: tool.use }));
    const [system, user] = plannerMessages({ name: "Steve" }, tools, "<question>\nwhere does pihole run\n</question>", { hints: [{ fn: "where_runs", title: "Where does it run?" }] });
    expect(system.content).toMatch(/- apps_list: Apps and containers\. For: which apps are installed, stopped, unhealthy or restarting\n- where_runs: Where does it run\?\. For: where does X run/);
    expect(user.content).toMatch(/Tools made for requests worded like this: where_runs \(Where does it run\?\)\.\n\nWork out what is asked/);
    // The system message is the same bytes with or without a hint: the cache holds.
    expect(plannerMessages({ name: "Steve" }, tools, "x")[0].content).toBe(system.content);
  });

  it("is carried with the plan's tools, and named in the plan when the plan left it out", () => {
    const offeredIds = ["memory.search", "plan.propose", "apps.list", "where.runs", "server.facts"];
    expect(actToolIds(offeredIds, { planned: ["apps.list"], hinted: ["where.runs"] })).toEqual(["memory.search", "plan.propose", "apps.list", "where.runs"]);
    expect(actToolIds(offeredIds, { planned: null, hinted: ["where.runs"] })).toContain("where.runs");
    const told = planMessage({ plan: [{ step: "List the apps", tool: "apps.list" }, { step: "Answer", tool: null }] }, { hinted: ["where.runs"] });
    expect(told).toMatch(/1\. List the apps \(apps_list\)\n2\. Answer\n\nThe request's words fit where_runs \(Where does it run\?\) too: use it if the plan's tools do not answer it directly\./);
    expect(planMessage({ plan: [{ step: "Find it", tool: "where.runs" }] }, { hinted: ["where.runs"] })).not.toMatch(/words fit/);
  });
});
