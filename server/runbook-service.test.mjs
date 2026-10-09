// @vitest-environment node
/**
 * The runbook service (M34.4): the facts come from the services BoxPilot already has, every stored
 * parameter set is masked before anything is read from it, and the out-of-date check needs nothing
 * but BoxPilot's own records. Host details are placeholders.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createStateStore } from "./state.mjs";
import { createRunbookService, diskFor, mountFor, runbookSettingKey } from "./runbook-service.mjs";
import { createRunbookRouter } from "./routes/runbook.mjs";

const sentinel = "SENTINEL-4d1e-never-print";
const directories = [];
const stores = [];
afterEach(async () => {
  // Close each database before its directory goes: Windows will not unlink an open SQLite file.
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const jellyfin = {
  id: "jellyfin", name: "Jellyfin", category: "Media", description: "Stream your films and music to any screen",
  image: { reference: "jellyfin/jellyfin:10.10.7", version: "10.10.7" }, network: "bridge",
  ports: [{ id: "web", label: "Web interface", container: 8096, host: 8096, protocol: "tcp", exposure: "lan", tailnet: "serve" }],
  volumes: [
    { id: "config", label: "Configuration", container: "/config", path: "config", hostPath: null, backup: true, readOnly: false, configurable: false },
    { id: "media", label: "Media library", container: "/media", path: null, hostPath: "/srv/media", backup: false, readOnly: true, configurable: true },
    { id: "socket", label: "Docker socket", container: "/var/run/docker.sock", path: null, hostPath: "/var/run/docker.sock", backup: false, readOnly: true, configurable: false },
  ],
  env: [{ name: "JELLYFIN_ADMIN_PASSWORD", type: "password", secret: true }, { name: "PUBLISHED_URL", type: "string", secret: false }],
  signIn: { passwordEnv: "JELLYFIN_ADMIN_PASSWORD", note: null },
  sidecars: [],
};

function answersFor() {
  return {
    "app.inspect": () => ({
      catalogRoot: "/var/lib/boxpilot-managed/catalog",
      applications: [
        { id: "jellyfin", installed: true, container: { exists: true, running: true, status: "running", health: "none" }, state: { image: { reference: "jellyfin/jellyfin:10.10.7" }, values: { ports: { web: 8096 }, env: { JELLYFIN_ADMIN_PASSWORD: sentinel, PUBLISHED_URL: "https://jellyfin.example" }, volumes: { media: "/mnt/media/library" } } } },
        { id: "plex", installed: false },
      ],
    }),
    "app.backup.protection": () => ({ available: true, apps: [{ id: "jellyfin", protectable: true, backups: 2, newestAt: "2026-09-28T03:00:00.000Z" }] }),
    "app.backups.inspect": ({ id }) => ({ id, directory: `/var/lib/boxpilot-managed/backups/catalog/${id}`, backups: [{ artifact: "20260928T030000Z.tar.gz", createdAt: "2026-09-28T03:00:00.000Z" }, { artifact: "20260927T030000Z.tar.gz", createdAt: "2026-09-27T03:00:00.000Z" }] }),
    "app.serve.inspect": () => ({ available: true, serves: [{ dnsName: "homeserver.example.ts.net", port: 8096, target: "http://127.0.0.1:8096" }] }),
    "firewall.inspect": () => ({ installed: true, enabled: true, defaults: { incoming: "deny", outgoing: "allow", routed: "deny" }, rules: [{ action: "allow", protocol: "tcp", port: 22, app: null, direction: "in", interface: null, comment: "SSH", family: "both" }] }),
    "host.snapshot.inspect": () => ({
      snapshotRoot: "/var/lib/boxpilot-managed/machine-snapshots", keep: 3,
      snapshots: [{ artifact: "machine-snapshot-20260927T010000Z-0a1b2c3d.tar.gz", createdAt: "2026-09-27T01:00:00.000Z" }],
      sync: { destination: "/mnt/boxpilot-backup/boxpilot-local-mirror", mount: { mounted: true, target: "/mnt/boxpilot-backup" }, lastSync: { completedAt: "2026-09-28T04:00:00.000Z" } },
    }),
    "samba.inspect": () => ({ configured: true, config: { shares: [{ name: "media", path: "/mnt/media/library" }] } }),
  };
}

const storage = {
  availability: { devices: true, mounts: true, fstab: true },
  devices: [
    { path: "/dev/nvme0n1", type: "disk", depth: 0, model: "Example NVMe", transport: "nvme" },
    { path: "/dev/nvme0n1p2", type: "part", depth: 1, uuid: "00000000-0000-4000-8000-00000000000a" },
    { path: "/dev/sdb", type: "disk", depth: 0, model: "Example Disk 4TB", transport: "usb" },
    { path: "/dev/sdb1", type: "part", depth: 1, uuid: "00000000-0000-4000-8000-000000000001" },
  ],
  mounts: [
    { target: "/", source: "/dev/nvme0n1p2", fstype: "ext4", sizeBytes: 5e11, availableBytes: 2e11, readOnly: false },
    { target: "/mnt/media", source: "/dev/sdb1", fstype: "ext4", sizeBytes: 4e12, availableBytes: 1e12, readOnly: false },
  ],
  fstab: [
    { device: "UUID=00000000-0000-4000-8000-00000000000a", mountpoint: "/", fstype: "ext4", options: "defaults", managedName: null },
    { device: "UUID=00000000-0000-4000-8000-000000000001", mountpoint: "/mnt/media", fstype: "ext4", options: "defaults,nofail", managedName: "media" },
  ],
  shares: [],
};

async function setup({ version = "9.9.9-test", answers = answersFor(), failing = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-runbook-"));
  directories.push(directory);
  const clock = { at: new Date("2026-09-28T10:00:00.000Z") };
  const now = () => clock.at;
  const state = createStateStore({ stateDirectory: directory, now });
  stores.push(state);
  const owner = state.consumeBootstrapToken(state.createBootstrapToken().token, { username: "owner", passwordHash: "not-a-real-hash" });
  const operator = state.createOwnerAccount({ username: "operator", passwordHash: "not-a-real-hash", role: "operator", createdBy: owner.id });
  const calls = [];
  const helper = {
    request: async (operation, parameters) => {
      calls.push(operation);
      if (failing || !answers[operation]) throw new Error(`helper unavailable ${sentinel}`);
      return answers[operation](parameters);
    },
  };
  const fail = async () => { throw new Error(`unavailable ${sentinel}`); };
  const service = (overrides = {}) => createRunbookService({
    store: state, helper, now, version,
    catalogService: { all: failing ? fail : async () => ({ manifests: [jellyfin], problems: [] }), get: async (id) => (id === "jellyfin" ? jellyfin : null) },
    secretEnvNamesFor: async (id) => (id === "jellyfin" ? ["JELLYFIN_ADMIN_PASSWORD"] : null),
    inventory: { inspect: failing ? fail : async () => ({ host: { hostname: "homeserver", operatingSystem: "Ubuntu 24.04 LTS", kernel: "6.8.0-generic", architecture: "x64" }, network: {}, storage: { smart: { available: true, status: "healthy", generatedAt: "2026-09-28T02:00:00.000Z", disks: [{ device: "/dev/nvme0n1", health: "healthy" }] } } }) },
    network: { inspect: failing ? fail : async () => ({ eligibleLanAddresses: [{ interface: "eth0", address: "192.0.2.10" }], tailscale: { connected: true, dnsName: "homeserver.example.ts.net", address: "100.64.0.10", advertisedRoutes: [], exitNodeAdvertised: false } }) },
    collect: failing ? fail : async () => storage,
    readTls: async () => ({ provisioned: false, port: 8443 }),
    notifications: { describe: () => ({ configured: false }) },
    autoReconnect: { status: () => ({ drives: { media: { flowId: "f1", enabled: true, held: false } } }) },
    webHost: "0.0.0.0", webPort: 8787,
    ...overrides,
  });

  // BoxPilot's own records, with secrets planted where a careless reader would find them.
  const due = "2026-09-29T03:00:00.000Z";
  state.createSchedule({ operationId: "app.backup", parameters: { id: "jellyfin", keep: 7 }, frequency: "daily", minute: 0, hour: 3, createdBy: owner.id, nextDueAt: due });
  state.createSchedule({ operationId: "backup.cloud.setup", parameters: { provider: "b2", bucket: "example-bucket", key: sentinel }, frequency: "weekly", minute: 0, hour: 4, weekday: 0, createdBy: operator.id, nextDueAt: due });
  state.createSchedule({ operationId: "http.request", parameters: { url: `https://hooks.example/${sentinel}`, body: sentinel }, frequency: "daily", minute: 15, hour: 6, createdBy: owner.id, nextDueAt: due });
  state.createSchedule({ operationId: "legacy.removed", parameters: { token: sentinel }, frequency: "hourly", minute: 5, createdBy: owner.id, nextDueAt: due });
  state.createFlow({ name: "Nightly", steps: [{ operationId: "http.request", parameters: { url: `https://push.example/${sentinel}` } }, { operationId: "app.install", parameters: { id: "jellyfin", values: { env: { JELLYFIN_ADMIN_PASSWORD: sentinel } } } }], createdBy: owner.id, frequency: "daily", minute: 30, hour: 2, nextDueAt: due });
  state.setSetting("backupDestination", { host: "backup.example", port: 2222, user: `mirror-${sentinel}`, path: "/srv/backups/homeserver" });
  state.setSetting("cloudDestination", { provider: "b2", account: sentinel, accessKeyId: sentinel, bucket: "example-bucket", path: "homeserver" });
  state.setSetting("vpnProfile", { provider: "example", openvpnUser: sentinel });
  state.setSetting("notifications", { kind: "ntfy", url: `https://ntfy.example/${sentinel}` });
  state.setSetting("firewallProfile", { id: "home-server", services: [], appliedAt: "2026-09-20T10:00:00.000Z", appliedBy: owner.id });
  state.setSetting("appBackupVerifications", { jellyfin: { verified: true, checkedAt: "2026-09-27T04:00:00.000Z", by: owner.id, history: [] } });
  state.setSetting("healthAlertsState", { "system.reboot": { title: "A reboot is required", since: "2026-09-26T00:00:00.000Z", notified: false } });
  const backupId = randomUUID();
  state.recordBackup({ id: backupId, applicationId: "boxpilot-controller", destination: "local-managed", artifactPath: `/var/lib/boxpilot-managed/backups/boxpilot-controller/${backupId}/boxpilot.sqlite3`, checksumSha256: "a".repeat(64), sizeBytes: 8192, downtimeMs: 0, restoreDrill: { passed: true }, createdBy: owner.id });
  state.recordControllerBackupProtection({ id: randomUUID(), backupId, destination: "mounted-restic-controller", repositoryId: "c".repeat(64), snapshotId: "2".repeat(64), sizeBytes: 8192, encrypted: true, independent: true, repositoryVerified: true, protected: true, restoreDrill: { passed: true }, createdBy: owner.id });
  return { state, service, owner, operator, clock, calls, answers };
}

describe("the runbook's facts", () => {
  it("come from the services BoxPilot already has, operator reads included", async () => {
    const { service, owner, calls } = await setup();
    const { markdown } = await service().preview({ role: "owner", callerId: owner.id });
    for (const read of ["app.inspect", "app.backup.protection", "app.backups.inspect", "app.serve.inspect", "firewall.inspect", "host.snapshot.inspect", "samba.inspect"]) expect(calls).toContain(read);
    for (const fact of [
      "- Hostname: `homeserver`",
      "- On your home network: http://192.0.2.10:8787 (any device on your network)",
      "- Database backups: `/var/lib/boxpilot-managed/backups/boxpilot-controller`",
      "- App backups (one folder per app): `/var/lib/boxpilot-managed/backups/catalog`",
      "  - Web interface: 8096/tcp, LAN; on the tailnet at https://homeserver.example.ts.net:8096",
      "  - Configuration: `/var/lib/boxpilot-managed/catalog/jellyfin/config`, managed by BoxPilot, in its backups; on the filesystem at `/`",
      "  - Media library: `/mnt/media/library`, a folder you chose, read-only, not in its backups; on drive `media` (`/mnt/media`)",
      "Scheduled daily at 03:00, keeping 7. Last restore drill 2026-09-27 04:00 UTC: passed.",
      "- `media` at `/mnt/media`: ext4 from `UUID=00000000-0000-4000-8000-000000000001`, on `/dev/sdb` (Example Disk 4TB, usb).",
      "Auto-reconnect: armed.\n  - Holds: Jellyfin: Media library (`/mnt/media/library`); the SMB share `media` (`/mnt/media/library`)",
      "- Another machine over SSH: at `backup.example:/srv/backups/homeserver`",
      "SSH port 2222.",
      "- Cloud storage (Backblaze B2): at `example-bucket/homeserver`",
      "- Backup drive: at `/mnt/boxpilot-backup/boxpilot-local-mirror`; last copy 2026-09-28 04:00 UTC.",
      "- Daily at 03:00: Back up application data (jellyfin), keeping 7. Not run yet.",
      "- **Nightly**: daily at 02:30. Steps: 1. Send an HTTP request; 2. Install application (jellyfin).",
    ]) expect(markdown).toContain(fact);
    // A socket is plumbing, not somewhere the app keeps data.
    expect(markdown).not.toContain("docker.sock");
  });

  it("mask every stored parameter set before anything is read from it", async () => {
    const { service } = await setup();
    const facts = await service().facts();
    const schedule = (operationId) => facts.automation.schedules.find((entry) => entry.operationId === operationId);
    expect(schedule("backup.cloud.setup").parameters.key).toBe("[secret]");
    expect(schedule("legacy.removed").parameters).toEqual({});
    expect(facts.automation.flows[0].steps[1].parameters.values.env.JELLYFIN_ADMIN_PASSWORD).toBe("[secret]");
    // The destinations keep their kind and path; the user and key ids beside them stay behind.
    expect(JSON.stringify(facts.backups.destinations)).not.toContain(sentinel);
    expect(JSON.stringify(facts.apps)).not.toContain(sentinel);
  });

  it("never let a secret into any copy of the document", async () => {
    const { service, owner, operator } = await setup();
    const runbook = service();
    const copies = [
      (await runbook.preview({ role: "owner", callerId: owner.id })).markdown,
      (await runbook.preview({ role: "operator", callerId: operator.id })).markdown,
      (await runbook.download({ callerId: owner.id })).markdown,
    ];
    for (const markdown of copies) {
      expect(markdown).not.toContain(sentinel);
      for (const place of ["hooks.example", "push.example", "ntfy.example"]) expect(markdown).not.toContain(place);
    }
    // The operator's copy leaves out where the second copies are.
    expect(copies[1]).not.toContain("backup.example");
    expect(copies[1]).not.toContain("example-bucket");
  });

  it("still makes a document when nothing on the host can be read, and says what is unknown and why", async () => {
    const { service, owner } = await setup({ failing: true });
    const { markdown } = await service({ identity: { servePublishesControlPlane: async () => { throw new Error(sentinel); } } }).preview({ role: "owner", callerId: owner.id });
    for (const line of [
      "- Hostname: unknown (the host inventory could not be read)",
      "Installed apps: unknown (the app inventory could not be read; is the BoxPilot helper running?).",
      "Drives and mounts: unknown (the drives could not be read).",
      "- ufw: unknown (the firewall could not be read)",
      "- Machine snapshots: unknown (the snapshot store could not be read)",
    ]) expect(markdown).toContain(line);
    // BoxPilot's own records are still there.
    expect(markdown).toContain("- BoxPilot's database: `");
    expect(markdown).toContain("- Daily at 03:00: Back up application data (jellyfin), keeping 7. Not run yet.");
    expect(markdown).not.toContain(sentinel);
  });
});

describe("the downloaded copy", () => {
  it("is recorded when the owner downloads it, and compared on every preview", async () => {
    const { service, state, owner, operator, answers } = await setup();
    const runbook = service();
    expect((await runbook.preview({ role: "owner", callerId: owner.id })).comparison).toBeNull();
    const downloaded = await runbook.download({ callerId: owner.id });
    expect(downloaded.filename).toBe("boxpilot-runbook-homeserver-2026-09-28.md");
    expect(state.getSetting(runbookSettingKey, null)).toMatchObject({ at: "2026-09-28T10:00:00.000Z", version: "9.9.9-test", digest: downloaded.fingerprint });
    expect(state.listAudit(10).some((event) => event.type === "runbook.downloaded" && event.actorId === owner.id)).toBe(true);
    expect((await runbook.preview({ role: "operator", callerId: operator.id })).comparison).toEqual({ downloadedAt: "2026-09-28T10:00:00.000Z", matches: true, changedSections: [] });
    // Someone opened a port by hand: the preview says which part of the downloaded copy is wrong.
    const firewall = answers["firewall.inspect"];
    answers["firewall.inspect"] = () => ({ ...firewall(), rules: [...firewall().rules, { action: "allow", protocol: "tcp", port: 8080, app: null, direction: "in", interface: null, comment: null, family: "v4" }] });
    expect((await runbook.preview({ role: "operator", callerId: operator.id })).comparison).toEqual({ downloadedAt: "2026-09-28T10:00:00.000Z", matches: false, changedSections: ["Network and firewall"] });
  });

  it("is out of date since the first change BoxPilot recorded after it, from its own records alone", async () => {
    const { service, state, owner, operator, clock, calls } = await setup();
    const runbook = service();
    expect(await runbook.status({ role: "owner", callerId: owner.id })).toMatchObject({ canDownload: true, lastDownload: null, outOfDate: null, changes: 0 });
    const { fingerprint } = await runbook.download({ callerId: owner.id });
    calls.length = 0;
    expect(await runbook.status({ role: "owner", callerId: owner.id })).toMatchObject({ lastDownload: { at: "2026-09-28T10:00:00.000Z", version: "9.9.9-test", fingerprint }, outOfDate: null, changes: 0 });
    // Cheap: the status check asks the helper nothing.
    expect(calls).toEqual([]);

    // A backup is not a change to the layout; installing an app is.
    clock.at = new Date("2026-09-28T11:00:00.000Z");
    const backup = state.createJob({ type: "op:app.backup", title: "Back up Jellyfin", createdBy: owner.id });
    state.transitionJob(backup.id, "awaiting_approval", "completed");
    expect((await runbook.status({ role: "owner", callerId: owner.id })).outOfDate).toBeNull();
    clock.at = new Date("2026-09-28T12:00:00.000Z");
    const install = state.createJob({ type: "op:app.install", title: "Install Immich", createdBy: owner.id });
    state.transitionJob(install.id, "awaiting_approval", "completed");
    expect((await runbook.status({ role: "owner", callerId: owner.id })).outOfDate).toEqual({ since: "2026-09-28T12:00:00.000Z", change: "Install Immich", more: 0 });
    // An operator learns what kind of change it was, not the owner's job title, and cannot download.
    const seen = await runbook.status({ role: "operator", callerId: operator.id });
    expect(seen).toMatchObject({ canDownload: false, lastDownload: { at: "2026-09-28T10:00:00.000Z", version: "9.9.9-test" }, outOfDate: { change: "Install application" } });
    expect(seen.lastDownload.fingerprint).toBeUndefined();

    // A new schedule moves the automation marker; a new BoxPilot is a change of its own.
    clock.at = new Date("2026-09-28T13:00:00.000Z");
    state.createSchedule({ operationId: "backup.sync", parameters: {}, frequency: "daily", minute: 0, hour: 5, createdBy: owner.id, nextDueAt: "2026-09-29T05:00:00.000Z" });
    expect(await runbook.status({ role: "owner", callerId: owner.id })).toMatchObject({ outOfDate: { change: "Install Immich", more: 1 }, changes: 2 });
    const upgraded = await service({ version: "9.9.10-test" }).status({ role: "owner", callerId: owner.id });
    expect(upgraded).toMatchObject({ changes: 3, outOfDate: { change: "Install Immich", more: 2 } });

    // Downloading again brings it up to date.
    await runbook.download({ callerId: owner.id });
    expect(await runbook.status({ role: "owner", callerId: owner.id })).toMatchObject({ outOfDate: null, changes: 0 });
  });
});

describe("an operator's copy, through GET /runbook (sweep 3)", () => {
  /** The real router over the real service, with the role and account a session would carry. */
  async function serve(runbook) {
    const auth = { requireRole: (...roles) => (request, response, next) => (roles.includes(request.boxpilotSession.owner.role) ? next() : response.status(403).json({ code: "forbidden" })) };
    const app = express();
    app.use((request, _response, next) => { request.boxpilotSession = { owner: { id: request.headers["x-test-owner"], role: request.headers["x-test-role"] } }; next(); });
    app.use("/api/v1", createRunbookRouter({ runbook, auth }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    return { server, markdownFor: async (account) => (await (await fetch(`${base}/api/v1/runbook`, { headers: { "x-test-owner": account.id, "x-test-role": account.role } })).json()).markdown };
  }

  it("gives an alert's words as the watch list does, and leaves out what BoxPilot published through the tunnel", async () => {
    const answers = answersFor();
    const apps = answers["app.inspect"];
    answers["app.inspect"] = () => ({ ...apps(), applications: [...apps().applications, { id: "cloudflared", installed: true, container: { exists: true, running: true, status: "running" } }] });
    answers["cloudflare.tunnel.inspect"] = () => ({ connected: true, tunnel: { id: "tunnel-1", name: "SECRET-TUNNEL-home" }, routes: [{ hostname: "photos.secret-zone.example", appId: "jellyfin", hostPort: 8096 }] });
    const { state, service, owner, operator } = await setup({ answers });
    const since = "2026-09-27T00:00:00.000Z";
    state.setSetting("healthAlertsState", {
      "system.reboot": { title: "A reboot is required", since, notified: false },
      "agent.important:agent-1": { title: "Owner's Auditor: SECRET-FINDING in /srv/private", message: "SECRET-FINDING", since, notified: false },
      "approval.lapsed:job-1": { title: "Not approved in 7 days: SECRET-JOB", since, notified: false },
      "report.weekly": { title: "Weekly report: SECRET-REPORT", since, notified: false },
      "flow.failed:flow-1": { title: "Automation stopped: SECRET-FLOW", since, notified: true, actorId: owner.id },
      "flow.failed:flow-2": { title: "Automation stopped: Operator's own", since, notified: true, actorId: operator.id },
    });
    const { server, markdownFor } = await serve(service());
    try {
      const mine = await markdownFor({ id: operator.id, role: "operator" });
      for (const secret of ["SECRET-FINDING", "SECRET-JOB", "SECRET-REPORT", "SECRET-FLOW", "SECRET-TUNNEL", "secret-zone"]) expect(mine, secret).not.toContain(secret);
      for (const line of [
        "- A reboot is required (since 2026-09-27 00:00 UTC). Not announced.",
        "- Automation stopped: Operator's own (since 2026-09-27 00:00 UTC). Announced.",
        "- An automation stopped or did not run (since 2026-09-27 00:00 UTC). Announced.",
        "- An agent found something important (2026-09-27 00:00 UTC).",
        "- A staged job was not approved in time (2026-09-27 00:00 UTC).",
        "- The weekly report (2026-09-27 00:00 UTC).",
        "Which hostnames BoxPilot published through it is in the owner's copy of this document.",
      ]) expect(mine).toContain(line);

      const owners = await markdownFor({ id: owner.id, role: "owner" });
      for (const secret of ["SECRET-FINDING", "SECRET-JOB", "SECRET-REPORT", "SECRET-FLOW", "`SECRET-TUNNEL-home`", "https://photos.secret-zone.example"]) expect(owners, secret).toContain(secret);
    } finally {
      server.close();
    }
  });
});

describe("where things live", () => {
  it("finds the mount a path is on, and the disk a device is part of", () => {
    const mounts = [{ target: "/" }, { target: "/mnt/media" }, { target: "/mnt/media2" }];
    expect(mountFor("/mnt/media/library", mounts).target).toBe("/mnt/media");
    expect(mountFor("/mnt/media2", mounts).target).toBe("/mnt/media2");
    expect(mountFor("/srv/data", mounts).target).toBe("/");
    expect(mountFor("relative/path", mounts)).toBeNull();
    expect(diskFor("/dev/sdb1", storage.devices).path).toBe("/dev/sdb");
    expect(diskFor("/dev/nvme0n1", storage.devices).path).toBe("/dev/nvme0n1");
    expect(diskFor("/dev/missing", storage.devices)).toBeNull();
  });
});
