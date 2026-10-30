import { readFile, unlink, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { createMaintenanceService } from "./maintenance.mjs";
import { createNvidiaInspector } from "./nvidia.mjs";

const execFile = promisify(execFileCallback);
const defaultDpkgQuery = "/usr/bin/dpkg-query";
const defaultAptCache = "/usr/bin/apt-cache";
const defaultSystemctl = "/usr/bin/systemctl";
const defaultEvidencePath = "/var/lib/boxpilot/storage-health.json";
const defaultApprovalPath = "/run/boxpilot/smartmontools-approval.json";
const defaultResticApprovalPath = "/run/boxpilot/restic-approval.json";
const defaultDockerApprovalPath = "/run/boxpilot/docker-approval.json";
const defaultVirtualizationApprovalPath = "/run/boxpilot/virtualization-approval.json";
const defaultAptApprovalPath = "/run/boxpilot/apt-refresh-approval.json";
const versionPattern = /^[0-9A-Za-z.+:~_-]{1,64}$/;
const virtualizationPackageNames = ["qemu-system-x86", "libvirt-daemon-system", "libvirt-clients", "virtinst", "ovmf"];
/**
 * The drive-check tools (M26.3): smartctl reads a disk's SMART health, fsck.exfat checks an exFAT
 * drive without changing it. Each is looked for where Ubuntu puts it, and each answers its version
 * question with its own name - that answer is what "installed" is verified by.
 */
const driveToolPackageNames = Object.freeze(["exfatprogs", "smartmontools"]);
const driveTools = Object.freeze({
  smartctl: { package: "smartmontools", paths: ["/usr/sbin/smartctl", "/sbin/smartctl"], versionArgs: ["--version"], identity: /^smartctl\s+(\d[\w.-]*)/m },
  // exfatprogs prints its version and exits non-zero after -V on some releases; the answer is the line, not the exit code.
  fsckExfat: { package: "exfatprogs", paths: ["/usr/sbin/fsck.exfat", "/sbin/fsck.exfat"], versionArgs: ["-V"], identity: /exfatprogs version\s*:\s*(\S+)/i },
});

/** Returns a problem, or null when `packages` is a non-empty map of fixed drive-tool package names to exact versions. */
export function driveToolPackagesProblem(packages) {
  if (!packages || typeof packages !== "object" || Array.isArray(packages)) return "must be an object of package name to exact version";
  const names = Object.keys(packages);
  if (names.length === 0) return "must list at least one package";
  if (names.some((name) => !driveToolPackageNames.includes(name))) return `may list only ${driveToolPackageNames.join(" and ")}`;
  if (names.some((name) => typeof packages[name] !== "string" || !versionPattern.test(packages[name]))) return "every version must be an exact Debian version string";
  return null;
}

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

async function clearDockerApprovalFile() {
  try {
    await unlink(defaultDockerApprovalPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function writeDockerApprovalFile(approval) {
  await writeFile(defaultDockerApprovalPath, `${JSON.stringify(approval)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

async function clearVirtualizationApprovalFile() {
  try {
    await unlink(defaultVirtualizationApprovalPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function writeVirtualizationApprovalFile(approval) {
  await writeFile(defaultVirtualizationApprovalPath, `${JSON.stringify(approval)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
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
  clearDockerApproval = clearDockerApprovalFile,
  writeDockerApproval = writeDockerApprovalFile,
  clearVirtualizationApproval = clearVirtualizationApprovalFile,
  writeVirtualizationApproval = writeVirtualizationApprovalFile,
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

  /** Where each drive-check tool is on this server, or null. */
  async function locateDriveTools() {
    const located = await Promise.all(Object.entries(driveTools).map(async ([tool, spec]) => {
      const found = await Promise.all(spec.paths.map((file) => run("/usr/bin/test", ["-e", file], { timeout: 10000 })));
      const index = found.findIndex((result) => result.ok);
      return [tool, index >= 0 ? spec.paths[index] : null];
    }));
    return Object.fromEntries(located);
  }

  /**
   * Can this server check its drives: is smartctl here, is fsck.exfat here, and for whichever is
   * not, which exact version do the configured package lists offer. A package dpkg calls installed
   * whose tool is nevertheless gone is broken rather than missing, and is not repaired from here.
   */
  async function inspectDriveTools() {
    const [packageEvidence, paths] = await Promise.all([
      Promise.all(driveToolPackageNames.map(async (name) => {
        const [installedResult, policyResult] = await Promise.all([
          run(dpkgQueryBinary, ["--show", "--showformat=${Status}\\t${Version}", name], { timeout: 10000 }),
          run(aptCacheBinary, ["policy", name], { timeout: 10000 }),
        ]);
        return [name, { installedVersion: installedResult.ok ? installedVersion(installedResult.stdout) : null, candidateVersion: policyResult.ok ? candidateVersion(policyResult.stdout) : null }];
      })),
      locateDriveTools(),
    ]);
    const packages = Object.fromEntries(packageEvidence);
    const missing = Object.entries(driveTools).filter(([tool]) => !paths[tool]).map(([, spec]) => spec.package).sort();
    const broken = missing.filter((name) => packages[name].installedVersion !== null);
    const offered = missing.filter((name) => !broken.includes(name) && packages[name].candidateVersion !== null);
    return {
      tools: { smartctl: paths.smartctl !== null, fsckExfat: paths.fsckExfat !== null },
      packages,
      installed: missing.length === 0,
      missing,
      broken,
      candidatePackages: Object.fromEntries(offered.map((name) => [name, packages[name].candidateVersion])),
      repairAvailable: missing.length > 0 && offered.length === missing.length,
      source: missing.length === 0 ? "installed-tools" : offered.length ? "configured-apt-candidates" : "unavailable",
      mutationPerformed: false,
      arbitraryPackageAccepted: false,
    };
  }

  /** Ask each tool who it is. An installed package whose tool does not answer is not a working checker. */
  async function driveToolsAnswer() {
    const paths = await locateDriveTools();
    const answers = await Promise.all(Object.entries(driveTools).map(async ([tool, spec]) => {
      if (!paths[tool]) return [tool, { answered: false, version: null }];
      const result = await run(paths[tool], spec.versionArgs, { timeout: 10000 });
      const version = String(result.stdout ?? "").match(spec.identity)?.[1] ?? null;
      return [tool, { answered: version !== null, version: cleanVersion(version) }];
    }));
    return Object.fromEntries(answers);
  }

  async function installDriveTools({ expectedPackages }) {
    const problem = driveToolPackagesProblem(expectedPackages);
    if (problem) throw new Error(`The expected drive-check packages are invalid: ${problem}`);
    const before = await inspectDriveTools();
    if (before.installed) throw new Error("smartctl and fsck.exfat are both already on this server; nothing was installed");
    const wanted = Object.keys(expectedPackages).sort();
    // The plan must name exactly what is missing now, at exactly the versions offered now.
    if (!before.repairAvailable || wanted.join(",") !== before.missing.join(",") || wanted.some((name) => before.candidatePackages[name] !== expectedPackages[name])) {
      throw new Error("Host state changed: the missing drive-check packages or their versions no longer match the approved plan");
    }
    const approved = Object.fromEntries(wanted.map((name) => [name, expectedPackages[name]]));
    await clearApproval();
    await writeApproval({ packages: approved, approvedAt: now().toISOString() });
    let start;
    try {
      start = await run(systemctlBinary, ["start", "boxpilot-smartmontools-install.service"], { timeout: 15 * 60 * 1000 });
    } finally {
      await clearApproval();
    }
    if (!start.ok) throw new Error("The fixed drive-check tools installation service failed");
    const after = await inspectDriveTools();
    for (const name of wanted) {
      if (after.packages[name]?.installedVersion !== approved[name]) throw new Error(`${name} did not match the approved version after installation`);
    }
    const answers = await driveToolsAnswer();
    const silent = Object.entries(answers).filter(([, answer]) => !answer.answered).map(([tool]) => (tool === "smartctl" ? "smartctl" : "fsck.exfat"));
    if (silent.length) throw new Error(`${silent.join(" and ")} ${silent.length === 1 ? "is" : "are"} installed but did not answer when asked for ${silent.length === 1 ? "its" : "their"} version`);
    let evidence = null;
    try { evidence = JSON.parse(await loadEvidence()); } catch { evidence = null; }
    const generatedTime = typeof evidence?.generatedAt === "string" ? Date.parse(evidence.generatedAt) : Number.NaN;
    const evidenceRefreshed = Number.isFinite(generatedTime) && Math.abs(now().getTime() - generatedTime) <= 5 * 60 * 1000;
    if (!evidenceRefreshed) throw new Error("The fixed storage evidence scan did not produce current evidence");
    return {
      installed: true,
      packages: approved,
      tools: answers,
      scan: { completed: true, evidenceRefreshed, smartEvidenceAvailable: evidence?.available === true, diskResults: Array.isArray(evidence?.disks) ? Math.min(evidence.disks.length, 16) : 0 },
      boundary: { fixedPackageSet: true, arbitraryPackageAccepted: false, aptUpdatePerformed: false, packageRemovalPerformed: false, driveTouched: false, browserCommandAccepted: false },
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

  async function inspectDocker() {
    const [packageResult, policyResult, clientPathResult, clientResult, engineResult, serviceResult] = await Promise.all([
      run(dpkgQueryBinary, ["--show", "--showformat=${Status}\\t${Version}", "docker.io"], { timeout: 10000 }),
      run(aptCacheBinary, ["policy", "docker.io"], { timeout: 10000 }),
      run("/usr/bin/test", ["-e", "/usr/bin/docker"], { timeout: 10000 }),
      run("/usr/bin/docker", ["--version"], { timeout: 10000 }),
      run("/usr/bin/docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 10000 }),
      run(systemctlBinary, ["is-active", "--quiet", "docker.service"], { timeout: 10000 }),
    ]);
    const packageVersion = packageResult.ok ? installedVersion(packageResult.stdout) : null;
    const candidate = policyResult.ok ? candidateVersion(policyResult.stdout) : null;
    const clientVersion = clientResult.ok ? cleanVersion(clientResult.stdout.match(/^Docker version\s+([^,\s]+)/i)?.[1]) : null;
    const engineVersion = engineResult.ok ? cleanVersion(engineResult.stdout) : null;
    const providerPresent = packageVersion !== null || clientPathResult.ok;
    const installed = engineVersion !== null && serviceResult.ok;
    return {
      package: "docker.io",
      installed,
      installedPackageVersion: packageVersion,
      candidateVersion: candidate,
      selectedVersion: packageVersion ?? candidate,
      clientVersion,
      engineVersion,
      serviceActive: serviceResult.ok,
      providerPresent,
      supported: providerPresent || candidate !== null,
      repairAvailable: !providerPresent && candidate !== null,
      provider: packageVersion ? "ubuntu-docker.io" : installed ? "existing-compatible-engine" : clientPathResult.ok ? "existing-provider" : candidate ? "configured-apt-candidate" : "unavailable",
      mutationPerformed: false,
      arbitraryPackageAccepted: false,
      arbitraryRepositoryAccepted: false,
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

  async function installDocker({ expectedVersion }) {
    if (!versionPattern.test(String(expectedVersion ?? ""))) throw new Error("The expected docker.io version is invalid");
    const before = await inspectDocker();
    if (before.installed) throw new Error("A compatible Docker Engine is already active; BoxPilot will not replace its provider");
    if (!before.supported || before.selectedVersion !== expectedVersion) throw new Error("Host state changed: the fixed docker.io candidate no longer matches the approved plan");
    await clearDockerApproval();
    await writeDockerApproval({ expectedVersion, approvedAt: now().toISOString() });
    let start;
    try {
      start = await run(systemctlBinary, ["start", "boxpilot-docker-install.service"], { timeout: 15 * 60 * 1000 });
    } finally {
      await clearDockerApproval();
    }
    if (!start.ok) throw new Error("The fixed Docker Engine installation service failed");
    const after = await inspectDocker();
    if (!after.installed || after.installedPackageVersion !== expectedVersion || !after.engineVersion || !after.serviceActive) {
      throw new Error("Docker Engine did not match the approved package and active-service proof after installation");
    }
    return {
      package: "docker.io",
      installed: true,
      version: after.installedPackageVersion,
      engineVersion: after.engineVersion,
      packageChanged: true,
      serviceActive: true,
      engineVerified: true,
      boundary: {
        fixedPackage: true,
        arbitraryPackageAccepted: false,
        arbitraryRepositoryAccepted: false,
        aptUpdatePerformed: false,
        packageUpgradePerformed: false,
        packageRemovalPerformed: false,
        daemonConfigurationChanged: false,
        userGroupChanged: false,
        containerCreated: false,
        imagePulled: false,
        browserCommandAccepted: false,
      },
    };
  }

  async function inspectVirtualization() {
    const packageEvidence = await Promise.all(virtualizationPackageNames.map(async (name) => {
      const [installedResult, policyResult] = await Promise.all([
        run(dpkgQueryBinary, ["--show", "--showformat=${Status}\\t${Version}", name], { timeout: 10000 }),
        run(aptCacheBinary, ["policy", name], { timeout: 10000 }),
      ]);
      return {
        name,
        installedVersion: installedResult.ok ? installedVersion(installedResult.stdout) : null,
        candidateVersion: policyResult.ok ? candidateVersion(policyResult.stdout) : null,
      };
    }));
    const [virshPath, qemuPath, kvmDevice, service, uri, qemu] = await Promise.all([
      run("/usr/bin/test", ["-e", "/usr/bin/virsh"], { timeout: 10000 }),
      run("/usr/bin/test", ["-e", "/usr/bin/qemu-system-x86_64"], { timeout: 10000 }),
      run("/usr/bin/test", ["-r", "/sys/class/misc/kvm/dev"], { timeout: 10000 }),
      run(systemctlBinary, ["is-active", "--quiet", "libvirtd.service"], { timeout: 10000 }),
      run("/usr/bin/virsh", ["--connect", "qemu:///system", "uri"], { timeout: 15000 }),
      run("/usr/bin/qemu-system-x86_64", ["--version"], { timeout: 10000 }),
    ]);
    const installedPackages = Object.fromEntries(packageEvidence.map((item) => [item.name, item.installedVersion]));
    const candidatePackages = Object.fromEntries(packageEvidence.map((item) => [item.name, item.candidateVersion]));
    const providerPresent = virshPath.ok || qemuPath.ok || packageEvidence.some((item) => item.installedVersion !== null);
    const packageSetInstalled = packageEvidence.every((item) => item.installedVersion !== null);
    const candidateSetAvailable = packageEvidence.every((item) => item.candidateVersion !== null);
    const connectionReady = uri.ok && uri.stdout === "qemu:///system";
    const qemuVerified = qemu.ok && /^QEMU emulator version\s+\S+/i.test(qemu.stdout);
    const installed = packageSetInstalled && kvmDevice.ok && service.ok && connectionReady && qemuVerified;
    return {
      installed,
      installedPackages,
      candidatePackages,
      packageNames: [...virtualizationPackageNames],
      packageSetInstalled,
      candidateSetAvailable,
      providerPresent,
      kvmDeviceAvailable: kvmDevice.ok,
      kvmEvidencePath: "/sys/class/misc/kvm/dev",
      serviceActive: service.ok,
      connectionReady,
      connectionUri: connectionReady ? uri.stdout : null,
      qemuVerified,
      supported: providerPresent || (kvmDevice.ok && candidateSetAvailable),
      repairAvailable: !providerPresent && kvmDevice.ok && candidateSetAvailable,
      source: providerPresent ? "existing-virtualization-provider" : candidateSetAvailable ? "configured-apt-candidates" : "unavailable",
      mutationPerformed: false,
      arbitraryPackageAccepted: false,
      arbitraryRepositoryAccepted: false,
    };
  }

  async function installVirtualization({ expectedPackages }) {
    const keys = expectedPackages && typeof expectedPackages === "object" && !Array.isArray(expectedPackages) ? Object.keys(expectedPackages).sort() : [];
    const expectedKeys = [...virtualizationPackageNames].sort();
    if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index]) || keys.some((key) => !versionPattern.test(String(expectedPackages[key] ?? "")))) {
      throw new Error("The expected virtualization package set is invalid");
    }
    const before = await inspectVirtualization();
    if (before.installed) throw new Error("The KVM, QEMU, and libvirt stack is already active; BoxPilot will not replace it");
    if (!before.repairAvailable || expectedKeys.some((name) => before.candidatePackages[name] !== expectedPackages[name])) {
      throw new Error("Host state changed: the fixed virtualization package candidates no longer match the approved plan");
    }
    await clearVirtualizationApproval();
    await writeVirtualizationApproval({ packages: expectedPackages, approvedAt: now().toISOString() });
    let start;
    try {
      start = await run(systemctlBinary, ["start", "boxpilot-virtualization-install.service"], { timeout: 21 * 60 * 1000 });
    } finally {
      await clearVirtualizationApproval();
    }
    if (!start.ok) throw new Error("The fixed virtualization installation service failed");
    const after = await inspectVirtualization();
    if (!after.installed || expectedKeys.some((name) => after.installedPackages[name] !== expectedPackages[name])) {
      throw new Error("The virtualization stack did not match the approved package, KVM, service, QEMU, and system-URI proof after installation");
    }
    // The helper's mount namespace was built before /var/lib/libvirt existed (its ReadWritePaths
    // are optional), so it must restart before VM work can write there. The operation asks the
    // helper for that restart once its work has drained (self-restart.mjs); an 8-second timer here
    // killed whatever had started behind this install.
    return {
      installed: true,
      helperRestartNeeded: true,
      packages: after.installedPackages,
      serviceActive: true,
      connectionUri: after.connectionUri,
      qemuVerified: true,
      kvmDeviceVerified: true,
      boundary: {
        fixedPackageSet: true,
        arbitraryPackageAccepted: false,
        arbitraryRepositoryAccepted: false,
        aptUpdatePerformed: false,
        packageRemovalPerformed: false,
        existingProviderReplaced: false,
        operatorUserGroupChanged: false,
        networkCreated: false,
        storagePoolCreated: false,
        virtualMachineCreated: false,
        browserCommandAccepted: false,
      },
    };
  }

  const nvidia = createNvidiaInspector({ run, dpkgQueryBinary });
  /** NVIDIA GPU readiness for apps (driver, container toolkit, Docker runtime). Read-only. */
  async function inspectNvidia() {
    return nvidia.inspect();
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

  return { inspectSmartmontools, installSmartmontools, inspectDriveTools, installDriveTools, inspectRestic, installRestic, inspectDocker, installDocker, inspectVirtualization, installVirtualization, inspectNvidia, inspectAptMetadata, refreshAptMetadata };
}

export const prerequisiteHelperInternals = { candidateVersion, cleanVersion, driveToolPackageNames, driveTools, defaultAptCache, defaultAptApprovalPath, defaultApprovalPath, defaultResticApprovalPath, defaultDockerApprovalPath, defaultVirtualizationApprovalPath, defaultDpkgQuery, defaultEvidencePath, defaultSystemctl, installedVersion, versionPattern, virtualizationPackageNames };
