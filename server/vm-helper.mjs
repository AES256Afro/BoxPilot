import { execFile as execFileCallback } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { buildVirtInstallArguments, normalizeVmPlanInput, validateVmPlanInput } from "./vm-plan.mjs";
import { vmLifecycleActions } from "./vm-lifecycle.mjs";

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
  statFile = lstat,
  run = defaultRunner,
  wait = delay,
} = {}) {
  const resolvedMediaRoot = path.resolve(mediaRoot);

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
    return { state, autostart: ["enable", "yes"].includes(autostartMatch[1].toLowerCase()) };
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

  return { create, action };
}

export const vmHelperInternals = { defaultRunner };
