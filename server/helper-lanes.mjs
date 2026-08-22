/**
 * Which mutations may run at the same time in the helper.
 *
 * Every change used to share one FIFO, so a 70-minute application backup delayed an unrelated
 * app restart and every scheduled job behind it. Operations are now serialized per *subject*:
 * two apps can work in parallel, two operations on the same app never do, and anything that
 * touches shared host state (apt, systemd, storage, firewall, users, VMs' host config) stays on
 * one "host" lane so those keep their old, safe ordering.
 */

/** Lane key for an operation and its parameters. Read-only operations never queue. */
export function laneFor(operation, parameters = {}) {
  const id = String(operation ?? "");
  const subject = (value) => (typeof value === "string" && value.length && value.length <= 64 ? value : null);
  if (id.startsWith("app.")) {
    const app = subject(parameters?.id);
    if (app) return `app:${app}`;
  }
  if (id.startsWith("vm.")) {
    const vm = subject(parameters?.name) ?? subject(parameters?.domain);
    // VM creation and media import write to shared pools and libvirt config: keep them on the host lane.
    if (vm && !["vm.create", "vm.cloud.create", "vm.media.import", "vm.foundation.initialize"].includes(id)) return `vm:${vm}`;
  }
  return "host";
}

/** A set of independent FIFOs keyed by lane; `run(lane, task)` resolves with the task's result. */
export function createLaneQueues() {
  const lanes = new Map();

  function run(lane, task) {
    const previous = lanes.get(lane) ?? Promise.resolve();
    const result = previous.then(task, task); // an earlier failure must not cancel the next entry
    // Keep the chain alive but never leak rejections, and drop the lane once it is idle again.
    const settled = result.then(() => {}, () => {});
    lanes.set(lane, settled);
    settled.then(() => { if (lanes.get(lane) === settled) lanes.delete(lane); });
    return result;
  }

  function busy(lane) {
    return lanes.has(lane);
  }

  return { run, busy, size: () => lanes.size };
}
