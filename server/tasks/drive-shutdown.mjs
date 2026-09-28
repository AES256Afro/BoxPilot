import { readdir, readFile, readlink, rename, unlink, writeFile } from "node:fs/promises";
import { mountpointFor } from "../backup-mount.mjs";
import { fixedRun } from "../exec.mjs";
import { exfatVolumeFlags, parseManagedFstab, processesUsing, readBootSector, unmountFromHost, withDockerOrder } from "./storage.mjs";

/**
 * Drives and shutdowns (M26): giving existing drive entries the Docker ordering new ones get, the
 * steps BoxPilot's own reboot takes before it reboots, and what each drive's filesystem says
 * about how it was last unmounted.
 *
 * Root-side, run by scripts/boxpilot-run.mjs inside boxpilot-run@.service. That unit has
 * PrivateTmp=, which gives it a mount namespace of its own whose unmounts do not reach the host,
 * so a drive is unmounted with unmountFromHost (umount -N /proc/1/ns/mnt) and everything about
 * what is mounted is asked of PID 1's namespace (findmnt --task 1).
 */

const fstabPath = "/etc/fstab";
const candidatePath = "/etc/fstab.boxpilot-new";
const binaries = {
  findmnt: process.env.BOXPILOT_FINDMNT_BINARY ?? "/usr/bin/findmnt",
  systemctl: process.env.BOXPILOT_SYSTEMCTL_BINARY ?? "/usr/bin/systemctl",
  docker: process.env.BOXPILOT_DOCKER_BINARY ?? "/usr/bin/docker",
  dumpe2fs: "/usr/sbin/dumpe2fs",
  blkid: "/usr/sbin/blkid",
  sync: "/usr/bin/sync",
};
const tail = (text) => String(text ?? "").split("\n").filter(Boolean).slice(-3).join(" ");
/** Filesystems reached over a network. Their entries are shares, with their own ordering (_netdev), and are left alone. */
const networkFilesystems = new Set(["cifs", "smb3", "smbfs", "nfs", "nfs4", "sshfs", "fuse.sshfs", "glusterfs", "ceph", "9p", "davfs"]);

/** The unit systemd names a mount at `mountpoint` (systemd-escape --path --suffix=mount). */
export function mountUnitName(mountpoint) {
  const trimmed = String(mountpoint ?? "").replace(/^\/+|\/+$/g, "");
  if (!trimmed) return "-.mount";
  const escaped = [...trimmed].map((char, index) => {
    if (char === "/") return "-";
    if (/[A-Za-z0-9:_]/.test(char) || (char === "." && index > 0)) return char;
    return [...Buffer.from(char, "utf8")].map((byte) => `\\x${byte.toString(16).padStart(2, "0")}`).join("");
  });
  return `${escaped.join("")}.mount`;
}

/**
 * The drives BoxPilot manages, and why any other marked entry is not one. A marker owns the line
 * after it; shares (`share-<name>`) and the swap file have their own markers and their own
 * operations, and an entry that is not a local filesystem at its mount point (/mnt/<name>, or the
 * backup destination's: see mountpointFor) is somebody's hand edit.
 */
export function managedDriveEntries(content) {
  const lines = String(content ?? "").split("\n");
  return parseManagedFstab(content).map(({ name, markerIndex }) => {
    const index = markerIndex + 1;
    const tokens = lines[index].split(/(\s+)/);
    const fieldAt = tokens.map((token, position) => (token && !/^\s+$/.test(token) ? position : -1)).filter((position) => position >= 0);
    const [source, mountpoint, fstype, options] = fieldAt.map((position) => tokens[position]);
    const entry = { name, index, tokens, optionsAt: fieldAt[3], source, mountpoint: mountpoint ?? null, fstype: fstype ?? null, options: options ?? null };
    const skipped = (reason) => ({ ...entry, drive: false, reason });
    if (name.startsWith("share-")) return skipped("a network share");
    if (name === "swap") return skipped("the swap file");
    if (lines[index].trim().startsWith("#") || fieldAt.length < 4) return skipped("not an fstab entry");
    if (mountpoint !== mountpointFor(name)) return skipped(`not mounted at ${mountpointFor(name)}`);
    if (networkFilesystems.has(fstype) || options.split(",").includes("_netdev")) return skipped("a network filesystem");
    if (fstype === "swap") return skipped("swap");
    return { ...entry, drive: true, reason: null };
  });
}

/**
 * The fstab with the Docker ordering added to every managed drive entry that lacks it. Only the
 * options field of those lines changes; every other byte, the spacing between fields included,
 * is kept, and running it on its own output changes nothing.
 */
export function planDockerOrder(content) {
  const lines = String(content ?? "").split("\n");
  const drives = managedDriveEntries(content).map((entry) => {
    if (!entry.drive) return { name: entry.name, mountpoint: entry.mountpoint, status: "skipped", reason: entry.reason };
    const options = withDockerOrder(entry.options);
    if (options === entry.options) return { name: entry.name, mountpoint: entry.mountpoint, status: "current" };
    const tokens = [...entry.tokens];
    tokens[entry.optionsAt] = options;
    lines[entry.index] = tokens.join("");
    return { name: entry.name, mountpoint: entry.mountpoint, status: "updated", previousOptions: entry.options, options };
  });
  const changed = drives.some((drive) => drive.status === "updated");
  return { changed, content: changed ? lines.join("\n") : String(content ?? ""), drives };
}

/** findmnt --verify's closing count ("0 parse errors, 1 error, 2 warnings"), or null when there is none. */
export function parseVerifySummary(text) {
  const match = String(text ?? "").match(/(\d+) parse errors?, (\d+) errors?, (\d+) warnings?/);
  return match ? { parseErrors: Number(match[1]), errors: Number(match[2]), warnings: Number(match[3]) } : null;
}

async function verifyFstab(run, file) {
  const result = await run(binaries.findmnt, ["--verify", "--tab-file", file], { timeout: 30_000 });
  return { ok: result.ok, summary: parseVerifySummary(`${result.stdout}\n${result.stderr}`), text: tail(`${result.stdout}\n${result.stderr}`) };
}

/**
 * Whether the rewritten fstab may replace the current one. A clean verification always may. One
 * that complains may only when the current file already complained as much: a drive that is
 * unplugged right now is reported the same before and after, and must not make this impossible.
 */
export function verificationAllows(current, proposed) {
  if (proposed.ok) return true;
  if (!proposed.summary || !current.summary || current.ok) return false;
  return proposed.summary.parseErrors === 0 && proposed.summary.errors <= current.summary.errors;
}

/**
 * Give every managed drive entry the Docker ordering (the migration for entries written before
 * v1.132). Backed up first, the rewritten file is verified before it replaces anything, replaced
 * by a rename so fstab is never half-written, and put back if systemd does not take the ordering.
 * Nothing is mounted, unmounted or restarted: the options are read by systemd's fstab generator,
 * so the change is in effect from the daemon-reload, for the next shutdown and the next boot.
 */
export async function storageDockerOrder(_parameters = {}, { run = fixedRun, log = null, files = { readFile, writeFile, rename, unlink }, now = () => new Date() } = {}) {
  const before = await files.readFile(fstabPath, "utf8");
  const plan = planDockerOrder(before);
  for (const drive of plan.drives) {
    if (drive.status === "skipped") log?.(`${drive.name}: left alone, ${drive.reason}`, "stdout");
    if (drive.status === "current") log?.(`${drive.mountpoint}: already ordered around Docker`, "stdout");
  }
  const updated = plan.drives.filter((drive) => drive.status === "updated");
  if (updated.length === 0) {
    log?.("Nothing to change; /etc/fstab was not touched", "stdout");
    return { changed: false, backup: null, drives: plan.drives };
  }
  const stamp = now().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const backup = `${fstabPath}.boxpilot-${stamp}`;
  await files.writeFile(backup, before, { mode: 0o644, flag: "wx" });
  log?.(`Saved the current fstab as ${backup}`, "stdout");
  await files.writeFile(candidatePath, plan.content, { mode: 0o644 });
  const current = await verifyFstab(run, fstabPath);
  const proposed = await verifyFstab(run, candidatePath);
  if (!verificationAllows(current, proposed)) {
    await files.unlink(candidatePath).catch(() => {});
    throw new Error(`findmnt --verify rejected the new fstab, so the current one was left as it is: ${proposed.text || "no details"}`);
  }
  if (!proposed.ok) log?.(`findmnt --verify reports what it reported before this change: ${proposed.text}`, "stderr");
  await files.rename(candidatePath, fstabPath);
  for (const drive of updated) log?.(`${drive.mountpoint}: ${drive.previousOptions} -> ${drive.options}`, "stdout");
  try {
    const reload = await run(binaries.systemctl, ["daemon-reload"], { timeout: 60_000 });
    if (!reload.ok) throw new Error(`systemctl daemon-reload failed: ${tail(reload.stderr)}`);
    // What systemd made of it, not what was written: the generator reads these options, and a
    // spelling it does not understand would leave the drive exactly as unordered as before.
    for (const drive of updated) {
      const unit = mountUnitName(drive.mountpoint);
      const shown = await run(binaries.systemctl, ["show", "--property=Before", "--value", unit], { timeout: 15_000 });
      if (!shown.ok || !shown.stdout.split(/\s+/).includes("docker.service")) throw new Error(`systemd did not order ${unit} before docker.service`);
      log?.(`${unit} is ordered before docker.service`, "stdout");
    }
  } catch (error) {
    await files.writeFile(candidatePath, before, { mode: 0o644 });
    await files.rename(candidatePath, fstabPath);
    await run(binaries.systemctl, ["daemon-reload"], { timeout: 60_000 }).catch(() => {});
    throw new Error(`${error.message}; /etc/fstab was put back as it was (the copy taken first is ${backup})`);
  }
  return { changed: true, backup, drives: plan.drives };
}

// ---- before a reboot ---------------------------------------------------------------------------

/**
 * Running containers with the folders they bind, from `docker inspect`'s JSON. Not a --format
 * template: Docker drops empty fields such as Config.StopSignal from what the template sees, and
 * naming one that is absent fails the whole command (found on the Linux runner).
 */
export function parseContainers(text) {
  let list;
  try { list = JSON.parse(String(text ?? "")); } catch { return []; }
  return (Array.isArray(list) ? list : []).filter((entry) => entry?.Id).map((entry) => ({
    id: entry.Id,
    name: String(entry.Name ?? "").replace(/^\//, ""),
    pid: Number(entry.State?.Pid) || null,
    stopSignal: entry.Config?.StopSignal || "SIGTERM",
    stopTimeout: Number.isInteger(entry.Config?.StopTimeout) ? entry.Config.StopTimeout : 10,
    sources: (entry.Mounts ?? []).map((mount) => mount?.Source).filter((source) => typeof source === "string" && source),
  }));
}

const under = (source, mountpoint) => source === mountpoint || source.startsWith(`${mountpoint}/`);

/** A container's StopSignal as process.kill takes it: Docker accepts "SIGQUIT", "QUIT" and "3" alike. */
export function stopSignalOf(container) {
  const value = String(container?.stopSignal ?? "").trim().toUpperCase();
  if (/^\d{1,2}$/.test(value)) return Number(value);
  if (/^(SIG)?[A-Z0-9+-]{2,12}$/.test(value)) return value.startsWith("SIG") ? value : `SIG${value}`;
  return "SIGTERM";
}

/** What the reboot preparation reads from the host itself: /proc and the drives' first sector. */
export const hostView = {
  /** Processes whose mount namespace, other than the host's, still has the filesystem `majMin`: a container with it bound, or a service's private copy. */
  async namespaceHolders(majMin, { proc = "/proc", fs = { readdir, readlink, readFile } } = {}) {
    const host = await fs.readlink(`${proc}/1/ns/mnt`).catch(() => null);
    const seen = new Set();
    const holders = [];
    for (const entry of await fs.readdir(proc).catch(() => [])) {
      if (!/^\d+$/.test(entry)) continue;
      const namespace = await fs.readlink(`${proc}/${entry}/ns/mnt`).catch(() => null);
      if (!namespace || namespace === host || seen.has(namespace)) continue;
      seen.add(namespace);
      const mountinfo = await fs.readFile(`${proc}/${entry}/mountinfo`, "utf8").catch(() => "");
      if (mountinfo.split("\n").some((line) => line.split(" ")[2] === majMin)) {
        holders.push({ pid: Number(entry), command: (await fs.readFile(`${proc}/${entry}/comm`, "utf8").catch(() => "?")).trim() });
      }
    }
    return holders;
  },
  /** Whether the container's first process is still alive: the pid exists and is still in that container's cgroup. */
  async running(container) {
    if (!container.pid) return false;
    const cgroup = await readFile(`/proc/${container.pid}/cgroup`, "utf8").catch(() => "");
    return cgroup.includes(container.id);
  },
  signal(pid, signal) {
    try { process.kill(pid, signal); return true; } catch { return false; }
  },
  /** Processes with something open on the filesystem, from /proc: fuser is not on every server. */
  processesUsing: (majMin) => processesUsing(majMin),
  bootSector: readBootSector,
};

/** The longest BoxPilot's reboot waits for apps and drives before it reboots regardless. */
export const rebootPreparationBudgetMs = 150_000;

/**
 * Stop what uses BoxPilot's drives and unmount them, then say how each went, before a reboot.
 *
 * Docker is stopped rather than its containers one by one: `docker stop` marks a container as
 * stopped by hand, and every BoxPilot app is `restart: unless-stopped`, so after the reboot they
 * would all stay down. A daemon that is shutting down stops its containers without that mark, and
 * starts them again when it starts - exactly what a shutdown does. With live-restore on, the daemon
 * leaves its containers running as it stops; those that use a drive are then sent their own stop
 * signal, given their own stop timeout, and killed after it, again without the mark. A drive that
 * is also a file share is let go by its clients first (unmountFromHost).
 *
 * Every wait is bounded and the whole is bounded by `budgetMs`: this is the belt, the reboot that
 * follows is the braces, and nothing here may keep the server from rebooting.
 */
export async function prepareDrivesForReboot(_parameters = {}, {
  run = fixedRun, log = null, files = { readFile }, host = hostView,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  clock = () => Date.now(), budgetMs = rebootPreparationBudgetMs,
} = {}) {
  const deadline = clock() + budgetMs;
  const left = (cap) => Math.max(1_000, Math.min(cap, deadline - clock()));
  const outOfTime = () => clock() >= deadline;
  const content = await files.readFile(fstabPath, "utf8").catch(() => "");
  const drives = [];
  for (const entry of managedDriveEntries(content).filter((candidate) => candidate.drive)) {
    const where = await run(binaries.findmnt, ["--task", "1", "-n", "-o", "SOURCE,FSTYPE,MAJ:MIN", "--mountpoint", entry.mountpoint], { timeout: 15_000 });
    const [source, fstype, majMin] = where.ok ? where.stdout.trim().split(/\s+/) : [];
    drives.push({ name: entry.name, mountpoint: entry.mountpoint, unit: mountUnitName(entry.mountpoint), source: source ?? null, fstype: fstype ?? entry.fstype, majMin: majMin ?? null, mounted: Boolean(source), state: source ? "mounted" : "not-mounted", holders: [], volumeDirty: null });
  }
  const mounted = drives.filter((drive) => drive.mounted);
  const summary = { drives, containers: { stopped: [], signalled: [], killed: [], stillRunning: [] }, dockerStopped: false };
  if (mounted.length === 0) {
    log?.(drives.length ? "No BoxPilot drive is mounted; nothing to unmount before the reboot" : "BoxPilot manages no drives here; nothing to unmount before the reboot", "stdout");
    return summary;
  }

  // 1. The containers using the drives, and Docker.
  const ids = await run(binaries.docker, ["ps", "-q", "--no-trunc"], { timeout: 15_000 });
  let containers = [];
  if (!ids.ok) log?.(`Docker did not answer, so no container was stopped: ${tail(ids.stderr) || "docker ps failed"}`, "stderr");
  else if (ids.stdout.trim()) {
    const inspected = await run(binaries.docker, ["inspect", ...ids.stdout.trim().split(/\s+/)], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    if (inspected.ok) containers = parseContainers(inspected.stdout);
    else log?.(`Could not read the running containers, so none was stopped: ${tail(inspected.stderr)}`, "stderr");
  }
  const bound = containers.filter((container) => container.sources.some((source) => mounted.some((drive) => under(source, drive.mountpoint))));
  if (bound.length) {
    log?.(`Stopping Docker so ${bound.map((container) => container.name).join(", ")} stop the way they do at shutdown; their restart policies start them again after the reboot`, "stdout");
    const stopped = await run(binaries.systemctl, ["stop", "docker.socket", "docker.service"], { timeout: left(90_000) });
    summary.dockerStopped = stopped.ok;
    if (!stopped.ok) log?.(`Docker did not stop: ${tail(stopped.stderr)}`, "stderr");
    const stillRunning = async (list) => (await Promise.all(list.map(async (container) => ((await host.running(container)) ? container : null)))).filter(Boolean);
    const waitFor = async (list, until) => {
      let remaining = await stillRunning(list);
      while (remaining.length && clock() < until) { await sleep(250); remaining = await stillRunning(remaining); }
      return remaining;
    };
    const alive = await stillRunning(bound);
    const names = (list) => list.map((container) => container.name);
    summary.containers.stopped.push(...names(bound.filter((container) => !alive.includes(container))));
    if (alive.length && summary.dockerStopped) {
      // live-restore: the daemon is gone and its containers are not. Nothing restarts them now, so
      // they are stopped the way `docker stop` would, without its "stopped by hand" mark.
      log?.(`${names(alive).join(", ")} kept running after Docker stopped (live-restore is on); sending each its stop signal`, "stdout");
      for (const container of alive) if (host.signal(container.pid, stopSignalOf(container))) summary.containers.signalled.push(container.name);
      const grace = Math.min(Math.max(...alive.map((container) => container.stopTimeout)) * 1000, 30_000);
      const stubborn = await waitFor(alive, Math.min(clock() + grace, deadline));
      summary.containers.stopped.push(...names(alive.filter((container) => !stubborn.includes(container))));
      for (const container of stubborn) { host.signal(container.pid, "SIGKILL"); log?.(`${container.name} did not stop within its stop timeout; killed it`, "stderr"); }
      const survivors = await waitFor(stubborn, clock() + 5_000);
      summary.containers.killed.push(...names(stubborn.filter((container) => !survivors.includes(container))));
      summary.containers.stillRunning.push(...names(survivors));
    } else {
      summary.containers.stillRunning.push(...names(alive));
    }
    if (summary.containers.stillRunning.length) log?.(`Still running: ${summary.containers.stillRunning.join(", ")}`, "stderr");
  } else {
    log?.(containers.length ? `None of the ${containers.length} running container${containers.length === 1 ? "" : "s"} uses a BoxPilot drive; Docker was left running` : "No container is running; Docker was left as it is", "stdout");
  }

  // 2. Everything written so far, on the drives.
  if (!outOfTime()) {
    log?.("$ sync", "stdout");
    const synced = await run(binaries.sync, [], { timeout: left(60_000) });
    if (!synced.ok) log?.(`sync did not finish: ${tail(synced.stderr)}`, "stderr");
  }

  // 3. Each drive, unmounted in the host's namespace (file-sharing clients let go of it first
  // when they are what holds it), and whether it really let go.
  for (const drive of mounted) {
    if (outOfTime()) { drive.state = "out-of-time"; log?.(`Out of time before ${drive.mountpoint}; the reboot unmounts it`, "stderr"); continue; }
    const unmounted = await unmountFromHost(drive.mountpoint, { run, log, files, sleep, tries: outOfTime() ? 1 : 30 });
    const still = await run(binaries.findmnt, ["--task", "1", "-n", "--mountpoint", drive.mountpoint], { timeout: 15_000 });
    if (still.ok && still.stdout.trim()) {
      drive.state = "busy";
      drive.holders = drive.majMin ? await host.processesUsing(drive.majMin) : [];
      log?.(`${drive.mountpoint} did not unmount (${tail(unmounted.result?.stderr).replace(/\.+$/, "") || "still mounted"}); it is in use${drive.holders.length ? ` by ${drive.holders.map((holder) => `${holder.command} (${holder.pid})`).join(", ")}` : ""}. The reboot stops those and unmounts it`, "stderr");
      continue;
    }
    // Gone from the host is not gone: a container, or a service with a private copy of the
    // mount, keeps the filesystem alive in its own namespace, and it is unmounted for real only
    // when the last of them lets go.
    drive.holders = drive.majMin ? await host.namespaceHolders(drive.majMin) : [];
    if (drive.holders.length) {
      drive.state = "busy";
      log?.(`${drive.mountpoint} is unmounted here but still open in ${drive.holders.map((holder) => `${holder.command} (${holder.pid})`).join(", ")}; the reboot stops those`, "stderr");
      continue;
    }
    drive.state = "unmounted";
    const flags = drive.fstype === "exfat" && drive.source ? exfatVolumeFlags(await host.bootSector(drive.source)) : null;
    drive.volumeDirty = flags ? flags.dirty : null;
    log?.(`${drive.mountpoint} unmounted cleanly`, "stdout");
    if (flags?.dirty) log?.(`${drive.mountpoint} is still marked as not properly unmounted: it was marked before this reboot, by an earlier unplug or drop mid-write, and Linux keeps that mark until a repairing check clears it, so the kernel will warn about it at every boot until then. Repair offers the check, and then clearing the mark`, "stderr");
  }
  return summary;
}

/** "Filesystem state:" from `dumpe2fs -h`: clean, not clean, clean with errors, not clean with errors. */
export function parseExtState(text) {
  return String(text ?? "").match(/^Filesystem state:\s*(.+?)\s*$/m)?.[1] ?? null;
}

/**
 * What each managed drive's own filesystem says about how it was last unmounted, read without
 * writing anything: the exFAT VolumeDirty mark from the boot sector, and an ext2/3/4 superblock's
 * state from dumpe2fs -h. With when each drive's current mount began, so a kernel warning can be
 * told apart from one printed at a mount that has since been undone (a check, a repair by hand, a
 * reconnect): this boot's log keeps every warning it ever printed.
 *
 * On a mounted exFAT drive a set mark is not conclusive: the first write after mounting sets it
 * and it stays set until the unmount (tests/ubuntu/drive-shutdown-order.sh, part 3). A clear one
 * is: nothing marked the drive, and nothing has written to it since it was mounted.
 */
export async function storageVolumeState(_parameters = {}, { run = fixedRun, files = { readFile }, readSector = readBootSector, now = () => new Date() } = {}) {
  const content = await files.readFile(fstabPath, "utf8").catch(() => "");
  const drives = [];
  for (const entry of managedDriveEntries(content).filter((candidate) => candidate.drive)) {
    const where = await run(binaries.findmnt, ["--task", "1", "-n", "-o", "SOURCE,FSTYPE", "--mountpoint", entry.mountpoint], { timeout: 15_000 });
    const [mountedFrom, mountedType] = where.ok ? where.stdout.trim().split(/\s+/) : [];
    let device = mountedFrom ?? null;
    if (!device && /^UUID=[0-9A-Fa-f-]{4,40}$/.test(entry.source ?? "")) {
      const found = await run(binaries.blkid, ["-U", entry.source.slice("UUID=".length)], { timeout: 15_000 });
      device = found.ok && found.stdout.trim().startsWith("/dev/") ? found.stdout.trim() : null;
    }
    const fstype = mountedType ?? entry.fstype;
    let mountedAt = null;
    if (mountedFrom) {
      const shown = await run(binaries.systemctl, ["show", "--timestamp=unix", "--property=ActiveEnterTimestamp", "--value", mountUnitName(entry.mountpoint)], { timeout: 15_000 });
      const seconds = shown.ok ? shown.stdout.trim().match(/^@(\d+)$/)?.[1] : null;
      mountedAt = seconds ? new Date(Number(seconds) * 1000).toISOString() : null;
    }
    let exfat = null;
    let ext = null;
    if (device && fstype === "exfat") {
      const flags = exfatVolumeFlags(await readSector(device));
      if (flags) exfat = { dirty: flags.dirty };
    }
    if (device && /^ext[234]$/.test(fstype ?? "")) {
      const dumped = await run(binaries.dumpe2fs, ["-h", device], { timeout: 30_000 });
      const state = dumped.ok ? parseExtState(dumped.stdout) : null;
      if (state) ext = { state };
    }
    drives.push({ name: entry.name, mountpoint: entry.mountpoint, device, fstype, mounted: Boolean(mountedFrom), mountedAt, exfat, ext });
  }
  return { available: true, readAt: now().toISOString(), drives };
}

/** Put back what the preparation stopped, when the reboot it prepared for could not be scheduled. */
export async function resumeAfterCancelledReboot(summary, { run = fixedRun, log = null } = {}) {
  for (const drive of summary?.drives ?? []) {
    if (drive.state !== "unmounted") continue;
    const started = await run(binaries.systemctl, ["start", drive.unit], { timeout: 120_000 });
    log?.(started.ok ? `Mounted ${drive.mountpoint} again` : `Could not mount ${drive.mountpoint} again: ${tail(started.stderr)}`, started.ok ? "stdout" : "stderr");
  }
  if (summary?.dockerStopped) {
    const started = await run(binaries.systemctl, ["start", "docker.socket", "docker.service"], { timeout: 120_000 });
    log?.(started.ok ? "Started Docker again; it starts its containers by their restart policies" : `Could not start Docker again: ${tail(started.stderr)}`, started.ok ? "stdout" : "stderr");
  }
}
