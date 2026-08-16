import { describe, expect, it, vi } from "vitest";
import { createLibvirtService, getSetupPlan, validateDomainName } from "./libvirt.mjs";

function successful(stdout = "") {
  return { ok: true, stdout, stderr: "" };
}

describe("libvirt service", () => {
  it("accepts only constrained domain names", () => {
    expect(validateDomainName("ubuntu-lab_01")).toBe(true);
    expect(validateDomainName("../../etc/passwd")).toBe(false);
    expect(validateDomainName("vm name")).toBe(false);
  });

  it("returns a guided Ubuntu setup plan", () => {
    const plan = getSetupPlan();
    expect(plan.commands.join("\n")).toContain("qemu-system-x86");
    expect(plan.commands.join("\n")).not.toContain("adduser");
    expect(plan.commands.join("\n")).toContain("qemu:///system");
    expect(plan.requiresConsoleApproval).toBe(true);
  });

  it("discovers domains and normalizes their live state", async () => {
    const runCommand = vi.fn(async (_command, args) => {
      const operation = args[2];
      if (operation === "list") return successful("ubuntu-lab\nwindows-test");
      if (operation === "dominfo" && args[3] === "ubuntu-lab") {
        return successful("Name: ubuntu-lab\nUUID: one\nState: running\nCPU(s): 2\nMax memory: 4194304 KiB\nPersistent: yes\nAutostart: enable");
      }
      if (operation === "dominfo") {
        return successful("Name: windows-test\nUUID: two\nState: shut off\nCPU(s): 4\nMax memory: 8388608 KiB\nPersistent: yes\nAutostart: disable");
      }
      if (operation === "domifaddr" && args[3] === "ubuntu-lab") {
        if (args[5] === "agent") return successful("Name MAC address Protocol Address\n------------------------------------------------\nens3 52:54:00:aa:bb:cc ipv4 100.64.0.8/32");
        return successful("Name MAC address Protocol Address\n------------------------------------------------\nvnet0 52:54:00:aa:bb:cc ipv4 192.168.122.25/24");
      }
      if (operation === "domblklist" && args[3] === "ubuntu-lab") {
        return successful("Type Device Target Source\n---------------------------------------------\nfile disk vda /var/lib/libvirt/images/ubuntu-lab.qcow2\nfile cdrom sda /var/lib/libvirt/boot/ubuntu.iso");
      }
      if (operation === "domiflist" && args[3] === "ubuntu-lab") {
        return successful("Interface Type Source Model MAC\n-------------------------------------------------------\nvnet0 network default virtio 52:54:00:aa:bb:cc");
      }
      if (operation === "snapshot-list" && args[3] === "ubuntu-lab") return successful("clean-install\npre-upgrade");
      if (operation === "snapshot-info") return successful(`Name: ${args[4]}\nDomain: ubuntu-lab\nCurrent: ${args[4] === "pre-upgrade" ? "yes" : "no"}\nState: shutoff\nLocation: internal\nParent: -\nCreation Time: 2026-08-15 10:00:00 -0500`);
      if (operation === "qemu-agent-command" && args[4].includes("guest-ping")) return successful('{"return":{}}');
      if (operation === "qemu-agent-command") return successful('{"return":"thawed"}');
      return successful();
    });
    const service = createLibvirtService({ runCommand });

    const result = await service.listDomains();

    expect(result.connected).toBe(true);
    expect(result.domains).toHaveLength(2);
    expect(result.domains[0]).toMatchObject({
      name: "ubuntu-lab",
      state: "running",
      vcpus: 2,
      memoryKiB: 4194304,
      autostart: true,
    });
    expect(result.domains[0].addresses[0].address).toBe("192.168.122.25/24");
    expect(result.domains[0].addresses[1].address).toBe("100.64.0.8/32");
    expect(result.domains[0].disks).toHaveLength(2);
    expect(result.domains[0].interfaces[0]).toMatchObject({ source: "default", model: "virtio" });
    expect(result.domains[0].snapshotCount).toBe(2);
    expect(result.domains[0].snapshots[1]).toMatchObject({ name: "pre-upgrade", current: true, state: "stopped", location: "internal" });
    expect(result.domains[0].guestAgent).toEqual({ available: true, filesystemState: "thawed", addressDiscovery: true });
    expect(result.domains[1].state).toBe("stopped");
  });

  it("discovers libvirt networks and storage pools", async () => {
    const runCommand = vi.fn(async (_command, args) => {
      if (args[2] === "net-list") return successful("default\nlab-net");
      if (args[2] === "pool-list") return successful("default");
      if (args[2] === "net-info") {
        return successful(`Name: ${args[3]}\nActive: yes\nPersistent: yes\nAutostart: yes\nBridge: virbr0`);
      }
      if (args[2] === "pool-info") {
        return successful("Name: default\nState: running\nPersistent: yes\nAutostart: yes\nCapacity: 500.00 GiB\nAllocation: 80.00 GiB\nAvailable: 420.00 GiB");
      }
      return successful();
    });
    const service = createLibvirtService({ runCommand });

    const result = await service.listResources();

    expect(result.connected).toBe(true);
    expect(result.networks).toHaveLength(2);
    expect(result.networks[0]).toMatchObject({ name: "default", active: true, bridge: "virbr0" });
    expect(result.pools[0]).toMatchObject({ name: "default", available: "420.00 GiB", availableBytes: 450971566080 });
  });

});
