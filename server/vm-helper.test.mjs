import { describe, expect, it, vi } from "vitest";
import { createVmHelper } from "./vm-helper.mjs";

function input(overrides = {}) {
  return { name: "ubuntu-lab", osProfile: "ubuntu-24.04", vcpus: 2, memoryMiB: 4096, diskGiB: 40, isoFile: "ubuntu.iso", network: "default", firmware: "uefi", autostart: false, ...overrides };
}

function regularIso(overrides = {}) {
  return { size: 4096, isFile: () => true, isSymbolicLink: () => false, ...overrides };
}

describe("restricted VM helper", () => {
  it("builds fixed arguments and verifies the created domain", async () => {
    const run = vi.fn(async (binary, args) => {
      if (binary === "/usr/bin/virt-install") return { stdout: "", stderr: "" };
      if (args.includes("list")) return { stdout: "", stderr: "" };
      if (args.includes("dominfo")) return { stdout: "Name: ubuntu-lab\nAutostart: disable", stderr: "" };
      if (args.includes("domblklist")) return { stdout: "Type Device Target Source\nfile disk vda /var/lib/libvirt/images/ubuntu-lab.qcow2", stderr: "" };
      if (args.includes("domiflist")) return { stdout: "Interface Type Source Model\nvnet0 network default virtio", stderr: "" };
      throw new Error("unexpected command");
    });
    const helper = createVmHelper({ run, statFile: async () => regularIso() });

    await expect(helper.create(input())).resolves.toMatchObject({ created: true, verified: true, domain: "ubuntu-lab" });
    expect(run).toHaveBeenCalledWith("/usr/bin/virt-install", expect.arrayContaining([
      "--connect", "qemu:///system", "--name", "ubuntu-lab", "--cdrom", "/var/lib/libvirt/boot/ubuntu.iso", "--noautoconsole",
    ]), { timeout: 180000 });
  });

  it("rejects a symlink before virt-install is invoked", async () => {
    const run = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const helper = createVmHelper({ run, statFile: async () => regularIso({ isSymbolicLink: () => true }) });
    await expect(helper.create(input())).rejects.toThrow("regular non-empty file");
    expect(run.mock.calls.some(([binary]) => binary === "/usr/bin/virt-install")).toBe(false);
  });

  it("refuses an existing exact-name domain", async () => {
    const run = vi.fn(async () => ({ stdout: "ubuntu-lab\n", stderr: "" }));
    const helper = createVmHelper({ run, statFile: async () => regularIso() });
    await expect(helper.create(input())).rejects.toThrow("already exists");
    expect(run.mock.calls.some(([binary]) => binary === "/usr/bin/virt-install")).toBe(false);
  });

  it("removes only the newly created exact-name domain after verification failure", async () => {
    let created = false;
    const run = vi.fn(async (binary, args) => {
      if (binary === "/usr/bin/virt-install") { created = true; return { stdout: "", stderr: "" }; }
      if (args.includes("list")) return { stdout: created ? "ubuntu-lab\n" : "", stderr: "" };
      if (args.includes("dominfo")) return { stdout: "Name: ubuntu-lab\nAutostart: enable", stderr: "" };
      if (args.includes("domblklist")) return { stdout: "file disk vda path", stderr: "" };
      if (args.includes("domiflist")) return { stdout: "vnet0 network default virtio", stderr: "" };
      if (args.includes("destroy") || args.includes("undefine")) return { stdout: "", stderr: "" };
      throw new Error("unexpected command");
    });
    const helper = createVmHelper({ run, statFile: async () => regularIso() });

    await expect(helper.create(input())).rejects.toThrow("Automated rollback completed");
    expect(run).toHaveBeenCalledWith("/usr/bin/virsh", ["--connect", "qemu:///system", "undefine", "ubuntu-lab", "--remove-all-storage", "--nvram"], { timeout: 120000 });
  });
});
