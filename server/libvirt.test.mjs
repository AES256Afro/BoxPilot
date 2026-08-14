import { describe, expect, it, vi } from "vitest";
import { createLibvirtService, getSetupPlan, validateAction, validateDomainName } from "./libvirt.mjs";

function successful(stdout = "") {
  return { ok: true, stdout, stderr: "" };
}

describe("libvirt service", () => {
  it("accepts only constrained domain names and lifecycle actions", () => {
    expect(validateDomainName("ubuntu-lab_01")).toBe(true);
    expect(validateDomainName("../../etc/passwd")).toBe(false);
    expect(validateDomainName("vm name")).toBe(false);
    expect(validateAction("start")).toBe(true);
    expect(validateAction("destroy")).toBe(false);
  });

  it("returns a guided Ubuntu setup plan", () => {
    const plan = getSetupPlan();
    expect(plan.commands.join("\n")).toContain("qemu-kvm");
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
        return successful("Name MAC address Protocol Address\n------------------------------------------------\nvnet0 52:54:00:aa:bb:cc ipv4 192.168.122.25/24");
      }
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
    expect(result.domains[1].state).toBe("stopped");
  });

  it("maps an approved action to a fixed virsh argument array", async () => {
    const runCommand = vi.fn(async (_command, args) => {
      if (args[2] === "start") return successful("Domain ubuntu-lab started");
      if (args[2] === "dominfo") {
        return successful("Name: ubuntu-lab\nState: running\nCPU(s): 2\nMax memory: 4194304 KiB\nPersistent: yes\nAutostart: disable");
      }
      return successful();
    });
    const service = createLibvirtService({ runCommand });

    const result = await service.runDomainAction("ubuntu-lab", "start");

    expect(result.action).toBe("start");
    expect(runCommand).toHaveBeenCalledWith(
      "virsh",
      ["--connect", "qemu:///system", "start", "ubuntu-lab"],
      { timeout: 30000 },
    );
  });
});
