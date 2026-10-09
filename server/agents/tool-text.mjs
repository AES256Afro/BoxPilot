/**
 * What the agents' read tools say (M40): facts stated outright, so a small model has nothing to
 * guess. The owner asked their Server Keeper which drives were connected, and it answered that
 * /dev/sda was the primary drive, 528 GB and 31% used: storage.health had said "Root disk: 31% used,
 * 366 GB free of 528 GB" and named no device at all, so the model filled one in. The 528 GB root was
 * on an NVMe drive through LVM; /dev/sda was a 15 TB exFAT drive on USB.
 *
 * So every line here carries its own subject and its facts together: a drive's line says its
 * device, how it is attached, its size, its model and whether it is the system disk; a
 * filesystem's line says its mountpoint, the drive and device under it, its type, its size, what
 * is used and what is free. A summary comes first, answering the plain question ("2 drives: ...").
 * The same shapes feed the evaluation's expected answers (drivesOf, stoppedAppsOf) and are what the
 * answer check (the harness's check/verify.mjs) holds a claim against, line by line.
 *
 * Everything is read from what BoxPilot already collects: lsblk (the web process runs it), the root
 * storage scan's mounts and SMART, statfs of /, and the helper's app and service reads.
 */

const pseudoFilesystems = new Set(["tmpfs", "devtmpfs", "overlay", "squashfs", "proc", "sysfs", "cgroup", "cgroup2", "efivarfs", "fuse.lxcfs", "nsfs", "tracefs", "debugfs", "securityfs", "pstore", "bpf", "autofs", "mqueue", "hugetlbfs", "configfs", "fusectl", "binfmt_misc", "ramfs", "rpc_pipefs", "nfsd"]);

/** Bytes as a person reads them, decimal like the rest of BoxPilot: 1.02 TB, 528 GB, 2.1 GB, 512 MB. */
export function sizeWords(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "an unknown size";
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(bytes >= 10e12 ? 1 : 2)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 100e9 ? 0 : 1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.round(bytes / 1e3)} kB`;
}

const shortDevice = (name) => String(name ?? "").replace(/^\/dev\//, "");

/** How a drive is attached, in the words a person uses, from lsblk's TRAN and ROTA and its name. */
export function driveKind({ name, transport, rotational }) {
  const tran = String(transport ?? "").toLowerCase();
  const device = shortDevice(name);
  if (tran === "nvme" || /^nvme\d/.test(device)) return { transport: "nvme", words: "NVMe SSD" };
  if (tran === "usb") return { transport: "usb", words: rotational === true ? "USB drive (spinning disk)" : rotational === false ? "USB drive (flash or SSD)" : "USB drive" };
  if (["sata", "ata", "sas", "scsi"].includes(tran)) return { transport: tran === "ata" ? "sata" : tran, words: rotational === true ? `${tran.toUpperCase()} hard disk` : rotational === false ? `${tran.toUpperCase()} SSD` : `${tran.toUpperCase()} drive` };
  if (/^mmcblk\d/.test(device)) return { transport: "mmc", words: "SD card or eMMC" };
  if (/^(vd|xvd)[a-z]/.test(device)) return { transport: "virtual", words: "virtual disk" };
  return { transport: tran || null, words: rotational === true ? "hard disk" : "drive" };
}

/**
 * The storage the snapshot describes, joined up: each whole drive with what it holds, and each
 * mounted filesystem with the drives under it. Nothing is guessed: a field that was not read is
 * null, and the text says so.
 */
export function storageModel(snapshot) {
  const storage = snapshot?.storage ?? {};
  const devices = storage.blockDevices?.available ? storage.blockDevices.devices ?? [] : [];
  const byName = new Map();
  for (const entry of devices) {
    if (!entry?.name || entry.name === "[unavailable]") continue;
    if (!byName.has(entry.name)) byName.set(entry.name, []);
    byName.get(entry.name).push(entry);
  }
  // The whole disks under a device: up through its parents until a disk (an LVM volume over two
  // partitions appears twice in lsblk, once under each, so it may have two).
  const disksOf = (name, seen = new Set()) => {
    if (!name || seen.has(name)) return [];
    seen.add(name);
    const entries = byName.get(name) ?? [];
    const found = [];
    for (const entry of entries) {
      if (entry.type === "disk") found.push(entry.name);
      else if (entry.parent) found.push(...disksOf(entry.parent, seen));
    }
    return [...new Set(found)];
  };
  // What sits between a filesystem's device and its disk: a partition, an LVM volume, an encrypted one.
  const layerOf = (name) => {
    const entry = byName.get(name)?.[0];
    if (!entry) return null;
    if (entry.type === "lvm") return "LVM volume";
    if (entry.type === "crypt") return "encrypted volume";
    if (entry.type === "part") return "partition";
    if (/^raid/.test(entry.type ?? "")) return `${entry.type.toUpperCase()} array`;
    return null;
  };

  const smartDisks = storage.smart?.disks ?? [];
  const smartOf = (device) => smartDisks.find((disk) => disk.device === device) ?? null;

  // Filesystems: the root scan's mounts when it is fresh (sizes and use), else lsblk's mountpoints.
  let filesystems = [];
  const scanned = storage.filesystems?.available ? storage.filesystems.mounts ?? [] : [];
  if (scanned.length) {
    filesystems = scanned.filter((mount) => !pseudoFilesystems.has(mount.filesystem) && String(mount.target ?? "").startsWith("/")).map((mount) => ({
      mountpoint: mount.target, source: mount.source && mount.source.startsWith("/dev/") ? mount.source : null, filesystem: mount.filesystem && mount.filesystem !== "unknown" ? mount.filesystem : null,
      totalBytes: mount.totalBytes ?? null, usedBytes: mount.usedBytes ?? null, availableBytes: mount.availableBytes ?? null, usedPercent: mount.usedPercent ?? null,
      readOnly: Boolean(mount.readOnly), capacityState: mount.capacityState ?? null, measured: true,
    }));
  } else {
    for (const entry of devices) {
      for (const target of entry.mountTargets ?? []) {
        if (!target.startsWith("/") || target.startsWith("/snap/") || pseudoFilesystems.has(entry.filesystem)) continue;
        if (filesystems.some((mount) => mount.mountpoint === target)) continue;
        filesystems.push({ mountpoint: target, source: entry.name, filesystem: entry.filesystem ?? null, totalBytes: entry.sizeBytes ?? null, usedBytes: null, availableBytes: null, usedPercent: null, readOnly: Boolean(entry.readOnly), capacityState: null, measured: false });
      }
    }
  }
  // The root filesystem's use comes from statfs of / on every read, fresher than any scan.
  const root = storage.root ?? null;
  let rootMount = filesystems.find((mount) => mount.mountpoint === "/");
  if (!rootMount && root) {
    const device = devices.find((entry) => (entry.mountTargets ?? []).includes("/"));
    rootMount = { mountpoint: "/", source: device?.name ?? null, filesystem: device?.filesystem ?? null, readOnly: false, capacityState: null };
    filesystems.unshift(rootMount);
  }
  if (rootMount && root && Number.isFinite(root.totalBytes)) {
    Object.assign(rootMount, { totalBytes: root.totalBytes, availableBytes: root.freeBytes ?? null, usedBytes: Number.isFinite(root.usedBytes) ? root.usedBytes : Number.isFinite(root.freeBytes) ? root.totalBytes - root.freeBytes : null, usedPercent: root.usedPercent ?? null, measured: true });
  }
  // A mount whose source lsblk does not name (a loop, the LVM name spelled another way) still
  // finds its device through lsblk's own mountpoints.
  for (const mount of filesystems) {
    if (!mount.source || !byName.has(mount.source)) {
      const holder = devices.find((entry) => (entry.mountTargets ?? []).includes(mount.mountpoint));
      if (holder) mount.source = holder.name;
    }
    mount.disks = mount.source ? disksOf(mount.source) : [];
    mount.layer = mount.source && !mount.disks.includes(mount.source) ? layerOf(mount.source) : null;
    mount.filesystem ??= byName.get(mount.source)?.[0]?.filesystem ?? null;
    // Inside the web service's sandbox (PrivateDevices=yes) lsblk lists no device-mapper volume: the
    // root's LVM volume is missing, and only the partition it lives on is there, as LVM2_member (or
    // crypto_LUKS for an encrypted one). A mapper volume lsblk does not show is on those partitions.
    if (!mount.disks.length && /^\/dev\/(mapper\/|dm-)/.test(mount.source ?? "")) {
      const members = devices.filter((entry) => ["LVM2_member", "crypto_LUKS"].includes(entry.filesystem));
      const lvm = members.filter((entry) => entry.filesystem === "LVM2_member");
      const holders = lvm.length ? lvm : members;
      if (holders.length) {
        mount.disks = [...new Set(holders.flatMap((entry) => disksOf(entry.name)))];
        mount.layer = holders[0].filesystem === "LVM2_member" ? "LVM volume" : "encrypted volume";
        mount.members = holders.map((entry) => entry.name);
      }
    }
  }
  filesystems.sort((a, b) => Number(b.mountpoint === "/") - Number(a.mountpoint === "/") || a.mountpoint.localeCompare(b.mountpoint));

  const systemDisks = new Set(rootMount?.disks ?? []);
  const drives = devices.filter((entry) => entry.type === "disk" && !/^\/dev\/(loop|zram|ram|sr)\d/.test(entry.name))
    .filter((entry, index, all) => all.findIndex((other) => other.name === entry.name) === index)
    .map((entry) => {
      const kind = driveKind(entry);
      return {
        device: entry.name, short: shortDevice(entry.name), transport: kind.transport, kind: kind.words, model: entry.model || null,
        sizeBytes: entry.sizeBytes ?? null, rotational: entry.rotational, readOnly: entry.readOnly === true,
        system: systemDisks.has(entry.name),
        mounts: filesystems.filter((mount) => mount.disks.includes(entry.name)).map((mount) => mount.mountpoint),
        smart: smartOf(entry.name),
      };
    });
  // A drive SMART knows but lsblk did not list (lsblk could not run): still named.
  for (const disk of smartDisks) {
    if (drives.some((drive) => drive.device === disk.device)) continue;
    const kind = driveKind({ name: disk.device, transport: disk.transport, rotational: null });
    drives.push({ device: disk.device, short: shortDevice(disk.device), transport: kind.transport, kind: kind.words, model: null, sizeBytes: null, rotational: null, readOnly: false, system: systemDisks.has(disk.device), mounts: [], smart: disk });
  }
  drives.sort((a, b) => Number(b.system) - Number(a.system) || a.device.localeCompare(b.device));
  return { drives, filesystems, root: rootMount ?? null, lsblk: Boolean(storage.blockDevices?.available), scanned: scanned.length > 0, smart: storage.smart ?? null };
}

/** The drives as an evaluation expects them named: device, how attached, whether it holds the system. */
export function drivesOf(snapshot) {
  const model = storageModel(snapshot);
  if (!model.drives.length) return null;
  return model.drives.map((drive) => ({ device: drive.device, transport: drive.transport, system: drive.system, sizeBytes: drive.sizeBytes, mounts: drive.mounts }));
}

function smartWords(disk) {
  if (!disk) return null;
  if (disk.health === "unavailable") {
    if (disk.reason === "usb-bridge-unsupported") return "SMART: not readable through its USB enclosure";
    // A spinning disk that sleeps when idle is doing what it should, and BoxPilot leaves it asleep
    // on purpose (M36). "Asleep and not woken" read to the Environment Scout as a fault (A-2).
    if (disk.reason === "asleep") return `SMART: spun down to save power, which is normal for an idle disk; its health was not read so as not to wake it${disk.lastHealth ? `; last reading ${disk.lastHealth}${disk.lastReadAt ? ` on ${disk.lastReadAt.slice(0, 10)}` : ""}` : ""}`;
    return "SMART: could not be read";
  }
  const parts = [`SMART: ${disk.health}`];
  if (Number.isFinite(disk.temperatureCelsius)) parts.push(`${disk.temperatureCelsius} °C`);
  if (Number.isFinite(disk.percentageUsed)) parts.push(`${disk.percentageUsed}% of rated wear used`);
  if (Number.isFinite(disk.mediaErrors) && disk.mediaErrors > 0) parts.push(`${disk.mediaErrors} media errors`);
  return parts.join(", ");
}

const fullness = (mount) => (mount.capacityState === "critical" ? " (nearly full)" : mount.capacityState === "warning" ? " (getting full)" : "");

/**
 * storage.health: the two things asked most, first - which drives, and the root filesystem on its
 * drive - then each drive's line, then every other real filesystem, each line with its own facts.
 */
export function describeStorage(snapshot) {
  if (!snapshot?.storage) return "Storage could not be read.";
  const model = storageModel(snapshot);
  const lines = [];
  const driveName = (short) => model.drives.find((drive) => drive.short === shortDevice(short)) ?? null;
  const system = model.drives.find((drive) => drive.system) ?? null;
  const mountLine = (mount, bullet = "- ") => {
    const drives = mount.disks.map((short) => driveName(short)).filter(Boolean);
    const where = drives.length
      ? `on ${drives.map((drive) => `${drive.device} (${drive.kind}${drive.system ? ", the system disk" : ""})`).join(" and ")}${mount.layer ? ` through ${mount.layer} ${mount.source}${mount.members ? ` on ${mount.members.join(" and ")}` : ""}` : mount.source && !drives.some((drive) => drive.device === mount.source) ? ` as ${mount.source}` : ""}`
      : mount.source ? `on ${mount.source}` : "on a device that was not read";
    const use = mount.measured && Number.isFinite(mount.totalBytes)
      ? `${sizeWords(mount.totalBytes)} in total, ${Number.isFinite(mount.usedBytes) ? `${sizeWords(mount.usedBytes)} used` : "use unknown"}${Number.isFinite(mount.usedPercent) ? ` (${mount.usedPercent}%)` : ""}, ${Number.isFinite(mount.availableBytes) ? `${sizeWords(mount.availableBytes)} free` : "free space unknown"}${fullness(mount)}`
      : `how full it is was not read (the storage scan has not run in the last day)${Number.isFinite(mount.totalBytes) ? `; the device is ${sizeWords(mount.totalBytes)}` : ""}`;
    return `${bullet}${mount.mountpoint}${mount.mountpoint === "/" ? " (the root filesystem)" : ""}: ${where}, ${mount.filesystem ?? "type unknown"}${mount.readOnly ? ", mounted read-only" : ""}, ${use}.`;
  };

  if (model.drives.length) {
    const summary = model.drives.map((drive) => `${drive.device} (${drive.kind}, ${sizeWords(drive.sizeBytes)}${drive.system ? ", the system disk" : ""})`);
    lines.push(`${model.drives.length} ${model.drives.length === 1 ? "drive" : "drives"} connected: ${summary.length > 1 ? `${summary.slice(0, -1).join(", ")} and ${summary.at(-1)}` : summary[0]}.`);
  } else {
    lines.push(`Which drives are connected could not be read (lsblk ${model.lsblk ? "listed no disks" : "did not answer"}).`);
  }
  if (model.root) lines.push(mountLine(model.root, ""));
  else lines.push("The root filesystem could not be read.");
  if (model.root && !system) lines.push("Which drive holds / could not be worked out.");

  if (model.drives.length) {
    lines.push("Drives:");
    for (const drive of model.drives) {
      const holds = drive.mounts.length ? `Holds ${drive.mounts.join(", ")}.` : "Nothing on it is mounted.";
      const facts = [
        `- ${drive.device}: ${drive.kind}, ${sizeWords(drive.sizeBytes)}${drive.model ? `, model ${drive.model}` : ""}${drive.readOnly ? ", read-only" : ""}.`,
        drive.system ? "The system disk: it holds / (the root filesystem)." : "Not the system disk.",
        holds,
        smartWords(drive.smart) ? `${smartWords(drive.smart)}.` : null,
      ];
      lines.push(facts.filter(Boolean).join(" "));
    }
  }

  const others = model.filesystems.filter((mount) => mount.mountpoint !== "/");
  const shown = others.slice(0, 12);
  if (shown.length) {
    lines.push(`Other filesystems mounted: ${others.length}.`);
    for (const mount of shown) lines.push(mountLine(mount));
    if (others.length > shown.length) lines.push(`(${others.length - shown.length} more not shown.)`);
  } else if (!model.filesystems.length) {
    lines.push("Mounted filesystems could not be read.");
  }

  const smart = model.smart;
  if (smart) {
    const summary = smart.summary ?? {};
    // Of those not read, the ones left asleep: said, so "not read" is not taken for a fault (A-2).
    const sleeping = (smart.disks ?? []).filter((disk) => disk?.health === "unavailable" && disk.reason === "asleep").length;
    lines.push(smart.available
      ? `Drive health (SMART): ${smart.status}: ${summary.healthy ?? 0} healthy, ${summary.warning ?? 0} warning, ${summary.critical ?? 0} critical, ${summary.unavailable ?? 0} not read${sleeping ? ` (${sleeping} spun down to save power, which is normal)` : ""}${smart.generatedAt ? `; checked ${smart.generatedAt}` : ""}.`
      : smart.reason === "disks-asleep" ? "Drive health (SMART): not read, because every disk was spun down to save power, which is normal; BoxPilot does not wake them to ask."
        : "Drive health (SMART): not read (the storage scan has not run, or smartctl is missing).");
  }
  return lines.join("\n");
}

/** The OS name and version from PRETTY_NAME: "Ubuntu 24.04.3 LTS" is Ubuntu, version 24.04.3. */
export function osVersion(pretty) {
  const text = String(pretty ?? "").trim();
  const version = /\b(\d+(?:\.\d+){0,2})\b/.exec(text)?.[1] ?? null;
  const name = text.split(/\s+/)[0] || null;
  return { name, version, pretty: text || null };
}

const hoursWords = (seconds) => (Number.isFinite(seconds) ? `${Math.floor(seconds / 86_400)} days ${Math.floor((seconds % 86_400) / 3600)} hours` : "unknown");

/** server.facts: one fact a line, each named. */
export function describeServer(snapshot) {
  const { host = {}, compute = {}, network = {}, services = [] } = snapshot ?? {};
  const os = osVersion(host.operatingSystem);
  const addresses = (network.addresses ?? []).slice(0, 8).map((entry) => `${entry.interface} ${entry.address}`).join(", ");
  return [
    `Hostname: ${host.hostname ?? "unknown"}.`,
    `Operating system: ${os.pretty ?? "unknown"}${os.name && os.version ? ` (${os.name}, version ${os.version})` : ""}.`,
    `Kernel: ${host.kernel ?? "unknown"} (${host.architecture ?? "?"}).`,
    `Up for ${hoursWords(host.uptimeSeconds)}.`,
    `Processor: ${compute.cpuModel ?? "unknown"}, ${compute.cpuCount ?? "?"} logical processors; load ${Number(compute.load1 ?? 0).toFixed(2)} over the last minute (${compute.loadPercent ?? "?"}% of them).`,
    `Memory: ${sizeWords(compute.usedMemoryBytes)} used of ${sizeWords(compute.totalMemoryBytes)} (${compute.memoryUsedPercent ?? "?"}%).`,
    `Network addresses: ${addresses || "none read"}.`,
    `Tailscale: ${network.tailscale?.connected ? `connected as ${network.tailscale.dnsName ?? "unknown"}` : network.tailscale?.installed ? "installed, not connected" : "not installed"}.`,
    `BoxPilot's key services: ${services.map((service) => `${service.unit} ${service.active}`).join(", ") || "not read"}.`,
  ].join("\n");
}

/** Whether an app's container is running, stopped (exited, created, absent) or restarting. */
export function appRunState(app) {
  const container = app?.container ?? {};
  if (container.running && container.status !== "restarting") return "running";
  if (container.status === "restarting") return "restarting";
  if (container.exists === false || container.status === "absent") return "stopped (no container)";
  return `stopped (${container.status ?? "not running"})`;
}

/**
 * Why an app that is not running is stopped (M44), from BoxPilot's own record of the owner's stops
 * (the `appStops` setting, server/app-stops.mjs: kept per app because jobs are pruned within weeks):
 * - "owner": the owner stopped it from BoxPilot (the app's Stop button, app.action stop) on `at`;
 * - "never-started": its container was made and never started (Repair's "Recreate (stays stopped)");
 * - "unknown": no stop is recorded - it crashed, or something outside BoxPilot stopped it.
 * A running app has none, and one that keeps restarting is never stopped on purpose.
 */
export function stopReasonOf(app, stops = {}) {
  const state = appRunState(app);
  if (state === "running" || state === "restarting") return null;
  const stop = stops?.[app?.id];
  if (stop) return { kind: "owner", at: typeof stop.at === "string" ? stop.at : null };
  if (app?.container?.status === "created") return { kind: "never-started", at: null };
  return { kind: "unknown", at: null };
}
const onPurpose = (reason) => reason?.kind === "owner" || reason?.kind === "never-started";

/** The installed apps whose container is not running, by id: what "which apps are stopped" means. */
export function stoppedAppsOf(applications) {
  if (!Array.isArray(applications)) return null;
  return applications.filter((app) => app?.installed && appRunState(app) !== "running").map((app) => app.id);
}

/** Whether apps.list calls an app unhealthy: its container's health check says unhealthy, or not yet healthy. */
const unhealthy = (app) => ["unhealthy", "starting"].includes(app?.container?.health);

/** The installed apps apps.list lists as unhealthy, by id: what "which apps are unhealthy" means (M43). */
export function unhealthyAppsOf(applications) {
  if (!Array.isArray(applications)) return null;
  return applications.filter((app) => app?.installed && unhealthy(app)).map((app) => app.id);
}

/** The installed apps with an update available, by id (M43). */
export function appUpdatesOf(applications) {
  if (!Array.isArray(applications)) return null;
  return applications.filter((app) => app?.installed && app.updateAvailable).map((app) => app.id);
}

/** The systemd units that have failed, as services.status names them (M43). */
export function failedServicesOf(units) {
  if (!Array.isArray(units)) return null;
  return units.filter((entry) => entry?.active === "failed" && entry.unit).map((entry) => entry.unit);
}

/**
 * apps.list: the counts and the stopped ones first, then one line an app. `stops` is BoxPilot's
 * record of the apps the owner stopped (M44): such an app, or one never started, is said to be
 * stopped on purpose, apart from the ones down for no recorded reason, so a survey does not call
 * the owner's choice a problem.
 */
export function describeApps(applications, others = [], { stops = {} } = {}) {
  const lines = [];
  if (Array.isArray(applications)) {
    const installed = applications.filter((app) => app?.installed);
    const stopped = installed.filter((app) => appRunState(app) !== "running");
    const sick = installed.filter(unhealthy);
    const reasons = new Map(stopped.map((app) => [app.id, stopReasonOf(app, stops)]));
    const purposeful = stopped.filter((app) => onPurpose(reasons.get(app.id)));
    const down = stopped.filter((app) => !onPurpose(reasons.get(app.id)));
    const split = stopped.length ? ` Of those, stopped on purpose (by the owner, or never started): ${purposeful.length ? purposeful.map((app) => app.id).join(", ") : "none"}; not running for another reason: ${down.length ? down.map((app) => app.id).join(", ") : "none"}.` : "";
    lines.push(`BoxPilot apps installed: ${installed.length}. Running: ${installed.length - stopped.length}. Stopped or not running: ${stopped.length ? `${stopped.length} (${stopped.map((app) => app.id).join(", ")})` : "none"}.${split} Unhealthy: ${sick.length ? sick.map((app) => app.id).join(", ") : "none"}.`);
    // The ones to look at first: down for no recorded reason, then unhealthy, then stopped on purpose, then the rest.
    const ordered = [...down, ...sick.filter((app) => !stopped.includes(app)), ...purposeful, ...installed.filter((app) => !stopped.includes(app) && !sick.includes(app))];
    for (const app of ordered.slice(0, 40)) {
      const container = app.container ?? {};
      const reason = reasons.get(app.id) ?? null;
      // Said after the facts, as a sentence of its own, so the line still starts with what it is.
      const why = reason?.kind === "owner" ? ` Stopped on purpose: the owner stopped it from BoxPilot${reason.at ? ` on ${reason.at.slice(0, 10)}` : ""}; not a fault.`
        : reason?.kind === "never-started" ? " Stopped on purpose: never started since its container was made; not a fault."
          : reason?.kind === "unknown" ? " No stop is recorded in BoxPilot: it may have crashed, or been stopped outside BoxPilot." : "";
      const parts = [appRunState(app)];
      if (container.health && container.health !== "none") parts.push(`health ${container.health}`);
      parts.push(`${Number(container.restarts) || 0} restarts`);
      const helpers = (app.sidecars ?? []).filter((sidecar) => !sidecar.running);
      if (helpers.length) parts.push(`helper containers not running: ${helpers.map((sidecar) => sidecar.id).join(", ")}`);
      const ports = (app.urls ?? []).map((url) => url.host).filter((port) => Number.isInteger(port));
      if (ports.length) parts.push(`web port ${ports.join(", ")}`);
      if (app.updateAvailable) parts.push("update available");
      if ((app.folderProblems ?? []).length) parts.push(`${app.folderProblems.length} data folder(s) it cannot write to`);
      lines.push(`- ${app.id}${app.name && app.name.toLowerCase() !== app.id ? ` (${app.name})` : ""}: ${parts.join(", ")}; container bp-${app.id}.${why}`);
    }
    if (installed.length > 40) lines.push(`(${installed.length - 40} more not shown.)`);
  } else {
    lines.push("Which BoxPilot apps are installed could not be read.");
  }
  if (others.length) lines.push(`Other Docker containers, not installed by BoxPilot: ${others.slice(0, 20).map((container) => `${container.name} (image ${container.image}, ${container.state}${container.health && container.health !== "none" ? `, ${container.health}` : ""})`).join("; ")}.`);
  return lines.join("\n");
}

/**
 * Where something runs: a BoxPilot app, another Docker container, or a systemd unit on the host,
 * as a list of places (the evaluation's expected answer) and as text (where.runs).
 */
export function locate(name, { applications = null, containers = null, units = null } = {}) {
  const wanted = String(name ?? "").toLowerCase().replace(/[\s._-]+/g, "");
  const matches = (value) => Boolean(wanted) && String(value ?? "").toLowerCase().replace(/[\s._-]+/g, "").includes(wanted);
  const places = [];
  for (const app of (applications ?? []).filter((entry) => entry?.installed && (matches(entry.id) || matches(entry.name)))) {
    places.push({ kind: "boxpilot-app", id: app.id, container: `bp-${app.id}`, state: appRunState(app) });
  }
  for (const container of (containers ?? []).filter((entry) => !String(entry.name ?? "").startsWith("bp-") && (matches(entry.name) || matches(entry.image)))) {
    places.push({ kind: "container", id: container.name, image: container.image, state: container.state });
  }
  for (const unit of (units ?? []).filter((entry) => matches(String(entry.unit ?? "").replace(/\.(service|timer|socket|mount)$/, "")))) {
    places.push({ kind: "host", id: unit.unit, state: `${unit.active} (${unit.sub})` });
  }
  return places;
}

/** The placement an evaluation checks: the first place found, or absent. */
export const placementOf = (places) => (places?.[0]?.kind ?? "absent");

export function describePlaces(name, places, { unread = false } = {}) {
  if (!places.length) return `Nothing called "${name}" runs on this server: no BoxPilot app, no Docker container and no systemd unit by that name.${unread ? " (Some of these could not be read.)" : ""}`;
  const first = places[0];
  const headline = {
    "boxpilot-app": `${first.id} runs as a BoxPilot app, in the Docker container ${first.container} on this server (not natively on the host).`,
    container: `${first.id} runs as a Docker container that BoxPilot did not install (not natively on the host).`,
    host: `${first.id} runs natively on the host as a systemd unit (not in a container).`,
  }[first.kind];
  const lines = [`Where "${name}" runs: ${headline}`];
  for (const place of places.slice(0, 12)) {
    if (place.kind === "boxpilot-app") lines.push(`- BoxPilot app ${place.id}: container ${place.container}, ${place.state}.`);
    else if (place.kind === "container") lines.push(`- Docker container ${place.id}, not installed by BoxPilot: image ${place.image}, ${place.state}.`);
    else lines.push(`- systemd unit ${place.id} on the host: ${place.state}.`);
  }
  return lines.join("\n");
}

// ---- M47: eyes on what the agents could not see - the firewall, package updates, brute-force protection, accounts, the tunnel, Repair ----

const plural = (count, word, words = `${word}s`) => `${count} ${count === 1 ? word : words}`;

/** firewall.status: whether ufw is on, its default policies, and each rule on a line. */
export function describeFirewall(result) {
  if (!result) return "The firewall could not be read.";
  if (!result.installed) return "Firewall: ufw is not installed on this server, so no host firewall is in place (Docker publishes its ports regardless).";
  const state = result.enabled === true ? "on" : result.enabled === false ? "off" : "state unknown";
  const defaults = result.defaults ? ` Default policy: incoming ${result.defaults.incoming ?? "?"}, outgoing ${result.defaults.outgoing ?? "?"}, routed ${result.defaults.routed ?? "?"}.` : "";
  const rules = Array.isArray(result.rules) ? result.rules : [];
  const lines = [`Firewall: ufw is installed and ${state}.${defaults} ${plural(rules.length, "rule")} configured.${result.dockerRules ? " Docker's own rules are in place, so a published container port is reachable whatever ufw says." : ""}`];
  for (const rule of rules.slice(0, 40)) {
    if (rule.raw && !rule.action) { lines.push(`- ${rule.raw}`); continue; }
    const what = rule.app ? rule.app : rule.port ? `${rule.port}${rule.protocol && rule.protocol !== "any" ? `/${rule.protocol}` : ""}` : "anything";
    lines.push(`- ${rule.action ?? "?"} ${rule.direction === "out" ? "out to" : "in to"} ${what}${rule.source ? ` from ${rule.source}` : " from anywhere"}${rule.interface ? ` on ${rule.interface}` : ""}${rule.family === "v6" ? " (IPv6)" : ""}${rule.comment ? ` - ${rule.comment}` : ""}`);
  }
  if (rules.length > 40) lines.push(`(${rules.length - 40} more rules not shown.)`);
  if (!rules.length && result.enabled) lines.push("No rules: with the default policy above, that is what applies to every port.");
  return lines.join("\n");
}

/** updates.status: how many packages wait, how many of them security, whether a reboot waits, which services run old libraries. */
export function describeUpdates(result) {
  if (!result) return "Package updates could not be read.";
  const items = Array.isArray(result.upgradable) ? result.upgradable : [];
  const count = Number.isInteger(result.count) ? result.count : items.length;
  const security = Number.isInteger(result.securityCount) ? result.securityCount : items.filter((item) => /security/i.test(item.suite ?? "")).length;
  const lines = [`Package updates waiting: ${count === 0 ? "none" : plural(count, "package")}${count ? `, ${security} of them security updates` : ""}. Reboot required: ${result.rebootRequired ? "yes" : "no"}.`];
  if (Array.isArray(result.servicesNeedingRestart)) lines.push(result.servicesNeedingRestart.length ? `Services still running old libraries (needrestart): ${result.servicesNeedingRestart.slice(0, 15).join(", ")}.` : "No service is running old libraries (needrestart).");
  else if (result.needrestartPresent === false) lines.push("Which services run old libraries is not known: needrestart is not installed.");
  for (const item of items.slice(0, 30)) lines.push(`- ${item.name}: ${item.installed ?? "?"} -> ${item.candidate ?? "?"}${item.suite ? ` (${item.suite})` : ""}`);
  if (items.length > 30) lines.push(`(${items.length - 30} more not shown.)`);
  return lines.join("\n");
}

/** protection.status: fail2ban, as the Firewall page shows it. */
export function describeProtection(result) {
  if (!result) return "Brute-force protection could not be read.";
  if (!result.installed) return "Brute-force protection: fail2ban is not installed, so repeated failed SSH logins are not banned.";
  const config = result.config ?? {};
  const settings = result.configured ? ` BoxPilot's sshd jail: ban after ${config.maxRetry ?? "?"} failures within ${config.findTimeMinutes ?? "?"} minutes, for ${config.banTimeMinutes ?? "?"} minutes${config.ignoreLan ? ", the home network never banned" : ""}.` : " BoxPilot has not written its sshd jail; fail2ban runs with whatever jails it has.";
  const banned = Number.isInteger(result.currentlyBanned) ? ` Banned right now: ${result.currentlyBanned}; banned in all: ${result.totalBanned ?? "?"}.` : "";
  return `Brute-force protection: fail2ban is installed and ${result.running === true ? "running" : result.running === false ? "not running" : "in an unknown state"}.${settings}${banned}`;
}

/** users.access: the accounts, who has sudo and keys, and how SSH is set. No key, hash or secret is in it. */
export function describeUsers(result) {
  if (!result) return "Users and SSH access could not be read.";
  const users = Array.isArray(result.users) ? result.users : [];
  const lines = [`${plural(users.length, "account")} that can log in${users.length ? `: ${users.map((user) => `${user.name}${user.sudo ? " (sudo)" : ""}${Number.isInteger(user.keyCount) ? `, ${plural(user.keyCount, "SSH key")}` : ""}`).join("; ")}` : ""}.`];
  const sshd = result.sshd;
  if (sshd) lines.push(`SSH (${result.sshActive === false ? "not running" : "running"}) on port ${sshd.port ?? 22}: password login ${sshd.passwordAuthentication ? "allowed" : "off"}, keys ${sshd.pubkeyAuthentication === false ? "off" : "allowed"}, root login ${sshd.permitRootLogin ?? "unknown"}.`);
  else lines.push(`SSH settings could not be read${result.sshActive === false ? "; the SSH service is not running" : ""}.`);
  return lines.join("\n");
}

/** tunnel.exposure: what the Cloudflare tunnel publishes to the internet, from BoxPilot's own record. */
export function describeTunnel(result) {
  if (!result) return "The Cloudflare tunnel could not be read.";
  if (!result.connected && !result.tunnel) return "Cloudflare is not connected: nothing is published to the internet through a tunnel from BoxPilot.";
  const routes = Array.isArray(result.routes) ? result.routes : [];
  const lines = [`Cloudflare tunnel ${result.tunnel?.name ?? "(unnamed)"}: ${result.connected ? "connected" : "the API token is gone; what is published keeps working"}. Published to the internet: ${routes.length ? plural(routes.length, "address", "addresses") : "nothing"}.`];
  for (const route of routes.slice(0, 30)) lines.push(`- ${route.hostname}: ${route.appId ?? route.service ?? "?"}${route.hostPort ? ` (port ${route.hostPort})` : ""}${route.publishedAt ? `, since ${String(route.publishedAt).slice(0, 10)}` : ""}`);
  return lines.join("\n");
}

/** repair.findings: the Repair Center's list, as the page shows it, worst first; each with its fix or what to do by hand. */
export function describeRepair(scan) {
  if (!scan) return "Repair's findings could not be read.";
  const findings = Array.isArray(scan.findings) ? scan.findings : [];
  const counts = scan.counts ?? {};
  const lines = [`Repair: ${findings.length === 0 ? "nothing to fix" : `${plural(findings.length, "finding")} (${counts.critical ?? 0} critical, ${counts.warning ?? 0} warning, ${counts.info ?? 0} info)`}${Array.isArray(scan.dismissed) && scan.dismissed.length ? `; ${scan.dismissed.length} set aside by the owner` : ""}.`];
  const order = { critical: 0, warning: 1, info: 2 };
  for (const finding of [...findings].sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3)).slice(0, 20)) {
    const fix = finding.fix ? ` Fix offered: ${finding.fix.label ?? finding.fix.operationId}${finding.fix.risk ? ` (${finding.fix.risk} risk)` : ""}.` : finding.manual ? ` By hand: ${String(finding.manual).slice(0, 200)}` : finding.view ? ` Page: ${finding.view}.` : "";
    lines.push(`- [${finding.severity}] ${finding.title}${finding.detail ? `: ${String(finding.detail).replace(/\s+/g, " ").slice(0, 300)}` : ""}${fix}`);
  }
  if (findings.length > 20) lines.push(`(${findings.length - 20} more not shown.)`);
  if (Array.isArray(scan.unavailableChecks) && scan.unavailableChecks.length) lines.push(`Not checked this time: ${scan.unavailableChecks.join(", ")}.`);
  return lines.join("\n");
}
