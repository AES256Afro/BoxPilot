// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { installApprovedVirtualization, virtualizationInstallInternals } from "./boxpilot-virtualization-install.mjs";

const approvedPackages = {
  "qemu-system-x86": "1:10.2.1+ds-1ubuntu3.2",
  "libvirt-daemon-system": "12.0.0-1ubuntu5.2",
  "libvirt-clients": "12.0.0-1ubuntu5.2",
  virtinst: "1:5.1.0-1",
  ovmf: "2025.11-3ubuntu7",
};

function approval(overrides = {}) {
  return JSON.stringify({ packages: approvedPackages, approvedAt: "2026-08-16T12:00:00.000Z", ...overrides });
}

describe("fixed virtualization installer", () => {
  it("installs only the exact approved Ubuntu bundle and verifies KVM, libvirt, and QEMU", async () => {
    let installed = false;
    const run = vi.fn(async (binary, args) => {
      if (binary.endsWith("test")) return args[0] === "-c" ? { ok: true, stdout: "" } : { ok: false, stdout: "" };
      if (binary.endsWith("dpkg-query")) {
        const name = args.at(-1);
        return installed ? { ok: true, stdout: `install ok installed\t${approvedPackages[name]}` } : { ok: false, stdout: "" };
      }
      if (binary.endsWith("apt-cache")) return { ok: true, stdout: `  Candidate: ${approvedPackages[args.at(-1)]}` };
      if (binary.endsWith("apt-get")) {
        expect(args).toEqual(["install", "--yes", "--no-install-recommends", ...virtualizationInstallInternals.packageNames.map((name) => `${name}=${approvedPackages[name]}`)]);
        installed = true;
        return { ok: true, stdout: "installed" };
      }
      if (binary.endsWith("systemctl")) return { ok: true, stdout: "" };
      if (binary.endsWith("virsh")) return { ok: true, stdout: "qemu:///system" };
      if (binary.endsWith("qemu-system-x86_64")) return { ok: true, stdout: "QEMU emulator version 10.2.1" };
      throw new Error(`Unexpected command ${binary}`);
    });
    await expect(installApprovedVirtualization({ run, loadApproval: async () => approval(), now: () => new Date("2026-08-16T12:01:00.000Z") })).resolves.toEqual({
      installed: true, packages: approvedPackages, serviceActive: true, connectionUri: "qemu:///system", qemuVerified: true, kvmDeviceVerified: true,
    });
    expect(run).toHaveBeenCalledWith("/usr/bin/systemctl", ["enable", "libvirtd.service"], { timeout: 30000 });
    expect(run).toHaveBeenCalledWith("/usr/bin/systemctl", ["start", "libvirtd.service"], { timeout: 120000 });
  });

  it("refuses absent KVM, existing providers, changed candidates, and stale approval before APT", async () => {
    const noKvm = vi.fn(async () => ({ ok: false, stdout: "" }));
    await expect(installApprovedVirtualization({ run: noKvm, loadApproval: async () => approval(), now: () => new Date("2026-08-16T12:01:00.000Z") })).rejects.toThrow("Hardware virtualization is unavailable");

    const provider = vi.fn(async (binary, args) => binary.endsWith("test") ? { ok: args[0] === "-c" || args.at(-1) === "/usr/bin/virsh", stdout: "" } : { ok: false, stdout: "" });
    await expect(installApprovedVirtualization({ run: provider, loadApproval: async () => approval(), now: () => new Date("2026-08-16T12:01:00.000Z") })).rejects.toThrow("provider became present");

    const changed = vi.fn(async (binary, args) => {
      if (binary.endsWith("test")) return { ok: args[0] === "-c", stdout: "" };
      if (binary.endsWith("dpkg-query")) return { ok: false, stdout: "" };
      if (binary.endsWith("apt-cache")) return { ok: true, stdout: args.at(-1) === "ovmf" ? "  Candidate: 2026.1-1" : `  Candidate: ${approvedPackages[args.at(-1)]}` };
      return { ok: false, stdout: "" };
    });
    await expect(installApprovedVirtualization({ run: changed, loadApproval: async () => approval(), now: () => new Date("2026-08-16T12:01:00.000Z") })).rejects.toThrow("APT metadata changed");
    expect(changed.mock.calls.some(([binary]) => binary.endsWith("apt-get"))).toBe(false);

    await expect(installApprovedVirtualization({ run: noKvm, loadApproval: async () => approval(), now: () => new Date("2026-08-16T13:01:00.000Z") })).rejects.toThrow("marker is stale");
  });

  it("accepts only the exact fixed package schema", () => {
    expect(() => virtualizationInstallInternals.parseApproval(approval({ packages: { ...approvedPackages, curl: "1.0" } }), new Date("2026-08-16T12:01:00.000Z"))).toThrow("package set is invalid");
    expect(virtualizationInstallInternals.exactPackageVersions(approvedPackages)).toEqual(approvedPackages);
  });
});
