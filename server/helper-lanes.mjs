/**
 * Which mutations may run at the same time in the helper.
 *
 * Every change used to share one FIFO, so a 70-minute application backup delayed an unrelated app
 * restart and every scheduled job behind it. Operations now hold one lane per *subject* they touch:
 * two apps can work in parallel, two operations on the same app never do, and an operation that
 * touches more than one subject — installing an app also rewrites the shared Homepage dashboard —
 * holds every lane involved, so it cannot slip past either.
 */

/**
 * Operations that read or rewrite the whole box (a machine snapshot copies every app's project
 * files while it runs). They take the exclusive lane: nothing else runs beside them.
 */
export const exclusiveLane = "exclusive";
const exclusiveOperations = new Set(["host.snapshot.create", "host.snapshot.restore", "controller.backup.create", "controller.backup.protect", "controller.backup.retention.apply"]);

/** Installing or removing an app rewrites the dashboard's shared services.yaml as well as the app. */
export const homepageLane = "app:homepage";
const homepageOperations = new Set(["homepage.sync", "app.install", "app.uninstall", "app.purge", "app.reinstall"]);

/** Everything shared with no subject of its own: apt, systemd, storage, firewall, users. */
export const hostLane = "host";

/** The agents' Zulip connection (M38): its posts, its key. */
export const chatLane = "chat:zulip";

/** BoxPilot's Cloudflare tunnel (M42): what it published, and the record of it. */
export const cloudflareLane = "cloudflare:tunnel";

/**
 * The application backup tree, which the three mirrors copy off the box. Held by every operation
 * that writes or deletes there and by the mirrors, so a mirror never reads an archive being written
 * (`<stamp>.tar.gz.partial`), renamed or pruned under it. A checkpoint is an app backup: an update,
 * a settings change, a compose edit, a rollback and a file restore each write one, and held only
 * their app's lane, so a mirror ran beside them, copied the half-written archive and kept it
 * forever, or died when it was renamed or grew (rsync exit 24, rclone errors). Reclaiming disk space
 * deletes the archives behind each app's newest few, and removing a machine snapshot that cannot be
 * read deletes from the snapshot folder the mirrors copy too, so both hold it.
 */
export const backupTreeLane = "backup-tree";
const backupTreeOperations = new Set(["app.backup", "app.backup.many", "app.backup.restore", "app.backup.restore-path", "app.backup.delete", "app.backup.verify", "app.update", "app.rollback", "app.reconfigure", "app.compose.edit", "backup.sync", "backup.remote.sync", "backup.cloud.sync", "housekeeping.reclaim", "housekeeping.unreadable-snapshot.remove"]);
/** Those that held the host lane before the tree had a lane of its own still hold it as well. */
const hostBackupOperations = new Set(["app.backup", "app.backup.many", "app.backup.restore", "app.backup.verify", "backup.sync", "backup.remote.sync", "backup.cloud.sync", "housekeeping.reclaim", "housekeeping.unreadable-snapshot.remove"]);

/**
 * The Docker daemon. An operation that can restart it holds this lane (with the host's): it waits
 * for every app lane to drain, and every operation holding an app lane waits for it, while app
 * operations still run beside each other. Docker log rotation restarts dockerd; a package change can
 * restart docker.service or containerd, through the package's own scripts or needrestart afterwards;
 * Services can restart either by name. They held only the host lane, which no app operation holds,
 * so Docker restarted under an install, an update or a model pull mid-compose, and its rollback.
 */
export const dockerLane = "docker";
const dockerRestartOperations = new Set(["docker.logging.set", "apt.upgrade", "apt.install", "apt.remove", "apt.purge", "apt.autoremove", "apt.repair", "apt.unattended.set", "prerequisite.docker.install"]);
const dockerUnit = /^(docker|containerd)\.(service|socket)$/;
/**
 * Operations that take a drive or a share out from under the apps hold the Docker lane too. A check,
 * clearing the dirty mark, a reconnect and letting apps write stop every container bound to the
 * drive, unmount it, and start them again; unmounting a drive or a share decides from the running
 * containers that none holds it. On the host lane alone an app start ran beside them: started
 * mid-check, Jellyfin bound the empty folder on the system disk, the check's own `docker start`
 * afterwards left that container as it was, and it wrote to the system disk hidden under the drive.
 */
const driveUnderAppsOperations = new Set(["storage.check", "storage.dirty-mark.clear", "storage.remount", "storage.writable", "storage.unmount", "share.reconnect", "share.unmount"]);
const isAppLane = (lane) => lane.startsWith("app:");

/** The lanes an operation must hold, as an array. Read-only operations never queue, so never get here. */
export function laneFor(operation, parameters = {}) {
  const id = String(operation ?? "");
  if (exclusiveOperations.has(id)) return [exclusiveLane];
  if (id === "job.output.release") return ["job-output"];
  // M38: the agents' posts to Zulip wait only for each other, never behind an upgrade or an app
  // backup; connecting runs manage.py in Zulip's container, so it holds Zulip's app lane too.
  if (id === "agents.zulip.post" || id === "agents.zulip.disconnect") return [chatLane];
  // M40: the runner's processors are set at each run; a question never waits behind an upgrade for them.
  if (id === "agents.runtime.cpu") return ["agents:cpu"];
  if (id === "agents.zulip.connect") return [chatLane, "app:zulip"];
  // M45.3: the Claude key, the cap and the gateway unit change one at a time, apart from everything else.
  if (id.startsWith("agents.cloud.")) return ["agents:cloud"];
  // M42: BoxPilot's Cloudflare record is read, changed and written back by one change at a time.
  // Connecting and publishing may install or start the Cloudflare Tunnel app (and an install
  // rewrites the dashboard); unpublishing and disconnecting touch only Cloudflare and the record.
  if (id === "cloudflare.connect" || id === "cloudflare.publish") return [cloudflareLane, "app:cloudflared", homepageLane];
  if (id.startsWith("cloudflare.")) return [cloudflareLane];
  if (dockerRestartOperations.has(id) || (id === "service.action" && dockerUnit.test(String(parameters?.unit ?? "")))) return [hostLane, dockerLane];
  if (driveUnderAppsOperations.has(id)) return [hostLane, dockerLane];
  const subject = (value) => (typeof value === "string" && value.length && value.length <= 64 ? value : null);
  // A DNS rehearsal stops and starts that DNS app's container, so an update of it waits.
  if (id === "dns.fallback.rehearse") { const app = subject(parameters?.app); return app ? [hostLane, `app:${app}`] : [hostLane, dockerLane]; }
  const lanes = [];
  if (id.startsWith("app.")) {
    const app = subject(parameters?.id);
    if (app) lanes.push(`app:${app}`);
    // Several apps in one job (app.backup.many) hold every one of their lanes.
    if (Array.isArray(parameters?.ids)) for (const entry of parameters.ids) { const each = subject(entry); if (each) lanes.push(`app:${each}`); }
  }
  if (id.startsWith("vm.")) {
    const vm = subject(parameters?.name) ?? subject(parameters?.domain);
    // VM creation and media import write to shared pools and libvirt config: those stay on the host lane.
    if (vm && !["vm.create", "vm.cloud.create", "vm.media.import", "vm.foundation.initialize"].includes(id)) lanes.push(`vm:${vm}`);
  }
  if (homepageOperations.has(id)) lanes.push(homepageLane);
  if (backupTreeOperations.has(id)) lanes.push(backupTreeLane);
  if (hostBackupOperations.has(id)) lanes.push(hostLane);
  return lanes.length ? [...new Set(lanes)] : [hostLane];
}

/**
 * Independent FIFOs keyed by lane. `run(lanes, task)` waits until every lane it names is free (and
 * the exclusive lane with it), then holds all of them until the task settles. The Docker lane also
 * waits for every app lane, and an app lane for the Docker lane.
 */
export function createLaneQueues() {
  const lanes = new Map();
  // Called, once each, the moment no lane is held (onIdle).
  const idleWaiters = new Set();
  function noticeIdle() {
    for (const waiter of [...idleWaiters]) {
      if (lanes.size) return; // a waiter before this one took a lane
      idleWaiters.delete(waiter);
      waiter();
    }
  }

  /** The lanes besides its own that a request must wait for: Docker and the apps wait for each other. */
  function across(held) {
    const also = [];
    if (held.includes(dockerLane)) for (const lane of lanes.keys()) if (isAppLane(lane)) also.push(lane);
    if (held.some(isAppLane)) also.push(dockerLane);
    return also;
  }

  function run(requested, task) {
    const held = [...new Set(Array.isArray(requested) ? requested : [requested])];
    // Take every lane in one step: acquiring them one at a time could deadlock two operations that
    // want the same pair in the opposite order.
    const waitFor = held.includes(exclusiveLane)
      ? [...lanes.values()]
      : [...held, ...across(held), exclusiveLane].map((lane) => lanes.get(lane)).filter(Boolean);
    // `holdUntil(promise)`: what the task started and left running (a root task past its own limit,
    // run-unit.mjs) keeps its lanes held until it settles too, while the task's answer goes out now.
    const after = [];
    let released = false;
    const holdUntil = (promise) => { if (!released) after.push(Promise.resolve(promise).catch(() => {})); };
    const start = () => task(holdUntil);
    const result = Promise.allSettled(waitFor).then(start, start); // an earlier failure must not cancel this one
    // Keep the chain alive but never leak rejections, and drop a lane once it is idle again.
    const settled = result.then(() => {}, () => {}).then(async () => {
      while (after.length) await Promise.all(after.splice(0));
      released = true;
    });
    for (const lane of held) {
      lanes.set(lane, settled);
      settled.then(() => { if (lanes.get(lane) === settled) lanes.delete(lane); if (!lanes.size) noticeIdle(); });
    }
    return result;
  }

  /** True when any of these lanes — or the exclusive one — would make a request wait. */
  function busy(requested) {
    const held = Array.isArray(requested) ? requested : [requested];
    if (held.includes(exclusiveLane)) return lanes.size > 0;
    return [...held, ...across(held), exclusiveLane].some((lane) => lanes.has(lane));
  }

  /**
   * Call `callback` the moment no lane is held - now, if none is - without holding or queueing on
   * anything meanwhile. Within the call nothing else has started, so a lane it takes is taken from
   * an idle helper. Returns a function that stops waiting.
   */
  function onIdle(callback) {
    if (!lanes.size) { callback(); return () => {}; }
    idleWaiters.add(callback);
    return () => { idleWaiters.delete(callback); };
  }

  return { run, busy, onIdle, size: () => lanes.size };
}

/** Bound active and queued reads; abandoned queued work must never start later. */
export function createConcurrencyGate(limit, { maxWaiting = limit * 4 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(maxWaiting) || maxWaiting < 0) throw new Error("Invalid helper concurrency limits");
  let running = 0;
  const waiting = [];
  const abandoned = () => Object.assign(new Error("The queued inspection was abandoned before it started"), { name: "AbortError" });
  const next = () => {
    if (running >= limit) return;
    const entry = waiting.shift();
    if (entry) { entry.cleanup(); running += 1; entry.resolve(); }
  };
  async function run(task, { signal } = {}) {
    if (signal?.aborted) throw abandoned();
    if (running >= limit) {
      if (waiting.length >= maxWaiting) throw Object.assign(new Error("The helper inspection queue is full. Wait for current checks to finish, then retry."), { code: "HELPER_BUSY" });
      await new Promise((resolve, reject) => {
        const entry = { resolve, cleanup: () => signal?.removeEventListener("abort", abort) };
        const abort = () => {
          const index = waiting.indexOf(entry);
          if (index < 0) return;
          waiting.splice(index, 1); entry.cleanup(); reject(abandoned());
        };
        waiting.push(entry);
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
    else running += 1;
    try {
      if (signal?.aborted) throw abandoned();
      return await task();
    } finally { running -= 1; next(); }
  }
  return { run, active: () => running, waiting: () => waiting.length };
}
