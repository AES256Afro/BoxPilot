/**
 * The facts behind the server runbook (M34.4), gathered from what BoxPilot already reads - the
 * host inventory, the network topology, the drives, the helper's app, backup, firewall, Serve and
 * snapshot reads, and BoxPilot's own records - and handed to the pure generator in runbook.mjs.
 * No new collector: every read here is one another page already makes.
 *
 * Secrets: every stored parameter set (each schedule's, each automation step's, each app's install
 * values) goes through secretPaths/maskSecrets before anything is taken from it, and the only
 * things taken are what a person needs to find their way: an app id, a drive name, a keep count.
 * Destinations keep their kind and path; the user names and key ids beside them stay behind.
 *
 * Some reads here are operator reads (ADR-003) - the snapshot store, the Samba shares, each app's
 * backup folder - which is one reason generating the document needs an operator.
 */
import path from "node:path";
import { productVersion } from "./version.mjs";
import { registry as defaultRegistry } from "./ops/index.mjs";
import { maskSecrets, secretPaths } from "./ops/registry.mjs";
import { defaultApprovalMode, normalizeApprovalMode } from "./ops/risk.mjs";
import { collectStorage } from "./storage-inventory.mjs";
import { readTlsStatus } from "./tls-status.mjs";
import { buildReachability } from "./routes/host.mjs";
import { bindingFor } from "./catalog/compose.mjs";
import { describeCadence, scheduleOutcome } from "./scheduler.mjs";
import { healthConditions, isNotice, noticeKinds } from "./health-alerts.mjs";
import { cloudProviders } from "./backup-cloud.mjs";
import { changedSections, changesSince, forAudience, layoutOperations, outOfDate, renderRunbook, runbookFingerprint, storeMarkers } from "./runbook.mjs";

const posix = path.posix;
/** What the last download recorded: when, from which version, its fingerprint, and the store markers then. */
export const runbookSettingKey = "serverRunbook";

// Fixed by deploy/boxpilot-helper.service (checked in server/deployment.test.mjs) and described in
// docs/CONTROLLER-BACKUPS.md: where the encrypted database copy lives and where its password is.
const controllerRepository = "/mnt/boxpilot-backup/restic-controller";
const controllerPasswordFile = "/etc/boxpilot/secrets/controller-backup-restic-password";

/** Operations a restore step names. Their titles and tiers come from the registry, not from here. */
const restoreOperations = ["storage.mount", "host.snapshot.discover", "host.snapshot.restore", "host.snapshot.restores", "controller.backup.create", "app.install", "app.backup", "app.backup.restore", "app.backup.restore-path"];
/** Schedules that make or copy a backup, listed again under Backups. */
const backupOperations = new Set(["app.backup", "app.backup.verify", "controller.backup.create", "controller.backup.protect", "controller.backup.retention.apply", "host.snapshot.create", "backup.sync", "backup.remote.sync", "backup.cloud.sync", "vm.export.create", "vm.export.protect", "vm.backup.restore-drill"]);
/** Host paths that are plumbing (a socket, the kernel's view), not somewhere an app keeps data. */
const plumbing = /^\/(?:dev|proc|sys|run|var\/run|etc)(?:\/|$)|\.sock$/;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const attempt = (read) => Promise.resolve().then(read).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
const subjectOf = (parameters) => (typeof parameters?.id === "string" ? parameters.id : typeof parameters?.name === "string" ? parameters.name : null);
const keepOf = (parameters) => (Number.isInteger(parameters?.keep) ? parameters.keep : null);

/** The mount a path lives on: the longest mount target that contains it. */
export function mountFor(target, mounts = []) {
  if (typeof target !== "string" || !target.startsWith("/")) return null;
  let best = null;
  for (const mount of mounts) {
    const root = typeof mount?.target === "string" ? mount.target : null;
    if (!root) continue;
    const inside = root === "/" || target === root || target.startsWith(`${root.replace(/\/+$/, "")}/`);
    if (inside && (!best || root.length > best.target.length)) best = mount;
  }
  return best;
}

/** The whole disk a device path belongs to, from lsblk's ordered tree: the nearest row above it at depth 0. */
export function diskFor(devicePath, devices = []) {
  const index = devices.findIndex((device) => device.path === devicePath);
  if (index < 0) return null;
  for (let at = index; at >= 0; at -= 1) if ((devices[at].depth ?? 0) === 0) return devices[at];
  return null;
}

/** "UUID=..", "LABEL=.." or a device path, as the device lsblk lists. */
function deviceFor(spec, devices = []) {
  const text = String(spec ?? "");
  if (text.startsWith("UUID=")) return devices.find((device) => device.uuid === text.slice(5)) ?? null;
  if (text.startsWith("LABEL=")) return devices.find((device) => device.label === text.slice(6)) ?? null;
  return devices.find((device) => device.path === text) ?? null;
}

function containerWords(container) {
  if (!isObject(container)) return null;
  if (container.exists === false) return "not created";
  const state = container.running === true ? "running" : typeof container.status === "string" ? container.status : typeof container.state === "string" ? container.state : null;
  if (!state) return null;
  return typeof container.health === "string" && !["none", ""].includes(container.health) ? `${state}, ${container.health}` : state;
}

function serveUrl(serve) {
  return `https://${serve.dnsName}${serve.port === 443 ? "" : `:${serve.port}`}`;
}

function cloudWhere(destination) {
  const hostOf = (value) => { try { return new URL(value).host; } catch { return null; } };
  const base = destination.provider === "webdav" ? hostOf(destination.url) : destination.provider === "s3" && destination.endpoint ? hostOf(destination.endpoint) : null;
  return [base, destination.bucket, destination.path].filter((part) => typeof part === "string" && part).join("/") || null;
}

function flowTrigger(flow, flows) {
  const triggers = [];
  if (flow.frequency) triggers.push(describeCadence(flow));
  if (flow.triggerFlowId) triggers.push(`after "${flows.find((entry) => entry.id === flow.triggerFlowId)?.name ?? "another automation"}" finishes`);
  if (flow.triggerDrive) triggers.push(`when drive ${flow.triggerDrive} drops or goes read-only (auto-reconnect)`);
  if (flow.webhookEnabled) triggers.push("when its webhook is called");
  return triggers.length ? triggers.join(", or ") : "run by hand";
}

export function createRunbookService({
  store, helper, catalogService, inventory = null, network = null, notifications = null, autoReconnect = null, identity = null,
  registry = defaultRegistry, secretEnvNamesFor = null, collect = collectStorage, readTls = readTlsStatus,
  webHost = "127.0.0.1", webPort = 8787, tlsDir = process.env.BOXPILOT_TLS_DIR ?? "/etc/boxpilot/tls",
  now = () => new Date(), version = productVersion,
} = {}) {
  const ask = (operation, parameters = {}, timeoutMs = 60_000) => helper.request(operation, parameters, { timeoutMs });

  /** A stored parameter set with its secrets masked. An operation the registry no longer knows keeps nothing. */
  async function mask(operationId, parameters) {
    const operation = registry.get(operationId);
    if (!operation || !isObject(parameters)) return {};
    return maskSecrets(parameters, await secretPaths(operation, parameters, { secretEnvNamesFor }));
  }

  const describeOperation = (id) => {
    const operation = registry.get(id);
    return operation ? { title: operation.title, risk: operation.risk, readOnly: operation.readOnly, minimumRole: operation.minimumRole, confirm: Boolean(operation.confirm) } : null;
  };

  async function schedulesAndFlows() {
    const schedules = await Promise.all((store.listSchedules?.() ?? []).map(async (schedule) => {
      const parameters = await mask(schedule.operationId, schedule.parameters);
      return {
        id: schedule.id, operationId: schedule.operationId, title: registry.get(schedule.operationId)?.title ?? schedule.operationId,
        subject: subjectOf(parameters), keep: keepOf(parameters), parameters,
        cadence: describeCadence(schedule), frequency: schedule.frequency, minute: schedule.minute, hour: schedule.hour ?? null, weekday: schedule.weekday ?? null,
        enabled: schedule.enabled !== false, backup: backupOperations.has(schedule.operationId),
        createdBy: schedule.createdBy ?? null, createdAt: schedule.createdAt ?? null,
        lastRunAt: schedule.lastRunAt ?? null, outcome: scheduleOutcome(schedule).outcome,
      };
    }));
    const stored = store.listFlows?.() ?? [];
    const flows = await Promise.all(stored.map(async (flow) => ({
      id: flow.id, name: flow.name, trigger: flowTrigger(flow, stored), enabled: flow.enabled !== false,
      createdBy: flow.createdBy ?? null, updatedAt: flow.updatedAt ?? null, lastRunAt: flow.lastRunAt ?? null,
      triggerDrive: flow.triggerDrive ?? null,
      steps: await Promise.all((flow.steps ?? []).map(async (step) => {
        const parameters = await mask(step.operationId, step.parameters);
        return { operationId: step.operationId, title: registry.get(step.operationId)?.title ?? step.operationId, subject: subjectOf(parameters), parameters };
      })),
      // For the store markers only: the same shape the flow is stored in, secrets masked.
      raw: { ...flow, steps: await Promise.all((flow.steps ?? []).map(async (step) => ({ operationId: step.operationId, parameters: await mask(step.operationId, step.parameters) }))) },
    })));
    return { schedules, flows };
  }

  /** The cheap half of "out of date": BoxPilot's own records, no helper call. */
  async function markersNow() {
    const { schedules, flows } = await schedulesAndFlows();
    const firewallProfile = store.getSetting("firewallProfile", null);
    const digests = storeMarkers({
      schedules,
      flows: flows.map((flow) => flow.raw),
      backupDestination: store.getSetting("backupDestination", null),
      cloudDestination: store.getSetting("cloudDestination", null),
      firewallProfile,
    });
    const latest = (values) => values.filter((value) => Number.isFinite(Date.parse(value ?? ""))).sort().at(-1) ?? null;
    return {
      digests,
      times: {
        automation: latest([...schedules.map((schedule) => schedule.createdAt), ...flows.map((flow) => flow.updatedAt)]),
        firewall: latest([firewallProfile?.appliedAt, firewallProfile?.editedAt]),
      },
    };
  }

  async function facts() {
    const [inventoryRead, topologyRead, storageRead, liveRead, catalogRead, protectionRead, servesRead, firewallRead, snapshotsRead, sambaRead, tlsRead, publishedRead, automation] = await Promise.all([
      attempt(() => inventory.inspect()),
      attempt(() => network.inspect()),
      attempt(() => collect()),
      attempt(() => ask("app.inspect", {}, 30_000)),
      attempt(() => catalogService.all()),
      attempt(() => ask("app.backup.protection", {}, 120_000)),
      attempt(() => ask("app.serve.inspect", {}, 30_000)),
      attempt(() => ask("firewall.inspect", {}, 30_000)),
      attempt(() => ask("host.snapshot.inspect", {}, 60_000)),
      attempt(() => ask("samba.inspect", {}, 30_000)),
      attempt(() => readTls({ dir: tlsDir })),
      attempt(() => (identity?.servePublishesControlPlane ? identity.servePublishesControlPlane() : false)),
      attempt(() => schedulesAndFlows()),
    ]);
    const value = (read) => (read.ok && isObject(read.value) ? read.value : null);
    const inventoryValue = value(inventoryRead);
    const topology = value(topologyRead);
    const storage = value(storageRead);
    const live = value(liveRead);
    const liveApps = Array.isArray(live?.applications) ? live.applications : null;
    const manifests = Array.isArray(value(catalogRead)?.manifests) ? catalogRead.value.manifests : [];
    const protection = value(protectionRead);
    const servesValue = value(servesRead);
    const firewall = value(firewallRead);
    const snapshots = value(snapshotsRead);
    const samba = value(sambaRead);
    const { schedules = [], flows = [] } = automation.ok ? automation.value : {};

    // ---- this server ----
    const hostValue = inventoryValue?.host;
    const host = typeof hostValue?.hostname === "string" && hostValue.hostname
      ? { available: true, hostname: hostValue.hostname, operatingSystem: hostValue.operatingSystem ?? null, kernel: hostValue.kernel ?? null, architecture: hostValue.architecture ?? null }
      : { available: false, reason: inventoryValue ? "the host inventory did not name this server" : "the host inventory could not be read" };
    const lanAddresses = Array.isArray(topology?.eligibleLanAddresses) ? topology.eligibleLanAddresses : null;
    const lan = lanAddresses ? { available: true, addresses: lanAddresses.map((entry) => ({ interface: entry.interface ?? null, address: entry.address })) } : { available: false, reason: "the network could not be read" };
    const tailscaleValue = topology?.tailscale ?? inventoryValue?.network?.tailscale ?? null;
    const tailnet = isObject(tailscaleValue)
      ? { available: true, connected: tailscaleValue.connected === true, dnsName: tailscaleValue.dnsName ?? null, address: tailscaleValue.address ?? null }
      : { available: false, reason: "Tailscale could not be read" };
    const reach = buildReachability({
      webHost, webPort,
      lanIp: lan.addresses?.[0]?.address ?? null,
      dnsName: tailnet.dnsName ?? null,
      tls: value(tlsRead) ?? { provisioned: false },
      servePublished: publishedRead.ok && publishedRead.value === true,
    });
    const controllerBackups = (store.listBackups?.(200) ?? []).filter((backup) => backup.applicationId === "boxpilot-controller");
    const databaseArtifact = controllerBackups.find((backup) => typeof backup.artifactPath === "string" && backup.artifactPath.startsWith("/"))?.artifactPath ?? null;
    const appBackupDirectories = new Map();
    const installed = (liveApps ?? []).filter((app) => app.installed === true);
    // One app at a time: each is a directory read in the helper, and the helper's read slots are shared.
    for (const app of installed) {
      const listed = await attempt(() => ask("app.backups.inspect", { id: app.id }, 30_000));
      if (listed.ok && isObject(listed.value)) appBackupDirectories.set(app.id, listed.value);
    }
    const anyBackupDirectory = [...appBackupDirectories.values()].find((entry) => typeof entry.directory === "string")?.directory ?? null;
    const catalogRoot = typeof live?.catalogRoot === "string" ? live.catalogRoot : null;
    const roots = {
      databaseBackups: databaseArtifact ? { path: posix.dirname(posix.dirname(databaseArtifact)) } : { path: null, reason: "no database backup has been taken yet" },
      appBackups: anyBackupDirectory ? { path: posix.dirname(anyBackupDirectory) } : { path: null, reason: !liveApps ? "the app inventory could not be read" : installed.length ? "the app backup folders could not be read" : "no app is installed to report it" },
      machineSnapshots: typeof snapshots?.snapshotRoot === "string" ? { path: snapshots.snapshotRoot } : { path: null, reason: "the snapshot store could not be read" },
      appData: catalogRoot ? { path: catalogRoot } : { path: null, reason: "the app inventory could not be read" },
    };
    const approvalMode = normalizeApprovalMode(store.getSetting("approvalMode", null) ?? process.env.BOXPILOT_APPROVAL_MODE ?? defaultApprovalMode);

    // ---- storage, first the raw material the apps need ----
    const mounts = Array.isArray(storage?.mounts) ? storage.mounts : [];
    const devices = Array.isArray(storage?.devices) ? storage.devices : [];
    const fstab = Array.isArray(storage?.fstab) ? storage.fstab : [];
    const managedByTarget = new Map(fstab.filter((row) => row.managedName && !row.managedName.startsWith("share-") && row.fstype !== "swap").map((row) => [row.mountpoint, row]));
    const whereIs = (target) => {
      if (!storage || storage.availability?.mounts === false) return { mount: null, mountReason: "the current mounts could not be read" };
      const mount = mountFor(target, mounts);
      return mount ? { mount: { target: mount.target, drive: managedByTarget.get(mount.target)?.managedName ?? null } } : { mount: null, mountReason: "no mount holds it" };
    };

    // ---- apps ----
    const serves = servesValue?.available === true && Array.isArray(servesValue.serves) ? servesValue.serves.filter((serve) => typeof serve?.dnsName === "string" && Number.isInteger(serve.port)) : null;
    const verifications = store.getSetting("appBackupVerifications", {}) ?? {};
    const protectionApps = protection?.available === true && Array.isArray(protection.apps) ? protection.apps : null;
    const holdings = []; // [path, words]: what the storage section says each filesystem holds
    const appItems = [];
    for (const app of installed) {
      const manifest = manifests.find((entry) => entry.id === app.id) ?? { id: app.id, name: app.id, ports: [], volumes: [], env: [] };
      const values = (await mask("app.install", { id: app.id, values: isObject(app.state?.values) ? app.state.values : {} })).values ?? {};
      const exposure = values.exposure ?? "lan";
      const networkMode = values.networkMode ?? manifest.network ?? "bridge";
      const ports = (manifest.ports ?? []).map((port) => {
        const hostPort = networkMode === "host" ? port.container : values.ports?.[port.id] ?? port.host;
        const reachOf = networkMode === "host" ? "host" : bindingFor(port, exposure, { lanAddress: "0.0.0.0", tailnetAddress: tailnet.address ?? null }).exposure;
        const serve = serves?.find((entry) => entry.port === hostPort || String(entry.target ?? "").endsWith(`:${hostPort}`));
        return { label: port.label ?? port.id, host: hostPort, protocol: port.protocol ?? "tcp", reach: reachOf, tailnetHttps: serve ? serveUrl(serve) : null };
      });
      const appRoot = catalogRoot ? posix.join(catalogRoot, app.id) : null;
      const data = [];
      const addFolder = (label, volume, owner = null) => {
        if (volume.path) {
          const folder = appRoot ? posix.join(appRoot, volume.path) : null;
          data.push({ label, path: folder, reason: folder ? null : "the app data folder was not reported", managed: true, backedUp: volume.backup === true, readOnly: volume.readOnly === true, ...(folder ? whereIs(folder) : { mount: null }) });
          return;
        }
        const chosen = (owner ? null : values.volumes?.[volume.id]) ?? volume.hostPath;
        if (typeof chosen !== "string" || !chosen.startsWith("/") || plumbing.test(chosen)) return;
        data.push({ label, path: chosen, managed: false, backedUp: false, readOnly: volume.readOnly === true, ...whereIs(chosen) });
      };
      for (const volume of manifest.volumes ?? []) addFolder(volume.label ?? volume.id, volume);
      for (const sidecar of manifest.sidecars ?? []) for (const volume of sidecar.volumes ?? []) addFolder(`${sidecar.id}: ${volume.id}`, volume, sidecar);
      for (const folder of data) if (folder.path) holdings.push([folder.path, `${manifest.name ?? app.id}: ${folder.label} (\`${folder.path}\`)`]);

      const counted = protectionApps?.find((entry) => entry.id === app.id) ?? null;
      const listed = appBackupDirectories.get(app.id) ?? null;
      const newest = Array.isArray(listed?.backups) ? listed.backups.find((backup) => typeof backup?.artifact === "string") ?? null : null;
      const verification = verifications[app.id];
      appItems.push({
        id: app.id, name: manifest.name ?? app.id, category: manifest.category ?? null, description: manifest.description ?? null,
        image: { reference: app.state?.image?.reference ?? app.installedImage ?? manifest.image?.reference ?? null, version: (app.state?.image?.reference ?? manifest.image?.reference) === manifest.image?.reference ? manifest.image?.version ?? null : null },
        container: containerWords(app.container), exposure, networkMode, ports, data,
        signIn: manifest.signIn ? { note: manifest.signIn.note ?? null } : null,
        secretNames: (manifest.env ?? []).filter((entry) => entry.secret === true).map((entry) => entry.name),
        backups: {
          ...(protectionApps ? { available: true } : { available: false, reason: "the backup folder could not be read" }),
          protectable: counted ? counted.protectable !== false : undefined,
          count: Number.isInteger(counted?.backups) ? counted.backups : newest ? listed.backups.length : 0,
          newestAt: counted?.newestAt ?? newest?.createdAt ?? null,
          newestArtifact: newest?.artifact ?? null,
          directory: typeof listed?.directory === "string" ? listed.directory : null,
          verification: isObject(verification) ? { verified: verification.verified === true, checkedAt: verification.checkedAt ?? null } : null,
          schedules: schedules.filter((schedule) => schedule.operationId === "app.backup" && schedule.subject === app.id).map((schedule) => ({ id: schedule.id, cadence: schedule.cadence, keep: schedule.keep ?? 5, enabled: schedule.enabled, createdBy: schedule.createdBy })),
        },
      });
    }
    const apps = liveApps ? { available: true, items: appItems } : { available: false, reason: liveRead.ok ? "the app inventory came back incomplete" : "the app inventory could not be read; is the BoxPilot helper running?" };
    const tunnelApp = installed.find((app) => app.id === "cloudflared");
    const tunnel = liveApps
      ? { installed: Boolean(tunnelApp), name: manifests.find((entry) => entry.id === "cloudflared")?.name ?? "Cloudflare Tunnel", running: tunnelApp ? tunnelApp.container?.running === true : null }
      : { installed: null, reason: "the app inventory could not be read" };

    // ---- backups ----
    const latestBackup = controllerBackups[0] ?? null;
    const protections = store.listControllerBackupProtections?.(200) ?? [];
    const protectedCopy = protections.find((entry) => entry.protected && entry.encrypted && entry.independent && entry.repositoryVerified) ?? null;
    const retentionRun = (store.listControllerRetentionRuns?.(1) ?? [])[0] ?? null;
    const snapshotList = Array.isArray(snapshots?.snapshots) ? snapshots.snapshots : null;
    const sync = isObject(snapshots?.sync) ? snapshots.sync : null;
    const destinations = [];
    if (sync) {
      const mounted = sync.mount?.mounted === true;
      const lastSync = sync.lastSync?.completedAt ?? null;
      destinations.push({
        kind: "drive", label: "Backup drive", configured: mounted || Boolean(lastSync), where: typeof sync.destination === "string" ? sync.destination : null,
        mountTarget: typeof sync.mount?.target === "string" ? sync.mount.target : null, lastSync,
        note: `${mounted ? "Mounted now" : "Not mounted now"}. It gets copies of the database backups, app backups and machine snapshots, checked by hash; nothing there is ever deleted by BoxPilot`,
      });
    } else {
      destinations.push({ kind: "drive", label: "Backup drive", configured: null, where: null, whereReason: "the snapshot store could not be read", lastSyncReason: "the snapshot store could not be read" });
    }
    const ssh = store.getSetting("backupDestination", null);
    if (isObject(ssh) && ssh.host) {
      destinations.push({
        kind: "ssh", label: "Another machine over SSH", configured: true, where: `${ssh.host}:${ssh.path ?? "/"}`, lastSync: store.getSetting("backupDestinationLastSync", null)?.completedAt ?? null,
        note: `${ssh.port && ssh.port !== 22 ? `SSH port ${ssh.port}. ` : ""}A plain mirror of the local backups, copied with rsync; not encrypted`,
        credential: "The SSH key is /etc/boxpilot/secrets/backup-mirror-key on this server (root only); its public half is authorized on the destination",
      });
    }
    const cloud = store.getSetting("cloudDestination", null);
    if (isObject(cloud) && cloud.provider) {
      destinations.push({
        kind: "cloud", label: `Cloud storage (${cloudProviders[cloud.provider]?.label ?? cloud.provider})`, configured: true, where: cloudWhere(cloud), whereReason: "the destination names no bucket or path",
        lastSync: store.getSetting("cloudDestinationLastSync", null)?.completedAt ?? null,
        note: "A plain mirror of the local backups, copied with rclone; not encrypted",
        credential: "Its keys are in /etc/boxpilot/secrets/rclone.conf on this server (root only); keep a copy of them off this server",
      });
    }
    const backups = {
      database: {
        count: controllerBackups.length,
        latest: latestBackup ? { at: latestBackup.createdAt, verifiedAt: latestBackup.verifiedAt ?? null, drillPassed: latestBackup.restoreDrill?.passed === true } : null,
        protected: protectedCopy ? { at: protectedCopy.createdAt, snapshotId: protectedCopy.snapshotId ?? null, drillPassed: protectedCopy.restoreDrill?.passed === true } : null,
        repository: controllerRepository, passwordFile: controllerPasswordFile,
        retention: retentionRun ? { at: retentionRun.createdAt } : null,
      },
      snapshots: snapshotList
        ? { available: true, root: snapshots.snapshotRoot ?? null, count: snapshotList.length, keep: Number.isInteger(snapshots.keep) ? snapshots.keep : null, latest: snapshotList[0] ? { at: snapshotList[0].createdAt ?? null, artifact: snapshotList[0].artifact ?? null } : null }
        : { available: false, reason: "the snapshot store could not be read" },
      destinations,
    };

    // ---- storage ----
    holdings.push([store.databasePath, "BoxPilot's database"]);
    for (const [key, words] of [["databaseBackups", "BoxPilot's database backups"], ["appBackups", "the app backups"], ["machineSnapshots", "the machine snapshots"], ["appData", "every app's own folder"]]) if (roots[key].path) holdings.push([roots[key].path, words]);
    const mirror = destinations.find((destination) => destination.kind === "drive" && destination.configured && destination.where);
    if (mirror) holdings.push([mirror.where, "the backup drive's copy of every local backup"]);
    if (protectedCopy) holdings.push([controllerRepository, "the encrypted copy of BoxPilot's database"]);
    if (samba?.configured) for (const share of samba.config?.shares ?? []) if (typeof share?.path === "string") holdings.push([share.path, `the SMB share \`${share.name}\` (\`${share.path}\`)`]);
    const smartValue = inventoryValue?.storage?.smart;
    const smartDisks = Array.isArray(smartValue?.disks) ? smartValue.disks : [];
    const smart = isObject(smartValue) && smartValue.available !== false
      ? { available: true, status: smartValue.status ?? "unknown", checkedAt: smartValue.generatedAt ?? null }
      : { available: false, reason: isObject(smartValue) ? String(smartValue.reason ?? "no SMART reading").replaceAll("-", " ") : "the host inventory could not be read" };
    const smartFor = (disk) => {
      const reading = disk ? smartDisks.find((entry) => entry.device === disk.path) : null;
      if (reading) return { smart: { health: reading.health } };
      return { smart: null, smartReason: !smart.available ? smart.reason : disk?.transport === "usb" ? "no reading; USB enclosures often do not pass SMART through" : "no reading for this disk" };
    };
    const reconnect = (() => { try { return autoReconnect?.status?.() ?? null; } catch { return null; } })();
    const holdsOn = (target) => holdings.filter(([where]) => mountFor(where, mounts)?.target === target).map(([, words]) => words);
    let storageFacts;
    if (!storage) storageFacts = { available: false, reason: "the drives could not be read", smart };
    else {
      const mountsKnown = storage.availability?.mounts !== false;
      const drives = [...managedByTarget.values()].map((row) => {
        const mounted = mounts.find((mount) => mount.target === row.mountpoint) ?? null;
        const device = (mounted ? devices.find((entry) => entry.path === mounted.source) : null) ?? deviceFor(row.device, devices);
        const disk = device ? diskFor(device.path, devices) : null;
        const armed = reconnect?.drives?.[row.managedName] ?? null;
        return {
          name: row.managedName, target: row.mountpoint, device: row.device, fstype: row.fstype,
          mounted: mountsKnown ? Boolean(mounted) : null, readOnly: mounted?.readOnly === true,
          sizeBytes: mounted?.sizeBytes ?? null, availableBytes: mounted?.availableBytes ?? null,
          disk: disk?.path ?? null, model: disk?.model ?? null, transport: disk?.transport ?? null, ...smartFor(disk),
          autoReconnect: armed ? { armed: true, enabled: armed.enabled !== false, held: armed.held === true, heldBecause: armed.heldBecause ?? null } : { armed: false },
          holds: holdsOn(row.mountpoint),
        };
      });
      const others = mounts
        .filter((mount) => !managedByTarget.has(mount.target) && holdsOn(mount.target).length)
        .map((mount) => { const disk = diskFor(mount.source, devices); return { target: mount.target, source: mount.source, fstype: mount.fstype, disk: disk?.path ?? null, ...smartFor(disk), holds: holdsOn(mount.target) }; });
      const shares = (Array.isArray(storage.shares) ? storage.shares : []).map((share) => ({ name: share.name, target: share.mountpoint, source: share.source, kind: share.kind, mounted: share.mounted === true, readOnly: share.readOnly === true }));
      storageFacts = { available: true, smart, drives, others, shares };
    }

    // ---- network ----
    const knownApps = new Map(appItems.flatMap((app) => app.ports.map((port) => [port.host, app.name])));
    const profile = store.getSetting("firewallProfile", null);
    const networkFacts = {
      firewall: typeof firewall?.installed === "boolean"
        ? { available: true, installed: firewall.installed, enabled: typeof firewall.enabled === "boolean" ? firewall.enabled : null, defaults: isObject(firewall.defaults) ? firewall.defaults : null, rules: Array.isArray(firewall.rules) ? firewall.rules.slice(0, 200) : [], profile: isObject(profile) && profile.id ? { id: profile.id, appliedAt: profile.appliedAt ?? null, edited: Boolean(profile.editedAt) } : null }
        : { available: false, reason: firewallRead.ok ? "the firewall read came back incomplete" : "the firewall could not be read" },
      serves: serves ? { available: true, items: serves.map((serve) => ({ url: serveUrl(serve), port: serve.port, target: serve.target ?? null, app: liveApps ? knownApps.get(Number(String(serve.target ?? "").match(/:(\d+)\s*$/)?.[1] ?? serve.port)) ?? knownApps.get(serve.port) ?? null : undefined })) } : { available: false, reason: servesRead.ok ? "Tailscale Serve did not answer" : "Tailscale Serve could not be read" },
      tunnel,
      tailscale: { advertisedRoutes: Array.isArray(topology?.tailscale?.advertisedRoutes) ? topology.tailscale.advertisedRoutes : [], exitNode: typeof topology?.tailscale?.exitNodeAdvertised === "boolean" ? topology.tailscale.exitNodeAdvertised : null },
    };

    // ---- known issues ----
    const alerts = store.getSetting("healthAlertsState", {}) ?? {};
    const conditions = [];
    const notices = [];
    for (const [key, entry] of Object.entries(isObject(alerts) ? alerts : {})) {
      if (!isObject(entry)) continue;
      const [family, subject = null] = key.split(":");
      if (isNotice(key)) { notices.push({ family, subject, label: noticeKinds[family], title: entry.title ?? noticeKinds[family], since: entry.since ?? null }); continue; }
      const label = healthConditions[family] ?? family;
      conditions.push({ family, subject, label, title: entry.title ?? label, since: entry.since ?? null, announced: entry.notified !== false, ...(family.startsWith("schedule.") ? { scheduleCreatedBy: store.getSchedule?.(subject)?.createdBy ?? null } : {}) });
    }
    let targetConfigured = null;
    try { targetConfigured = notifications ? notifications.describe().configured === true : null; } catch { targetConfigured = null; }

    return {
      version,
      server: { host, databasePath: store.databasePath ?? null, roots, reach: { available: true, ways: reach.ways }, lan, tailnet, approvalMode },
      apps,
      storage: storageFacts,
      network: networkFacts,
      backups,
      automation: automation.ok ? { schedules, flows: flows.map(({ raw: _raw, ...flow }) => flow) } : { available: false, reason: "the schedules could not be read", schedules: [], flows: [] },
      issues: { available: true, targetConfigured, conditions, notices },
      operations: Object.fromEntries(restoreOperations.map((id) => [id, describeOperation(id)])),
    };
  }

  const audienceOf = (role) => (role === "owner" ? "owner" : "operator");

  /** The document as the caller may read it, and how it compares with the last downloaded copy. */
  async function preview({ role = "owner", callerId = null } = {}) {
    const full = await facts();
    const audience = audienceOf(role);
    const rendered = renderRunbook(forAudience(full, { audience, callerId }), { now });
    const record = store.getSetting(runbookSettingKey, null);
    // Compared on the full facts, so an operator's preview and the owner's download agree; only
    // the section names go back, never the digests of what an operator's copy leaves out.
    const current = runbookFingerprint(full);
    return {
      audience, version, generatedAt: rendered.generatedAt, fingerprint: rendered.fingerprint.digest, markdown: rendered.markdown,
      comparison: isObject(record) && record.at ? { downloadedAt: record.at, matches: record.digest === current.digest, changedSections: changedSections(record, current) } : null,
    };
  }

  /** The owner's full document, recorded as the copy now kept elsewhere. */
  async function download({ callerId = null } = {}) {
    const full = await facts();
    const rendered = renderRunbook(forAudience(full, { audience: "owner" }), { now });
    const { digests } = await markersNow();
    store.setSetting(runbookSettingKey, { at: rendered.generatedAt, version, digest: rendered.fingerprint.digest, sections: rendered.fingerprint.sections, markers: digests }, { updatedBy: callerId });
    store.recordAudit?.("runbook.downloaded", { actorId: callerId, details: { fingerprint: rendered.fingerprint.digest } });
    const hostname = String(full.server?.host?.hostname ?? "server").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "server";
    return { markdown: rendered.markdown, generatedAt: rendered.generatedAt, fingerprint: rendered.fingerprint.digest, filename: `boxpilot-runbook-${hostname}-${rendered.generatedAt.slice(0, 10)}.md` };
  }

  /**
   * Whether the downloaded copy is out of date, from BoxPilot's own records alone (no helper call,
   * so the page can ask on every load): a layout-changing job completed since, a schedule, flow,
   * destination or firewall-profile marker that moved, or another BoxPilot version.
   */
  async function status({ role = "owner", callerId = null } = {}) {
    const audience = audienceOf(role);
    const record = store.getSetting(runbookSettingKey, null);
    const known = isObject(record) && record.at;
    const { digests, times } = known ? await markersNow() : { digests: {}, times: {} };
    const changes = known ? changesSince(record, {
      jobs: store.listJobs?.(200) ?? [], markers: digests, markerTimes: times, version,
      operations: Object.fromEntries(layoutOperations.map((id) => [id, { title: registry.get(id)?.title ?? id }])), audience, callerId,
    }) : [];
    return {
      audience, canDownload: audience === "owner", version, checkedAt: now().toISOString(),
      lastDownload: known ? { at: record.at, version: record.version ?? null, ...(audience === "owner" ? { fingerprint: record.digest ?? null } : {}) } : null,
      outOfDate: outOfDate(changes),
      changes: changes.length,
    };
  }

  return { facts, preview, download, status };
}
