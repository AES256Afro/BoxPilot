import { constants as fsConstants } from "node:fs";
import { access, statfs } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

async function fixedCommand(command, args, { timeout = 3000 } = {}) {
  try {
    const result = await execFile(command, args, { timeout, maxBuffer: 256 * 1024, encoding: "utf8" });
    return { ok: true, stdout: result.stdout.trim() };
  } catch (error) {
    return { ok: false, code: error.code ?? null };
  }
}

function check(id, group, name, status, summary, repair = null) {
  return { id, group, name, status, summary, repair };
}

export function createPrerequisiteService({ stateDirectory, helper, runCommand = fixedCommand, checkAccess = access, getFilesystem = statfs } = {}) {
  async function inspect() {
    const checks = [];
    const major = Number.parseInt(process.versions.node.split(".")[0], 10);
    checks.push(check(
      "runtime.node",
      "BoxPilot",
      "Node.js runtime",
      major >= 24 ? "ready" : "missing",
      major >= 24 ? `Node.js ${process.versions.node} satisfies the version 24 requirement` : `Node.js ${process.versions.node} is too old`,
      major >= 24 ? null : { kind: "manual", description: "Install a verified Node.js 24 or newer runtime" },
    ));

    try {
      await checkAccess(stateDirectory, fsConstants.R_OK | fsConstants.W_OK);
      const filesystem = await getFilesystem(stateDirectory);
      const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
      checks.push(check(
        "storage.state",
        "Storage",
        "State database directory",
        availableBytes >= 1024 ** 3 ? "ready" : "conflict",
        `${(availableBytes / 1024 ** 3).toFixed(1)} GiB available to BoxPilot state`,
        availableBytes >= 1024 ** 3 ? null : { kind: "manual", description: "Free at least 1 GiB before running jobs" },
      ));
    } catch {
      checks.push(check("storage.state", "Storage", "State database directory", "missing", "BoxPilot cannot read and write its state directory", { kind: "manual", description: "Restore ownership and mode 0700 on the BoxPilot state directory" }));
    }

    try {
      const result = await helper.request("canary.verify", {});
      checks.push(check(
        "helper.boundary",
        "BoxPilot",
        "Restricted helper",
        result?.verified && result?.mutationPerformed === false ? "ready" : "conflict",
        result?.verified ? `Typed protocol ${result.helperVersion} responded without host mutation` : "Helper response failed validation",
        result?.verified ? null : { kind: "guided", description: "Restart the restricted helper and verify its socket permissions" },
      ));
    } catch {
      checks.push(check("helper.boundary", "BoxPilot", "Restricted helper", "repairable", "The local helper socket is unavailable", { kind: "guided", description: "Start or repair boxpilot-helper.service" }));
    }

    let smartmontools = null;
    try {
      smartmontools = await helper.request("prerequisite.smartmontools.inspect", {});
    } catch {
      smartmontools = null;
    }
    checks.push(check(
      "storage.smartmontools",
      "Storage",
      "SMART monitoring tools",
      smartmontools?.installed ? "ready" : smartmontools?.repairAvailable ? "repairable" : "missing",
      smartmontools?.installed
        ? `smartmontools ${smartmontools.installedVersion} is installed for the fixed storage evidence timer`
        : smartmontools?.repairAvailable
          ? `Configured APT metadata offers the fixed smartmontools ${smartmontools.candidateVersion} candidate`
          : "smartmontools is not installed and no fixed configured APT candidate was verified",
      smartmontools?.installed ? null : smartmontools?.repairAvailable
        ? { kind: "approved", description: "Review an exact-version durable plan, reauthenticate, install only smartmontools, and verify a fresh fixed storage scan" }
        : { kind: "manual", description: "Repair configured Ubuntu APT metadata before creating an installation plan" },
    ));

    let restic = null;
    try {
      restic = await helper.request("prerequisite.restic.inspect", {});
    } catch {
      restic = null;
    }
    checks.push(check(
      "backup.restic",
      "Backups",
      "Restic encryption engine",
      restic?.installed ? "ready" : restic?.repairAvailable ? "repairable" : "missing",
      restic?.installed
        ? `restic package ${restic.installedVersion} is installed for fixed independent backup repositories`
        : restic?.repairAvailable
          ? `Configured APT metadata offers the fixed restic ${restic.candidateVersion} candidate`
          : "restic is not installed and no fixed configured APT candidate was verified",
      restic?.installed ? null : restic?.repairAvailable
        ? { kind: "approved", description: "Review an exact-version durable plan, reauthenticate, install only restic, and verify its fixed binary" }
        : { kind: "manual", description: "Repair configured Ubuntu APT metadata before creating a restic installation plan" },
    ));

    let aptMetadata = null;
    try {
      aptMetadata = await helper.request("prerequisite.apt-metadata.inspect", {});
    } catch {
      aptMetadata = null;
    }
    const aptReady = aptMetadata?.state === "current" && aptMetadata?.packageManagerState === "ready";
    const aptRepairable = aptMetadata?.refreshAvailable === true && aptMetadata?.packageManagerState === "ready";
    const aptInterrupted = aptMetadata?.packageManagerState === "interrupted";
    checks.push(check(
      "host.apt-metadata",
      "Host maintenance",
      "APT package metadata",
      aptReady ? "ready" : aptRepairable ? "repairable" : aptInterrupted ? "conflict" : "missing",
      aptReady
        ? `APT metadata is current${Number.isInteger(aptMetadata.ageHours) ? ` (${aptMetadata.ageHours} hours old)` : ""}; dpkg state is ready`
        : aptRepairable
          ? `APT metadata is ${aptMetadata.state}; the fixed metadata-only refresh is available`
          : aptInterrupted
            ? "dpkg has pending update fragments; metadata refresh is locked until package state is repaired"
            : "APT metadata or package-manager readiness could not be verified",
      aptReady ? null : aptRepairable
        ? { kind: "approved", description: "Review a durable fixed APT metadata refresh that performs no package install, upgrade, or removal" }
        : { kind: "manual", description: aptInterrupted ? "Repair interrupted dpkg state from the server console before refreshing metadata" : "Verify configured Ubuntu repositories and package-manager state" },
    ));

    let docker = null;
    try {
      docker = await helper.request("prerequisite.docker.inspect", {});
    } catch {
      docker = null;
    }
    checks.push(check(
      "containers.docker",
      "Applications",
      "Docker Engine",
      docker?.installed ? "ready" : docker?.repairAvailable ? "repairable" : "missing",
      docker?.installed
        ? `Docker Engine ${docker.engineVersion || "available"} is active through ${docker.provider === "ubuntu-docker.io" ? `Ubuntu docker.io ${docker.installedPackageVersion}` : "an existing compatible provider"}`
        : docker?.repairAvailable
          ? `Configured Ubuntu APT metadata offers the fixed docker.io ${docker.candidateVersion} candidate`
          : docker?.providerPresent
            ? "A Docker provider already occupies the fixed client path, but an active local daemon was not verified"
          : "Docker Engine is not active and no fixed configured Ubuntu docker.io candidate was verified",
      docker?.installed ? null : docker?.repairAvailable
        ? { kind: "approved", description: "Review an exact-version durable plan, reauthenticate, install only Ubuntu docker.io, and verify the active local daemon" }
        : { kind: "manual", description: "Repair configured Ubuntu APT metadata or an existing Docker provider before creating an installation plan" },
    ));

    let virtualization = null;
    try {
      virtualization = await helper.request("virtualization.inventory.inspect", { scope: "status" });
    } catch {
      virtualization = null;
    }
    const libvirtReady = virtualization?.checks?.some((item) => item.id === "connection" && item.ok)
      && virtualization?.checks?.some((item) => item.id === "helper" && item.ok);
    checks.push(check(
      "virtualization.libvirt",
      "Virtualization",
      "libvirt system connection",
      libvirtReady ? "ready" : "missing",
      libvirtReady ? "Restricted helper connected to qemu:///system" : "The helper-backed system libvirt connection is unavailable",
      libvirtReady ? null : { kind: "guided", description: "Repair the helper or run the existing virtualization setup repair" },
    ));

    const tailscale = await runCommand("tailscale", ["status", "--json"]);
    checks.push(check(
      "access.tailscale",
      "Private access",
      "Tailscale",
      tailscale.ok ? "ready" : "missing",
      tailscale.ok ? "Tailscale is connected; peer details remain redacted" : "Tailscale status is unavailable",
      tailscale.ok ? null : { kind: "manual", description: "Restore Tailscale before changing DNS or remote access" },
    ));

    const listeners = await runCommand("ss", ["-H", "-lntu"]);
    const port53InUse = listeners.ok && /(?:\*|\[[^\]]*\]|[0-9a-fA-F:.]+):53\s/.test(`${listeners.stdout}\n`);
    checks.push(check(
      "dns.port53",
      "DNS",
      "DNS listener port",
      port53InUse ? "conflict" : "ready",
      port53InUse ? "TCP or UDP port 53 is already occupied; identify the active resolver before deploying another" : "Port 53 is available for a future DNS appliance",
      port53InUse ? { kind: "manual", description: "Choose one primary DNS service or assign a separate VM address" } : null,
    ));

    const counts = checks.reduce((summary, item) => ({ ...summary, [item.status]: (summary[item.status] ?? 0) + 1 }), {});
    return { generatedAt: new Date().toISOString(), checks, counts, ready: checks.every((item) => item.status === "ready") };
  }

  return { inspect };
}
