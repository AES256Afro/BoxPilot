import path from "node:path";
import { defineOperation } from "./registry.mjs";
import { validateCloudVmInput } from "../vm-cloud.mjs";

/** Where libvirt keeps the disks BoxPilot manages; the same root vm-helper.mjs confines to. */
const imageRoot = path.resolve(process.env.BOXPILOT_VM_IMAGE_ROOT ?? "/var/lib/libvirt/images");

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
/**
 * `virsh domstats` output → one record per domain with the counters the VM page turns into
 * rates. Counters are cumulative; the browser diffs two samples.
 */
export function parseDomstats(stdout) {
  const domains = [];
  let current = null;
  for (const raw of String(stdout ?? "").split("\n")) {
    const line = raw.trim();
    const header = line.match(/^Domain: '(.+)'$/);
    if (header) { current = { name: header[1], state: "unknown", cpuTimeNs: 0, vcpus: null, memoryKiB: null, memoryMaxKiB: null, diskReadBytes: 0, diskWriteBytes: 0, netRxBytes: 0, netTxBytes: 0 }; domains.push(current); continue; }
    if (!current || !line.includes("=")) continue;
    const [key, value] = line.split("=", 2).map((part) => part.trim());
    const number = Number(value);
    if (key === "state.state") current.state = ({ 1: "running", 2: "blocked", 3: "paused", 4: "shutdown", 5: "stopped", 6: "crashed", 7: "suspended" })[number] ?? "unknown";
    else if (key === "cpu.time") current.cpuTimeNs = number;
    else if (key === "vcpu.current" || key === "vcpu.maximum") current.vcpus = current.vcpus ?? number;
    else if (key === "balloon.current") current.memoryKiB = number;
    else if (key === "balloon.maximum") current.memoryMaxKiB = number;
    else if (/^block\.\d+\.rd\.bytes$/.test(key)) current.diskReadBytes += number;
    else if (/^block\.\d+\.wr\.bytes$/.test(key)) current.diskWriteBytes += number;
    else if (/^net\.\d+\.rx\.bytes$/.test(key)) current.netRxBytes += number;
    else if (/^net\.\d+\.tx\.bytes$/.test(key)) current.netTxBytes += number;
  }
  return domains;
}

export function vmOperations() {
  return [
    defineOperation({
      id: "vm.stats.inspect", title: "Read VM resource use", risk: "low", readOnly: true, timeoutMs: 30_000,
      description: "CPU time, memory, disk, and network counters for every domain from virsh domstats; the page turns two samples into rates.",
      run: async (_parameters, { run }) => {
        const result = await virsh(run, ["domstats", "--state", "--cpu-total", "--vcpu", "--balloon", "--block", "--interface"], { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
        if (!result.ok) throw new Error(`virsh domstats failed: ${result.stderr.split("\n").slice(-2).join(" ")}`);
        return { sampledAt: new Date().toISOString(), domains: parseDomstats(result.stdout) };
      },
    }),
    defineOperation({ id: "vm.cloud.images", title: "List cloud base images", risk: "low", readOnly: true, run: (_p, { vmCloud }) => vmCloud.images() }),
    defineOperation({
      id: "vm.cloud.create", title: "Create VM from cloud image", risk: "medium", timeoutMs: 90 * 60_000,
      description: "Downloads the official cloud image if needed (checksum verified), clones it to a new disk, seeds cloud-init with your user and SSH keys, boots the VM on the default NAT network, and waits for its address.",
      parameters: { exact: false, fields: { name: { type: "string", validate: (_v, all) => { const errors = validateCloudVmInput(all); return errors.length ? errors.join("; ") : null; } }, image: { type: "string" }, vcpus: { type: "number" }, memoryMiB: { type: "number" }, diskGiB: { type: "number" }, sshKeys: { type: "array" }, username: { type: "string", optional: true }, packages: { type: "array", optional: true }, autostart: { type: "boolean", optional: true }, password: { type: "string", optional: true, secret: true } } },
      run: (parameters, { vmCloud, runUnit, progress, jobLog }) => vmCloud.create(parameters, { progress, runUnit, jobLog }),
    }),
    defineOperation({
      id: "vm.media.import", title: "Import a staged ISO", risk: "medium", timeoutMs: 6 * 60 * 60_000,
      description: "Copies the staged upload into the managed media library, verifying its SHA-256 end to end. Nothing is overwritten.",
      parameters: { exact: false, fields: { filename: { type: "string", maxLength: 128 } } },
      run: (parameters, { vmMedia }) => vmMedia.importMedia(parameters),
    }),
    defineOperation({
      id: "vm.create", title: "Create a VM from a managed ISO", risk: "high", timeoutMs: 30 * 60_000,
      description: "Creates the exact reviewed domain with virt-install from a managed ISO. Failure removes only the newly created domain and its new storage.",
      parameters: { exact: false, fields: { name: { type: "string", maxLength: 64 } } },
      run: (parameters, { virtualization }) => virtualization.create(parameters),
    }),
    defineOperation({
      id: "vm.export.create", title: "Export a stopped VM", risk: "medium", timeoutMs: 6 * 60 * 60_000,
      description: "Converts the stopped VM's disks to standalone verified qcow2 files under a server-generated export id. The source is never changed.",
      parameters: { exact: false, fields: { name: { type: "string", maxLength: 64 } } },
      run: (parameters, { virtualization }) => virtualization.createExport(parameters),
    }),
    defineOperation({
      id: "vm.export.protect", title: "Protect a VM export independently", risk: "medium", timeoutMs: 12 * 60 * 60_000,
      description: "Writes the verified export into the encrypted independent restic repository and reads the whole repository back. Nothing is pruned.",
      parameters: { exact: false, fields: { exportId: { type: "string", maxLength: 40 } } },
      run: (parameters, { vmProtection, progress }) => vmProtection.createBackup(parameters, { progress }),
    }),
    defineOperation({
      id: "vm.backup.retention.apply", title: "Apply VM backup retention", risk: "medium", timeoutMs: 12 * 60 * 60_000,
      description: "Forgets only the pinned eligible old snapshots and verifies the repository afterwards. Never prunes.",
      parameters: { exact: false, fields: { retentionId: { type: "string", optional: true } } },
      run: ({ candidates: _candidates, expectedBeforeCount: _expectedBeforeCount, ...parameters }, { vmRetention }) => vmRetention.apply(parameters),
    }),
    defineOperation({
      id: "vm.backup.snapshot.forget", title: "Forget an unrecorded snapshot", risk: "high", timeoutMs: 2 * 60 * 60_000,
      description: "Removes one snapshot the encrypted repository holds and BoxPilot has no record of — normally a backup that was written and then failed its verification. Nothing that has a local record can be removed this way, and nothing is pruned.",
      minimumRole: "owner",
      parameters: { fields: { snapshotId: { type: "string", maxLength: 64, pattern: /^[a-f0-9]{64}$/ }, knownSnapshotIds: { type: "array", optional: true } } },
      confirm: (parameters) => String(parameters.snapshotId).slice(0, 8),
      run: (parameters, { vmRetention }) => vmRetention.forgetUnrecorded(parameters),
    }),
    defineOperation({
      id: "vm.backup.restore-drill", title: "Run an isolated VM restore drill", risk: "medium", timeoutMs: 12 * 60 * 60_000,
      description: "Restores the exact snapshot into a no-network transient domain, requires guest-agent health, then cleans up. A pass promotes the backup to protected.",
      parameters: { exact: false, fields: { backupId: { type: "string", maxLength: 40 } } },
      run: (parameters, { vmRestoreDrill, progress }) => vmRestoreDrill.runDrill(parameters, { progress }),
    }),
    defineOperation({
      id: "vm.recovery.create", title: "Create a recovery clone from a backup", risk: "medium", timeoutMs: 12 * 60 * 60_000,
      description: "Restores the drilled snapshot into a new persistent, stopped, no-network domain. The source VM and repository are never changed.",
      parameters: { exact: false, fields: { backupId: { type: "string", maxLength: 40 }, targetDomainName: { type: "string", maxLength: 64 } } },
      run: (parameters, { vmRecovery, progress }) => vmRecovery.createRecovery(parameters, { progress }),
    }),
    defineOperation({
      id: "vm.foundation.initialize", title: "Initialize the libvirt foundation", risk: "medium", timeoutMs: 5 * 60_000,
      description: "Defines, starts, and autostarts only the canonical default NAT network and default storage pool where missing. Failure rolls back only this job's changes.",
      parameters: { exact: false, fields: { foundationId: { type: "string", optional: true } } },
      run: (parameters, { foundation }) => foundation.initialize(parameters),
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
      id: "vm.delete", title: "Delete a VM", risk: "high", confirm: (parameters) => parameters.name, timeoutMs: 5 * 60_000,
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
      id: "vm.snapshot.create", title: "Snapshot a stopped VM", risk: "medium", timeoutMs: 10 * 60_000,
      description: "Creates an offline internal snapshot. Only stopped VMs with plain qcow2 disks qualify, and a snapshot is not an independent backup.",
      parameters: { fields: { name: nameField, snapshotName: snapshotField } },
      run: async (parameters, { run, progress }) => {
        const { name, snapshotName } = parameters;
        const state = await domainState(run, name);
        if (state !== "shut off") throw new Error(`VM ${name} is ${state}; offline snapshots need a stopped VM`);
        if (await snapshotExists(run, name, snapshotName)) throw new Error(`Snapshot ${snapshotName} already exists on ${name}`);
        const blocks = await virsh(run, ["domblklist", name, "--details"], { timeout: 15_000 });
        if (!blocks.ok) throw new Error(`Could not read the VM's disks: ${blocks.stderr.split("\n").slice(-2).join(" ")}`);
        // Rejoin the tail: a disk path containing a space is truncated by a plain field split,
        // and the VM then reports "is not qcow2" for a file that is. server/vm-helper.mjs does the
        // same, and this parser has to agree with it.
        const disks = blocks.stdout.split("\n").map((line) => line.trim().split(/\s+/))
          .filter((fields) => fields.length >= 4 && fields[0] === "file" && fields[1] === "disk")
          .map((fields) => ({ target: fields[2], source: fields.slice(3).join(" ") }));
        if (!disks.length) throw new Error(`${name} has no file-backed disks to snapshot`);
        for (const { target, source } of disks) {
          // The same confinement vm-helper applies: a disk path from an externally defined domain
          // is not automatically somewhere BoxPilot should be reading.
          const diskPath = path.resolve(source);
          if (diskPath !== imageRoot && !diskPath.startsWith(`${imageRoot}${path.sep}`)) throw new Error(`Disk ${target} (${source}) is outside ${imageRoot}; BoxPilot only snapshots disks it manages`);
          const info = await run("/usr/bin/qemu-img", ["info", "--output=json", source], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
          let parsed = null;
          try { parsed = JSON.parse(info.stdout); } catch { parsed = null; }
          if (!info.ok || parsed?.format !== "qcow2") throw new Error(`Disk ${target} (${source}) is not qcow2; internal snapshots need qcow2`);
          if (parsed["backing-filename"] || parsed["full-backing-filename"]) throw new Error(`Disk ${target} has a backing chain; this snapshot workflow does not support it`);
        }
        progress?.(`$ virsh snapshot-create-as ${name} ${snapshotName} --atomic`, "stdout");
        const create = await virsh(run, ["snapshot-create-as", name, snapshotName, "--description", "Created by BoxPilot offline snapshot workflow", "--atomic"], { timeout: 8 * 60_000 });
        if (!create.ok) throw new Error(`virsh snapshot-create-as failed: ${create.stderr.split("\n").slice(-2).join(" ")}`);
        const info = await virsh(run, ["snapshot-info", name, snapshotName], { timeout: 15_000 });
        const verified = /^Current:\s+yes$/mi.test(info.stdout ?? "") && /^Location:\s+internal$/mi.test(info.stdout ?? "") && /^State:\s+shut\s?off$/mi.test(info.stdout ?? "");
        if (!verified) throw new Error("The snapshot command returned, but offline internal verification failed. Leave the VM stopped and inspect it manually.");
        return { name, snapshotName, created: true, verified: true, consistency: "offline-consistent", independentBackup: false, diskTargets: disks.map(([, , target]) => target) };
      },
    }),
    defineOperation({
      id: "vm.snapshot.revert", title: "Revert a VM to a snapshot", risk: "high", confirm: (parameters) => parameters.name, timeoutMs: 10 * 60_000,
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
