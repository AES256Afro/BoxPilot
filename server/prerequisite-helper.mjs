import { readFile, unlink, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { createMaintenanceService } from "./maintenance.mjs";

const execFile = promisify(execFileCallback);
const defaultDpkgQuery = "/usr/bin/dpkg-query";
const defaultAptCache = "/usr/bin/apt-cache";
const defaultSystemctl = "/usr/bin/systemctl";
const defaultEvidencePath = "/var/lib/boxpilot/storage-health.json";
const defaultApprovalPath = "/run/boxpilot/smartmontools-approval.json";
const defaultResticApprovalPath = "/run/boxpilot/restic-approval.json";
const defaultAptApprovalPath = "/run/boxpilot/apt-refresh-approval.json";
const versionPattern = /^[0-9A-Za-z.+:~_-]{1,64}$/;

async function fixedRun(binary, args, { timeout = 30000 } = {}) {
  try {
    const result = await execFile(binary, args, { timeout, maxBuffer: 256 * 1024, encoding: "utf8", env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" } });
    return { ok: true, stdout: result.stdout.trim() };
  } catch (error) {
    return { ok: false, stdout: typeof error.stdout === "string" ? error.stdout.trim() : "", code: error.code ?? null };
  }
}

function cleanVersion(value) {
  const candidate = String(value ?? "").trim();
  return versionPattern.test(candidate) && candidate !== "(none)" ? candidate : null;
}

function installedVersion(output) {
  const [status, version] = String(output ?? "").split("\t", 2);
  return status === "install ok installed" ? cleanVersion(version) : null;
}

function candidateVersion(output) {
  return cleanVersion(String(output ?? "").match(/^\s*Candidate:\s*(\S+)\s*$/m)?.[1]);
}

async function clearApprovalFile() {
  try {
    await unlink(defaultApprovalPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function writeApprovalFile(approval) {
  await writeFile(defaultApprovalPath, `${JSON.stringify(approval)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

async function clearResticApprovalFile() {
  try {
    await unlink(defaultResticApprovalPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function writeResticApprovalFile(approval) {
  await writeFile(defaultResticApprovalPath, `${JSON.stringify(approval)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

async function clearAptApprovalFile() {
  try {
    await unlink(defaultAptApprovalPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function writeAptApprovalFile(approval) {
  await writeFile(defaultAptApprovalPath, `${JSON.stringify(approval)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

export function createPrerequisiteHelper({
  run = fixedRun,
  loadEvidence = () => readFile(defaultEvidencePath, "utf8"),
  now = () => new Date(),
  dpkgQueryBinary = defaultDpkgQuery,
  aptCacheBinary = defaultAptCache,
  systemctlBinary = defaultSystemctl,
  clearApproval = clearApprovalFile,
  writeApproval = writeApprovalFile,
  clearResticApproval = clearResticApprovalFile,
  writeResticApproval = writeResticApprovalFile,
  maintenance = createMaintenanceService(),
  clearAptApproval = clearAptApprovalFile,
  writeAptApproval = writeAptApprovalFile,
} = {}) {
  async function inspectSmartmontools() {
    const [installedResult, policyResult] = await Promise.all([
      run(dpkgQueryBinary, ["--show", "--showformat=${Status}\\t${Version}", "smartmontools"], { timeout: 10000 }),
      run(aptCacheBinary, ["policy", "smartmontools"], { timeout: 10000 }),
    ]);
    const installed = installedResult.ok ? installedVersion(installedResult.stdout) : null;
    const candidate = policyResult.ok ? candidateVersion(policyResult.stdout) : null;
    const selected = installed ?? candidate;
    return {
      package: "smartmontools",
      installed: installed !== null,
      installedVersion: installed,
      candidateVersion: candidate,
      selectedVersion: selected,
      supported: selected !== null,
      repairAvailable: installed === null && candidate !== null,
      source: candidate ? "configured-apt-candidate" : installed ? "installed-package-database" : "unavailable",
      mutationPerformed: false,
      arbitraryPackageAccepted: false,
    };
  }

  async function installSmartmontools({ expectedVersion }) {
    if (!versionPattern.test(String(expectedVersion ?? ""))) throw new Error("The expected smartmontools version is invalid");
    const before = await inspectSmartmontools();
    if (!before.supported || before.selectedVersion !== expectedVersion) throw new Error("Host state changed: the fixed smartmontools candidate no longer matches the approved plan");
    const service = before.installed ? "boxpilot-storage-scan.service" : "boxpilot-smartmontools-install.service";
    if (!before.installed) {
      await clearApproval();
      await writeApproval({ expectedVersion, approvedAt: now().toISOString() });
    }
    let start;
    try {
      start = await run(systemctlBinary, ["start", service], { timeout: before.installed ? 120000 : 15 * 60 * 1000 });
    } finally {
      if (!before.installed) await clearApproval();
    }
    if (!start.ok) throw new Error(before.installed ? "The fixed storage evidence scan failed" : "The fixed smartmontools installation service failed");
    const after = await inspectSmartmontools();
    if (!after.installed || after.installedVersion !== expectedVersion) throw new Error("smartmontools did not match the approved version after installation");
    let evidence = null;
    try { evidence = JSON.parse(await loadEvidence()); } catch { evidence = null; }
    const generatedTime = typeof evidence?.generatedAt === "string" ? Date.parse(evidence.generatedAt) : Number.NaN;
    const evidenceRefreshed = Number.isFinite(generatedTime) && Math.abs(now().getTime() - generatedTime) <= 5 * 60 * 1000;
    if (!evidenceRefreshed) throw new Error("The fixed storage evidence scan did not produce current evidence");
    return {
      package: "smartmontools",
      installed: true,
      version: after.installedVersion,
      packageChanged: !before.installed,
      scan: { completed: true, evidenceRefreshed, smartEvidenceAvailable: evidence?.available === true, diskResults: Array.isArray(evidence?.disks) ? Math.min(evidence.disks.length, 16) : 0 },
      boundary: { fixedPackage: true, arbitraryPackageAccepted: false, aptUpdatePerformed: false, packageRemovalPerformed: false, browserCommandAccepted: false },
    };
  }

  async function inspectRestic() {
    const [installedResult, policyResult] = await Promise.all([
      run(dpkgQueryBinary, ["--show", "--showformat=${Status}\\t${Version}", "restic"], { timeout: 10000 }),
      run(aptCacheBinary, ["policy", "restic"], { timeout: 10000 }),
    ]);
    const installed = installedResult.ok ? installedVersion(installedResult.stdout) : null;
    const candidate = policyResult.ok ? candidateVersion(policyResult.stdout) : null;
    const selected = installed ?? candidate;
    return {
      package: "restic",
      installed: installed !== null,
      installedVersion: installed,
      candidateVersion: candidate,
      selectedVersion: selected,
      supported: selected !== null,
      repairAvailable: installed === null && candidate !== null,
      source: candidate ? "configured-apt-candidate" : installed ? "installed-package-database" : "unavailable",
      mutationPerformed: false,
      arbitraryPackageAccepted: false,
    };
  }

  async function installRestic({ expectedVersion }) {
    if (!versionPattern.test(String(expectedVersion ?? ""))) throw new Error("The expected restic version is invalid");
    const before = await inspectRestic();
    if (!before.supported || before.selectedVersion !== expectedVersion) throw new Error("Host state changed: the fixed restic candidate no longer matches the approved plan");
    if (!before.installed) {
      await clearResticApproval();
      await writeResticApproval({ expectedVersion, approvedAt: now().toISOString() });
      let start;
      try {
        start = await run(systemctlBinary, ["start", "boxpilot-restic-install.service"], { timeout: 15 * 60 * 1000 });
      } finally {
        await clearResticApproval();
      }
      if (!start.ok) throw new Error("The fixed restic installation service failed");
    }
    const after = await inspectRestic();
    if (!after.installed || after.installedVersion !== expectedVersion) throw new Error("restic did not match the approved version after installation");
    const binary = await run("/usr/bin/restic", ["version"], { timeout: 10000 });
    if (!binary.ok || !/^restic\s+\S+/i.test(binary.stdout)) throw new Error("The installed restic binary did not pass its fixed version probe");
    return {
      package: "restic",
      installed: true,
      version: after.installedVersion,
      packageChanged: !before.installed,
      binaryVerified: true,
      next: {
        mountConfigured: false,
        recoveryKeyCreated: false,
        repositoryInitialized: false,
        automaticSetupPerformed: false,
      },
      boundary: { fixedPackage: true, arbitraryPackageAccepted: false, aptUpdatePerformed: false, packageUpgradePerformed: false, packageRemovalPerformed: false, mountChanged: false, passwordCreated: false, repositoryInitialized: false, browserCommandAccepted: false },
    };
  }

  async function inspectAptMetadata() {
    const evidence = await maintenance.inspect();
    const packageManagerState = evidence.packageManager.state;
    return {
      available: evidence.aptMetadata.available,
      state: evidence.aptMetadata.state,
      updatedAt: evidence.aptMetadata.updatedAt,
      ageHours: evidence.aptMetadata.ageHours,
      packageManagerState,
      refreshAvailable: packageManagerState === "ready" && evidence.aptMetadata.state !== "current",
      source: "fixed-local-apt-metadata",
      mutationPerformed: false,
      arbitraryCommandAccepted: false,
    };
  }

  async function refreshAptMetadata({ expectedUpdatedAt }) {
    if (!(expectedUpdatedAt === null || (typeof expectedUpdatedAt === "string" && Number.isFinite(Date.parse(expectedUpdatedAt))))) throw new Error("The expected APT metadata timestamp is invalid");
    const before = await inspectAptMetadata();
    if (before.packageManagerState !== "ready") throw new Error("The package manager is not ready for a metadata refresh");
    if (before.updatedAt !== expectedUpdatedAt || before.state === "current") throw new Error("Host state changed: APT metadata no longer matches the approved plan");
    await clearAptApproval();
    await writeAptApproval({ approvedAt: now().toISOString(), expectedUpdatedAt });
    let start;
    try {
      start = await run(systemctlBinary, ["start", "boxpilot-apt-refresh.service"], { timeout: 15 * 60 * 1000 });
    } finally {
      await clearAptApproval();
    }
    if (!start.ok) throw new Error("The fixed APT metadata refresh service failed");
    const after = await inspectAptMetadata();
    if (after.packageManagerState !== "ready" || after.state !== "current" || after.updatedAt === before.updatedAt) throw new Error("APT metadata was not verified current after the approved refresh");
    return {
      refreshed: true,
      updatedAt: after.updatedAt,
      state: after.state,
      packageManagerState: after.packageManagerState,
      boundary: {
        fixedAptUpdateOnly: true,
        packageInstallPerformed: false,
        packageUpgradePerformed: false,
        packageRemovalPerformed: false,
        serviceMutationPerformed: false,
        rebootPerformed: false,
        arbitraryCommandAccepted: false,
        browserArgumentAccepted: false,
      },
    };
  }

  return { inspectSmartmontools, installSmartmontools, inspectRestic, installRestic, inspectAptMetadata, refreshAptMetadata };
}

export const prerequisiteHelperInternals = { candidateVersion, cleanVersion, defaultAptCache, defaultAptApprovalPath, defaultApprovalPath, defaultResticApprovalPath, defaultDpkgQuery, defaultEvidencePath, defaultSystemctl, installedVersion, versionPattern };
