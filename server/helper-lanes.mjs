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
const homepageOperations = new Set(["homepage.sync", "app.install", "app.uninstall", "app.purge"]);

/** Everything shared with no subject of its own: apt, systemd, storage, firewall, users. */
export const hostLane = "host";

/** The lanes an operation must hold, as an array. Read-only operations never queue, so never get here. */
export function laneFor(operation, parameters = {}) {
  const id = String(operation ?? "");
  if (exclusiveOperations.has(id)) return [exclusiveLane];
  const subject = (value) => (typeof value === "string" && value.length && value.length <= 64 ? value : null);
  const lanes = [];
  if (id.startsWith("app.")) {
    const app = subject(parameters?.id);
    if (app) lanes.push(`app:${app}`);
  }
  if (id.startsWith("vm.")) {
    const vm = subject(parameters?.name) ?? subject(parameters?.domain);
    // VM creation and media import write to shared pools and libvirt config: those stay on the host lane.
    if (vm && !["vm.create", "vm.cloud.create", "vm.media.import", "vm.foundation.initialize"].includes(id)) lanes.push(`vm:${vm}`);
  }
  if (homepageOperations.has(id)) lanes.push(homepageLane);
  return lanes.length ? [...new Set(lanes)] : [hostLane];
}

/**
 * Independent FIFOs keyed by lane. `run(lanes, task)` waits until every lane it names is free (and
 * the exclusive lane with it), then holds all of them until the task settles.
 */
export function createLaneQueues() {
  const lanes = new Map();

  function run(requested, task) {
    const held = [...new Set(Array.isArray(requested) ? requested : [requested])];
    // Take every lane in one step: acquiring them one at a time could deadlock two operations that
    // want the same pair in the opposite order.
    const waitFor = held.includes(exclusiveLane)
      ? [...lanes.values()]
      : [...held.map((lane) => lanes.get(lane)), lanes.get(exclusiveLane)].filter(Boolean);
    const result = Promise.allSettled(waitFor).then(task, task); // an earlier failure must not cancel this one
    // Keep the chain alive but never leak rejections, and drop a lane once it is idle again.
    const settled = result.then(() => {}, () => {});
    for (const lane of held) {
      lanes.set(lane, settled);
      settled.then(() => { if (lanes.get(lane) === settled) lanes.delete(lane); });
    }
    return result;
  }

  /** True when any of these lanes — or the exclusive one — would make a request wait. */
  function busy(requested) {
    const held = Array.isArray(requested) ? requested : [requested];
    if (held.includes(exclusiveLane)) return lanes.size > 0;
    return held.some((lane) => lanes.has(lane)) || lanes.has(exclusiveLane);
  }

  return { run, busy, size: () => lanes.size };
}
