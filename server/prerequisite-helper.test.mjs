import { describe, expect, it, vi } from "vitest";
import { createPrerequisiteHelper } from "./prerequisite-helper.mjs";

function packageRun({ installed = true } = {}) {
  return vi.fn(async (binary, args) => {
    if (binary.endsWith("dpkg-query")) return installed ? { ok: true, stdout: "install ok installed\t7.5-2" } : { ok: false, stdout: "" };
    if (binary.endsWith("apt-cache")) return { ok: true, stdout: "smartmontools:\n  Installed: 7.5-2\n  Candidate: 7.5-2\n  Version table:\n *** 7.5-2 500\n        token=must-not-leak" };
    if (binary.endsWith("systemctl")) return { ok: true, stdout: "" };
    throw new Error(`unexpected binary ${binary} with ${args.join(" ")}`);
  });
}

describe("fixed prerequisite helper", () => {
  it("reports only bounded smartmontools package state", async () => {
    const run = packageRun();
    const helper = createPrerequisiteHelper({ run });
    const result = await helper.inspectSmartmontools();
    expect(result).toEqual({ package: "smartmontools", installed: true, installedVersion: "7.5-2", candidateVersion: "7.5-2", selectedVersion: "7.5-2", supported: true, repairAvailable: false, source: "configured-apt-candidate", mutationPerformed: false, arbitraryPackageAccepted: false });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(run).toHaveBeenCalledWith("/usr/bin/dpkg-query", ["--show", "--showformat=${Status}\\t${Version}", "smartmontools"], { timeout: 10000 });
    expect(run).toHaveBeenCalledWith("/usr/bin/apt-cache", ["policy", "smartmontools"], { timeout: 10000 });
  });

  it("selects an existing installed version instead of turning this repair into an upgrade", async () => {
    const run = vi.fn(async (binary) => binary.endsWith("dpkg-query")
      ? { ok: true, stdout: "install ok installed\t7.4-2" }
      : { ok: true, stdout: "  Installed: 7.4-2\n  Candidate: 7.5-2" });
    const result = await createPrerequisiteHelper({ run }).inspectSmartmontools();
    expect(result).toMatchObject({ installed: true, installedVersion: "7.4-2", candidateVersion: "7.5-2", selectedVersion: "7.4-2", repairAvailable: false });
  });

  it("refreshes evidence without invoking APT when the approved package is already installed", async () => {
    const run = packageRun();
    const helper = createPrerequisiteHelper({
      run,
      loadEvidence: vi.fn(async () => JSON.stringify({ generatedAt: "2026-08-16T05:00:00.000Z", available: true, disks: [{ device: "/dev/nvme0n1" }] })),
      now: () => new Date("2026-08-16T05:01:00.000Z"),
    });
    const result = await helper.installSmartmontools({ expectedVersion: "7.5-2" });
    expect(run).toHaveBeenCalledWith("/usr/bin/systemctl", ["start", "boxpilot-storage-scan.service"], { timeout: 120000 });
    expect(run.mock.calls.some(([binary]) => binary.endsWith("apt-get"))).toBe(false);
    expect(result).toMatchObject({ installed: true, packageChanged: false, scan: { completed: true, evidenceRefreshed: true, smartEvidenceAvailable: true, diskResults: 1 }, boundary: { fixedPackage: true, arbitraryPackageAccepted: false, aptUpdatePerformed: false, packageRemovalPerformed: false } });
  });

  it("delegates a missing package only to the fixed installation unit and rejects a changed candidate", async () => {
    let installed = false;
    const run = vi.fn(async (binary, args) => {
      if (binary.endsWith("dpkg-query")) return installed ? { ok: true, stdout: "install ok installed\t7.5-2" } : { ok: false, stdout: "" };
      if (binary.endsWith("apt-cache")) return { ok: true, stdout: "  Candidate: 7.5-2" };
      if (binary.endsWith("systemctl")) { expect(args).toEqual(["start", "boxpilot-smartmontools-install.service"]); installed = true; return { ok: true, stdout: "" }; }
      throw new Error("unexpected binary");
    });
    const clearApproval = vi.fn(async () => undefined);
    const writeApproval = vi.fn(async () => undefined);
    const helper = createPrerequisiteHelper({ run, clearApproval, writeApproval, loadEvidence: vi.fn(async () => JSON.stringify({ generatedAt: "2026-08-16T05:00:00.000Z", available: false, disks: [] })), now: () => new Date("2026-08-16T05:01:00.000Z") });
    await expect(helper.installSmartmontools({ expectedVersion: "8.0-evil" })).rejects.toThrow("candidate no longer matches");
    const result = await helper.installSmartmontools({ expectedVersion: "7.5-2" });
    expect(result).toMatchObject({ installed: true, version: "7.5-2", packageChanged: true });
    expect(run.mock.calls.filter(([binary]) => binary.endsWith("systemctl"))).toHaveLength(1);
    expect(writeApproval).toHaveBeenCalledWith({ expectedVersion: "7.5-2", approvedAt: "2026-08-16T05:01:00.000Z" });
    expect(clearApproval).toHaveBeenCalledTimes(2);
  });

  it("reports only bounded restic package state", async () => {
    const run = vi.fn(async (binary) => binary.endsWith("dpkg-query")
      ? { ok: false, stdout: "" }
      : { ok: true, stdout: "restic:\n  Installed: (none)\n  Candidate: 0.18.1-1\n        secret=must-not-leak" });
    const result = await createPrerequisiteHelper({ run }).inspectRestic();
    expect(result).toEqual({ package: "restic", installed: false, installedVersion: null, candidateVersion: "0.18.1-1", selectedVersion: "0.18.1-1", supported: true, repairAvailable: true, source: "configured-apt-candidate", mutationPerformed: false, arbitraryPackageAccepted: false });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(run).toHaveBeenCalledWith("/usr/bin/dpkg-query", ["--show", "--showformat=${Status}\\t${Version}", "restic"], { timeout: 10000 });
    expect(run).toHaveBeenCalledWith("/usr/bin/apt-cache", ["policy", "restic"], { timeout: 10000 });
  });

  it("delegates a missing restic package only to the fixed unit and performs no repository setup", async () => {
    let installed = false;
    const run = vi.fn(async (binary, args) => {
      if (binary.endsWith("dpkg-query")) return installed ? { ok: true, stdout: "install ok installed\t0.18.1-1" } : { ok: false, stdout: "" };
      if (binary.endsWith("apt-cache")) return { ok: true, stdout: "  Candidate: 0.18.1-1" };
      if (binary.endsWith("systemctl")) { expect(args).toEqual(["start", "boxpilot-restic-install.service"]); installed = true; return { ok: true, stdout: "" }; }
      if (binary.endsWith("restic")) { expect(args).toEqual(["version"]); return { ok: true, stdout: "restic 0.18.1 compiled with go1.24" }; }
      throw new Error("unexpected binary");
    });
    const clearResticApproval = vi.fn(async () => undefined);
    const writeResticApproval = vi.fn(async () => undefined);
    const helper = createPrerequisiteHelper({ run, clearResticApproval, writeResticApproval, now: () => new Date("2026-08-16T12:01:00.000Z") });
    const result = await helper.installRestic({ expectedVersion: "0.18.1-1" });
    expect(result).toMatchObject({ package: "restic", installed: true, version: "0.18.1-1", packageChanged: true, binaryVerified: true, next: { automaticSetupPerformed: false }, boundary: { fixedPackage: true, aptUpdatePerformed: false, packageUpgradePerformed: false, packageRemovalPerformed: false, mountChanged: false, passwordCreated: false, repositoryInitialized: false } });
    expect(writeResticApproval).toHaveBeenCalledWith({ expectedVersion: "0.18.1-1", approvedAt: "2026-08-16T12:01:00.000Z" });
    expect(clearResticApproval).toHaveBeenCalledTimes(2);
  });

  it("detects an existing compatible Docker provider without offering replacement", async () => {
    const run = vi.fn(async (binary, args) => {
      if (binary.endsWith("dpkg-query")) return { ok: false, stdout: "" };
      if (binary.endsWith("apt-cache")) return { ok: true, stdout: "  Candidate: 28.2.2-0ubuntu1\n token=must-not-leak" };
      if (binary.endsWith("test")) return { ok: true, stdout: "" };
      if (binary.endsWith("docker")) return { ok: true, stdout: args[0] === "--version" ? "Docker version 29.1.3, build fixture" : "29.1.3" };
      if (binary.endsWith("systemctl")) return { ok: true, stdout: "" };
      throw new Error(`unexpected ${binary} ${args.join(" ")}`);
    });
    const result = await createPrerequisiteHelper({ run }).inspectDocker();
    expect(result).toEqual({
      package: "docker.io", installed: true, installedPackageVersion: null, candidateVersion: "28.2.2-0ubuntu1", selectedVersion: "28.2.2-0ubuntu1",
      clientVersion: "29.1.3", engineVersion: "29.1.3", serviceActive: true, providerPresent: true, supported: true, repairAvailable: false, provider: "existing-compatible-engine",
      mutationPerformed: false, arbitraryPackageAccepted: false, arbitraryRepositoryAccepted: false,
    });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });

  it("does not offer package installation over a present but inactive Docker provider", async () => {
    const run = vi.fn(async (binary, args) => {
      if (binary.endsWith("dpkg-query")) return { ok: false, stdout: "" };
      if (binary.endsWith("apt-cache")) return { ok: true, stdout: "  Candidate: 28.2.2-0ubuntu1" };
      if (binary.endsWith("test")) return { ok: true, stdout: "" };
      if (binary.endsWith("docker") && args[0] === "--version") return { ok: true, stdout: "Docker version 29.1.3, build fixture" };
      return { ok: false, stdout: "" };
    });
    await expect(createPrerequisiteHelper({ run }).inspectDocker()).resolves.toMatchObject({ installed: false, providerPresent: true, repairAvailable: false, clientVersion: "29.1.3", engineVersion: null, serviceActive: false });
  });

  it("does not offer package installation when an unrecognized Docker-compatible shim occupies the fixed client path", async () => {
    const run = vi.fn(async (binary) => {
      if (binary.endsWith("dpkg-query")) return { ok: false, stdout: "" };
      if (binary.endsWith("apt-cache")) return { ok: true, stdout: "  Candidate: 28.2.2-0ubuntu1" };
      if (binary.endsWith("test")) return { ok: true, stdout: "" };
      if (binary.endsWith("docker")) return { ok: true, stdout: "podman version 5.4.2" };
      return { ok: false, stdout: "" };
    });
    await expect(createPrerequisiteHelper({ run }).inspectDocker()).resolves.toMatchObject({ installed: false, providerPresent: true, repairAvailable: false, clientVersion: null, provider: "existing-provider" });
  });

  it("delegates a missing Docker Engine only to the fixed unit and verifies its package and daemon", async () => {
    let installed = false;
    const run = vi.fn(async (binary, args) => {
      if (binary.endsWith("dpkg-query")) return installed ? { ok: true, stdout: "install ok installed\t28.2.2-0ubuntu1" } : { ok: false, stdout: "" };
      if (binary.endsWith("apt-cache")) return { ok: true, stdout: "  Candidate: 28.2.2-0ubuntu1" };
      if (binary.endsWith("test")) return installed ? { ok: true, stdout: "" } : { ok: false, stdout: "" };
      if (binary.endsWith("docker")) return installed ? { ok: true, stdout: args[0] === "--version" ? "Docker version 28.2.2, build fixture" : "28.2.2" } : { ok: false, stdout: "" };
      if (binary.endsWith("systemctl") && args[0] === "is-active") return installed ? { ok: true, stdout: "" } : { ok: false, stdout: "" };
      if (binary.endsWith("systemctl")) { expect(args).toEqual(["start", "boxpilot-docker-install.service"]); installed = true; return { ok: true, stdout: "" }; }
      throw new Error("unexpected binary");
    });
    const clearDockerApproval = vi.fn(async () => undefined);
    const writeDockerApproval = vi.fn(async () => undefined);
    const helper = createPrerequisiteHelper({ run, clearDockerApproval, writeDockerApproval, now: () => new Date("2026-08-16T12:01:00.000Z") });
    const result = await helper.installDocker({ expectedVersion: "28.2.2-0ubuntu1" });
    expect(result).toMatchObject({ package: "docker.io", installed: true, version: "28.2.2-0ubuntu1", engineVersion: "28.2.2", packageChanged: true, serviceActive: true, engineVerified: true, boundary: { fixedPackage: true, arbitraryPackageAccepted: false, arbitraryRepositoryAccepted: false, aptUpdatePerformed: false, packageUpgradePerformed: false, packageRemovalPerformed: false, daemonConfigurationChanged: false, userGroupChanged: false, containerCreated: false, imagePulled: false } });
    expect(writeDockerApproval).toHaveBeenCalledWith({ expectedVersion: "28.2.2-0ubuntu1", approvedAt: "2026-08-16T12:01:00.000Z" });
    expect(clearDockerApproval).toHaveBeenCalledTimes(2);
  });

  it("reports a ready existing KVM, QEMU, and libvirt stack without offering replacement", async () => {
    const versions = { "qemu-system-x86": "1:10.2.1+ds-1ubuntu3.2", "libvirt-daemon-system": "12.0.0-1ubuntu5.2", "libvirt-clients": "12.0.0-1ubuntu5.2", virtinst: "1:5.1.0-1", ovmf: "2025.11-3ubuntu7" };
    const run = vi.fn(async (binary, args) => {
      if (binary.endsWith("dpkg-query")) return { ok: true, stdout: `install ok installed\t${versions[args.at(-1)]}` };
      if (binary.endsWith("apt-cache")) return { ok: true, stdout: `  Candidate: ${versions[args.at(-1)]}` };
      if (binary.endsWith("test")) return { ok: true, stdout: "" };
      if (binary.endsWith("systemctl")) return { ok: true, stdout: "" };
      if (binary.endsWith("virsh")) return { ok: true, stdout: "qemu:///system" };
      if (binary.endsWith("qemu-system-x86_64")) return { ok: true, stdout: "QEMU emulator version 10.2.1" };
      throw new Error(`unexpected ${binary}`);
    });
    await expect(createPrerequisiteHelper({ run }).inspectVirtualization()).resolves.toMatchObject({
      installed: true, installedPackages: versions, candidatePackages: versions, packageSetInstalled: true, candidateSetAvailable: true, providerPresent: true,
      kvmDeviceAvailable: true, kvmEvidencePath: "/sys/class/misc/kvm/dev", serviceActive: true, connectionReady: true, connectionUri: "qemu:///system", qemuVerified: true, repairAvailable: false,
      mutationPerformed: false, arbitraryPackageAccepted: false, arbitraryRepositoryAccepted: false,
    });
  });

  it("delegates a clean virtualization host only to the fixed unit and verifies the exact package set", async () => {
    const versions = { "qemu-system-x86": "1:10.2.1+ds-1ubuntu3.2", "libvirt-daemon-system": "12.0.0-1ubuntu5.2", "libvirt-clients": "12.0.0-1ubuntu5.2", virtinst: "1:5.1.0-1", ovmf: "2025.11-3ubuntu7" };
    let installed = false;
    const run = vi.fn(async (binary, args) => {
      if (binary.endsWith("dpkg-query")) return installed ? { ok: true, stdout: `install ok installed\t${versions[args.at(-1)]}` } : { ok: false, stdout: "" };
      if (binary.endsWith("apt-cache")) return { ok: true, stdout: `  Candidate: ${versions[args.at(-1)]}` };
      if (binary.endsWith("test")) return { ok: args[0] === "-r" || installed, stdout: "" };
      if (binary.endsWith("systemctl") && args[0] === "is-active") return { ok: installed, stdout: "" };
      if (binary.endsWith("systemctl")) { expect(args).toEqual(["start", "boxpilot-virtualization-install.service"]); installed = true; return { ok: true, stdout: "" }; }
      if (binary.endsWith("virsh")) return installed ? { ok: true, stdout: "qemu:///system" } : { ok: false, stdout: "" };
      if (binary.endsWith("qemu-system-x86_64")) return installed ? { ok: true, stdout: "QEMU emulator version 10.2.1" } : { ok: false, stdout: "" };
      throw new Error(`unexpected ${binary}`);
    });
    const clearVirtualizationApproval = vi.fn(async () => undefined);
    const writeVirtualizationApproval = vi.fn(async () => undefined);
    const helper = createPrerequisiteHelper({ run, clearVirtualizationApproval, writeVirtualizationApproval, now: () => new Date("2026-08-16T12:01:00.000Z") });
    const result = await helper.installVirtualization({ expectedPackages: versions });
    expect(result).toMatchObject({ installed: true, packages: versions, serviceActive: true, connectionUri: "qemu:///system", qemuVerified: true, kvmDeviceVerified: true, boundary: { fixedPackageSet: true, aptUpdatePerformed: false, packageRemovalPerformed: false, existingProviderReplaced: false, operatorUserGroupChanged: false, networkCreated: false, storagePoolCreated: false, virtualMachineCreated: false } });
    expect(writeVirtualizationApproval).toHaveBeenCalledWith({ packages: versions, approvedAt: "2026-08-16T12:01:00.000Z" });
    expect(clearVirtualizationApproval).toHaveBeenCalledTimes(2);
  });

  it("does not offer virtualization installation over partial provider state or without the KVM kernel interface", async () => {
    const versions = { "qemu-system-x86": "1:10.2.1+ds-1ubuntu3.2", "libvirt-daemon-system": "12.0.0-1ubuntu5.2", "libvirt-clients": "12.0.0-1ubuntu5.2", virtinst: "1:5.1.0-1", ovmf: "2025.11-3ubuntu7" };
    const partial = vi.fn(async (binary, args) => {
      if (binary.endsWith("dpkg-query")) return { ok: false, stdout: "" };
      if (binary.endsWith("apt-cache")) return { ok: true, stdout: `  Candidate: ${versions[args.at(-1)]}` };
      if (binary.endsWith("test")) return { ok: args.at(-1) === "/usr/bin/virsh" || args[0] === "-r", stdout: "" };
      return { ok: false, stdout: "" };
    });
    await expect(createPrerequisiteHelper({ run: partial }).inspectVirtualization()).resolves.toMatchObject({ installed: false, providerPresent: true, kvmDeviceAvailable: true, repairAvailable: false });
    const noKvm = vi.fn(async (binary, args) => {
      if (binary.endsWith("dpkg-query")) return { ok: false, stdout: "" };
      if (binary.endsWith("apt-cache")) return { ok: true, stdout: `  Candidate: ${versions[args.at(-1)]}` };
      return { ok: false, stdout: "" };
    });
    await expect(createPrerequisiteHelper({ run: noKvm }).inspectVirtualization()).resolves.toMatchObject({ installed: false, providerPresent: false, kvmDeviceAvailable: false, candidateSetAvailable: true, repairAvailable: false });
    expect(noKvm).toHaveBeenCalledWith("/usr/bin/test", ["-r", "/sys/class/misc/kvm/dev"], { timeout: 10000 });
    expect(noKvm).not.toHaveBeenCalledWith("/usr/bin/test", ["-c", "/dev/kvm"], expect.anything());
  });

  it("reports bounded APT metadata evidence without mutating the host", async () => {
    const maintenance = { inspect: vi.fn(async () => ({
      aptMetadata: { available: true, state: "stale", updatedAt: "2026-08-01T00:00:00.000Z", ageHours: 360 },
      packageManager: { state: "ready" },
    })) };
    const result = await createPrerequisiteHelper({ maintenance }).inspectAptMetadata();
    expect(result).toEqual({ available: true, state: "stale", updatedAt: "2026-08-01T00:00:00.000Z", ageHours: 360, packageManagerState: "ready", refreshAvailable: true, source: "fixed-local-apt-metadata", mutationPerformed: false, arbitraryCommandAccepted: false });
  });

  it("delegates an approved stale timestamp only to the fixed APT refresh unit", async () => {
    const states = [
      { aptMetadata: { available: true, state: "stale", updatedAt: "2026-08-01T00:00:00.000Z", ageHours: 360 }, packageManager: { state: "ready" } },
      { aptMetadata: { available: true, state: "current", updatedAt: "2026-08-16T06:30:00.000Z", ageHours: 0 }, packageManager: { state: "ready" } },
    ];
    const run = vi.fn(async () => ({ ok: true, stdout: "" }));
    const clearAptApproval = vi.fn(async () => undefined);
    const writeAptApproval = vi.fn(async () => undefined);
    const helper = createPrerequisiteHelper({
      run,
      maintenance: { inspect: vi.fn(async () => states.shift()) },
      clearAptApproval,
      writeAptApproval,
      now: () => new Date("2026-08-16T06:29:00.000Z"),
    });
    const result = await helper.refreshAptMetadata({ expectedUpdatedAt: "2026-08-01T00:00:00.000Z" });
    expect(run).toHaveBeenCalledWith("/usr/bin/systemctl", ["start", "boxpilot-apt-refresh.service"], { timeout: 15 * 60 * 1000 });
    expect(writeAptApproval).toHaveBeenCalledWith({ approvedAt: "2026-08-16T06:29:00.000Z", expectedUpdatedAt: "2026-08-01T00:00:00.000Z" });
    expect(clearAptApproval).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ refreshed: true, state: "current", boundary: { fixedAptUpdateOnly: true, packageInstallPerformed: false, packageUpgradePerformed: false, packageRemovalPerformed: false, arbitraryCommandAccepted: false, browserArgumentAccepted: false } });
  });

  it("refuses an APT refresh when the package manager or approved timestamp changed", async () => {
    const interrupted = createPrerequisiteHelper({ maintenance: { inspect: async () => ({ aptMetadata: { available: true, state: "stale", updatedAt: "2026-08-01T00:00:00.000Z", ageHours: 360 }, packageManager: { state: "interrupted" } }) } });
    await expect(interrupted.refreshAptMetadata({ expectedUpdatedAt: "2026-08-01T00:00:00.000Z" })).rejects.toThrow("package manager is not ready");
    const changed = createPrerequisiteHelper({ maintenance: { inspect: async () => ({ aptMetadata: { available: true, state: "stale", updatedAt: "2026-08-02T00:00:00.000Z", ageHours: 336 }, packageManager: { state: "ready" } }) } });
    await expect(changed.refreshAptMetadata({ expectedUpdatedAt: "2026-08-01T00:00:00.000Z" })).rejects.toThrow("no longer matches");
    await expect(changed.refreshAptMetadata({ expectedUpdatedAt: "not-a-time" })).rejects.toThrow("timestamp is invalid");
  });
});
