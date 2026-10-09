/**
 * The Repair Center's scan (M35, M36): everything BoxPilot can read about the drives, the apps, the
 * shares, the ports and the backups, run through the detectors and the owner's ledger of what was
 * set aside and tried. One function, so the Repair page (GET /remediations) and the agents' tool
 * repair.findings (M47) report the same findings. `operatorReadsWanted` says whether the reads an
 * operator may make (ADR-003) are made; `visibleJobsGiven` are the jobs this caller may see.
 */
import { registry } from "./ops/index.mjs";
import { detectRemediations } from "./remediations.mjs";
import { applyLedger, attemptsKey, dismissalsKey } from "./repair-ledger.mjs";

export async function scanRemediations({ helper, state, catalogService, inventory = null, collect, fileExists, readListeners, notifications = null, dnsResilience = null, operatorReadsWanted = false, visibleJobsGiven = [], now = () => Date.now() }) {
  const facts = { mounts: [], devices: [], containers: [], shares: [], sambaShares: [], apps: [], samba: null, now: Date.now() };
  // File sharing (share folder owners, stat'd as root) and USB history (the kernel's journal) are
  // operator reads (ADR-003). A viewer is not handed what they hold as findings: they are not read
  // on a viewer's behalf, and the scan says which checks it left to an operator (M29.4).
  const operatorReads = Boolean(operatorReadsWanted);
  const [storage, live, samba, usb, unclean, volumes, protection] = await Promise.all([
    collect().catch(() => null),
    helper.request("app.inspect", {}, { timeoutMs: 30_000 }).catch(() => null),
    operatorReads ? helper.request("samba.inspect", {}, { timeoutMs: 30_000 }).catch(() => null) : null,
    operatorReads ? helper.request("storage.usb.events", {}, { timeoutMs: 45_000 }).catch(() => null) : null,
    operatorReads ? helper.request("storage.unclean.events", {}, { timeoutMs: 45_000 }).catch(() => null) : null,
    // What each drive's filesystem says about its last unmount (M26): the kernel's warnings are
    // only evidence for the mount they were printed at.
    operatorReads ? helper.request("storage.volumes.state", {}, { timeoutMs: 90_000 }).catch(() => null) : null,
    // Which apps have a recent backup (M35), the same read Home's backup panel makes.
    helper.request("app.backup.protection", {}, { timeoutMs: 60_000 }).catch(() => null),
  ]);
  facts.usb = usb;
  facts.unclean = unclean;
  facts.volumes = volumes;
  facts.driveTools = null;
  facts.driveChecks = state.getSetting("driveChecks", {}) ?? {};
  if (storage) {
    // findmnt knows what is mounted; fstab knows which of those BoxPilot manages and with what
    // options. Only managed mounts are offered a fix, so a hand-made entry is never touched.
    const byMountpoint = new Map((storage.fstab ?? []).map((row) => [row.mountpoint, row]));
    facts.fstab = (storage.fstab ?? []).map((row) => ({ device: row.device, mountpoint: row.mountpoint, managedName: row.managedName ?? null }));
    facts.mounts = (storage.mounts ?? []).map((mount) => {
      const entry = byMountpoint.get(mount.target);
      return { ...mount, managedName: entry?.managedName ?? null, options: entry?.options ?? null };
    });
    facts.devices = (storage.devices ?? []).filter((device) => device.path).map((device) => ({ path: device.path, transport: device.transport ?? device.tran ?? null }));
    // Whether the exFAT checker exists here at all; asked of the filesystem, not of apt.
    const present = await Promise.all(["/usr/sbin/fsck.exfat", "/sbin/fsck.exfat"].map((file) => fileExists(file)));
    facts.tools = { fsckExfat: present.some(Boolean) };
    // The exact versions the drive-tools fix would install, asked only when a finding offers that
    // fix: an exFAT drive and no fsck.exfat. Asked on every scan, it was eight root processes, two
    // of them apt-cache, on every Repair load of a server that already had the checker.
    if (!facts.tools.fsckExfat && facts.mounts.some((mount) => mount.fstype === "exfat")) {
      facts.driveTools = await helper.request("prerequisite.drive-tools.inspect", {}, { timeoutMs: 30_000 }).catch(() => null);
    }
  }
  if (samba?.configured) {
    const shares = samba.config?.shares ?? [];
    facts.samba = { configured: true, scope: samba.config?.scope ?? "tailscale", shareCount: shares.length, discoveryRunning: Boolean(samba.discovery?.running) };
    // The owner uid comes from the helper, which stats the folder. Deriving it from whether a
    // force user exists made every force-user-less read-write share look unwritable.
    facts.shares = shares
      .filter((share) => Number.isInteger(share.ownerUid))
      .map((share) => ({ name: share.name, path: share.path, readOnly: Boolean(share.readOnly), forceUser: share.forceUser ?? null, ownerUid: share.ownerUid }));
    // Every share, so a fix that unmounts a drive can say which shares it disconnects (M35).
    facts.sambaShares = shares.filter((share) => typeof share.path === "string").map((share) => ({ name: share.name, path: share.path }));
  }
  const verifications = state.getSetting("appBackupVerifications", {}) ?? {};
  const drills = state.getSetting("killSwitchDrills", {}) ?? {};
  const catalogManifests = await catalogService.all().then(({ manifests: all }) => all).catch(() => null);
  const manifests = catalogManifests ?? [];
  facts.apps = (live?.applications ?? []).filter((app) => app.installed).map((app) => ({
    id: app.id,
    name: manifests.find((manifest) => manifest.id === app.id)?.name ?? app.id,
    folderProblems: app.folderProblems ?? [],
    backupVerification: verifications[app.id] ?? null,
    killSwitchDrill: drills[app.id] ?? null,
    installedAt: app.state?.installedAt ?? null,
    container: app.container ?? null,
    // Installed, with no container at all (M35): where the record is, and what is left to rebuild from.
    missingContainer: app.missingContainer ?? (app.container && app.container.exists === false ? { record: `the app's boxpilot.json`, project: "its compose.yaml", projectPresent: true, container: `bp-${app.id}` } : null),
  }));
  // ntfy on this server, for "Nothing BoxPilot notices can reach you" (M35): whether there is one to send to.
  if (catalogManifests?.some((manifest) => manifest.id === "ntfy") && live) {
    const ntfy = (live.applications ?? []).find((app) => app.id === "ntfy");
    facts.ntfy = { installed: Boolean(ntfy?.installed), running: Boolean(ntfy?.container?.running) && ntfy?.container?.status !== "paused" };
  }
  facts.protection = protection;
  const schedules = typeof state.listSchedules === "function" ? state.listSchedules() : [];
  facts.schedules = schedules.map((schedule) => ({ operationId: schedule.operationId, parameters: schedule.parameters ?? {}, enabled: schedule.enabled !== false }));
  // The jobs this caller may see, newest first: the last try at each fix, and when Docker's cleanup ran.
  const visibleJobs = Array.isArray(visibleJobsGiven) ? visibleJobsGiven : [];
  // Each clean-up, and whether a schedule started it (its last job, or a job begun at its time),
  // so an app it removed can be told "removed by the nightly clean-up" (M35).
  const pruneSchedules = schedules.filter((schedule) => schedule.operationId === "docker.prune");
  const scheduleOf = (job) => pruneSchedules.find((schedule) => schedule.lastJobId === job.id) ?? pruneSchedules.find((schedule) => {
    const started = new Date(job.createdAt ?? "");
    return schedule.frequency !== "hourly" && !Number.isNaN(started.getTime()) && started.getHours() === schedule.hour && started.getMinutes() - schedule.minute >= 0 && started.getMinutes() - schedule.minute <= 5;
  }) ?? null;
  // Only a clean-up that ran `docker system prune` removed containers. Since #312 it prunes images,
  // the build cache and networks alone, and says so in the description each job keeps as its
  // recovery reason; one of those is nobody's story.
  const removedContainers = (job) => !/containers are never removed/i.test(String(job.recovery?.reason ?? ""));
  facts.pruneRuns = visibleJobs.filter((job) => job.type === "op:docker.prune" && job.state === "completed" && (job.updatedAt ?? job.createdAt) && removedContainers(job)).map((job) => {
    const schedule = scheduleOf(job);
    return { at: job.updatedAt ?? job.createdAt, scheduled: Boolean(schedule), frequency: schedule?.frequency ?? null };
  });
  const stops = state.getSetting("appStops", {}) ?? {};
  for (const app of facts.apps) app.stoppedAt = stops[app.id]?.at ?? null;
  // The ports each app publishes, against the host's listeners and what Tailscale Serve publishes:
  // Dockge could not start on 2026-09-29 because Serve held its port on the tailnet address. Asked
  // only when an installed app publishes something; the container inventory, which names who holds
  // a port, only when a stopped app's port is actually held.
  for (const app of facts.apps) app.published = live?.applications?.find((entry) => entry.id === app.id)?.published ?? [];
  if (facts.apps.some((app) => app.published.length)) {
    const [listeners, serveState, snapshot] = await Promise.all([
      Promise.resolve().then(() => readListeners()).catch(() => null),
      helper.request("app.serve.inspect", {}, { timeoutMs: 30_000 }).catch(() => null),
      inventory?.inspect ? inventory.inspect().catch(() => null) : null,
    ]);
    facts.listeners = Array.isArray(listeners) ? listeners : null;
    facts.serves = serveState?.available ? serveState.serves ?? [] : [];
    // The home-network address, to say which address a fix keeps or ends: not Docker's bridges, not
    // Tailscale's, not a VM bridge.
    facts.lanAddress = snapshot?.network?.addresses?.find((entry) => /^\d+\.\d+\.\d+\.\d+$/.test(entry.address) && !/^(docker|br-|veth|tailscale|virbr|lxc|cni|flannel|wg|zt)/.test(entry.interface ?? ""))?.address ?? null;
    const heldWhileStopped = facts.apps.some((app) => !app.container?.running && app.published.some((port) => (facts.listeners ?? []).some((listener) => listener.port === port.host && listener.protocol === port.protocol)));
    facts.dockerContainers = heldWhileStopped ? (await helper.request("container.docker.inventory", {}, { timeoutMs: 30_000 }).catch(() => null))?.containers ?? null : null;
  }
  // Which folders each installed app has bound, so a remount can say what needs restarting, and
  // which of those the owner chose, so a split across drives can be spotted. A volume with a
  // `path` is inside the app's own managed directory and is nobody else's business.
  for (const app of facts.apps) {
    const manifest = manifests.find((entry) => entry.id === app.id);
    const stored = live?.applications?.find((entry) => entry.id === app.id)?.state?.values?.volumes ?? {};
    const chosen = (volume) => stored[volume.id] ?? volume.hostPath;
    app.binds = (manifest?.volumes ?? []).map(chosen).filter((bind) => typeof bind === "string" && bind.startsWith("/"));
    app.dataFolders = (manifest?.volumes ?? []).filter((volume) => !volume.path && !volume.readOnly).map(chosen).filter((folder) => typeof folder === "string" && folder.startsWith("/"));
  }
  facts.containers = facts.apps.filter((app) => app.binds.length > 0).map((app) => ({ name: `bp-${app.id}`, appId: app.id, appName: app.name, binds: app.binds, startedAt: app.container?.running ? app.container.startedAt ?? null : null }));
  // A drive mounted after an app using it started: that app holds whatever was there before.
  // Both times are known only from an operator's read of the drives (mountedAt) and Docker.
  facts.remountedTargets = (volumes?.available && Array.isArray(volumes.drives) ? volumes.drives : [])
    .filter((drive) => drive.mounted !== false && drive.mountedAt && facts.containers.some((container) => container.startedAt
      && (container.binds ?? []).some((bind) => bind === drive.mountpoint || bind.startsWith(`${drive.mountpoint}/`))
      && Date.parse(container.startedAt) < Date.parse(drive.mountedAt) - 5_000))
    .map((drive) => drive.mountpoint);
  // Every finding here, and every health condition the watcher tracks, ends at a notification
  // target. Whether there is one is therefore part of whether any of this reaches anybody.
  try { facts.notifications = { configured: notifications?.describe?.().configured === true }; } catch { facts.notifications = null; }
  // Whether the house leans on this server for its DNS (M39.2): the kept answer, or a fresh one
  // bounded so a resolver that does not answer cannot hold Home up. Not having it is not a finding.
  if (dnsResilience) {
    facts.dnsResilience = await Promise.race([
      dnsResilience.check().catch(() => null),
      new Promise((resolve) => { const timer = setTimeout(() => resolve(null), 8_000); timer.unref?.(); }),
    ]);
  }
  const unavailableChecks = [["Drives and mounts", storage, true], ["Applications", live, true], ["File sharing", samba, operatorReads], ["USB history", usb, operatorReads], ["Unclean unmounts", unclean, operatorReads], ["Drive filesystems", volumes, operatorReads], ["App backups", protection, true]]
    .filter(([, value]) => !value || value.available === false)
    .map(([name, , allowed]) => (allowed ? name : `${name} (needs an operator)`));
  if (storage?.availability?.mounts === false) unavailableChecks.push("Current mounts");
  if (storage?.availability?.fstab === false) unavailableChecks.push("Saved mount configuration");
  if (!catalogManifests) unavailableChecks.push("Application definitions");
  if (facts.apps.some((app) => app.published?.length) && !Array.isArray(facts.listeners)) unavailableChecks.push("Ports in use");
  const detected = detectRemediations(facts);
  // Each fix carries its tier from the registry, the same the approval dialog will ask for.
  const tiered = detected.findings.map((entry) => {
    const fixes = entry.fixes.map((fix) => ({ ...fix, risk: registry.get(fix.operationId)?.risk ?? "high" }));
    return { ...entry, fix: fixes[0] ?? null, fixes };
  });
  // What the owner set aside, and the last try at each fix (M35).
  const ledger = applyLedger(tiered, { dismissals: state.getSetting(dismissalsKey, {}) ?? {}, attempts: state.getSetting(attemptsKey, {}) ?? {}, jobs: visibleJobs, mounts: storage && storage.availability?.mounts !== false ? facts.mounts : null });
  const count = (severity) => ledger.findings.filter((entry) => entry.severity === severity).length;
  return {
    findings: ledger.findings, dismissed: ledger.dismissed, jobs: ledger.jobs,
    counts: { critical: count("critical"), warning: count("warning"), info: count("info") },
    checkedAt: new Date(now()).toISOString(), sourceStatus: unavailableChecks.length ? "partial" : "ready", unavailableChecks,
  };
}
