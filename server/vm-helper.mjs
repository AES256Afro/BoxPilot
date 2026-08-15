import { execFile as execFileCallback } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createLibvirtService } from "./libvirt.mjs";
import { buildVirtInstallArguments, normalizeVmPlanInput, validateVmPlanInput } from "./vm-plan.mjs";
import { vmLifecycleActions } from "./vm-lifecycle.mjs";
import { snapshotDiskRevision, snapshotInventoryRevision, validateVmSnapshotInput } from "./vm-snapshot.mjs";

const execFile = promisify(execFileCallback);

async function defaultRunner(binary, args, { timeout = 180000 } = {}) {
  const result = await execFile(binary, args, {
    timeout,
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
    env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" },
  });
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createVmHelper({
  mediaRoot = process.env.BOXPILOT_ISO_DIRECTORY ?? "/var/lib/libvirt/boot",
  connectionUri = process.env.BOXPILOT_LIBVIRT_URI ?? "qemu:///system",
  virtInstallBinary = process.env.BOXPILOT_VIRT_INSTALL_BINARY ?? "/usr/bin/virt-install",
  virshBinary = process.env.BOXPILOT_VIRSH_BINARY ?? "/usr/bin/virsh",
  qemuBinary = process.env.BOXPILOT_QEMU_BINARY ?? (process.arch === "arm64" ? "/usr/bin/qemu-system-aarch64" : "/usr/bin/qemu-system-x86_64"),
  qemuImgBinary = process.env.BOXPILOT_QEMU_IMG_BINARY ?? "/usr/bin/qemu-img",
  tailscaleBinary = process.env.BOXPILOT_TAILSCALE_BINARY ?? "/usr/bin/tailscale",
  systemctlBinary = process.env.BOXPILOT_SYSTEMCTL_BINARY ?? "/usr/bin/systemctl",
  imageRoot = process.env.BOXPILOT_VM_IMAGE_ROOT ?? "/var/lib/libvirt/images",
  statFile = lstat,
  run = defaultRunner,
  wait = delay,
} = {}) {
  const resolvedMediaRoot = path.resolve(mediaRoot);
  const resolvedImageRoot = path.resolve(imageRoot);

  async function readOnlyCommand(command, args, options = {}) {
    const binary = command === "virsh" ? virshBinary
      : command === "virt-install" ? virtInstallBinary
        : command === "tailscale" ? tailscaleBinary
          : command === "qemu-system-x86_64" || command === "qemu-system-aarch64" ? qemuBinary
            : null;
    if (!binary) return { ok: false, stdout: "", stderr: "Command is not available through the fixed inventory adapter" };
    try {
      const result = await run(binary, args, { timeout: options.timeout ?? 8000 });
      return { ok: true, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    } catch (error) {
      return {
        ok: false,
        stdout: typeof error.stdout === "string" ? error.stdout.trim() : "",
        stderr: typeof error.stderr === "string" ? error.stderr.trim() : error.message,
        code: error.code,
      };
    }
  }

  const inventoryService = createLibvirtService({
    runCommand: readOnlyCommand,
    checkKvmAccess: async () => {
      const result = await readOnlyCommand("virsh", ["--connect", connectionUri, "domcapabilities"]);
      return result.ok && result.stdout.includes("<domain>kvm</domain>");
    },
  });

  async function virsh(args, options) {
    return run(virshBinary, ["--connect", connectionUri, ...args], options);
  }

  async function domainNames() {
    const result = await virsh(["list", "--all", "--name"], { timeout: 15000 });
    return result.stdout.split("\n").map((name) => name.trim()).filter(Boolean);
  }

  async function rollbackCreatedDomain(name) {
    await virsh(["destroy", name], { timeout: 30000 }).catch(() => {});
    await virsh(["undefine", name, "--remove-all-storage", "--nvram"], { timeout: 120000 })
      .catch(() => virsh(["undefine", name, "--remove-all-storage"], { timeout: 120000 }));
  }

  async function domainSnapshot(name) {
    const [stateResult, infoResult] = await Promise.all([
      virsh(["domstate", name], { timeout: 15000 }),
      virsh(["dominfo", name], { timeout: 15000 }),
    ]);
    const state = stateResult.stdout === "shut off" ? "stopped" : stateResult.stdout.split("\n")[0].trim();
    const autostartMatch = infoResult.stdout.match(/^Autostart:\s+(enable|disable|yes|no)/mi);
    if (!["running", "stopped"].includes(state) || !autostartMatch) throw new Error("Unable to verify the current VM lifecycle state");
    const uuidMatch = infoResult.stdout.match(/^UUID:\s+([a-f0-9-]+)$/mi);
    return { state, autostart: ["enable", "yes"].includes(autostartMatch[1].toLowerCase()), uuid: uuidMatch?.[1]?.toLowerCase() ?? null };
  }

  async function snapshotNames(name) {
    const result = await virsh(["snapshot-list", name, "--name"], { timeout: 15000 });
    return result.stdout.split("\n").map((value) => value.trim()).filter(Boolean);
  }

  function parseDiskSources(output) {
    const lines = output.split("\n");
    const separator = lines.findIndex((line) => /^\s*-{3,}/.test(line));
    return (separator === -1 ? [] : lines.slice(separator + 1))
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts.length >= 4 && parts[1] === "disk")
      .map((parts) => ({ type: parts[0], device: parts[1], target: parts[2], source: parts.slice(3).join(" ") }));
  }

  async function verifySnapshotDisks(name) {
    const blockResult = await virsh(["domblklist", name, "--details"], { timeout: 15000 });
    const disks = parseDiskSources(blockResult.stdout);
    if (!disks.length || disks.some((disk) => disk.type !== "file")) throw new Error("Every writable VM disk must be file-backed");
    for (const disk of disks) {
      const diskPath = path.resolve(disk.source);
      if (diskPath === resolvedImageRoot || !diskPath.startsWith(`${resolvedImageRoot}${path.sep}`)) throw new Error("VM disk escaped the managed default image directory");
      const metadata = await statFile(diskPath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) throw new Error("VM disk must be a regular non-empty file with no symlink");
      const infoResult = await run(qemuImgBinary, ["info", "--output=json", diskPath], { timeout: 30000 });
      const info = JSON.parse(infoResult.stdout);
      if (info.format !== "qcow2") throw new Error("Offline internal snapshots require qcow2 disks");
      if (info["backing-filename"] || info["full-backing-filename"]) throw new Error("VM disks with a backing chain are not supported by this snapshot workflow");
    }
    return { targets: disks.map((disk) => disk.target), revision: snapshotDiskRevision(disks) };
  }

  async function waitForState(name, desiredState, attempts) {
    let current = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      current = await domainSnapshot(name);
      if (current.state === desiredState) return current;
      await wait(1000);
    }
    throw new Error(`VM did not reach ${desiredState} before the verification timeout`);
  }

  async function action(parameters) {
    const definition = vmLifecycleActions[parameters.action];
    if (!definition) throw new Error("Unsupported VM lifecycle action");
    const previous = await domainSnapshot(parameters.name);
    if (previous.state !== parameters.expectedState || previous.autostart !== parameters.expectedAutostart) {
      throw new Error("VM lifecycle state changed after approval");
    }
    const actionArguments = parameters.action === "start" ? ["start", parameters.name]
      : parameters.action === "shutdown" ? ["shutdown", parameters.name]
        : parameters.action === "reboot" ? ["reboot", parameters.name]
          : parameters.action === "autostart-on" ? ["autostart", parameters.name]
            : ["autostart", parameters.name, "--disable"];
    await virsh(actionArguments, { timeout: 30000 });
    const current = parameters.action === "shutdown" ? await waitForState(parameters.name, "stopped", 120)
      : parameters.action === "start" ? await waitForState(parameters.name, "running", 30)
        : await domainSnapshot(parameters.name);
    if (parameters.action === "reboot" && current.state !== "running") throw new Error("VM reboot request did not leave the domain running");
    if (definition.desiredAutostart !== undefined && current.autostart !== definition.desiredAutostart) throw new Error("VM autostart verification failed");
    return {
      action: parameters.action,
      domain: parameters.name,
      verified: true,
      previous,
      current,
      verification: parameters.action === "reboot" ? "reboot-request-accepted-domain-running" : "desired-state-observed",
    };
  }

  async function inventory({ scope }) {
    if (scope === "status") return inventoryService.getStatus();
    if (scope === "domains") return inventoryService.listDomains();
    if (scope === "resources") return inventoryService.listResources();
    throw new Error("Unsupported virtualization inventory scope");
  }

  async function consoleGuidance() {
    let tailscaleDnsName = null;
    const tailscale = await readOnlyCommand("tailscale", ["status", "--json"], { timeout: 10000 });
    if (tailscale.ok) {
      try { tailscaleDnsName = JSON.parse(tailscale.stdout).Self?.DNSName?.replace(/\.$/, "") ?? null; } catch { tailscaleDnsName = null; }
    }
    try {
      const result = await run(systemctlBinary, ["show", "cockpit.socket", "--property=LoadState,ActiveState,UnitFileState", "--no-pager"], { timeout: 10000 });
      const values = Object.fromEntries(result.stdout.split("\n").map((line) => line.split("=", 2)).filter((parts) => parts.length === 2));
      return {
        nativeProxyAvailable: false,
        cockpit: {
          installed: values.LoadState === "loaded",
          active: values.ActiveState === "active",
          enabled: ["enabled", "enabled-runtime"].includes(values.UnitFileState),
          port: 9090,
        },
        tailscaleDnsName,
      };
    } catch {
      return { nativeProxyAvailable: false, cockpit: { installed: false, active: false, enabled: false, port: 9090 }, tailscaleDnsName };
    }
  }

  async function createSnapshot(parameters) {
    const errors = validateVmSnapshotInput(parameters);
    if (errors.length) throw new Error(errors.join(" | "));
    const previous = await domainSnapshot(parameters.name);
    if (previous.uuid !== parameters.expectedUuid.toLowerCase() || previous.state !== parameters.expectedState) throw new Error("VM identity or state changed after approval");
    const previousSnapshots = await snapshotNames(parameters.name);
    if (previousSnapshots.includes(parameters.snapshotName)) throw new Error("The requested snapshot name already exists");
    if (snapshotInventoryRevision(previousSnapshots) !== parameters.expectedSnapshotRevision) throw new Error("VM snapshot inventory changed after approval");
    const disks = await verifySnapshotDisks(parameters.name);
    if (disks.revision !== parameters.expectedDiskRevision) throw new Error("VM disk topology changed after approval");
    await virsh([
      "snapshot-create-as", parameters.name, parameters.snapshotName,
      "--description", "Created by BoxPilot offline snapshot workflow",
      "--atomic",
    ], { timeout: 180000 });
    const currentSnapshots = await snapshotNames(parameters.name);
    const info = await virsh(["snapshot-info", parameters.name, parameters.snapshotName], { timeout: 15000 });
    const verified = currentSnapshots.includes(parameters.snapshotName)
      && /^Current:\s+yes$/mi.test(info.stdout)
      && /^Location:\s+internal$/mi.test(info.stdout)
      && /^State:\s+shut\s?off$/mi.test(info.stdout);
    if (!verified) throw new Error("Snapshot command returned, but offline internal snapshot verification failed. Leave the VM stopped and inspect it manually.");
    return {
      created: true,
      verified: true,
      domain: parameters.name,
      snapshotName: parameters.snapshotName,
      consistency: "offline-consistent",
      independentBackup: false,
      diskTargets: disks.targets,
      snapshotCount: currentSnapshots.length,
      snapshotRevision: snapshotInventoryRevision(currentSnapshots),
    };
  }

  async function create(parameters) {
    const errors = validateVmPlanInput(parameters);
    if (errors.length) throw new Error(errors.join(" | "));
    const input = normalizeVmPlanInput(parameters);
    if (input.osProfile === "windows-11") throw new Error("Windows 11 creation remains locked until TPM 2.0 and Secure Boot checks are implemented");
    if ((await domainNames()).includes(input.name)) throw new Error(`A libvirt domain named ${input.name} already exists`);

    const isoPath = path.join(resolvedMediaRoot, input.isoFile);
    const metadata = await statFile(isoPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) {
      throw new Error("The selected managed ISO is not a regular non-empty file");
    }

    const args = buildVirtInstallArguments(input, { mediaRoot: resolvedMediaRoot, connectionUri });
    let creationAttempted = false;
    try {
      creationAttempted = true;
      await run(virtInstallBinary, args, { timeout: 180000 });
      const [info, disks, interfaces] = await Promise.all([
        virsh(["dominfo", input.name], { timeout: 15000 }),
        virsh(["domblklist", input.name, "--details"], { timeout: 15000 }),
        virsh(["domiflist", input.name], { timeout: 15000 }),
      ]);
      if (!info.stdout.includes(`Name:           ${input.name}`) && !info.stdout.match(new RegExp(`Name:\\s+${input.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`))) {
        throw new Error("Created domain identity verification failed");
      }
      const autostartMatch = info.stdout.match(/^Autostart:\s+(enable|disable)/mi);
      if (!autostartMatch || (autostartMatch[1] === "enable") !== input.autostart) {
        throw new Error("Created domain autostart verification failed");
      }
      if (!disks.stdout.includes(" disk ") || !interfaces.stdout.includes(" default ")) {
        throw new Error("Created domain disk or default network verification failed");
      }
      return {
        created: true,
        verified: true,
        domain: input.name,
        media: input.isoFile,
        storagePool: "default",
        network: "default",
        autostart: input.autostart,
      };
    } catch (error) {
      let rollback = "not-required";
      if (creationAttempted) {
        try {
          if ((await domainNames()).includes(input.name)) {
            await rollbackCreatedDomain(input.name);
            rollback = "completed";
          }
        } catch {
          rollback = "failed";
        }
      }
      const suffix = rollback === "completed"
        ? " Automated rollback completed."
        : rollback === "failed"
          ? " Automated rollback failed; inspect the exact managed domain before retrying."
          : "";
      throw new Error(`${error.message}${suffix}`);
    }
  }

  return { create, action, inventory, consoleGuidance, createSnapshot };
}

export const vmHelperInternals = { defaultRunner };
