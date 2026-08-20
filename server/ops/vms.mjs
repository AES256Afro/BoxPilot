import { defineOperation } from "./registry.mjs";
import { validateCloudVmInput } from "../vm-cloud.mjs";

const virshBinary = process.env.BOXPILOT_VIRSH_BINARY ?? "/usr/bin/virsh";
const connectionUri = process.env.BOXPILOT_LIBVIRT_URI ?? "qemu:///system";
export const domainNamePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const nameField = { type: "string", maxLength: 64, pattern: domainNamePattern };
const snapshotField = { type: "string", maxLength: 64, pattern: domainNamePattern };

function virsh(run, args, options = {}) {
  return run(virshBinary, ["--connect", connectionUri, ...args], { timeout: 60_000, ...options });
}

async function domainState(run, name) {
  const result = await virsh(run, ["domstate", name], { timeout: 15_000 });
  if (!result.ok) throw new Error(`VM ${name} was not found`);
  return result.stdout.split("\n")[0].trim();
}

async function snapshotExists(run, name, snapshotName) {
  const result = await virsh(run, ["snapshot-list", name, "--name"], { timeout: 15_000 });
  return result.ok && result.stdout.split("\n").map((line) => line.trim()).includes(snapshotName);
}

/** Cloud-init creation plus the direct lifecycle verbs (force off, delete, snapshot revert/delete). */
export function vmOperations() {
  return [
    defineOperation({ id: "vm.cloud.images", title: "List cloud base images", risk: "low", readOnly: true, run: (_p, { vmCloud }) => vmCloud.images() }),
    defineOperation({
      id: "vm.cloud.create", title: "Create VM from cloud image", risk: "medium", timeoutMs: 90 * 60_000,
      description: "Downloads the official cloud image if needed (checksum verified), clones it to a new disk, seeds cloud-init with your user and SSH keys, boots the VM on the default NAT network, and waits for its address.",
      parameters: { exact: false, fields: { name: { type: "string", validate: (_v, all) => { const errors = validateCloudVmInput(all); return errors.length ? errors.join("; ") : null; } }, image: { type: "string" }, vcpus: { type: "number" }, memoryMiB: { type: "number" }, diskGiB: { type: "number" }, sshKeys: { type: "array" }, username: { type: "string", optional: true }, packages: { type: "array", optional: true }, autostart: { type: "boolean", optional: true }, password: { type: "string", optional: true } } },
      run: (parameters, { vmCloud, runUnit, progress, jobLog }) => vmCloud.create(parameters, { progress, runUnit, jobLog }),
    }),
    defineOperation({
      id: "vm.action", title: "Start, stop, or restart a VM", risk: "medium", timeoutMs: 5 * 60_000,
      description: "Start, graceful ACPI shutdown, guest reboot, or autostart toggle. Shutdown waits up to two minutes and never pulls the plug — Force off exists for that.",
      parameters: { fields: { name: nameField, action: { type: "string", enum: ["start", "shutdown", "reboot", "autostart-on", "autostart-off"] } } },
      run: async (parameters, { run, progress, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) => {
        const { name, action } = parameters;
        const state = await domainState(run, name);
        if (action === "start") {
          if (state !== "shut off") throw new Error(`VM ${name} is ${state}; only a stopped VM can be started`);
          progress?.(`$ virsh start ${name}`, "stdout");
          const result = await virsh(run, ["start", name], { timeout: 2 * 60_000 });
          if (!result.ok) throw new Error(`virsh start failed: ${result.stderr.split("\n").slice(-2).join(" ")}`);
          return { name, action, state: await domainState(run, name) };
        }
        if (action === "shutdown" || action === "reboot") {
          if (state !== "running") throw new Error(`VM ${name} is ${state}; ${action} needs a running VM`);
          progress?.(`$ virsh ${action} ${name}`, "stdout");
          const result = await virsh(run, [action, name], { timeout: 60_000 });
          if (!result.ok) throw new Error(`virsh ${action} failed: ${result.stderr.split("\n").slice(-2).join(" ")}`);
          if (action === "reboot") return { name, action, state: await domainState(run, name) };
          const deadline = Date.now() + 2 * 60_000;
          for (;;) {
            const current = await domainState(run, name);
            if (current === "shut off") return { name, action, state: current };
            if (Date.now() > deadline) throw new Error(`${name} did not stop within two minutes; the guest may be ignoring ACPI. Use Force off if you need it down now.`);
            progress?.(`waiting for the guest to stop (${current})...`, "stdout");
            await wait(3000);
          }
        }
        const enable = action === "autostart-on";
        progress?.(`$ virsh autostart ${enable ? "" : "--disable "}${name}`, "stdout");
        const result = await virsh(run, ["autostart", ...(enable ? [] : ["--disable"]), name], { timeout: 30_000 });
        if (!result.ok) throw new Error(`virsh autostart failed: ${result.stderr.split("\n").slice(-2).join(" ")}`);
        const info = await virsh(run, ["dominfo", name], { timeout: 15_000 });
        const autostart = /Autostart:\s+enable/.test(info.stdout ?? "");
        if (autostart !== enable) throw new Error("virsh accepted the change but dominfo does not reflect it");
        return { name, action, autostart };
      },
    }),
    defineOperation({
      id: "vm.force-off", title: "Force off a VM", risk: "medium", timeoutMs: 2 * 60_000,
      description: "Pulls the virtual power plug with virsh destroy. Unsaved data inside the guest is lost; the VM can be started again afterwards.",
      parameters: { fields: { name: nameField } },
      run: async (parameters, { run, progress }) => {
        const { name } = parameters;
        const state = await domainState(run, name);
        if (state === "shut off") throw new Error(`VM ${name} is already off`);
        progress?.(`$ virsh destroy ${name}`, "stdout");
        const result = await virsh(run, ["destroy", name], { timeout: 60_000 });
        if (!result.ok) throw new Error(`virsh destroy failed: ${result.stderr.split("\n").slice(-2).join(" ")}`);
        return { name, previousState: state, state: await domainState(run, name) };
      },
    }),
    defineOperation({
      id: "vm.delete", title: "Delete a VM", risk: "high", timeoutMs: 5 * 60_000,
      description: "Removes the VM definition and, when requested, its disks. The VM must be off. Independent restic backups are not touched.",
      parameters: { fields: { name: nameField, deleteStorage: { type: "boolean" } } },
      run: async (parameters, { run, progress }) => {
        const { name, deleteStorage } = parameters;
        const state = await domainState(run, name);
        if (state !== "shut off") throw new Error(`VM ${name} is ${state}; force it off first, then delete it`);
        const flags = ["--snapshots-metadata", ...(deleteStorage ? ["--remove-all-storage"] : [])];
        progress?.(`$ virsh undefine ${name} ${flags.join(" ")} --nvram`, "stdout");
        const withNvram = await virsh(run, ["undefine", name, ...flags, "--nvram"], { timeout: 3 * 60_000 });
        if (!withNvram.ok) {
          const withoutNvram = await virsh(run, ["undefine", name, ...flags], { timeout: 3 * 60_000 });
          if (!withoutNvram.ok) throw new Error(`virsh undefine failed: ${withoutNvram.stderr.split("\n").slice(-2).join(" ")}`);
        }
        const gone = await virsh(run, ["domstate", name], { timeout: 15_000 });
        if (gone.ok) throw new Error(`VM ${name} is still defined after undefine; inspect it with virsh`);
        return { name, deleted: true, storageDeleted: deleteStorage };
      },
    }),
    defineOperation({
      id: "vm.snapshot.revert", title: "Revert a VM to a snapshot", risk: "high", timeoutMs: 10 * 60_000,
      description: "Reverts the offline VM to the named snapshot. Everything changed since that snapshot is discarded; the VM stays off.",
      parameters: { fields: { name: nameField, snapshotName: snapshotField } },
      run: async (parameters, { run, progress }) => {
        const { name, snapshotName } = parameters;
        const state = await domainState(run, name);
        if (state !== "shut off") throw new Error(`VM ${name} is ${state}; snapshots revert only while it is off`);
        if (!(await snapshotExists(run, name, snapshotName))) throw new Error(`Snapshot ${snapshotName} does not exist on ${name}`);
        progress?.(`$ virsh snapshot-revert ${name} ${snapshotName}`, "stdout");
        const result = await virsh(run, ["snapshot-revert", name, snapshotName], { timeout: 8 * 60_000 });
        if (!result.ok) throw new Error(`virsh snapshot-revert failed: ${result.stderr.split("\n").slice(-2).join(" ")}`);
        return { name, snapshotName, reverted: true, state: await domainState(run, name) };
      },
    }),
    defineOperation({
      id: "vm.snapshot.delete", title: "Delete a VM snapshot", risk: "medium", timeoutMs: 10 * 60_000,
      description: "Deletes the named snapshot and merges its state into the disk. The VM itself is unchanged.",
      parameters: { fields: { name: nameField, snapshotName: snapshotField } },
      run: async (parameters, { run, progress }) => {
        const { name, snapshotName } = parameters;
        if (!(await snapshotExists(run, name, snapshotName))) throw new Error(`Snapshot ${snapshotName} does not exist on ${name}`);
        progress?.(`$ virsh snapshot-delete ${name} ${snapshotName}`, "stdout");
        const result = await virsh(run, ["snapshot-delete", name, snapshotName], { timeout: 8 * 60_000 });
        if (!result.ok) throw new Error(`virsh snapshot-delete failed: ${result.stderr.split("\n").slice(-2).join(" ")}`);
        return { name, snapshotName, deleted: true };
      },
    }),
  ];
}
