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

/**
 * Is anything listening on port 53, per one line of `ss -H -lntu` output?
 *
 * Ubuntu's own systemd-resolved prints its stub listener as `127.0.0.53%lo:53`, and the scoped
 * form is the whole point of this check: it is what makes a Pi-hole or AdGuard container fail to
 * bind. An address pattern that stopped at the `%` matched every other resolver and missed the
 * one that is actually there on a stock install.
 */
export function port53Occupied(text) {
  return String(text ?? "").split("\n").some((line) => {
    const columns = line.trim().split(/\s+/);
    // ss -H -lntu: Netid State Recv-Q Send-Q Local:Port Peer:Port
    const local = columns[4];
    if (!local) return false;
    return local.slice(local.lastIndexOf(":")) === ":53";
  });
}

export function createPrerequisiteService({ stateDirectory, helper, runCommand = fixedCommand, checkAccess = access, getFilesystem = statfs } = {}) {
  /**
   * The six helper inspections this page needs are independent of each other, so they are sent
   * together: the page waits for the slowest, not for the sum. The helper caps concurrent
   * read-only work at eight, so this cannot flood it.
   */
  function gatherInspections() {
    const quiet = (operation) => helper.request(operation, {}).catch(() => null);
    return {
      canary: helper.request("canary.verify", {}).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error })),
      smartmontools: quiet("prerequisite.smartmontools.inspect"),
      restic: quiet("prerequisite.restic.inspect"),
      aptMetadata: quiet("prerequisite.apt-metadata.inspect"),
      docker: quiet("prerequisite.docker.inspect"),
      virtualization: quiet("prerequisite.virtualization.inspect"),
    };
  }

  async function collect() {
    const pending = gatherInspections();
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
      const canary = await pending.canary;
      if (!canary.ok) throw canary.error;
      const result = canary.value;
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

    const smartmontools = await pending.smartmontools;
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

    const restic = await pending.restic;
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

    const aptMetadata = await pending.aptMetadata;
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

    const docker = await pending.docker;
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

    const virtualization = await pending.virtualization;
    checks.push(check(
      "virtualization.libvirt",
      "Virtualization",
      "KVM, QEMU, and libvirt",
      virtualization?.installed ? "ready" : virtualization?.repairAvailable ? "repairable" : virtualization && !virtualization.kvmDeviceAvailable ? "conflict" : "missing",
      virtualization?.installed
        ? "The fixed Ubuntu virtualization package set, /dev/kvm, QEMU, libvirtd.service, and qemu:///system are ready"
        : virtualization?.repairAvailable
          ? "The KVM kernel interface is registered and configured Ubuntu metadata offers every fixed package candidate"
          : virtualization?.providerPresent
            ? "A partial or inactive virtualization provider is present and will not be replaced automatically"
            : virtualization && !virtualization.kvmDeviceAvailable
              ? "The KVM kernel interface is unavailable"
              : "The virtualization package candidates or helper inspection are unavailable",
      virtualization?.installed ? null : virtualization?.repairAvailable
        ? { kind: "approved", description: "Review the exact five-package Ubuntu virtualization plan, reauthenticate, and verify KVM plus qemu:///system" }
        : { kind: "manual", description: virtualization && !virtualization.kvmDeviceAvailable ? "Enable hardware virtualization in firmware and verify the KVM kernel interface before planning installation" : "Repair the existing provider or configured Ubuntu package metadata before planning installation" },
    ));

    const tailscale = await runCommand("tailscale", ["status", "--json"], { timeout: 8000 });
    // An exit code only says the command ran. Whether the tailnet is actually up is BackendState,
    // which is what server/inventory.mjs reads — the two used to disagree about the same host.
    let tailscaleState = "unreadable";
    if (tailscale.ok) { try { tailscaleState = JSON.parse(tailscale.stdout || "{}")?.BackendState ?? "unknown"; } catch { tailscaleState = "unreadable"; } }
    const tailscaleRunning = tailscaleState === "Running";
    checks.push(check(
      "access.tailscale",
      "Private access",
      "Tailscale",
      tailscaleRunning ? "ready" : "missing",
      tailscaleRunning ? "Tailscale is connected; peer details remain redacted" : tailscale.ok ? `Tailscale is installed but not connected (${tailscaleState})` : "Tailscale status is unavailable",
      tailscaleRunning ? null : { kind: "manual", description: "Restore Tailscale before changing DNS or remote access" },
    ));

    const listeners = await runCommand("ss", ["-H", "-lntu"]);
    const port53InUse = listeners.ok && port53Occupied(listeners.stdout);
    checks.push(check(
      "dns.port53",
      "DNS",
      "DNS listener port",
      !listeners.ok ? "unavailable" : port53InUse ? "conflict" : "ready",
      !listeners.ok
        ? "The listening-socket list could not be read, so nothing is known about port 53"
        : port53InUse ? "TCP or UDP port 53 is already occupied; identify the active resolver before deploying another" : "Port 53 is available for a future DNS appliance",
      !listeners.ok
        ? { kind: "manual", description: "Check port 53 yourself with: ss -lntu | grep :53" }
        : port53InUse ? { kind: "manual", description: "Choose one primary DNS service or assign a separate VM address" } : null,
    ));

    const counts = checks.reduce((summary, item) => ({ ...summary, [item.status]: (summary[item.status] ?? 0) + 1 }), {});
    return { generatedAt: new Date().toISOString(), checks, counts, ready: checks.every((item) => item.status === "ready") };
  }

  // Three panels on the Repair Center ask for this at once, and the page re-asks every ten seconds
  // while a job runs. One collection is ~29 child processes on the helper, eight of them parsing
  // the whole APT cache, so callers arriving together share one.
  const ttlMs = 10_000;
  let cached = null;
  let inFlight = null;
  async function inspect() {
    if (cached && Date.now() - cached.at < ttlMs) return cached.value;
    if (inFlight) return inFlight;
    inFlight = collect().then((value) => { cached = { at: Date.now(), value }; return value; }).finally(() => { inFlight = null; });
    return inFlight;
  }

  return { inspect };
}
