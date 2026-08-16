import { readFile, unlink, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const defaultDpkgQuery = "/usr/bin/dpkg-query";
const defaultAptCache = "/usr/bin/apt-cache";
const defaultSystemctl = "/usr/bin/systemctl";
const defaultEvidencePath = "/var/lib/boxpilot/storage-health.json";
const defaultApprovalPath = "/run/boxpilot/smartmontools-approval.json";
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

export function createPrerequisiteHelper({
  run = fixedRun,
  loadEvidence = () => readFile(defaultEvidencePath, "utf8"),
  now = () => new Date(),
  dpkgQueryBinary = defaultDpkgQuery,
  aptCacheBinary = defaultAptCache,
  systemctlBinary = defaultSystemctl,
  clearApproval = clearApprovalFile,
  writeApproval = writeApprovalFile,
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

  return { inspectSmartmontools, installSmartmontools };
}

export const prerequisiteHelperInternals = { candidateVersion, cleanVersion, defaultAptCache, defaultApprovalPath, defaultDpkgQuery, defaultEvidencePath, defaultSystemctl, installedVersion, versionPattern };
