import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createVmHelper } from "./vm-helper.mjs";
import { snapshotDiskRevision, snapshotInventoryRevision } from "./vm-snapshot.mjs";

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

  it("serves read-only libvirt inventory through fixed binaries", async () => {
    const run = vi.fn(async (_binary, args) => {
      if (args[2] === "list") return { stdout: "", stderr: "" };
      throw new Error("unexpected command");
    });
    const helper = createVmHelper({ run });
    await expect(helper.inventory({ scope: "domains" })).resolves.toEqual({ connected: true, domains: [], error: null });
    expect(run).toHaveBeenCalledWith("/usr/bin/virsh", ["--connect", "qemu:///system", "list", "--all", "--name"], { timeout: 8000 });
    await expect(helper.inventory({ scope: "shell" })).rejects.toThrow("Unsupported virtualization inventory scope");
  });

  it("detects an existing Cockpit handoff without changing systemd", async () => {
    const run = vi.fn(async () => ({ stdout: "LoadState=loaded\nActiveState=active\nUnitFileState=enabled", stderr: "" }));
    const helper = createVmHelper({ run });
    await expect(helper.consoleGuidance()).resolves.toEqual({ nativeProxyAvailable: false, cockpit: { installed: true, active: true, enabled: true, port: 9090 }, tailscaleDnsName: null });
    expect(run).toHaveBeenCalledWith("/usr/bin/systemctl", ["show", "cockpit.socket", "--property=LoadState,ActiveState,UnitFileState", "--no-pager"], { timeout: 10000 });
  });

  it("rejects an unsafe libvirt disk target before it can become an export filename", async () => {
    const run = vi.fn(async (binary, args) => {
      if (binary === "/usr/bin/qemu-img") return { stdout: JSON.stringify({ format: "qcow2", "actual-size": 4096, "virtual-size": 1024 ** 3 }), stderr: "" };
      if (args[2] === "domstate") return { stdout: "shut off", stderr: "" };
      if (args[2] === "dominfo") return { stdout: "UUID: 11111111-1111-4111-8111-111111111111\nPersistent: yes\nAutostart: disable", stderr: "" };
      if (args[2] === "snapshot-list") return { stdout: "", stderr: "" };
      if (args[2] === "domblklist") return { stdout: "Type Device Target Source\n-----\nfile disk ../../escape /var/lib/libvirt/images/ubuntu-lab.qcow2", stderr: "" };
      throw new Error("unexpected command");
    });
    const helper = createVmHelper({ run, statFile: async () => regularIso() });
    await expect(helper.inspectExport({ name: "ubuntu-lab" })).rejects.toThrow("unique constrained device names");
    expect(run.mock.calls.some(([, args]) => args[2] === "dumpxml")).toBe(false);
  });

  it("exports a stopped persistent VM to a server-owned root-only verified artifact", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-helper-export-"));
    try {
      const imageRoot = path.join(directory, "images");
      const exportRoot = path.join(directory, "exports");
      const diskPath = path.join(imageRoot, "ubuntu-lab.qcow2");
      await mkdir(imageRoot);
      await writeFile(diskPath, Buffer.from("fixture qcow2 content"));
      const run = vi.fn(async (binary, args) => {
        if (binary === "/usr/bin/qemu-img") {
          if (args[0] === "info") return { stdout: JSON.stringify({ format: "qcow2", "actual-size": 4096, "virtual-size": 1024 ** 3 }), stderr: "" };
          if (args[0] === "convert") { await copyFile(args[5], args[6]); return { stdout: "", stderr: "" }; }
          if (["check", "compare"].includes(args[0])) return { stdout: "{}", stderr: "" };
        }
        if (args[2] === "domstate") return { stdout: "shut off", stderr: "" };
        if (args[2] === "dominfo") return { stdout: "Name: ubuntu-lab\nUUID: 11111111-1111-4111-8111-111111111111\nPersistent: yes\nAutostart: disable", stderr: "" };
        if (args[2] === "snapshot-list") return { stdout: "clean-install", stderr: "" };
        if (args[2] === "domblklist") return { stdout: `Type Device Target Source\n---------------------------------------------\nfile disk vda ${diskPath}`, stderr: "" };
        if (args[2] === "dumpxml") return { stdout: "<domain><name>ubuntu-lab</name></domain>", stderr: "" };
        throw new Error(`unexpected command ${binary} ${args.join(" ")}`);
      });
      const helper = createVmHelper({ run, imageRoot, exportRoot });
      const parameters = {
        name: "ubuntu-lab",
        exportId: "22222222-2222-4222-8222-222222222222",
        expectedUuid: "11111111-1111-4111-8111-111111111111",
        expectedState: "stopped",
        expectedDiskRevision: snapshotDiskRevision([{ type: "file", device: "disk", target: "vda", source: diskPath }]),
        expectedSnapshotRevision: snapshotInventoryRevision(["clean-install"]),
      };

      const inspection = await helper.inspectExport({ name: parameters.name });
      expect(inspection).toMatchObject({ state: "stopped", sourceAllocatedBytes: 4096, disks: [{ target: "vda" }] });
      const result = await helper.createExport(parameters);
      expect(result).toMatchObject({ created: true, contentVerified: true, protected: false, encrypted: false, restoreDrill: { passed: false } });
      expect(result.exportId).toBe(parameters.exportId);
      const manifest = JSON.parse(await readFile(path.join(result.artifactPath, "manifest.json"), "utf8"));
      expect(manifest).toMatchObject({ protected: false, encrypted: false, disks: [{ target: "vda", contentVerified: true }] });
      expect((await lstat(path.join(result.artifactPath, "vda.qcow2"))).mode & 0o777).toBe(0o600);
      expect(run).toHaveBeenCalledWith("/usr/bin/qemu-img", ["compare", "-f", "qcow2", "-F", "qcow2", diskPath, expect.stringContaining("vda.qcow2.partial")], { timeout: 6 * 60 * 60 * 1000 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("removes only the new export directory after conversion verification failure", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-helper-export-fail-"));
    try {
      const imageRoot = path.join(directory, "images");
      const exportRoot = path.join(directory, "exports");
      const diskPath = path.join(imageRoot, "ubuntu-lab.qcow2");
      await mkdir(imageRoot);
      await writeFile(diskPath, Buffer.from("source remains"));
      const run = vi.fn(async (binary, args) => {
        if (binary === "/usr/bin/qemu-img" && args[0] === "info") return { stdout: JSON.stringify({ format: "qcow2", "actual-size": 4096, "virtual-size": 1024 ** 3 }), stderr: "" };
        if (binary === "/usr/bin/qemu-img" && args[0] === "convert") { await copyFile(args[5], args[6]); return { stdout: "", stderr: "" }; }
        if (binary === "/usr/bin/qemu-img" && args[0] === "check") throw new Error("structural check failed");
        if (args[2] === "domstate") return { stdout: "shut off", stderr: "" };
        if (args[2] === "dominfo") return { stdout: "UUID: 11111111-1111-4111-8111-111111111111\nPersistent: yes\nAutostart: disable", stderr: "" };
        if (args[2] === "snapshot-list") return { stdout: "", stderr: "" };
        if (args[2] === "domblklist") return { stdout: `Type Device Target Source\n-----\nfile disk vda ${diskPath}`, stderr: "" };
        if (args[2] === "dumpxml") return { stdout: "<domain/>", stderr: "" };
        throw new Error("unexpected command");
      });
      const helper = createVmHelper({ run, imageRoot, exportRoot });
      const parameters = {
        name: "ubuntu-lab", exportId: "22222222-2222-4222-8222-222222222222", expectedUuid: "11111111-1111-4111-8111-111111111111", expectedState: "stopped",
        expectedDiskRevision: snapshotDiskRevision([{ type: "file", device: "disk", target: "vda", source: diskPath }]), expectedSnapshotRevision: snapshotInventoryRevision([]),
      };
      await expect(helper.createExport(parameters)).rejects.toThrow("Automated export cleanup completed");
      await expect(lstat(path.join(exportRoot, parameters.exportId))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(diskPath, "utf8")).toBe("source remains");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
