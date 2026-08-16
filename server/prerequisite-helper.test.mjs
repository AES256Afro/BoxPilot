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
