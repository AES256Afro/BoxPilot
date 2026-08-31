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
import { readFile } from "node:fs/promises";
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
const installed = { "open-webui": 8088, jellyfin: 8096, "pi-hole": 8084, immich: 2283, vaultwarden: 8222, "uptime-kuma": 3001, homepage: 3000, nextcloud: 8087, scrutiny: 8086, qbittorrent: 8095, ntfy: 8093 };
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
  { path: "/dev/sdb", kname: "sdb", pkname: null, type: "disk", size: 2000 * GiB, fstype: null, model: "Example USB HDD 2TB", tran: "usb", mountpoints: [null], ro: false, rm: true },
  { path: "/dev/sdb1", kname: "sdb1", pkname: "sdb", type: "part", size: 2000 * GiB, fstype: "exfat", uuid: "6B3F-1D2A", label: "Backup", mountpoints: [null], ro: false, rm: true },
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
  // The three jobs the Update night flow's last run left behind, one per step.
  { id: "j1", type: "op:host.snapshot.create", title: "Create a machine snapshot", state: "completed", risk: "medium", error: null, result: null, createdAt: ago(30), steps: [], approvals: [] },
  { id: "j2", type: "op:apt.refresh", title: "Refresh package lists", state: "completed", risk: "low", error: null, result: null, createdAt: ago(30), steps: [], approvals: [] },
  { id: "j3", type: "op:apt.upgrade", title: "Install package updates", state: "completed", risk: "medium", error: null, result: null, createdAt: ago(30), steps: [], approvals: [] },
];
// What each job's terminal would have shown; the demo serves it from /jobs/:id/output like the product.
const jobOutputs = {
  j1: "Snapshotting boxpilot state...\nApps: 8 included, project files and backups packed\nWrote machine-snapshot-20260826T030004Z-c9d0e1f2.tar.gz (41.2 MiB)\nChecksum recorded; snapshot verified readable.\n",
  j2: "Hit:1 http://archive.ubuntu.com/ubuntu noble InRelease\nGet:2 http://archive.ubuntu.com/ubuntu noble-updates InRelease [126 kB]\nGet:3 http://security.ubuntu.com/ubuntu noble-security InRelease [126 kB]\nFetched 252 kB in 1s (198 kB/s)\nReading package lists...\n4 packages can be upgraded.\n",
  j3: "Reading package lists...\nBuilding dependency tree...\nThe following upgrades will be installed:\n  openssl curl libcurl4t64 tailscale\nUnpacking openssl (3.0.13-0ubuntu3.6) over (3.0.13-0ubuntu3.5)...\nSetting up openssl (3.0.13-0ubuntu3.6)...\nProcessing triggers for man-db...\nScanning for services running old libraries...\nRestarted: cron.service\nAll updates installed.\n",
  d1: "Reading package lists...\nAll packages are up to date.\n",
  d2: "Creating LVM snapshot boxpilot-pre-change...\n  Logical volume \"boxpilot-pre-change\" created.\nSnapshot ready; changes can be rolled back from the Storage page.\n",
  d3: "Mirroring local backups to boxpilot:homebox-backups/homebox\nTransferred: 58.1 MiB, 3 files, no errors\n",
  d4: "Pulling image for the new version...\nRecreating container...\nHealthy after 6s; previous image kept for rollback.\n",
};
const backups = [
  { id: "10000000-0000-4000-8000-000000000003", applicationId: "boxpilot-controller", destination: "local-managed", checksumSha256: digest("c"), sizeBytes: 6 * 1024 ** 2, downtimeMs: 0, restoreDrill: { passed: true }, createdAt: ago(3) },
  { id: "10000000-0000-4000-8000-000000000002", applicationId: "boxpilot-controller", destination: "local-managed", checksumSha256: digest("b"), sizeBytes: 6 * 1024 ** 2, downtimeMs: 0, restoreDrill: { passed: true }, createdAt: ago(27) },
  { id: "10000000-0000-4000-8000-000000000001", applicationId: "boxpilot-controller", destination: "local-managed", checksumSha256: digest("a"), sizeBytes: 5 * 1024 ** 2, downtimeMs: 0, restoreDrill: { passed: true }, createdAt: ago(51) },
];
const machineState = {
  snapshots: [
    { artifact: "machine-snapshot-20260821T020000Z-a1b2c3d4.tar.gz", sizeBytes: 41 * 1024 ** 2, checksumSha256: digest("d"), createdAt: ago(20), contents: { apps: Object.keys(installed).map((id) => ({ id, installed: true, projectFiles: 3, backups: ({ vaultwarden: 4, immich: 2, jellyfin: 2, homepage: 1 })[id] ?? 0 })), vms: { domains: ["dev-lab"] } } },
    { artifact: "machine-snapshot-20260814T020000Z-e5f6a7b8.tar.gz", sizeBytes: 39 * 1024 ** 2, checksumSha256: digest("e"), createdAt: ago(188), contents: { apps: Object.keys(installed).slice(0, 6).map((id) => ({ id, installed: true, projectFiles: 3, backups: ({ vaultwarden: 3, jellyfin: 1 })[id] ?? 0 })), vms: { domains: [] } } },
  ],
  keep: 3,
  sync: { destination: "/mnt/boxpilot-backup/boxpilot-local-mirror", mount: { mounted: true, freeBytes: 1290 * GiB }, lastSync: { completedAt: ago(20), copiedCount: 12 } },
};

// Exported so a test can hold these to the operations the interface actually calls: a page whose
// operation has no fixture here gets `{}` from the demo, and an empty object is exactly the shape
// that breaks code expecting a field — which is how three crashes reached a real server.
export const inspections = {
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
  "app.serve.inspect": { available: true, serves: [{ dnsName: host.tailnet, port: 2283, target: "http://127.0.0.1:2283" }, { dnsName: host.tailnet, port: 8222, target: "http://127.0.0.1:8222" }, { dnsName: host.tailnet, port: 9001, target: "http://127.0.0.1:9001" }] },
  "app.stats.inspect": { available: true, stats },
  "host.snapshot.inspect": machineState,
  "backup.remote.inspect": { keyReady: true, publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExampleExam boxpilot-backup-mirror", fingerprint: "SHA256:ExampleFingerprintExampleFingerprintExample0", hostKeysPinned: 1, rsyncInstalled: true },
  "backup.cloud.inspect": { rcloneInstalled: true, configured: true, provider: "b2", providers: Object.fromEntries(Object.entries(cloudProviders).map(([id, entry]) => [id, { label: entry.label, fields: entry.fields, secrets: entry.secrets, help: entry.help }])) },
  "fail2ban.inspect": fail2ban,
  "canary.verify": { ok: true },
  "system.update.status": { running: false, log: [], startedAt: null, finishedAt: null, ok: null },
  "users.inspect": {
    users: [
      { name: "root", uid: 0, sudo: true, shell: "/bin/bash", keyCount: 0 },
      { name: host.owner, uid: 1000, sudo: true, shell: "/bin/bash", keyCount: 2 },
      { name: "sam", uid: 1001, sudo: false, shell: "/bin/bash", keyCount: 1 },
    ],
    sshd: { passwordAuthentication: false, keyboardInteractive: false, pubkeyAuthentication: true, permitRootLogin: "prohibit-password", port: 22 },
    sshActive: true,
  },
  "docker.disk.inspect": { images: { count: 22, sizeBytes: 9.4 * GiB, reclaimableBytes: 1.1 * GiB }, containers: { count: 14, sizeBytes: 0.6 * GiB }, volumes: { count: 9, sizeBytes: 3.2 * GiB }, buildCache: { sizeBytes: 0 } },
  "housekeeping.inspect": (() => {
    const categories = [
      { id: "boxpilot-versions", title: "Previous BoxPilot releases", summary: "Copies of BoxPilot that past updates left in /opt. The most recent working version is kept, so you can still put it back by hand, and so is the last update that failed its health check.", items: 4, bytes: 1.4 * GiB, detail: ["boxpilot.prev.1750", "boxpilot.prev.1746", "boxpilot.rollback-1741", "boxpilot-prev-1738"], keeping: ["boxpilot.prev.1752"], safe: true },
      { id: "docker-unused", title: "Orphaned image layers and build cache", summary: "Layers left behind when an image was replaced by a newer version, and what Docker cached while building. Nothing references either; both come back on their own if they are ever needed again.", items: 6, bytes: 1.1 * GiB, detail: ["6 orphaned layers: 902.0 MiB", "build cache: 224.0 MiB"], keeping: [], safe: true },
      { id: "docker-unreferenced-images", title: "Images no app uses", summary: "Complete images that no container references and no installed app needs. Left by apps you removed, versions replaced by updates, or a trial run. Installing one of these again downloads it again.", items: 3, bytes: 2.3 * GiB, detail: ["ghcr.io/example/oldapp:1.2 (980.0 MiB)", "ghcr.io/example/oldapp:1.1 (960.0 MiB)", "example/scratch:latest (416.0 MiB)"], keeping: [], safe: true },
      { id: "app-backups", title: "Older application backups", summary: "Backup archives beyond the newest 3 for each app. The newest 3 are always kept, and any copy already mirrored off this server is unaffected.", items: 5, bytes: 780 * 1024 ** 2, detail: ["immich: 3 archive(s)", "nextcloud: 2 archive(s)"], keeping: [], safe: true },
      { id: "restore-leftovers", title: "Unfinished restores", summary: "Folders a restore left behind when it could not finish swapping data back. They are copies, not the live data an app is using.", items: 0, bytes: 0, detail: [], keeping: [], safe: true },
      { id: "job-logs", title: "Logs for jobs no longer listed", summary: "Output from jobs older than 90 days, which is longer than the history keeps them; nothing lists those jobs any more.", items: 214, bytes: 18 * 1024 ** 2, detail: [], keeping: [], safe: true },
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
  "app.config.inspect": { id: "homepage", name: "Homepage", directory: "/var/lib/boxpilot-managed/catalog/homepage", compose: "name: bp-homepage\nservices:\n  homepage:\n    image: ghcr.io/gethomepage/homepage:v1.5.0\n    restart: unless-stopped\n    ports:\n      - 192.168.1.10:3000:3000\n", env: [{ name: "HOMEPAGE_ALLOWED_HOSTS", value: "*", secret: false }, { name: "PUID", value: "1000", secret: false }, { name: "SECRET", value: "********", secret: true }] },
  // Every dialog the interface can open needs an answer here; see scripts/demo-fixtures.test.mjs.
  "app.vpn.inspect": { id: "qbittorrent", tunneled: true, sidecarId: "vpn", running: true, status: "running", exit: { ip: "203.0.113.7", location: "Netherlands, North Holland, Amsterdam", at: "2026-08-25T03:00:00Z" } },
  "samba.diagnose": { ok: true, scope: "tailscale", discovery: { installed: false, running: false }, checks: [
    { id: "running", state: "ok", title: "The file server is running", detail: "smbd is active.", hint: null, share: null },
    { id: "config", state: "ok", title: "The configuration is valid", detail: "2 share(s) defined.", hint: null, share: null },
    { id: "listening", state: "ok", title: "Listening for connections", detail: "Answering on 100.100.20.10:445.", hint: null, share: null },
    { id: "firewall", state: "info", title: "The firewall is not filtering", detail: "ufw is inactive.", hint: null, share: null },
    { id: "discovery", state: "info", title: "Windows will not list this server", detail: "Windows browses with WS-Discovery, which Samba does not speak.", hint: null, share: null },
    { id: "share.Media.write", state: "ok", title: "Media: read-only, as configured", detail: "/mnt/media is shared read-only.", hint: null, share: "Media" },
    { id: "share.Documents.write", state: "ok", title: "Documents: writable", detail: "Writes land as alex.", hint: null, share: "Documents" },
  ] },
  "storage.folders": { path: "/mnt/media", folders: ["/mnt/media/films", "/mnt/media/music", "/mnt/media/series", "/mnt/media/torrents"], truncated: false },
  "storage.fs-snapshots.inspect": { supported: true, btrfs: { toolPresent: true, filesystems: [{ target: "/mnt/pool", source: "/dev/sdc1", snapshots: [{ name: "before-reorg", path: "/mnt/pool/.boxpilot-snapshots/before-reorg" }] }] }, zfs: { toolPresent: true, datasets: [{ name: "tank/media", mountpoint: "/tank/media", snapshots: [{ name: "nightly", path: "tank/media@nightly", used: "1.2G" }] }] } },
  "compose.project.logs": { name: "old-wordpress", lines: [
    "wordpress_1  | [28-Aug-2026] WordPress database connection failed",
    "db_1         | 2026-08-28  [Warning] Aborted connection to db",
    "wordpress_1  | AH00558: apache2: Could not reliably determine the server's fully qualified domain name",
  ] },
  "compose.projects.inspect": { available: true, projects: [
    { name: "old-wordpress", status: "exited(2)", configFiles: ["/opt/wordpress/docker-compose.yml"] },
  ] },
  "credentials.inspect": { credentials: [
    { name: "ntfy-token", createdAt: "2026-08-20T10:00:00.000Z", updatedAt: "2026-08-26T09:30:00.000Z" },
    { name: "weather-api", createdAt: "2026-08-24T18:00:00.000Z", updatedAt: "2026-08-24T18:00:00.000Z" },
  ] },
  "app.reachability.inspect": { headline: null, probedFrom: "this server", addresses: [
    { id: "probe-0", portId: "web", portLabel: "Web UI", kind: "lan", url: "http://192.168.1.10:8096", probe: true, note: null, outcome: "answered", status: 200, ms: 14, verdict: "Answers (HTTP 200 in 14ms)." },
    { id: "probe-1", portId: "web", portLabel: "Web UI", kind: "tailnet", url: "http://100.101.102.103:8096", probe: true, note: "In a browser on your tailnet, use http://homebox:<port> (the short name; the full ts.net name only works for https through Serve).", outcome: "answered", status: 200, ms: 21, verdict: "Answers (HTTP 200 in 21ms)." },
    { id: "probe-2", portId: null, portLabel: null, kind: "browser-rule", url: "http://homebox.tail0a1b.ts.net:<port>", probe: false, note: "Browsers refuse this form outright: ts.net is on their built-in HSTS preload list, so plain http on the full name is rewritten to https and nothing answers. Use the short name or the Serve address.", outcome: "not-probed", verdict: "Browsers refuse this form outright: ts.net is on their built-in HSTS preload list, so plain http on the full name is rewritten to https and nothing answers. Use the short name or the Serve address." },
  ] },
  "app.logs": { id: "jellyfin", container: null, lines: [
    "[2026-08-25 06:12:04] [INF] Startup complete 00:00:07.2118863",
    "[2026-08-25 06:12:09] [INF] Loading library db",
    "[2026-08-25 07:41:22] [INF] Playback start: Blade Runner 2049 (user: alex)",
    "[2026-08-25 07:41:23] [INF] Direct play, no transcode required",
  ] },
  "app.backups.inspect": { id: "jellyfin", directory: "/var/lib/boxpilot-managed/backups/catalog/jellyfin", backups: [
    { artifact: "20260825T031400Z.tar.gz", createdAt: ago(11), sizeBytes: 84 * 1024 ** 2, checksumSha256: "5cadc3b554cd25b0f7b1c1e2a9d4f6b3c8e0a1d2f3b4c5d6e7f8a9b0c1d2e3f4", contents: ["compose.yaml", ".env", "config"], downtimeMs: 10268, skippedVolumes: [], skippedHostPaths: ["/srv/media"], image: "jellyfin/jellyfin:10.10.7" },
    { artifact: "20260824T031400Z.tar.gz", createdAt: ago(35), sizeBytes: 83 * 1024 ** 2, checksumSha256: "21871c8a3ea0e84d9b2f4c6a8e0d2b4f6a8c0e2d4b6f8a0c2e4d6b8f0a2c4e6d", contents: ["compose.yaml", ".env", "config"], downtimeMs: 209, skippedVolumes: [], skippedHostPaths: ["/srv/media"], image: "jellyfin/jellyfin:10.10.7" },
  ] },
  "app.backup.files": { id: "jellyfin", backup: "20260825T031400Z.tar.gz", truncated: false, files: [
    { path: "compose.yaml", sizeBytes: 812 }, { path: ".env", sizeBytes: 214 },
    { path: "config/system.xml", sizeBytes: 4210 }, { path: "config/data/library.db", sizeBytes: 61 * 1024 ** 2 },
  ] },
  "app.secrets": { id: "vaultwarden", secrets: [{ name: "ADMIN_TOKEN", label: "Admin page token", value: "demo-token-not-a-real-secret" }] },
  "service.journal": { unit: "boxpilot.service", lines: [
    "2026-08-25T06:11:58+0000 homebox systemd[1]: Started BoxPilot.",
    "2026-08-25T06:12:01+0000 homebox node[812]: BoxPilot listening on 127.0.0.1:8787",
    "2026-08-25T07:15:44+0000 homebox node[812]: job completed: app.backup (jellyfin)",
  ] },
  "logs.read": { lines: ["demo: nothing is read from this machine"], truncated: false },
  "host.snapshot.restores": { restores: [{
    name: "20260825T140000Z", stagedAt: "/var/lib/boxpilot/snapshots/restored/20260825T140000Z",
    files: [
      { path: "system/netplan/00-installer-config.yaml", area: "system", sizeBytes: 312, content: "network:\n  version: 2\n  ethernets:\n    eno1:\n      dhcp4: false\n      addresses: [192.168.50.20/24]\n      routes:\n        - to: default\n          via: 192.168.50.1\n" },
      { path: "system/ufw/user.rules", area: "system", sizeBytes: 1840, content: "### RULES ###\n-A ufw-user-input -p tcp --dport 22 -j ACCEPT\n-A ufw-user-input -p tcp --dport 8096 -j ACCEPT\n" },
      { path: "system/fstab", area: "system", sizeBytes: 640, content: "UUID=1a2b3c4d / ext4 defaults 0 1\n//nas.local/backups /mnt/backup cifs credentials=/etc/cifs.cred,nofail 0 0\n" },
      { path: "vms/dev-lab.xml", area: "vms", sizeBytes: 2410, content: "<domain type=\"kvm\">\n  <name>dev-lab</name>\n  <vcpu>4</vcpu>\n  <memory unit=\"GiB\">8</memory>\n</domain>\n" },
      { path: "controller/boxpilot.sqlite3", area: "controller", sizeBytes: 845824, content: null },
    ],
  }] },
  "host.snapshot.discover": { locations: [
    { root: "/mnt/backup-drive/boxpilot-local-mirror/machine-snapshots", mount: { target: "/mnt/backup-drive", source: "//nas.local/backups", filesystem: "cifs" },
      snapshots: [{ artifact: "machine-snapshot-20260820T020000Z-9f3c1a77.tar.gz", sizeBytes: 184320, createdAt: ago(30), checksumSha256: "b".repeat(64), apps: 11 }] },
  ], unanswered: [] },
  "host.snapshot.sources": {
    mount: { mounted: true, blocker: null },
    sources: [
      { source: "local", root: "/var/lib/boxpilot-managed/machine-snapshots", available: true, snapshots: [
        { artifact: "machine-snapshot-20260824T141228Z-5cadc3b5.tar.gz", sizeBytes: 41 * 1024 ** 2, createdAt: ago(26), checksumSha256: "5cadc3b554cd25b0f7b1c1e2a9d4f6b3c8e0a1d2f3b4c5d6e7f8a9b0c1d2e3f4", apps: 9 },
        { artifact: "machine-snapshot-20260817T141228Z-21871c8a.tar.gz", sizeBytes: 39 * 1024 ** 2, createdAt: ago(194), checksumSha256: "21871c8a3ea0e84d9b2f4c6a8e0d2b4f6a8c0e2d4b6f8a0c2e4d6b8f0a2c4e6d", apps: 6 },
      ] },
      { source: "mirror", root: "/mnt/boxpilot-backup/boxpilot-local-mirror/machine-snapshots", available: true, snapshots: [
        { artifact: "machine-snapshot-20260824T141228Z-5cadc3b5.tar.gz", sizeBytes: 41 * 1024 ** 2, createdAt: ago(26), checksumSha256: "5cadc3b554cd25b0f7b1c1e2a9d4f6b3c8e0a1d2f3b4c5d6e7f8a9b0c1d2e3f4", apps: 9 },
      ] },
    ],
  },
  "host.snapshot.describe": {
    source: "local", artifact: "machine-snapshot-20260824T141228Z-5cadc3b5.tar.gz", createdAt: ago(26),
    checksumSha256: "5cadc3b554cd25b0f7b1c1e2a9d4f6b3c8e0a1d2f3b4c5d6e7f8a9b0c1d2e3f4",
    apps: Object.keys(installed).map((id) => ({ id, installed: true, newestBackup: ago(11), dataAvailable: true, dataLocation: "local" })),
    system: { netplan: true, firewall: true, fstab: true, database: true },
    vms: { domains: ["dev-lab"], disksIncluded: false, diskRepository: "/var/lib/libvirt/images", diskRepositoryReachable: true },
  },
  "dns.names.inspect": {
    available: true, reason: null, platform: { id: "pi-hole", label: "Pi-hole", running: true },
    file: "/var/lib/boxpilot-managed/catalog/pi-hole/etc-pihole/hosts/boxpilot.list",
    records: [{ address: host.lan, name: "jellyfin.lan" }, { address: host.lan, name: "immich.lan" }],
    apps: Object.entries(installed).map(([id, port]) => ({ id, name: id, port })),
  },
  "dns.blocker.clients": { available: true, reason: null, platform: { id: "pi-hole", label: "Pi-hole", running: true },
    clients: [{ address: "192.168.50.31", queries: 812 }, { address: "192.168.50.44", queries: 240 }, { address: "192.168.50.52", queries: 96 }], self: 14 },
  "dns.blocker.verify": { address: host.lan, answering: true, resolving: true, blocking: true, intercepted: false, interceptorBlocking: null,
    control: { domain: "example.com", addresses: ["93.184.216.34"], error: null },
    probe: { domain: "doubleclick.net", addresses: ["0.0.0.0"], error: null }, reason: null },
  "router.inspect": { configured: true, reachable: true, host: "192.168.1.1", username: "root", model: "GL-MT6000", firmware: "4.7.0", reason: null },
  "router.leases": { host: "192.168.1.1", leases: [
    { name: "homebox", address: host.lan, mac: "aa:bb:cc:dd:ee:02", online: true, reserved: true },
    { name: "alex-laptop", address: "192.168.1.26", mac: "aa:bb:cc:dd:ee:01", online: true, reserved: false },
    { name: "living-room-tv", address: "192.168.1.51", mac: "aa:bb:cc:dd:ee:04", online: false, reserved: false },
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
/**
 * Every route answers through here, which is the one place a whole world can be swapped.
 *
 * The operations were only half of it: the Overview, the catalog and the setup checklist read plain
 * REST routes, so the "fresh" world was still showing nine installed apps and four of five
 * essentials done — a fresh server that had clearly been running for weeks. These are the routes
 * that describe what has happened to a machine, rewritten for a machine to which nothing has.
 *
 * Written out rather than derived, unlike the operation fixtures: emptying `/auth/status` signs you
 * out and emptying `/network/topology` leaves a server with no network at all, neither of which is
 * a state worth reviewing. Each entry starts from the default body so the shape cannot drift.
 */
const freshRest = {
  "/jobs": () => ({ jobs: [] }),
  "/backups": () => ({ backups: [] }),
  "/schedules": () => ({ schedules: [] }),
  "/network/plans": (body) => body,
  "/flows": (body) => ({ ...body, flows: [] }),
  "/people": (body) => ({ people: body.people.slice(0, 1) }),
  "/settings/backup-destination": () => ({ destination: null, lastSync: null }),
  "/settings/cloud-destination": () => ({ destination: null, lastSync: null }),
  "/settings/notifications": (body) => ({ ...body, configured: false, kind: null, topic: null, hasToken: false }),
  "/controller-backup-protection": (body) => ({ destination: { ...body.destination, ready: false, encrypted: false, blockers: ["Encrypted copies are not set up yet"] }, protections: [] }),
  "/controller-backup-retention": (body) => ({ ...body, candidates: [] }),
  "/storage/samba": (body) => ({ ...body, installed: false, running: false, configured: false, config: { ...body.config, managed: false, shares: [] }, users: [] }),
  "/storage/nfs": (body) => ({ ...body, installed: false, running: false, configured: false, config: { ...body.config, exports: [] } }),
  "/storage/shares/discover": (body) => ({ ...body, devices: [] }),
  "/power/ups/detect": (body) => ({ ...body, devices: [], nutInstalled: false }),
  "/virtualization/domains": (body) => ({ ...body, connected: false, error: "libvirt is not installed on this server yet", domains: [] }),
  "/virtualization/status": (body) => ({ ...body, ready: false, checks: body.checks.map((check) => ({ ...check, ok: false, detail: "Not installed on this server yet" })) }),
  "/firewall/overview": (body) => ({ ...body, report: { ...body.report, installed: true, enabled: false, rules: [] }, current: null, advice: [] }),
  // The disks are real on a new server; what BoxPilot has done to them is not. So the hardware
  // stays and the snapshots, mounted shares and cifs/nfs tooling — all of it BoxPilot's doing — go.
  "/storage/overview": (body) => ({ ...body, snapshots: [], shares: [], tools: { cifs: false, nfs: false, smbclient: false, showmount: false } }),
  // What the machine is, rather than what has been done to it. A new server has hardware and an
  // address; it is not on anybody's tailnet and its firewall has never been turned on. Leaving
  // these alone made the demo contradict itself — the checklist said Tailscale was not set up
  // while the Network page said "Connected as ...".
  "/network/topology": (body) => ({ ...body, tailscale: { ...body.tailscale, connected: false, dnsName: null, address: null, resolverPresent: false, overrideState: "none", exitNodeAdvertised: false, advertisedRoutes: [], approvedRoutes: [] }, dnsListeners: [], devices: [] }),
  "/inventory": (body) => ({ ...body, docker: { ...body.docker, available: false, containers: [], images: [], networks: [], volumes: [], projects: [] } }),
};

const json = (response, body) => {
  const scenario = scenarioOf(response.req?.get?.("referer"));
  const table = scenario === "fresh" ? freshRest : scenario === "trouble" ? troubleRest : null;
  const rewrite = table ? table[response.req?.path] : null;
  return response.json(rewrite ? rewrite(body) : body);
};

/** What the machine has installed, per world: nothing at all on a server nobody has set up yet. */
const installedFor = (scenario) => (scenario === "fresh" ? {} : installed);

api.get("/capabilities", (_request, response) => json(response, { version: productVersion, network: { bind: "127.0.0.1", port: 8787, lan: false, canSet: true }, tls: { provisioned: true, port: 8443, names: ["homebox.lan", "homebox", "boxpilot.lan"], ipAddresses: [host.lan], fingerprint: "A1:B2:C3:D4:E5:F6:07:18:29:3A:4B:5C:6D:7E:8F:90:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89", notAfter: "Sep 29 12:00:00 2027 GMT", caFingerprint: "0F:1E:2D:3C:4B:5A:69:78:87:96:A5:B4:C3:D2:E1:F0:0F:1E:2D:3C:4B:5A:69:78:87:96:A5:B4:C3:D2:E1:F0", canProvision: true }, identity: { password: true, tailscale: true, github: true, passkeys: true, roles: ["owner", "operator", "viewer"] } }));
api.get("/health", (_request, response) => json(response, { status: "ok", product: "BoxPilot", version: productVersion, mode: "demo", safeMode: true, hostMutationsEnabled: false, mutationPolicy: "demo", ownerBootstrapRequired: false, timestamp: now().toISOString() }));
api.get("/auth/status", (_request, response) => json(response, { bootstrapRequired: false, authenticated: true, owner: { id: "owner-demo", username: host.owner, role: "owner" }, csrfToken: "demo", expiresAt: ago(-12), elevatedUntil: null }));
api.post("/auth/logout", (_request, response) => json(response, { ok: true }));
api.get("/auth/passkey", (_request, response) => json(response, { passkeys: [
  { id: "pk-demo-phone", rpId: host.tailnet, label: "iPhone (Face ID)", transports: ["internal", "hybrid"], createdAt: ago(24 * 34), lastUsedAt: ago(7) },
  { id: "pk-demo-key", rpId: "boxpilot.lan", label: "YubiKey 5C", transports: ["usb"], createdAt: ago(24 * 11), lastUsedAt: ago(24 * 3) },
], recoveryCodesRemaining: 8 }));
api.get("/oidc/clients", (_request, response) => json(response, {
  issuer: `https://${host.tailnet}`,
  discovery: `https://${host.tailnet}/.well-known/openid-configuration`,
  clients: [
    { id: "grafana-a1b2c3d4e5f6", name: "Grafana", redirectUris: [`https://grafana.${host.tailnet}/login/generic_oauth`], createdAt: ago(24 * 20) },
    { id: "immich-9f8e7d6c5b4a", name: "Immich", redirectUris: [`https://photos.${host.tailnet}/auth/login`], createdAt: ago(24 * 5) },
  ],
}));
api.get("/network/reachability", (_request, response) => json(response, {
  ways: [
    { id: "loopback", label: "On this server", url: "http://127.0.0.1:8787", scope: "Only from the server itself", encrypted: false, trusted: true },
    { id: "tailnet", label: "Over Tailscale, from anywhere", url: `https://${host.tailnet}`, scope: "Any device on your tailnet", encrypted: true, trusted: true },
  ], onLan: false, tlsProvisioned: true, servePublished: true,
}));
api.get("/auth/sessions", (_request, response) => json(response, { currentId: "sess-demo-here", sessions: [
  { id: "sess-demo-here", createdAt: ago(6), expiresAt: ago(-6), lastSeenAt: ago(0.02), address: host.tailscaleIp, userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36", method: "passkey", elevated: true },
  { id: "sess-demo-phone", createdAt: ago(31), expiresAt: ago(-2), lastSeenAt: ago(3), address: host.tailscaleIp, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1", method: "tailscale", elevated: false },
] }));
api.get("/inventory", (_request, response) => json(response, inventory()));
api.get("/network/topology", (_request, response) => json(response, topology()));
api.get("/network/tailnet", (_request, response) => json(response, { available: true, connected: true,
  self: { name: "homebox", dnsName: host.tailnet, address: host.tailscaleIp, os: "linux", online: true, lastSeen: null, exitNode: false, subnetRoutes: ["192.168.50.0/24"], direct: null, relay: null, isSelf: true },
  peers: [
    { name: "workbook", dnsName: "workbook.tail0a1b.ts.net", address: "100.64.0.7", os: "macOS", online: true, lastSeen: null, exitNode: false, subnetRoutes: [], direct: true, relay: null, isSelf: false },
    { name: "gamebox", dnsName: "gamebox.tail0a1b.ts.net", address: "100.64.0.8", os: "windows", online: true, lastSeen: null, exitNode: false, subnetRoutes: [], direct: true, relay: null, isSelf: false },
    { name: "pixel", dnsName: "pixel.tail0a1b.ts.net", address: "100.64.0.9", os: "android", online: false, lastSeen: ago(30), exitNode: false, subnetRoutes: [], direct: false, relay: "sfo", isSelf: false },
  ] }));
api.get("/network/plans", (_request, response) => json(response, { plans: [] }));
api.get("/jobs", (_request, response) => json(response, { jobs }));
api.post("/flows/:id/webhook", (request, response) => json(response, { token: "demo-token-shown-once", path: `/api/v1/hooks/flows/${request.params.id}/demo-token-shown-once` }));
api.delete("/flows/:id/webhook", (_request, response) => response.status(204).end());
api.get("/jobs/:id", (request, response) => {
  // 404 like the product: falling back to the first job meant an unknown id quietly opened
  // somebody else's terminal, and the pruned-job message never showed anywhere.
  const job = jobs.find((entry) => entry.id === request.params.id);
  return job ? json(response, { job }) : response.status(404).json({ error: "Job not found" });
});
api.get("/jobs/:id/output", (request, response) => json(response, { output: jobOutputs[request.params.id] ?? "" }));
api.get("/backups", (_request, response) => json(response, { backups }));
api.get("/controller-backup-protection", (_request, response) => json(response, { destination: { ready: true, encrypted: true, repositoryId: "restic-controller", blockers: [] }, protections: [{ id: "p1", backupId: backups[0].id, createdAt: ago(2) }] }));
api.get("/controller-backup-retention", (_request, response) => json(response, { policy: { minimumCopies: 3, minimumAgeDays: 30 }, candidates: [] }));
api.get("/settings/backup-destination", (_request, response) => json(response, { destination: { host: "nas.local", port: 22, user: "backup", path: "/volume1/boxpilot" }, lastSync: { completedAt: ago(26), filesTransferred: 3, bytesTransferred: 58 * 1024 ** 2, destination: "backup@nas.local:/volume1/boxpilot" } }));
api.get("/settings/cloud-destination", (_request, response) => json(response, { destination: { provider: "b2", account: "001a2b3c4d5e", bucket: "homebox-backups", path: "homebox" }, lastSync: { completedAt: ago(26), filesTransferred: 3, bytesTransferred: "58.1 MiB", destination: "boxpilot:homebox-backups/homebox", errors: 0 } }));
api.get("/settings/notifications", (_request, response) => json(response, { configured: true, kind: "ntfy", url: "http://127.0.0.1:8093", topic: "homebox", hasToken: false }));
api.get("/settings/watch", (_request, response) => json(response, { targetConfigured: true, activeCount: 0, conditions: [
  ["storage.root.full", "Root disk nearly full"], ["storage.mount.full", "A mounted filesystem is nearly full"], ["storage.forecast", "A filesystem is on track to fill soon"],
  ["storage.smart", "A disk reports SMART problems"], ["smart.errors", "A disk's error count is climbing"], ["smart.wear", "An SSD is nearing its write-endurance limit"],
  ["power.ups", "UPS on battery or low"], ["system.services", "System services have failed"], ["system.reboot", "A reboot is required"],
  ["docker.unhealthy", "A container is unhealthy"], ["docker.restarting", "A container keeps restarting (crash-looping)"], ["schedule.overdue", "A scheduled task (such as a backup) has stopped running"],
].map(([key, label]) => ({ key, label, active: false, details: [] })) }));
api.get("/settings/approval-mode", (_request, response) => json(response, { mode: "tiered", modes: ["tiered", "always-ask"] }));
api.get("/settings/vpn-profile", (_request, response) => json(response, {
  profile: { configured: true, provider: "mullvad", type: "wireguard", wireguardAddresses: "10.64.222.21/32", countries: "Sweden, Netherlands", portForwarding: "off", dot: "on", blockMalicious: "on", blockAds: "on", blockSurveillance: "off", dnsAddress: "", outboundSubnets: "192.168.0.0/16, 10.0.0.0/8", healthTargetAddress: "", hasWireguardKey: true, hasOpenvpnPassword: false, updatedAt: ago(48) },
  providers: ["mullvad", "protonvpn", "nordvpn", "surfshark", "private internet access", "airvpn", "windscribe", "ivpn", "custom"],
  protocols: ["wireguard", "openvpn"],
}));
// Real profiles from the product, resolved against the demo's installed set, so the first page a
// new owner sees is actually exercisable here.
api.get("/setup", async (request, response) => {
  const present = installedFor(scenarioOf(request.get("referer")));
  const status = (id) => (present[id] ? "done" : "ready");
  const profiles = setupProfiles.map((profile) => {
    const steps = profile.steps.map((step) => ({
      ...step,
      status: step.kind === "app" ? status(step.appId) : step.id === "automatic-updates" && Object.keys(present).length ? "done" : "ready",
      detail: step.kind === "app" && present[step.appId] ? "Already installed" : null,
    }));
    return { id: profile.id, name: profile.name, icon: profile.icon, description: profile.description, steps, remaining: steps.filter((step) => step.status === "ready").length, blocked: 0 };
  });
  json(response, { firstRun: Object.keys(present).length === 0, installedApps: Object.keys(present).length, appsKnown: true, profiles });
});
api.get("/setup/checklist", (request, response) => {
  // A brand new server has done none of this; that list is the whole point of the page.
  const bare = scenarioOf(request.get("referer")) === "fresh";
  json(response, buildChecklist(bare
    ? { tailscale: { connected: false }, firewall: { active: false }, firewallProfile: null, unattended: { enabled: false }, notifications: { configured: false }, cloudDestination: null, installedApps: [], samba: { configured: false }, nfs: { configured: false }, ups: { configured: false } }
    : { tailscale: { connected: true, dnsName: host.tailnet }, firewall: firewallReport, firewallProfile, unattended: { enabled: true }, notifications: { configured: true, kind: "ntfy" }, cloudDestination: { provider: "b2" }, installedApps: Object.keys(installed), samba: { configured: true }, nfs: { configured: false }, ups: { configured: true } }));
});
// The whole Virtual Machines page used to answer "not part of the demo", so nobody could look at
// it before it reached a server. These mirror the real route shapes in server/routes/virtualization.mjs.
const demoDomain = (name, state, vcpus, memoryGiB, extra = {}) => ({
  name, uuid: `demo-${name}`, state, vcpus, memoryKiB: memoryGiB * 1024 * 1024, persistent: true, autostart: state === "running",
  managed: true, addresses: state === "running" ? [{ interface: "vnet0", protocol: "ipv4", address: "192.168.122.31" }] : [],
  disks: [{ type: "file", device: "disk", target: "vda", source: `/var/lib/libvirt/images/${name}.qcow2` }],
  interfaces: [{ interface: "vnet0", type: "network", source: "default", model: "virtio", mac: "52:54:00:6f:2a:1c" }],
  snapshotCount: state === "running" ? 2 : 0,
  snapshots: state === "running" ? [{ name: "before-upgrade", manageable: true, current: true, state: "running", location: "internal", parent: null, createdAt: ago(52) }] : [],
  ...extra,
});
api.get("/virtualization/domains", (_request, response) => json(response, {
  connected: true, error: null,
  domains: [demoDomain("dev-lab", "running", 4, 8), demoDomain("win11-test", "shut off", 2, 4)],
}));
api.get("/virtualization/status", (_request, response) => json(response, {
  platform: "linux", architecture: "x86_64", connectionUri: "qemu:///system", ready: true,
  checks: [
    { id: "kvm", label: "KVM acceleration", ok: true, detail: "/dev/kvm is present and readable" },
    { id: "libvirtd", label: "libvirt service", ok: true, detail: "libvirtd.service is active" },
    { id: "qemu", label: "QEMU", ok: true, detail: "qemu-system-x86_64 8.2.2" },
  ],
  tailscale: { installed: true, connected: true, dnsName: host.tailnet, serveUrls: [] },
  setupPlan: { title: "Everything needed is already installed", destructive: false, requiresConsoleApproval: false, commands: [], notes: [] },
  actions: { enabled: true },
}));
api.get("/virtualization/resources", (_request, response) => json(response, {
  connected: true, errors: [],
  networks: [{ name: "default", active: true, autostart: true, persistent: true, bridge: "virbr0" }],
  pools: [{ name: "default", active: true, autostart: true, persistent: true, type: "dir", targetPath: "/var/lib/libvirt/images", capacity: "800 GiB", allocation: "96 GiB", available: "704 GiB", availableBytes: 704 * GiB }],
}));
api.get("/virtualization/console-guidance", (_request, response) => json(response, {
  nativeProxyAvailable: false,
  cockpit: { installed: false, active: false, enabled: false, port: 9090 },
  tailscaleDnsName: host.tailnet, privateUrl: null,
  accessNote: "Install Cockpit to open a VM console in the browser over your tailnet.",
}));
api.get("/virtualization/foundation", (_request, response) => json(response, {
  connectionUri: "qemu:///system", connectionReady: true, ready: true, revision: "1",
  network: { name: "default", exists: true, active: true, autostart: true, persistent: true, compatible: true, bridge: "virbr0" },
  pool: { name: "default", exists: true, active: true, autostart: true, persistent: true, compatible: true, targetPath: "/var/lib/libvirt/images" },
  conflicts: [], planAvailable: false, changes: [],
  boundary: { mutationPerformed: false, browserResourceAccepted: false },
}));
api.get("/flows", (_request, response) => json(response, {
  flows: [
    { id: "flow-1", name: "Update night", steps: [{ operationId: "host.snapshot.create", parameters: {} }, { operationId: "apt.refresh", parameters: {} }, { operationId: "apt.upgrade", parameters: {} }],
      createdBy: "owner-demo", risk: "medium", running: false, createdAt: ago(200), updatedAt: ago(200), lastRunAt: ago(30), lastResult: "completed", lastJobIds: ["j1", "j2", "j3"],
      frequency: "weekly", minute: 0, hour: 3, weekday: 0, enabled: true, nextDueAt: ago(-96), triggerFlowId: null, webhookEnabled: true },
    { id: "flow-2", name: "Belt and braces", steps: [{ operationId: "controller.backup.create", parameters: {}, name: "backup" }, { operationId: "backup.sync", parameters: {}, when: { value: "{{ steps.backup.changed }}" }, onFailure: "continue" }],
      createdBy: "owner-demo", risk: "medium", running: false, createdAt: ago(100), updatedAt: ago(100), lastRunAt: ago(5), lastResult: "completed (1 step skipped by condition)", lastJobIds: ["d3", null],
      frequency: null, minute: null, hour: null, weekday: null, enabled: true, nextDueAt: null, triggerFlowId: "flow-1", webhookEnabled: false },
  ],
  shelf: [
    { slug: "update-night", name: "Update night", description: "Snapshot, refresh, then install every update.", steps: [{ operationId: "host.snapshot.create", parameters: {} }, { operationId: "apt.refresh", parameters: {} }, { operationId: "apt.upgrade", parameters: {}, retry: 1 }] },
    { slug: "belt-and-braces", name: "Belt and braces", description: "Back up the database, then mirror it off-box.", steps: [{ operationId: "controller.backup.create", parameters: {} }, { operationId: "backup.sync", parameters: {} }] },
    { slug: "tidy-docker", name: "Tidy up Docker", description: "Reclaim disk from unused images and layers.", steps: [{ operationId: "docker.prune", parameters: {} }] },
  ],
  palette: [
    { operationId: "host.snapshot.create", title: "Create a machine snapshot", risk: "medium", description: "", fields: [] },
    { operationId: "apt.refresh", title: "Refresh package lists", risk: "low", description: "", fields: [] },
    { operationId: "apt.upgrade", title: "Install package updates", risk: "medium", description: "", fields: [] },
    { operationId: "controller.backup.create", title: "Back up the BoxPilot database", risk: "low", description: "", fields: [] },
    { operationId: "backup.sync", title: "Mirror local backups to the independent destination", risk: "medium", description: "", fields: [] },
    { operationId: "docker.prune", title: "Clean up Docker disk space", risk: "medium", description: "", fields: [] },
    { operationId: "homepage.sync", title: "Sync Homepage with installed apps", risk: "low", description: "", fields: [{ name: "host", type: "string", optional: true, enum: null, default: null }] },
    { operationId: "http.request", title: "Send an HTTP request", risk: "medium", description: "Call a webhook or API from this server.", fields: [
      { name: "url", type: "string", optional: false, enum: null, default: null },
      { name: "method", type: "string", optional: true, enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"], default: null },
      { name: "body", type: "string", optional: true, enum: null, default: null },
      { name: "credentialName", type: "string", optional: true, enum: null, default: null },
    ] },
  ],
}));
api.get("/schedules", (_request, response) => json(response, { schedules: [
  { id: "s1", operationId: "app.backup", parameters: { subject: "immich" }, frequency: "daily", minute: 0, hour: 3, weekday: null, enabled: true, createdBy: "owner-demo", createdAt: ago(200), nextDueAt: ago(-8), lastRunAt: ago(16) },
  { id: "s2", operationId: "backup.cloud.sync", parameters: {}, frequency: "daily", minute: 30, hour: 4, weekday: null, enabled: true, createdBy: "owner-demo", createdAt: ago(200), nextDueAt: ago(-7), lastRunAt: ago(26), lastJobId: "d3", lastResult: "started" },
  { id: "s3", operationId: "apt.refresh", parameters: {}, frequency: "weekly", minute: 0, hour: 5, weekday: 0, enabled: true, createdBy: "owner-demo", createdAt: ago(400), nextDueAt: ago(-60), lastRunAt: ago(108), lastJobId: "j2", lastResult: "started" },
  { id: "s4", operationId: "app.vpn.killswitch.drill", parameters: { subject: "qbittorrent" }, frequency: "weekly", minute: 0, hour: 4, weekday: 0, enabled: true, overdue: false, title: "Prove the kill switch", cadence: "weekly on Sunday at 04:00", createdBy: "owner-demo", createdAt: ago(400), nextDueAt: ago(-90), lastRunAt: ago(60), lastResult: "completed" },
] }));
api.get("/system/update", (_request, response) => json(response, { current: { version: productVersion, tag: `v${productVersion}` }, latest: { tag: `v${productVersion}`, version: productVersion, publishedAt: ago(30), url: "https://github.com/AES256Afro/BoxPilot/releases" }, updateAvailable: false, checkedAt: now().toISOString(), error: null }));
api.get("/power/ups/detect", (_request, response) => json(response, { devices: [{ vendorId: "051d", productId: "0002", manufacturer: "American Power Conversion", product: "Back-UPS ES 700G", driver: "usbhid-ups", confidence: "vendor-id", sysfs: "1-3" }], nutInstalled: true }));
api.get("/firewall/overview", (_request, response) => json(response, {
  report: firewallReport, reportError: null, web: { port: 8787, lanExposed: false }, protected: protectedRules({ webPort: 8787, webHost: "127.0.0.1" }), profiles, services, riskyPorts, current: firewallProfile,
  advice: adviseFirewall({ report: firewallReport, listeners, apps: [{ id: "immich", name: "Immich", ports: [{ port: 2283, protocol: "tcp", label: "Web UI and mobile app" }] }], current: firewallProfile, fail2ban, webPort: 8787, webHost: "127.0.0.1" }),
}));
api.get("/firewall/plan", (request, response) => json(response, buildPlan({ profileId: request.query.profile ?? "home-server", serviceIds: typeof request.query.services === "string" && request.query.services ? request.query.services.split(",") : [], replace: request.query.replace === "true", sshRateLimit: request.query.sshRateLimit === "true", webPort: 8787, webHost: "127.0.0.1" })));
api.get("/storage/overview", (_request, response) => json(response, storageOverview));
api.get("/storage/forecast", (_request, response) => json(response, { tracking: 2, forecasts: [
  { target: "/mnt/media", daysToFull: 11, availableBytes: 214 * 1024 ** 3, totalBytes: 4000 * 1024 ** 3, samples: 14 },
  { target: "/", daysToFull: 63, availableBytes: 41 * 1024 ** 3, totalBytes: 234 * 1024 ** 3, samples: 14 },
] }));
api.get("/storage/shares/discover", (_request, response) => json(response, { devices: [{ address: "192.168.50.30", name: "nas.local", smb: true, nfs: true, mac: "02:00:00:aa:00:30", interface: "eno1" }], scanned: 253, interfaces: ["eno1 192.168.50.20/24"] }));
api.get("/storage/samba", (_request, response) => json(response, { installed: true, running: true, configured: true, error: null, config: { managed: true, workgroup: "WORKGROUP", scope: "tailscale", interfaces: ["lo", "tailscale0"], shares: [{ name: "Media", path: "/mnt/media", comment: "Films and series", readOnly: true, guest: true, users: [], forceUser: host.owner, ownerUid: 1000 }, { name: "Documents", path: "/srv/documents", comment: null, readOnly: false, guest: false, users: [host.owner, "sam"], forceUser: host.owner, ownerUid: 1000, recycle: true, recycleBytes: 2415919104 }] }, users: [host.owner, "sam"], tailscaleDnsName: host.tailnet, tailscaleAddress: host.tailscaleIp, lanAddress: host.lan, discovery: { installed: false, running: false } }));
api.get("/storage/nfs", (_request, response) => json(response, { installed: true, running: false, configured: false, error: null, config: { managed: false, scope: "tailscale", exports: [] }, tailscaleDnsName: host.tailnet, tailscaleAddress: host.tailscaleIp, lanAddress: host.lan }));
api.get("/people", (_request, response) => json(response, { people: [{ id: "owner-demo", username: host.owner, role: "owner", createdAt: ago(900) }, { id: "p2", username: "sam", role: "viewer", createdAt: ago(300) }] }));
// The Repair page's problem sweep. The trouble world shows the failure that actually happened:
// a USB drive that came back under a new name, leaving the mount pointing at nothing.
api.get("/remediations", (request, response) => {
  const world = scenarioOf(request.get("referer"));
  if (world !== "trouble") return json(response, { findings: [], counts: { critical: 0, warning: 0, info: 0 }, checkedAt: now().toISOString() });
  return json(response, {
    checkedAt: now().toISOString(),
    counts: { critical: 1, warning: 2, info: 2 },
    findings: [
      { id: "stale-mount:media", severity: "critical", title: "/mnt/media is mounted from a drive that is gone",
        detail: "The mount still points at /dev/sda2, which no longer exists - the drive was disconnected and came back under a different name. Anything reading this folder gets an error or sees it empty, including network shares and any app that uses it.",
        evidence: ["mounted from /dev/sda2", "/dev/sda2 is not a device on this server", "16 TiB filesystem"],
        fix: { operationId: "storage.remount", parameters: { name: "media" }, label: "Reconnect the drive", preview: "Detaches the dead mount at /mnt/media and mounts it again from fstab, which finds the drive by its UUID wherever the kernel has put it. Nothing on the drive is touched." }, manual: null },
      { id: "stale-bind:bp-jellyfin", severity: "warning", title: "bp-jellyfin is still using the old copy of that folder",
        detail: "Docker attaches a folder when the container starts, so this one is still looking at the filesystem that was mounted then, not the one that is there now. It needs restarting before it sees the files again.",
        evidence: ["bp-jellyfin uses /mnt/media"],
        fix: { operationId: "app.action", parameters: { id: "jellyfin", action: "restart" }, label: "Restart bp-jellyfin", preview: "Restarts bp-jellyfin so it picks up the folder as it is mounted now. Its data and settings are untouched." }, manual: null },
      { id: "app-folder:qbittorrent", severity: "warning", title: "qBittorrent cannot write to its data folder",
        detail: "/srv/media is owned by user root, while the app runs as user 1000. Downloads, uploads, and anything else this app saves there will fail without saying why.",
        evidence: ["Media folder: /srv/media", "owned by user root, while the app runs as user 1000"],
        fix: { operationId: "app.reconfigure", parameters: { id: "qbittorrent", values: {} }, label: "Fix folder access", preview: "Redeploys qBittorrent with its current settings; the deploy hands its data folders to the user the app runs as. Nothing else changes." }, manual: null },
      { id: "split-data-folders", severity: "info", title: "Your apps are saving to different drives",
        detail: "These apps were each given a folder to work in, but on different drives, so none of them can see what the others write. That is fine if it was deliberate; it is the usual reason a download appears nowhere and a library stays empty.",
        evidence: ["qBittorrent uses /srv/media on /", "Jellyfin uses /mnt/media on /mnt/media"],
        fix: null, manual: "If they are meant to share files, point them at folders on the same drive from each app's Settings, and move any existing files across first." },
      { id: "windows-discovery", severity: "info", title: "Windows will not list this server under Network",
        detail: "Windows finds file servers with WS-Discovery, which Samba does not answer. The shares work if you type the address; they just never appear on their own.",
        evidence: ["sharing on the LAN", "wsdd is not running"],
        fix: { operationId: "samba.discovery.set", parameters: { enabled: true }, label: "Show it in Windows", preview: "Installs wsdd, runs it, and allows the two discovery ports (3702/udp, 5357/tcp) so File Explorer lists this server. Shares and permissions are unchanged." }, manual: null },
    ],
  });
});
api.get("/catalog", async (request, response) => {
  const { manifests, problems } = await loadCatalog();
  const present = installedFor(scenarioOf(request.get("referer")));
  json(response, {
    applications: manifests.map((manifest) => {
      const port = present[manifest.id];
      const live = { id: manifest.id, installed: Boolean(port), dataPresent: Boolean(port), state: port ? { installedAt: ago(19 * 24), updatedAt: ago(50), manifestSha256: manifest.sha256, image: { reference: manifest.image.reference, id: "sha256:demo" }, values: { ports: {}, env: {}, volumes: {}, setup: [] }, pinnedRollback: false, uninstalledAt: null } : null, container: port ? { exists: true, running: true, status: manifest.id === "open-webui" ? "paused" : "running", health: manifest.health.kind === "healthcheck" ? "healthy" : "none", restarts: 0, image: "sha256:demo" } : { exists: false, running: false, status: "absent", health: "none", restarts: 0, image: null }, sidecars: port ? (manifest.sidecars ?? []).map((entry) => ({ id: entry.id, running: true, status: "running", restarts: 0 })) : [], urls: port ? manifest.ports.filter((entry) => entry.protocol === "tcp").map((entry) => ({ id: entry.id, label: entry.label, host: entry.host, exposure: entry.exposure })) : [], updateAvailable: manifest.id === "jellyfin", installedImage: port ? manifest.image.reference : null, backupVerification: port && manifest.id === "jellyfin" ? { verified: true, backup: "20260825T031400Z.tar.gz", reason: null, checkedAt: ago(11), history: [{ verified: true, backup: "20260825T031400Z.tar.gz", reason: null, checkedAt: ago(11) }, { verified: true, backup: "20260818T031400Z.tar.gz", reason: null, checkedAt: ago(11 + 168) }, { verified: false, backup: "20260811T031400Z.tar.gz", reason: "The archive could not be unpacked: unexpected end of file", checkedAt: ago(11 + 336) }] } : null };
      return { manifest, live };
    }),
    problems, liveError: null, host: { lanAddress: host.lan, tailscaleDnsName: host.tailnet },
  });
});
/**
 * The demo has always served one world: everything installed, every list populated, every
 * connection healthy. That is the world least likely to break, and it is the only one anybody ever
 * looked at — so the states that actually shipped broken were the empty ones and the failed ones.
 * A form nobody could submit, a Logs page with no groups, a dialog whose list was absent: each
 * rendered fine here because here it was never empty.
 *
 * So there are three worlds now, chosen by `?scenario=` on the page URL and read back off the
 * Referer header, which means no interface change and one scenario per tab:
 *
 *   default  — a lived-in server, as before
 *   fresh    — the first ten minutes: nothing installed, nothing connected, every list empty
 *   trouble  — installed but unwell: unreachable, refused, failed, absent
 *
 * Each scenario is a shallow patch over the default table, so a fixture only appears here when the
 * state is genuinely different. `npm run demo:sweep` walks every page in every scenario.
 */
export const scenarioNames = ["default", "fresh", "trouble"];

/**
 * The empty world is derived from the lived-in one rather than written out by hand. Hand-written
 * fixtures are guesses about the server's shape, and a guess that is wrong teaches every test that
 * reads it the wrong thing — which is the fault this whole exercise exists to close. Emptying keeps
 * every key exactly where it was and takes the contents out: lists become empty, numbers zero,
 * flags false. Strings are left alone because they are labels, ids and enums, and a page that
 * switches on one should still get something it recognises.
 */
export function emptied(value) {
  if (Array.isArray(value)) return [];
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, emptied(inner)]));
  if (typeof value === "number") return 0;
  if (typeof value === "boolean") return false;
  return value;
}

/** The words that only appear when there is nothing to show, which emptying cannot invent. */
const freshWords = {
  // The rebuild persona: a fresh box with the old server's backup drive already mounted. This is
  // what makes the Overview's "Rebuilding this server?" card reviewable.
  "host.snapshot.discover": { locations: [
    { root: "/mnt/backup-drive/boxpilot-local-mirror/machine-snapshots", mount: { target: "/mnt/backup-drive", source: "//nas.local/backups", filesystem: "cifs" },
      snapshots: [{ artifact: "machine-snapshot-20260820T020000Z-9f3c1a77.tar.gz", sizeBytes: 184320, createdAt: ago(30), checksumSha256: "b".repeat(64), apps: 11 }] },
  ] },
  "app.models.inspect": { available: false, reason: "No model runner is installed.", models: [] },
  "dns.names.inspect": { available: false, reason: "No DNS server BoxPilot can write to is installed. Install Pi-hole from the App catalog.", platform: null, records: [], apps: [] },
  "router.inspect": { configured: false, reachable: false, host: null, username: null, model: null, firmware: null, reason: "No router is connected yet." },
  "router.leases": { host: null, leases: [] },
};

/**
 * Installed but unwell. Not an emptier server, a working one where the things that reach outside it
 * have stopped reaching: a share that will not mount, a credential the far end refuses, a unit that
 * failed, a disk about to fill. This is where the copy has to say what to do about it, and it is
 * the state nobody could look at before, because the demo only ever had a healthy server in it.
 */
const troubleWords = {
  "router.inspect": { configured: true, reachable: false, host: "192.168.1.1", username: "root", model: null, firmware: null,
    reason: 'The router did not accept that password for "root". This is the password for the router\'s own admin page, which is often not the same as any other password on this network.' },
  // Pi-hole is installed but its container is stopped, so the names it serves have gone with it.
  "dns.names.inspect": { available: true, reason: null, platform: { id: "pi-hole", label: "Pi-hole", running: false }, records: [] },
  "dns.blocker.clients": { available: true, reason: null, platform: { id: "pi-hole", label: "Pi-hole", running: true }, clients: [], self: 9 },
  "app.serve.inspect": { available: false, serves: [] },
  "dns.blocker.verify": { address: "192.168.1.10", answering: true, resolving: false, blocking: true, intercepted: true, interceptorBlocking: false,
    control: { domain: "example.com", addresses: [], error: "ESERVFAIL" },
    probe: { domain: "doubleclick.net", addresses: ["0.0.0.0"], error: null },
    reason: "Something between this server and the internet is answering every DNS query itself, including ones sent to addresses that cannot run a resolver. A recursive resolver cannot work through that, which is why lookups fail, and it also means devices on your network reach that thing rather than this blocker no matter what your router hands out. The setting is usually on the router, named something like \"Override DNS Settings of All Clients\", \"Force DNS\" or \"DNS Redirect\", and routers that run a blocker of their own (AdGuard Home, for instance) often switch it on. Turn it off to use this blocker, or keep the one on the router and leave this one to the apps on this server." },
  // The key exists but the far end has never been vouched for, so a mirror would refuse to run.
  "backup.remote.inspect": { keyReady: true, hostKeysPinned: 0, rsyncInstalled: false },
  "backup.cloud.inspect": { configured: true, provider: "b2" },
  "host.snapshot.inspect": { sync: { destination: "/mnt/boxpilot-backup/boxpilot-local-mirror", mount: { mounted: false, freeBytes: 0 }, lastSync: null } },
  "host.snapshot.sources": { mount: { mounted: false, blocker: "The backup drive is not mounted. Mount it from the Storage page." } },
  "host.snapshot.discover": { locations: [], unanswered: [{ target: "/mnt/backup-drive", source: "//nas.local/backups", error: "EIO" }] },
  "service.list": { counts: { total: 134, active: 88, failed: 3 }, units: [
    { unit: "docker.service", description: "Docker Application Container Engine", load: "loaded", active: "active", sub: "running", enabled: "enabled", guarded: null, critical: true },
    { unit: "smbd.service", description: "Samba SMB Daemon", load: "loaded", active: "failed", sub: "failed", enabled: "enabled", guarded: null, critical: false },
    { unit: "nut-monitor.service", description: "Network UPS Tools monitor", load: "loaded", active: "failed", sub: "failed", enabled: "enabled", guarded: null, critical: false },
  ] },
  // Password sign-in left on with a root login allowed is the shape of a server that gets found.
  "users.inspect": { sshd: { passwordAuthentication: true, keyboardInteractive: false, pubkeyAuthentication: true, permitRootLogin: "yes", port: 22 } },
  "logs.sources": { dockerAvailable: false, containers: [] },
  "canary.verify": { ok: false },
  "app.models.inspect": { id: "open-webui", available: false, reason: "Open WebUI + Ollama is paused. Resume it to see its models", models: [] },
  "housekeeping.inspect": { totalBytes: 41 * GiB },
};

/** The same server, described by the routes that report what it can currently reach. */
const troubleRest = {
  "/jobs": (body) => ({ jobs: body.jobs.map((job, index) => (index === 0
    ? { ...job, state: "failed", error: "rsync: connection unexpectedly closed by nas.local" }
    : job)) }),
  // A mirror that keeps failing does not record an error anywhere; it just stops being recent,
  // which is the thing the interface has to notice on the owner's behalf.
  "/settings/backup-destination": (body) => ({ ...body, lastSync: { ...body.lastSync, completedAt: ago(24 * 34) } }),
  "/storage/overview": (body) => ({ ...body, shares: body.shares.map((share) => ({ ...share, mounted: false })) }),
  "/virtualization/status": (body) => ({ ...body, ready: false, checks: body.checks.map((check, index) => (index === 0
    ? { ...check, ok: false, detail: "/dev/kvm is not present; this machine has no hardware virtualization, or it is switched off in the BIOS" }
    : check)) }),
  "/firewall/overview": (body) => ({ ...body, report: { ...body.report, enabled: false } }),
  "/flows": (body) => ({ ...body, flows: body.flows.map((flow, index) => (index === 0
    ? { ...flow, lastResult: "stopped at step 3 (Install package updates): apt-get upgrade failed: E: Could not get lock /var/lib/dpkg/lock-frontend" }
    : flow)) }),
  // In the unwell world the doctor finds what the owner would: the LAN side dropped by a firewall.
  "/operations/app.reachability.inspect/run": (body) => ({ ...body, result: { ...body.result, addresses: (body.result.addresses ?? []).map((address) => (address.kind === "lan"
    ? { ...address, outcome: "timeout", status: undefined, ms: 4000, verdict: "The connection was silently dropped, which is what a firewall in the path looks like. The probe ran from the server itself, so the block is on this machine or inside the app's own network." }
    : address)) } }),
  // The failed flow's third step, opened from "What the last run did", must agree with the story.
  // Installed but unwell includes an app whose helper container is looping: the card must say
  // so instead of a green Running. Immich's database sidecar plays the patient.
  "/catalog": (body) => ({ ...body, applications: body.applications.map((entry) => (entry.manifest.id === "immich" && entry.live?.installed && (entry.live.sidecars ?? []).length
    ? { ...entry, live: { ...entry.live, sidecars: entry.live.sidecars.map((sidecar, index) => (index === 0 ? { ...sidecar, running: true, status: "restarting", restarts: 4 } : sidecar)) } }
    : entry.manifest.id === "qbittorrent" && entry.live?.installed
      ? { ...entry, live: { ...entry.live, folderProblems: [{ path: "/srv/media", volume: "Media folder", reason: "owned by user root, while the app runs as user 1000" }] } }
      : entry)) }),
  "/jobs/j3": (body) => ({ ...body, job: { ...body.job, state: "failed", error: "apt-get upgrade failed: E: Could not get lock /var/lib/dpkg/lock-frontend" } }),
  "/jobs/j3/output": (body) => ({ ...body, output: "Reading package lists...\nE: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 41283 (unattended-upgr)\nE: Unable to acquire the dpkg frontend lock\n" }),
  "/storage/samba": (body) => ({ ...body, running: false }),
};

const patch = (base, words) => Object.fromEntries(Object.entries(base).map(([id, value]) => [id, words[id] ? { ...value, ...words[id] } : value]));

export { app, freshRest, troubleRest };
export const scenarios = {
  default: {},
  fresh: patch(Object.fromEntries(Object.entries(inspections).map(([id, value]) => [id, emptied(value)])), freshWords),
  // Trouble keeps the lived-in data and spoils the connections, which is what actually goes wrong.
  trouble: patch(inspections, troubleWords),
};

/** Which world a request belongs to, taken from the page that made it. */
export function scenarioOf(referer) {
  const name = (() => { try { return new URL(String(referer ?? "")).searchParams.get("scenario"); } catch { return null; } })();
  return scenarioNames.includes(name) ? name : "default";
}
export const fixturesFor = (name) => ({ ...inspections, ...(scenarios[name] ?? {}) });

api.get("/operations", (_request, response) => json(response, { operations: [], riskTiers: ["low", "medium", "high"] }));
const demoPrerequisites = [
  { id: "helper.boundary", group: "BoxPilot", name: "Root helper", status: "ready", summary: "Answering on its socket, running the pinned release.", repair: null },
  { id: "docker", group: "Applications", name: "Docker Engine", status: "ready", summary: "28.0.0 installed, service active.", repair: null },
  { id: "smartmontools", group: "Disks", name: "smartmontools", status: "ready", summary: "7.4 installed; the disk-health timer is running.", repair: null },
  { id: "restic", group: "Backups", name: "restic", status: "ready", summary: "0.17.3 installed.", repair: null },
  { id: "rsync", group: "Backups", name: "rsync", status: "missing", summary: "Not installed. Mirroring backups to another machine needs it.", repair: { kind: "approved", description: "Installs rsync from Ubuntu's repositories." } },
  { id: "virtualization", group: "Virtual machines", name: "QEMU/KVM and libvirt", status: "ready", summary: "Hardware virtualization available; libvirtd active.", repair: null },
  { id: "apt-metadata", group: "Updates", name: "Package lists", status: "ready", summary: "Refreshed 4 hours ago.", repair: null },
];
api.get("/operations/prerequisites", (_request, response) => json(response, { generatedAt: now().toISOString(), checks: demoPrerequisites, counts: { ready: 6, repairable: 1, missing: 1, conflict: 0 }, ready: false }));

// The Repair page's other two panels. Without these the demo showed two "unavailable" notices,
// which reads as a broken page rather than as the feature it is meant to be showing.
api.get("/operations/recovery-kit", (_request, response) => json(response, {
  schemaVersion: 2, generatedAt: ago(2), product: { name: "BoxPilot", version: productVersion }, mode: "secret-free-readiness-and-runbook",
  summary: { status: "operator-checks-required", verified: 4, actionRequired: 0, operatorChecks: 2, notApplicable: 0, total: 6 },
  checks: [
    { id: "controller.database", state: "verified", title: "Restore BoxPilot's own database", evidence: "3 backups, newest 6 hours old, each checked by restoring the copy.", action: "Keep a copy somewhere that is not this machine." },
    { id: "controller.source", state: "operator-check", title: "Get the server back", evidence: "No copy of this BoxPilot release is recorded outside this server.", action: "Keep the release and your Ubuntu setup notes somewhere else." },
    { id: "host.snapshot", state: "verified", title: "Restore the machine snapshot", evidence: "Machine snapshot from 2 days ago, 1.2 GiB, verified.", action: "Refresh it after any big change." },
    { id: "applications.backup", state: "operator-check", title: "Restore each app's data", evidence: "5 of 7 installed apps have a backup; 2 have never been backed up.", action: "Back up the two without one, then rehearse weekly." },
    { id: "virtualization.backup", state: "verified", title: "Restore virtual machines", evidence: "2 VMs with encrypted copies and passing restore drills.", action: "Repeat the drills now and then." },
    { id: "host.prerequisites", state: "verified", title: "Check it, then make a new kit", evidence: "7 checks reported; 1 optional tool missing.", action: "Re-run before any recovery work." },
  ],
  evidence: { jobs: [], controllerBackups: [{ id: "b1" }, { id: "b2" }, { id: "b3" }], controllerProtections: [{ id: "p1" }], controllerRetentionRuns: [{ id: "r1" }], applications: [{ id: "jellyfin" }, { id: "plex" }], virtualMachines: [{ name: "buildbox" }], vmBackups: [{ id: "v1" }, { id: "v2" }], prerequisites: demoPrerequisites },
  runbookMarkdown: "# BoxPilot recovery runbook\n\n1. Get the server back\n2. Get back in privately\n3. Restore BoxPilot's own database\n4. Restore the machine snapshot\n5. Restore each app's data\n6. Restore virtual machines\n7. Check it, then make a new kit\n",
}));

api.get("/operations/action-center", (_request, response) => json(response, {
  generatedAt: ago(2), sourceStatus: "ready", summary: { critical: 0, warning: 2, info: 0, total: 2 },
  notices: [
    { id: "recovery.controller.source", severity: "warning", category: "If this server died", title: "Get the server back",
      summary: "Keep the release and your Ubuntu setup notes somewhere else.",
      evidence: ["No copy of this BoxPilot release is recorded outside this server."],
      recommendation: { view: "github", title: "Open GitHub", steps: ["Keep a copy of the BoxPilot version you are running somewhere other than this server.", "Keep the notes for setting Ubuntu up again beside it, so a rebuild does not start from memory.", "The GitHub page shows which release this is, so you can check the copy you kept matches."] },
      boundary: { mutationPerformed: false, automaticFixAvailable: false, commandsIncluded: false, secretsIncluded: false, logsIncluded: false } },
    { id: "recovery.applications.backup", severity: "warning", category: "Apps with no backup", title: "Restore each app's data",
      summary: "Back up the two without one, then rehearse weekly.",
      evidence: ["5 of 7 installed apps have a backup; 2 have never been backed up."],
      recommendation: { view: "catalog", title: "Open Catalog", steps: ["Open the App catalog. Each card says whether that app has ever been backed up.", "Back it up from the card, then use Rehearse weekly so a broken backup does not stay unnoticed.", "Mirror the backups off this server from the Backups page."] },
      boundary: { mutationPerformed: false, automaticFixAvailable: false, commandsIncluded: false, secretsIncluded: false, logsIncluded: false } },
  ],
  boundary: { mutationPerformed: false, automaticRepair: false, persistence: false, browserNotifications: false, externalDelivery: false, credentialsIncluded: false, arbitraryLogsIncluded: false },
}));
api.get("/operations/:id/inspect", (request, response) => {
  const result = fixturesFor(scenarioOf(request.get("referer")))[request.params.id];
  if (!result) return response.status(404).json({ error: "Not in the demo", code: "demo_missing" });
  return json(response, { operation: request.params.id, result });
});
// Read-only operations answer from the same fixtures the inspect route uses, so anything the UI
// reads through /run (which is how it passes parameters) behaves here too.
api.post("/operations/:id/run", (request, response) => json(response, { operation: request.params.id, result: fixturesFor(scenarioOf(request.get("referer")))[request.params.id] ?? {} }));
api.post("/operations/:id/jobs", (request, response) => response.status(201).json({ job: { id: "demo-job", type: `op:${request.params.id}`, title: request.params.id, state: "awaiting_approval", risk: "medium", error: null, result: null, steps: [], approvals: [], createdAt: now().toISOString() }, approval: { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", reason: "demo: jobs never run here" } }));
api.all("/{*rest}", (_request, response) => response.status(404).json({ error: "Not part of the demo", code: "demo_missing" }));
app.use("/api/v1", api);
app.use(express.static(dist, { index: false }));
/**
 * The page is served with a small bar naming the world it is in, so the empty and broken states are
 * something you can click to rather than a query parameter you have to know about. It is appended
 * to the demo's own copy of the page and never reaches a real build.
 */
export const switcher = (current) => `<style>
  #demo-worlds { position: fixed; bottom: 0; left: 0; right: 0; z-index: 2147483647; display: flex; gap: .5rem; align-items: center;
    padding: .4rem .75rem; font: 500 12px/1.5 ui-sans-serif, system-ui, sans-serif; color: #cbd5e1;
    background: #0b1220ee; border-top: 1px solid #1e293b; backdrop-filter: blur(6px); }
  #demo-worlds b { color: #94a3b8; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; font-size: 11px; }
  #demo-worlds a { color: #cbd5e1; text-decoration: none; padding: .2rem .55rem; border-radius: 999px; border: 1px solid #1e293b; }
  #demo-worlds a[data-current="true"] { background: #34d399; border-color: #34d399; color: #04231a; }
  #demo-worlds span { color: #64748b; margin-left: auto; }
</style>
<div id="demo-worlds"><b>Demo world</b>${scenarioNames.map((name) => {
  const description = { default: "a lived-in server", fresh: "nothing set up yet", trouble: "installed but unwell" }[name];
  return `<a href="#" data-world="${name}" data-current="${name === current}" title="${description}">${name}</a>`;
}).join("")}<span>Fictional data. Nothing here touches a real machine.</span></div>
<script>
  document.getElementById("demo-worlds").addEventListener("click", (event) => {
    const chosen = event.target.closest("[data-world]");
    if (!chosen) return;
    event.preventDefault();
    const url = new URL(window.location.href);
    chosen.dataset.world === "default" ? url.searchParams.delete("scenario") : url.searchParams.set("scenario", chosen.dataset.world);
    window.location.assign(url);
  });
</script>`;

const indexHtml = await readFile(path.join(dist, "index.html"), "utf8");
app.get("/{*rest}", (request, response) => {
  const current = scenarioNames.includes(request.query.scenario) ? request.query.scenario : "default";
  response.type("html").send(indexHtml.replace("</body>", `${switcher(current)}</body>`));
});
// Only when run directly: importing this module for its fixtures must not start a server.
if (import.meta.main) app.listen(port, "127.0.0.1", () => console.log(`BoxPilot demo (${productVersion}) with fictional data at http://127.0.0.1:${port}`));
