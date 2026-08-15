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

  it("starts a VM through a fixed virsh action and verifies running state", async () => {
    let state = "shut off";
    const run = vi.fn(async (_binary, args) => {
      if (args[2] === "domstate") return { stdout: state, stderr: "" };
      if (args[2] === "dominfo") return { stdout: "Name: ubuntu-lab\nAutostart: disable", stderr: "" };
      if (args[2] === "start") { state = "running"; return { stdout: "started", stderr: "" }; }
      throw new Error("unexpected command");
    });
    const helper = createVmHelper({ run, wait: async () => {} });

    await expect(helper.action({ name: "ubuntu-lab", action: "start", expectedState: "stopped", expectedAutostart: false })).resolves.toMatchObject({
      verified: true, domain: "ubuntu-lab", action: "start", previous: { state: "stopped" }, current: { state: "running" },
    });
    expect(run).toHaveBeenCalledWith("/usr/bin/virsh", ["--connect", "qemu:///system", "start", "ubuntu-lab"], { timeout: 30000 });
  });

  it("changes and reads back autostart with no arbitrary virsh arguments", async () => {
    let autostart = true;
    const run = vi.fn(async (_binary, args) => {
      if (args[2] === "domstate") return { stdout: "running", stderr: "" };
      if (args[2] === "dominfo") return { stdout: `Name: ubuntu-lab\nAutostart: ${autostart ? "enable" : "disable"}`, stderr: "" };
      if (args[2] === "autostart") { autostart = false; return { stdout: "", stderr: "" }; }
      throw new Error("unexpected command");
    });
    const helper = createVmHelper({ run });

    await expect(helper.action({ name: "ubuntu-lab", action: "autostart-off", expectedState: "running", expectedAutostart: true })).resolves.toMatchObject({ current: { autostart: false } });
    expect(run).toHaveBeenCalledWith("/usr/bin/virsh", ["--connect", "qemu:///system", "autostart", "ubuntu-lab", "--disable"], { timeout: 30000 });
  });

  it("refuses lifecycle execution when approved state has drifted", async () => {
    const run = vi.fn(async (_binary, args) => args[2] === "domstate"
      ? { stdout: "stopped", stderr: "" }
      : { stdout: "Name: ubuntu-lab\nAutostart: disable", stderr: "" });
    const helper = createVmHelper({ run });
    await expect(helper.action({ name: "ubuntu-lab", action: "shutdown", expectedState: "running", expectedAutostart: false })).rejects.toThrow("state changed after approval");
    expect(run.mock.calls.some(([, args]) => args[2] === "shutdown")).toBe(false);
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

  it("creates and verifies only an offline internal snapshot of managed qcow2 disks", async () => {
    let created = false;
    const run = vi.fn(async (binary, args) => {
      if (binary === "/usr/bin/qemu-img") return { stdout: '{"format":"qcow2"}', stderr: "" };
      if (args[2] === "domstate") return { stdout: "shut off", stderr: "" };
      if (args[2] === "dominfo") return { stdout: "Name: ubuntu-lab\nUUID: 11111111-1111-4111-8111-111111111111\nAutostart: disable", stderr: "" };
      if (args[2] === "snapshot-list") return { stdout: created ? "pre-upgrade" : "", stderr: "" };
      if (args[2] === "domblklist") return { stdout: "Type Device Target Source\n---------------------------------------------\nfile disk vda /var/lib/libvirt/images/ubuntu-lab.qcow2", stderr: "" };
      if (args[2] === "snapshot-create-as") { created = true; return { stdout: "Domain snapshot pre-upgrade created", stderr: "" }; }
      if (args[2] === "snapshot-info") return { stdout: "Name: pre-upgrade\nCurrent: yes\nState: shutoff\nLocation: internal", stderr: "" };
      throw new Error("unexpected command");
    });
    const helper = createVmHelper({ run, statFile: async () => regularIso() });
    const parameters = {
      name: "ubuntu-lab", snapshotName: "pre-upgrade", expectedUuid: "11111111-1111-4111-8111-111111111111",
      expectedState: "stopped", expectedDiskRevision: snapshotDiskRevision([{ type: "file", device: "disk", target: "vda", source: "/var/lib/libvirt/images/ubuntu-lab.qcow2" }]), expectedSnapshotRevision: snapshotInventoryRevision([]),
    };

    await expect(helper.createSnapshot(parameters)).resolves.toMatchObject({ created: true, verified: true, consistency: "offline-consistent", independentBackup: false, diskTargets: ["vda"] });
    expect(run).toHaveBeenCalledWith("/usr/bin/virsh", ["--connect", "qemu:///system", "snapshot-create-as", "ubuntu-lab", "pre-upgrade", "--description", "Created by BoxPilot offline snapshot workflow", "--atomic"], { timeout: 180000 });
  });

  it("rejects a VM disk outside the managed image root before snapshot creation", async () => {
    const run = vi.fn(async (_binary, args) => {
      if (args[2] === "domstate") return { stdout: "shut off", stderr: "" };
      if (args[2] === "dominfo") return { stdout: "UUID: 11111111-1111-4111-8111-111111111111\nAutostart: disable", stderr: "" };
      if (args[2] === "snapshot-list") return { stdout: "", stderr: "" };
      if (args[2] === "domblklist") return { stdout: "Type Device Target Source\n---------------------------------------------\nfile disk vda /tmp/escape.qcow2", stderr: "" };
      throw new Error("unexpected command");
    });
    const helper = createVmHelper({ run, statFile: async () => regularIso() });
    await expect(helper.createSnapshot({
      name: "ubuntu-lab", snapshotName: "safe", expectedUuid: "11111111-1111-4111-8111-111111111111",
      expectedState: "stopped", expectedDiskRevision: snapshotDiskRevision([{ type: "file", device: "disk", target: "vda", source: "/tmp/escape.qcow2" }]), expectedSnapshotRevision: snapshotInventoryRevision([]),
    })).rejects.toThrow("escaped the managed default image directory");
    expect(run.mock.calls.some(([, args]) => args[2] === "snapshot-create-as")).toBe(false);
  });
});
