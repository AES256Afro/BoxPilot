#!/usr/bin/env node
/**
 * BoxPilot demo: the real web UI on top of fictional data, no Ubuntu host required.
 *
 *   npm run build && npm run demo        # then open http://127.0.0.1:8799
 *
 * Every answer comes from the fixtures below (host "homebox", owner "alex", an example
 * tailnet); nothing is read from or written to the machine running it. Mutations return
 * a staged job that never executes. Used for the README screenshots and for trying the
 * interface before installing.
 */
import { createHash } from "node:crypto";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { loadCatalog } from "../server/catalog/index.mjs";
import { adviseFirewall, profiles, protectedRules, riskyPorts, services, buildPlan } from "../server/firewall-profiles.mjs";
import { annotateDevices, parseLsblkTree, sharesFrom, volumeGroupsFrom } from "../server/storage-inventory.mjs";
import { cloudProviders } from "../server/backup-cloud.mjs";
import { buildChecklist } from "../server/setup-checklist.mjs";
import { setupProfiles } from "../server/setup-profiles.mjs";
import { productVersion } from "../server/version.mjs";
import { humanBytes } from "../server/housekeeping.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const port = Number.parseInt(process.env.PORT ?? "8799", 10);
const GiB = 1024 ** 3;
const now = () => new Date();
const ago = (hours) => new Date(Date.now() - hours * 3600_000).toISOString();
const digest = (seed) => createHash("sha256").update(`demo:${seed}`).digest("hex");

// ---------- the fictional server ----------
const host = { hostname: "homebox", lan: "192.168.50.20", gateway: "192.168.50.1", tailnet: "homebox.tail0a1b.ts.net", tailscaleIp: "100.101.102.103", owner: "alex" };
const installed = { "open-webui": 8088, jellyfin: 8096, "pi-hole": 8084, immich: 2283, vaultwarden: 8222, "uptime-kuma": 3001, homepage: 3000, nextcloud: 8087, scrutiny: 8086 };
const stats = { jellyfin: { cpuPercent: 3.2, memBytes: 412 * 1024 ** 2, containers: 1 }, "pi-hole": { cpuPercent: 0.4, memBytes: 96 * 1024 ** 2, containers: 2 }, immich: { cpuPercent: 6.1, memBytes: 1.4 * GiB, containers: 4 }, vaultwarden: { cpuPercent: 0.1, memBytes: 48 * 1024 ** 2, containers: 1 }, "uptime-kuma": { cpuPercent: 0.8, memBytes: 120 * 1024 ** 2, containers: 1 }, homepage: { cpuPercent: 0.2, memBytes: 70 * 1024 ** 2, containers: 1 }, nextcloud: { cpuPercent: 1.9, memBytes: 620 * 1024 ** 2, containers: 3 }, scrutiny: { cpuPercent: 0.3, memBytes: 110 * 1024 ** 2, containers: 1 } };

const lsblk = JSON.stringify({ blockdevices: [
  { path: "/dev/nvme0n1", kname: "nvme0n1", pkname: null, type: "disk", size: 1024209543168, fstype: null, model: "Example NVMe SSD 1TB", tran: "nvme", mountpoints: [null], ro: false, rm: false },
  { path: "/dev/nvme0n1p1", kname: "nvme0n1p1", pkname: "nvme0n1", type: "part", size: GiB, fstype: "vfat", uuid: "1A2B-3C4D", mountpoints: ["/boot/efi"], ro: false, rm: false },
  { path: "/dev/nvme0n1p2", kname: "nvme0n1p2", pkname: "nvme0n1", type: "part", size: 2 * GiB, fstype: "ext4", uuid: "0e8c1a0e-boot", mountpoints: ["/boot"], ro: false, rm: false },
  { path: "/dev/nvme0n1p3", kname: "nvme0n1p3", pkname: "nvme0n1", type: "part", size: 1020 * GiB, fstype: "LVM2_member", mountpoints: [null], ro: false, rm: false },
  { path: "/dev/mapper/ubuntu--vg-ubuntu--lv", kname: "dm-0", pkname: "nvme0n1p3", type: "lvm", size: 700 * GiB, fstype: "ext4", uuid: "5f2d-root", mountpoints: ["/"], ro: false, rm: false },
  { path: "/dev/mapper/ubuntu--vg-boxpilot--snap--20260821--0900--before--upgrade", kname: "dm-3", pkname: "nvme0n1p3", type: "lvm", size: 20 * GiB, fstype: "ext4", mountpoints: [null], ro: false, rm: false },
  { path: "/dev/sda", kname: "sda", pkname: null, type: "disk", size: 4000 * GiB, fstype: null, model: "Example USB HDD 4TB", tran: "usb", mountpoints: [null], ro: false, rm: true },
  { path: "/dev/sda1", kname: "sda1", pkname: "sda", type: "part", size: 4000 * GiB, fstype: "ext4", uuid: "77aa-media", label: "media", mountpoints: ["/mnt/media"], ro: false, rm: true },
] });
const fstab = [
  { device: "UUID=5f2d-root", mountpoint: "/", fstype: "ext4", options: "defaults", managedName: null },
  { device: "UUID=77aa-media", mountpoint: "/mnt/media", fstype: "ext4", options: "defaults,nofail", managedName: "media" },
  { device: "//nas.local/Public", mountpoint: "/mnt/nas-public", fstype: "cifs", options: "credentials=/etc/boxpilot/secrets/share-nas-public.cred,uid=1000,gid=1000,nofail,_netdev,x-systemd.automount", managedName: "share-nas-public" },
];
const mounts = [
  { target: "/", source: "/dev/mapper/ubuntu--vg-ubuntu--lv", fstype: "ext4", sizeBytes: 700 * GiB, usedBytes: 212 * GiB, availableBytes: 488 * GiB },
  { target: "/mnt/media", source: "/dev/sda1", fstype: "ext4", sizeBytes: 4000 * GiB, usedBytes: 2710 * GiB, availableBytes: 1290 * GiB },
  { target: "/mnt/nas-public", source: "//nas.local/Public", fstype: "cifs", sizeBytes: 8000 * GiB, usedBytes: 3100 * GiB, availableBytes: 4900 * GiB },
];
const devices = annotateDevices(parseLsblkTree(lsblk));
const volumeGroups = volumeGroupsFrom(devices);
const storageOverview = {
  devices, mounts, fstab, volumeGroups,
  snapshots: volumeGroups.flatMap((group) => group.logicalVolumes.filter((volume) => volume.snapshot).map((volume) => ({ path: volume.path, name: volume.name, volumeGroup: group.name, sizeBytes: volume.sizeBytes, origin: "/dev/mapper/ubuntu--vg-ubuntu--lv", sizeGiB: 20, createdAt: ago(9), suffix: "before-upgrade" }))),
  shares: sharesFrom(fstab, mounts),
  tools: { cifs: true, nfs: true, smbclient: true, showmount: true },
};

const firewallReport = {
  installed: true, enabled: true, defaults: { incoming: "drop", outgoing: "accept", routed: "reject" },
  rules: [
    { action: "allow", protocol: "tcp", port: 22, app: null, direction: "in", interface: null, comment: "BoxPilot keeps SSH reachable", family: "both" },
    { action: "allow", protocol: "udp", port: 41641, app: null, direction: "in", interface: null, comment: "BoxPilot keeps Tailscale reachable", family: "both" },
    { action: "allow", protocol: "any", port: null, app: null, direction: "in", interface: "tailscale0", comment: "BoxPilot keeps the tailnet reachable", family: "v4" },
    { action: "allow", protocol: "tcp", port: 53, app: null, direction: "in", interface: null, comment: "BoxPilot service: DNS server", family: "both" },
    { action: "allow", protocol: "udp", port: 53, app: null, direction: "in", interface: null, comment: "BoxPilot service: DNS server", family: "both" },
    { action: "allow", protocol: "tcp", port: 8096, app: null, direction: "in", interface: null, comment: "BoxPilot service: Jellyfin", family: "both" },
    { action: "allow", protocol: "tcp", port: 5432, app: null, direction: "in", interface: null, comment: "postgres for the laptop", family: "v4" },
  ],
};
const firewallProfile = { id: "home-server", services: ["dns", "jellyfin"], sshRateLimit: true, appliedAt: ago(30) };
const listeners = [{ protocol: "tcp", address: "0.0.0.0", port: 2283, scope: "wildcard" }, { protocol: "tcp", address: "0.0.0.0", port: 5432, scope: "wildcard" }];
const fail2ban = { installed: true, running: true, configured: true, config: { managed: true, maxRetry: 5, findTimeMinutes: 10, banTimeMinutes: 60, ignoreLan: true, ignore: ["127.0.0.1/8", "::1", "100.64.0.0/10", "192.168.50.0/24"], sshd: true }, currentlyBanned: 1, totalBanned: 14 };

const inventory = () => ({
  generatedAt: now().toISOString(),
  host: { hostname: host.hostname, operatingSystem: "Ubuntu 24.04.3 LTS", kernel: "6.8.0-64-generic", architecture: "x64", uptimeSeconds: 19 * 86400 + 4 * 3600 },
  compute: { cpuCount: 8, cpuModel: "AMD Ryzen 5 5600G", load1: 0.84, load5: 0.71, load15: 0.66, loadPercent: 11, totalMemoryBytes: 32 * GiB, freeMemoryBytes: 21 * GiB, usedMemoryBytes: 11 * GiB, memoryUsedPercent: 34 },
  storage: {
    root: { totalBytes: 800 * GiB, usedBytes: 212 * GiB, freeBytes: 588 * GiB, usedPercent: 27 },
    filesystems: { available: true, mounts: [
      { target: "/", source: "/dev/mapper/ubuntu--vg-ubuntu--lv", filesystem: "ext4", totalBytes: 800 * GiB, usedBytes: 212 * GiB, availableBytes: 588 * GiB, usedPercent: 27, capacityState: "healthy", readOnly: false, optionNames: ["relatime", "rw"], errorEvidence: { supported: true, state: "healthy", errorsCount: 0, source: "ext4-sysfs-errors-count", reason: "ok" } },
      { target: "/mnt/media", source: "/dev/sda1", filesystem: "ext4", totalBytes: 4000 * GiB, usedBytes: 2710 * GiB, availableBytes: 1290 * GiB, usedPercent: 68, capacityState: "healthy", readOnly: false, optionNames: ["nofail", "relatime", "rw"], errorEvidence: { supported: true, state: "healthy", errorsCount: 0, source: "ext4-sysfs-errors-count", reason: "ok" } },
    ], summary: { healthy: 2, warning: 0, critical: 0, unavailable: 0 }, errors: { healthy: 2, critical: 0, unavailable: 0, unsupported: 0 } },
    blockDevices: { available: true, devices: [{ name: "/dev/nvme0n1", parent: null, type: "disk", filesystem: null, sizeBytes: 1024209543168, mountTargets: [], rotational: false, readOnly: false, transport: "nvme", model: "Example NVMe SSD 1TB" }, { name: "/dev/sda", parent: null, type: "disk", filesystem: null, sizeBytes: 4000 * GiB, mountTargets: [], rotational: true, readOnly: false, transport: "usb", model: "Example USB HDD 4TB" }] },
    smart: { available: true, status: "healthy", reason: "fixed-root-scan", generatedAt: ago(2), stale: false, disks: [{ device: "/dev/nvme0n1", health: "healthy", passed: true, temperatureCelsius: 41, powerOnHours: 6120, percentageUsed: 3, mediaErrors: 0, unsafeShutdowns: 2 }, { device: "/dev/sda", health: "healthy", passed: true, temperatureCelsius: 36, powerOnHours: 14800, percentageUsed: null, mediaErrors: 0, unsafeShutdowns: 0 }] },
  },
  maintenance: { system: { available: true, state: "running", failedServiceCount: 0, failedServiceCountTruncated: false }, reboot: { available: true, required: false }, packageManager: { available: true, state: "ready", pendingUpdateFragments: 0, countTruncated: false }, aptMetadata: { available: true, state: "current", updatedAt: ago(5), ageHours: 5 }, automaticSecurityUpdates: { available: true, state: "enabled-active", enabled: true, active: true } },
  power: { ups: { installed: true, configured: true, available: true, state: "online", reason: "ok", deviceCount: 1, statusTokens: ["OL"], batteryChargePercent: 100, estimatedRuntimeSeconds: 2460, loadPercent: 18, source: "nut-localhost-fixed", boundary: { mutationPerformed: false, powerCommandAvailable: false, shutdownPolicyChanged: false, localhostOnly: true, remoteNetworkProbePerformed: false, browserTargetAccepted: false, rawOutputIncluded: false, deviceNameIncluded: false, serialIncluded: false } } },
  network: { addresses: [{ interface: "eno1", address: host.lan, cidr: `${host.lan}/24` }, { interface: "tailscale0", address: host.tailscaleIp, cidr: `${host.tailscaleIp}/32` }], tailscale: { installed: true, connected: true, dnsName: host.tailnet } },
  services: [{ unit: "boxpilot.service", load: "loaded", active: "active", sub: "running", enabled: "enabled" }, { unit: "boxpilot-helper.service", load: "loaded", active: "active", sub: "running", enabled: "enabled" }, { unit: "docker.service", load: "loaded", active: "active", sub: "running", enabled: "enabled" }, { unit: "tailscaled.service", load: "loaded", active: "active", sub: "running", enabled: "enabled" }],
  docker: { available: true, containers: Object.keys(installed).map((id) => ({ id: id.slice(0, 6), name: `bp-${id}`, image: `${id}:latest`, state: "running", status: "Up 19 days", health: "healthy", ports: `${host.lan}:${installed[id]}`, networks: `bp-${id}_default` })), images: [], networks: [], volumes: [], projects: [] },
});

const topology = () => ({
  generatedAt: now().toISOString(),
  collectors: { addresses: true, routes: true, resolvers: true, listeners: true, tailscale: true, neighbors: true },
  addresses: [{ interface: "eno1", address: host.lan, cidr: `${host.lan}/24` }],
  eligibleLanAddresses: [{ interface: "eno1", address: host.lan, cidr: `${host.lan}/24` }],
  defaultRoutes: [{ gateway: host.gateway, interface: "eno1", protocol: "dhcp" }],
  resolverLinks: [], defaultResolvers: ["127.0.0.53"],
  tailscale: { connected: true, dnsName: host.tailnet, address: host.tailscaleIp, resolverPresent: true, defaultDnsObserved: false, overrideState: "split-resolver", exitNodeAdvertised: true, advertisedRoutes: ["192.168.50.0/24"], approvedRoutes: ["192.168.50.0/24"], lanSubnets: ["192.168.50.0/24"] },
  dnsListeners: [{ protocol: "udp", address: host.lan, port: 53, scope: "address", interface: "eno1" }, { protocol: "tcp", address: "127.0.0.53", port: 53, scope: "loopback", interface: null }],
  devices: [
    { address: host.gateway, mac: "02:00:00:aa:00:01", interface: "eno1", state: "REACHABLE" },
    { address: "192.168.50.30", mac: "02:00:00:aa:00:30", interface: "eno1", state: "REACHABLE" },
    { address: "192.168.50.41", mac: "02:00:00:aa:00:41", interface: "eno1", state: "STALE" },
    { address: "192.168.50.77", mac: "02:00:00:aa:00:77", interface: "eno1", state: "REACHABLE" },
  ],
  routerCatalog: [], mutationSupported: false,
});

const jobs = [
  { id: "d1", type: "op:apt.upgrade", title: "Install all updates", state: "completed", risk: "medium", error: null, result: null, createdAt: ago(3), steps: [], approvals: [] },
  { id: "d2", type: "op:storage.lvm.snapshot.create", title: "Take a snapshot", state: "completed", risk: "medium", error: null, result: null, createdAt: ago(9), steps: [], approvals: [] },
  { id: "d3", type: "op:backup.cloud.sync", title: "Mirror local backups to the cloud destination", state: "completed", risk: "medium", error: null, result: null, createdAt: ago(26), steps: [], approvals: [] },
  { id: "d4", type: "op:app.update", title: "Update application", state: "completed", risk: "medium", error: null, result: null, createdAt: ago(50), steps: [], approvals: [] },
];
const backups = [
  { id: "10000000-0000-4000-8000-000000000003", applicationId: "boxpilot-controller", destination: "local-managed", checksumSha256: digest("c"), sizeBytes: 6 * 1024 ** 2, downtimeMs: 0, restoreDrill: { passed: true }, createdAt: ago(3) },
  { id: "10000000-0000-4000-8000-000000000002", applicationId: "boxpilot-controller", destination: "local-managed", checksumSha256: digest("b"), sizeBytes: 6 * 1024 ** 2, downtimeMs: 0, restoreDrill: { passed: true }, createdAt: ago(27) },
  { id: "10000000-0000-4000-8000-000000000001", applicationId: "boxpilot-controller", destination: "local-managed", checksumSha256: digest("a"), sizeBytes: 5 * 1024 ** 2, downtimeMs: 0, restoreDrill: { passed: true }, createdAt: ago(51) },
];
const machineState = {
  snapshots: [
    { artifact: "machine-snapshot-20260821T020000Z-a1b2c3d4.tar.gz", sizeBytes: 41 * 1024 ** 2, checksumSha256: digest("d"), createdAt: ago(20), contents: { apps: Object.keys(installed).map((id) => ({ id })), vms: { domains: ["dev-lab"] } } },
    { artifact: "machine-snapshot-20260814T020000Z-e5f6a7b8.tar.gz", sizeBytes: 39 * 1024 ** 2, checksumSha256: digest("e"), createdAt: ago(188), contents: { apps: Object.keys(installed).slice(0, 6).map((id) => ({ id })), vms: { domains: [] } } },
  ],
  keep: 3,
  sync: { destination: "/mnt/boxpilot-backup/boxpilot-local-mirror", mount: { mounted: true, freeBytes: 1290 * GiB }, lastSync: { completedAt: ago(20), copiedCount: 12 } },
};

const inspections = {
  "system.settings.inspect": {
    hostname: { static: host.hostname, live: host.hostname }, timezone: "UTC",
    timezones: ["UTC", "Europe/London", "Europe/Berlin", "America/New_York", "America/Chicago", "America/Los_Angeles", "Asia/Tokyo", "Australia/Sydney"],
    locale: "en_US.UTF-8", locales: ["C.UTF-8", "en_US.UTF-8", "en_GB.UTF-8"], swappiness: 60,
    swap: [{ device: "/swap.img", type: "file", sizeKiB: 4 * 1024 ** 2, usedKiB: 0, priority: -2 }],
    memory: { memTotalKiB: 32 * 1024 ** 2, memAvailableKiB: 21 * 1024 ** 2, swapTotalKiB: 4 * 1024 ** 2, swapFreeKiB: 4 * 1024 ** 2 },
    fstrim: { active: "active", enabled: "enabled", nextRun: "Mon 2026-08-24 00:00:00 UTC" },
  },
  "apt.upgradable.inspect": { count: 4, securityCount: 1, rebootRequired: false, needrestartPresent: true, servicesNeedingRestart: [], upgradable: [
    { name: "openssl", suite: "noble-security", candidate: "3.0.13-0ubuntu3.6", installed: "3.0.13-0ubuntu3.5", architecture: "amd64", source: "security" },
    { name: "curl", suite: "noble-updates", candidate: "8.5.0-2ubuntu10.7", installed: "8.5.0-2ubuntu10.6", architecture: "amd64" },
    { name: "libcurl4t64", suite: "noble-updates", candidate: "8.5.0-2ubuntu10.7", installed: "8.5.0-2ubuntu10.6", architecture: "amd64" },
    { name: "tailscale", suite: "stable", candidate: "1.92.1", installed: "1.90.4", architecture: "amd64" },
  ] },
  "apt.unattended.inspect": { installed: true, enabled: true, config: { updatePackageLists: "1", unattendedUpgrade: "1" } },
  "packages.curated.inspect": { packages: ["htop", "btop", "tmux", "git", "curl", "jq", "ncdu", "smartmontools", "restic", "nfs-common", "cifs-utils", "samba", "nut", "fail2ban", "rclone", "needrestart"].map((name) => ({ name, installed: ["htop", "git", "curl", "jq", "smartmontools", "cifs-utils", "samba", "nut", "fail2ban", "rclone"].includes(name), version: null })) },
  "service.list": { counts: { total: 134, active: 92, failed: 0 }, units: [] },
  "app.serve.inspect": { available: true, serves: [{ dnsName: host.tailnet, port: 2283, target: "http://127.0.0.1:2283" }, { dnsName: host.tailnet, port: 8222, target: "http://127.0.0.1:8222" }] },
  "app.stats.inspect": { available: true, stats },
  "host.snapshot.inspect": machineState,
  "backup.remote.inspect": { keyReady: true, publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExampleExam boxpilot-backup-mirror", fingerprint: "SHA256:ExampleFingerprintExampleFingerprintExample0", hostKeysPinned: 1, rsyncInstalled: true },
  "backup.cloud.inspect": { rcloneInstalled: true, configured: true, provider: "b2", providers: Object.fromEntries(Object.entries(cloudProviders).map(([id, entry]) => [id, { label: entry.label, fields: entry.fields, secrets: entry.secrets, help: entry.help }])) },
  "fail2ban.inspect": fail2ban,
  "canary.verify": { ok: true },
  "system.update.status": { running: false, log: [], startedAt: null, finishedAt: null, ok: null },
  "users.inspect": { users: [{ username: host.owner, uid: 1000, sudo: true, shell: "/bin/bash", keys: 2 }] },
  "docker.disk.inspect": { images: { count: 22, sizeBytes: 9.4 * GiB, reclaimableBytes: 1.1 * GiB }, containers: { count: 14, sizeBytes: 0.6 * GiB }, volumes: { count: 9, sizeBytes: 3.2 * GiB }, buildCache: { sizeBytes: 0 } },
  "housekeeping.inspect": (() => {
    const categories = [
      { id: "boxpilot-versions", title: "Previous BoxPilot releases", summary: "Copies of BoxPilot left in /opt by past updates. The most recent one is kept — that is what a failed update rolls back to.", items: 4, bytes: 1.4 * GiB, detail: ["boxpilot.prev.1750", "boxpilot.prev.1746", "boxpilot.rollback-1741", "boxpilot-prev-1738"], keeping: ["boxpilot.prev.1752"], safe: true },
      { id: "docker-unused", title: "Orphaned image layers and build cache", summary: "Layers left behind when an image was replaced by a newer version, and what Docker cached while building. Nothing references either; both come back on their own if they are ever needed again.", items: 6, bytes: 1.1 * GiB, detail: ["6 orphaned layers: 902.0 MiB", "build cache: 224.0 MiB"], keeping: [], safe: true },
      { id: "docker-unreferenced-images", title: "Images no app uses", summary: "Complete images that no container references and no installed app needs — left by apps you removed, versions replaced by updates, or a trial run. Installing one of these again downloads it again.", items: 3, bytes: 2.3 * GiB, detail: ["ghcr.io/example/oldapp:1.2 (980.0 MiB)", "ghcr.io/example/oldapp:1.1 (960.0 MiB)", "example/scratch:latest (416.0 MiB)"], keeping: [], safe: true },
      { id: "app-backups", title: "Older application backups", summary: "Backup archives beyond the newest 3 for each app. The newest 3 are always kept, and any copy already mirrored off this server is unaffected.", items: 5, bytes: 780 * 1024 ** 2, detail: ["immich: 3 archive(s)", "nextcloud: 2 archive(s)"], keeping: [], safe: true },
      { id: "restore-leftovers", title: "Unfinished restores", summary: "Folders a restore left behind when it could not finish swapping data back. They are copies, not the live data an app is using.", items: 0, bytes: 0, detail: [], keeping: [], safe: true },
      { id: "job-logs", title: "Logs for jobs no longer listed", summary: "Output from jobs older than 90 days, which is longer than the history keeps them — nothing lists those jobs any more.", items: 214, bytes: 18 * 1024 ** 2, detail: [], keeping: [], safe: true },
    ].map((category) => ({ ...category, humanBytes: humanBytes(category.bytes) }));
    const totalBytes = categories.reduce((sum, category) => sum + category.bytes, 0);
    return { generatedAt: now().toISOString(), categories, totalBytes, totalHumanBytes: humanBytes(totalBytes) };
  })(),
  "system.performance.inspect": (() => {
    const perApp = { jellyfin: [34.2, 412], immich: [11.8, 1430], "pi-hole": [0.9, 96], nextcloud: [4.1, 620], "uptime-kuma": [1.2, 120], homepage: [0.3, 70], vaultwarden: [0.2, 48], scrutiny: [0.4, 110] };
    return {
      generatedAt: now().toISOString(),
      cpu: { model: "AMD Ryzen 7 7800X3D 8-Core Processor", cores: 16, usagePercent: 27.4, perCore: [41, 18, 12, 63, 9, 22, 7, 15, 33, 11, 8, 19, 6, 24, 13, 10], load1: 2.31, load5: 1.84, load15: 1.42, loadPercent: 14 },
      memory: { totalBytes: 32 * GiB, usedBytes: 11 * GiB, availableBytes: 21 * GiB, usedPercent: 34 },
      swap: { totalBytes: 4 * GiB, usedBytes: 0, usedPercent: 0 },
      uptimeSeconds: 19 * 86400 + 5 * 3600,
      temps: [{ label: "k10temp: Tctl", celsius: 52.4 }, { label: "nvme: Composite", celsius: 41.9 }],
      disks: [
        { mount: "/", fstype: "ext4", totalBytes: 492 * GiB, usedBytes: 60 * GiB, availableBytes: 411 * GiB, usedPercent: 13 },
        { mount: "/mnt/media", fstype: "ext4", totalBytes: 4000 * GiB, usedBytes: 2710 * GiB, availableBytes: 1290 * GiB, usedPercent: 68 },
      ],
      statsAvailable: true,
      apps: Object.entries(installed).map(([id]) => ({ id, state: id === "open-webui" ? "paused" : "running", running: true, cpuPercent: id === "open-webui" ? 0 : perApp[id]?.[0] ?? 0.5, memBytes: (perApp[id]?.[1] ?? (id === "open-webui" ? 6100 : 64)) * 1024 ** 2, containers: id === "open-webui" ? 2 : 1 })),
    };
  })(),
  "app.models.inspect": { id: "open-webui", available: true, reason: null, models: [
    { name: "hermes3:8b", id: "1b226e2802db", size: "4.7 GB", modified: "2 days ago", bytes: 4.7e9 },
    { name: "qwen3:30b-a3b", id: "aabbccddeeff", size: "19 GB", modified: "3 weeks ago", bytes: 19e9 },
    { name: "nomic-embed-text:latest", id: "0a109f422b47", size: "274 MB", modified: "3 weeks ago", bytes: 274e6 },
  ] },
  "app.backup.protection": { available: true, generatedAt: now().toISOString(), apps: [
    { id: "vaultwarden", name: "Vaultwarden", protectable: true, backups: 0, newestAt: null },
    { id: "immich", name: "Immich", protectable: true, backups: 2, newestAt: ago(24 * 63) },
    { id: "nextcloud", name: "Nextcloud", protectable: true, backups: 0, newestAt: null },
    { id: "jellyfin", name: "Jellyfin", protectable: true, backups: 9, newestAt: ago(11) },
    { id: "pi-hole", name: "Pi-hole", protectable: true, backups: 4, newestAt: ago(30) },
    { id: "open-webui", name: "Open WebUI + Ollama", protectable: true, backups: 1, newestAt: ago(5) },
    { id: "homepage", name: "Homepage", protectable: true, backups: 0, newestAt: null },
  ] },
  "logs.sources": { groups: [{ id: "boxpilot", label: "BoxPilot" }, { id: "system", label: "System journal" }, { id: "docker", label: "Docker" }], units: [{ unit: "boxpilot.service", description: "BoxPilot", active: "active" }, { unit: "docker.service", description: "Docker Engine", active: "active" }, { unit: "tailscaled.service", description: "Tailscale", active: "active" }], dockerAvailable: true, containers: Object.keys(installed).map((id) => ({ name: `bp-${id}`, state: "running", image: `${id}:latest` })) },
  "vm.cloud.images": { images: [] },
  "vm.stats.inspect": { available: true, domains: {} },
};

// ---------- server ----------
if (!existsSync(dist)) { console.error("dist/ is missing: run `npm run build` first"); process.exit(1); }
const app = express();
app.use(express.json());
const api = express.Router();
const json = (response, body) => response.json(body);

api.get("/health", (_request, response) => json(response, { status: "ok", product: "BoxPilot", version: productVersion, mode: "demo", safeMode: true, hostMutationsEnabled: false, mutationPolicy: "demo", ownerBootstrapRequired: false, timestamp: now().toISOString() }));
api.get("/auth/status", (_request, response) => json(response, { bootstrapRequired: false, authenticated: true, owner: { id: "owner-demo", username: host.owner, role: "owner" }, csrfToken: "demo", expiresAt: ago(-12), elevatedUntil: null }));
api.post("/auth/logout", (_request, response) => json(response, { ok: true }));
api.get("/inventory", (_request, response) => json(response, inventory()));
api.get("/network/topology", (_request, response) => json(response, topology()));
api.get("/network/plans", (_request, response) => json(response, { plans: [] }));
api.get("/jobs", (_request, response) => json(response, { jobs }));
api.get("/jobs/:id", (request, response) => json(response, { job: jobs.find((job) => job.id === request.params.id) ?? jobs[0] }));
api.get("/backups", (_request, response) => json(response, { backups }));
api.get("/controller-backup-protection", (_request, response) => json(response, { destination: { ready: true, encrypted: true, repositoryId: "restic-controller", blockers: [] }, protections: [{ id: "p1", backupId: backups[0].id, createdAt: ago(2) }] }));
api.get("/controller-backup-retention", (_request, response) => json(response, { policy: { minimumCopies: 3, minimumAgeDays: 30 }, candidates: [] }));
api.get("/settings/backup-destination", (_request, response) => json(response, { destination: { host: "nas.local", port: 22, user: "backup", path: "/volume1/boxpilot" }, lastSync: { completedAt: ago(26), filesTransferred: 3, bytesTransferred: 58 * 1024 ** 2, destination: "backup@nas.local:/volume1/boxpilot" } }));
api.get("/settings/cloud-destination", (_request, response) => json(response, { destination: { provider: "b2", account: "001a2b3c4d5e", bucket: "homebox-backups", path: "homebox" }, lastSync: { completedAt: ago(26), filesTransferred: 3, bytesTransferred: "58.1 MiB", destination: "boxpilot:homebox-backups/homebox", errors: 0 } }));
api.get("/settings/notifications", (_request, response) => json(response, { configured: true, kind: "ntfy", url: "http://127.0.0.1:8093", topic: "homebox", hasToken: false }));
api.get("/settings/approval-mode", (_request, response) => json(response, { mode: "tiered", modes: ["tiered", "always-ask"] }));
// Real profiles from the product, resolved against the demo's installed set, so the first page a
// new owner sees is actually exercisable here.
api.get("/setup", async (_request, response) => {
  const status = (id) => (installed[id] ? "done" : "ready");
  const profiles = setupProfiles.map((profile) => {
    const steps = profile.steps.map((step) => ({
      ...step,
      status: step.kind === "app" ? status(step.appId) : step.id === "automatic-updates" ? "done" : "ready",
      detail: step.kind === "app" && installed[step.appId] ? "Already installed" : null,
    }));
    return { id: profile.id, name: profile.name, icon: profile.icon, description: profile.description, steps, remaining: steps.filter((step) => step.status === "ready").length, blocked: 0 };
  });
  json(response, { firstRun: false, installedApps: Object.keys(installed).length, appsKnown: true, profiles });
});
api.get("/setup/checklist", (_request, response) => json(response, buildChecklist({ tailscale: { connected: true, dnsName: host.tailnet }, firewall: firewallReport, firewallProfile, unattended: { enabled: true }, notifications: { configured: true, kind: "ntfy" }, cloudDestination: { provider: "b2" }, installedApps: Object.keys(installed), samba: { configured: true }, nfs: { configured: false }, ups: { configured: true } })));
api.get("/virtualization/domains", (_request, response) => json(response, { domains: [{ name: "dev-lab", state: "running" }, { name: "win11-test", state: "stopped" }] }));
api.get("/schedules", (_request, response) => json(response, { schedules: [
  { id: "s1", operationId: "app.backup", parameters: { id: "immich" }, frequency: "daily", minute: 0, hour: 3, weekday: null, enabled: true, createdBy: "owner-demo", createdAt: ago(200), nextDueAt: ago(-8), lastRunAt: ago(16) },
  { id: "s2", operationId: "backup.cloud.sync", parameters: {}, frequency: "daily", minute: 30, hour: 4, weekday: null, enabled: true, createdBy: "owner-demo", createdAt: ago(200), nextDueAt: ago(-7), lastRunAt: ago(26) },
  { id: "s3", operationId: "apt.refresh", parameters: {}, frequency: "weekly", minute: 0, hour: 5, weekday: 0, enabled: true, createdBy: "owner-demo", createdAt: ago(400), nextDueAt: ago(-60), lastRunAt: ago(108) },
] }));
api.get("/system/update", (_request, response) => json(response, { current: { version: productVersion, tag: `v${productVersion}` }, latest: { tag: `v${productVersion}`, version: productVersion, publishedAt: ago(30), url: "https://github.com/AES256Afro/BoxPilot/releases" }, updateAvailable: false, checkedAt: now().toISOString(), error: null }));
api.get("/power/ups/detect", (_request, response) => json(response, { devices: [{ vendorId: "051d", productId: "0002", manufacturer: "American Power Conversion", product: "Back-UPS ES 700G", driver: "usbhid-ups", confidence: "vendor-id", sysfs: "1-3" }], nutInstalled: true }));
api.get("/firewall/overview", (_request, response) => json(response, {
  report: firewallReport, reportError: null, web: { port: 8787, lanExposed: false }, protected: protectedRules({ webPort: 8787, webHost: "127.0.0.1" }), profiles, services, riskyPorts, current: firewallProfile,
  advice: adviseFirewall({ report: firewallReport, listeners, apps: [{ id: "immich", name: "Immich", ports: [{ port: 2283, protocol: "tcp", label: "Web UI and mobile app" }] }], current: firewallProfile, fail2ban, webPort: 8787, webHost: "127.0.0.1" }),
}));
api.get("/firewall/plan", (request, response) => json(response, buildPlan({ profileId: request.query.profile ?? "home-server", serviceIds: typeof request.query.services === "string" && request.query.services ? request.query.services.split(",") : [], replace: request.query.replace === "true", sshRateLimit: request.query.sshRateLimit === "true", webPort: 8787, webHost: "127.0.0.1" })));
api.get("/storage/overview", (_request, response) => json(response, storageOverview));
api.get("/storage/shares/discover", (_request, response) => json(response, { devices: [{ address: "192.168.50.30", name: "nas.local", smb: true, nfs: true, mac: "02:00:00:aa:00:30", interface: "eno1" }], scanned: 253, interfaces: ["eno1 192.168.50.20/24"] }));
api.get("/storage/samba", (_request, response) => json(response, { installed: true, running: true, configured: true, error: null, config: { managed: true, workgroup: "WORKGROUP", scope: "tailscale", interfaces: ["lo", "tailscale0"], shares: [{ name: "Media", path: "/mnt/media", comment: "Films and series", readOnly: true, guest: true, users: [], forceUser: host.owner }, { name: "Documents", path: "/srv/documents", comment: null, readOnly: false, guest: false, users: [host.owner, "sam"], forceUser: host.owner }] }, users: [host.owner, "sam"], tailscaleDnsName: host.tailnet, tailscaleAddress: host.tailscaleIp, lanAddress: host.lan }));
api.get("/storage/nfs", (_request, response) => json(response, { installed: true, running: false, configured: false, error: null, config: { managed: false, scope: "tailscale", exports: [] }, tailscaleDnsName: host.tailnet, tailscaleAddress: host.tailscaleIp, lanAddress: host.lan }));
api.get("/people", (_request, response) => json(response, { people: [{ id: "owner-demo", username: host.owner, role: "owner", createdAt: ago(900) }, { id: "p2", username: "sam", role: "viewer", createdAt: ago(300) }] }));
api.get("/catalog", async (_request, response) => {
  const { manifests, problems } = await loadCatalog();
  json(response, {
    applications: manifests.map((manifest) => {
      const port = installed[manifest.id];
      const live = { id: manifest.id, installed: Boolean(port), dataPresent: Boolean(port), state: port ? { installedAt: ago(19 * 24), updatedAt: ago(50), manifestSha256: manifest.sha256, image: { reference: manifest.image.reference, id: "sha256:demo" }, values: { ports: {}, env: {}, volumes: {}, setup: [] }, pinnedRollback: false, uninstalledAt: null } : null, container: port ? { exists: true, running: true, status: manifest.id === "open-webui" ? "paused" : "running", health: manifest.health.kind === "healthcheck" ? "healthy" : "none", restarts: 0, image: "sha256:demo" } : { exists: false, running: false, status: "absent", health: "none", restarts: 0, image: null }, urls: port ? manifest.ports.filter((entry) => entry.protocol === "tcp").map((entry) => ({ id: entry.id, label: entry.label, host: entry.host, exposure: entry.exposure })) : [], updateAvailable: manifest.id === "jellyfin", installedImage: port ? manifest.image.reference : null };
      return { manifest, live };
    }),
    problems, liveError: null, host: { lanAddress: host.lan, tailscaleDnsName: host.tailnet },
  });
});
api.get("/operations", (_request, response) => json(response, { operations: [], riskTiers: ["low", "medium", "high"] }));
api.get("/operations/prerequisites", (_request, response) => json(response, { generatedAt: now().toISOString(), checks: [], counts: { ready: 9, repairable: 0, missing: 0, conflict: 0 }, ready: true }));
api.get("/operations/:id/inspect", (request, response) => {
  const result = inspections[request.params.id];
  if (!result) return response.status(404).json({ error: "Not in the demo", code: "demo_missing" });
  return json(response, { operation: request.params.id, result });
});
// Read-only operations answer from the same fixtures the inspect route uses, so anything the UI
// reads through /run (which is how it passes parameters) behaves here too.
api.post("/operations/:id/run", (request, response) => json(response, { operation: request.params.id, result: request.params.id === "logs.read" ? { lines: ["demo: nothing is read from this machine"], truncated: false } : inspections[request.params.id] ?? {} }));
api.post("/operations/:id/jobs", (request, response) => response.status(201).json({ job: { id: "demo-job", type: `op:${request.params.id}`, title: request.params.id, state: "awaiting_approval", risk: "medium", error: null, result: null, steps: [], approvals: [], createdAt: now().toISOString() }, approval: { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", reason: "demo: jobs never run here" } }));
api.all("/{*rest}", (_request, response) => response.status(404).json({ error: "Not part of the demo", code: "demo_missing" }));
app.use("/api/v1", api);
app.use(express.static(dist, { index: false }));
app.get("/{*rest}", (_request, response) => response.sendFile(path.join(dist, "index.html")));
app.listen(port, "127.0.0.1", () => console.log(`BoxPilot demo (${productVersion}) with fictional data at http://127.0.0.1:${port}`));
