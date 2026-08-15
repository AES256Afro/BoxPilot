import { describe, expect, it } from "vitest";
import { createVmPlanner, validateVmPlanInput } from "./vm-plan.mjs";

function isoEntry(name, kind = "file") {
  return {
    name,
    isFile: () => kind === "file",
  };
}

function validInput(overrides = {}) {
  return {
    name: "ubuntu-lab",
    osProfile: "ubuntu-24.04",
    vcpus: 2,
    memoryMiB: 4096,
    diskGiB: 40,
    isoFile: "ubuntu-24.04.iso",
    network: "default",
    firmware: "uefi",
    autostart: false,
    ...overrides,
  };
}

describe("VM creation planning", () => {
  it("rejects paths, unknown networks, and out-of-range resources", () => {
    expect(validateVmPlanInput(validInput({ isoFile: "../../etc/passwd", network: "bridge0", vcpus: 0 }))).toEqual([
      "vCPU count must be an integer from 1 to 32",
      "Select an ISO filename from the managed media library",
      "Only the default NAT network is supported in this planning milestone",
    ]);
    expect(validateVmPlanInput(validInput({ name: "boxpilot-drill-manual" }))).toContain("Names beginning with boxpilot-drill- are reserved for isolated restore recovery");
  });

  it("lists regular ISO files without following directories or symlinks", async () => {
    const planner = createVmPlanner({
      mediaRoot: "/safe/iso",
      readDirectory: async () => [isoEntry("ubuntu-24.04.iso"), isoEntry("empty.iso"), isoEntry("nested.iso", "directory"), isoEntry("link.iso", "symlink"), isoEntry("notes.txt")],
      statFile: async (filename) => ({ size: filename.endsWith("empty.iso") ? 0 : 2048, mtime: new Date("2026-08-14T12:00:00Z"), isFile: () => true, isSymbolicLink: () => false }),
      hostCapacity: () => ({ cpuThreads: 8, memoryMiB: 32768 }),
    });

    const options = await planner.getOptions();

    expect(options.isoImages).toEqual([{ name: "ubuntu-24.04.iso", sizeBytes: 2048, modifiedAt: "2026-08-14T12:00:00.000Z" }]);
    expect(options.mediaRoot).toBe("/safe/iso");
  });

  it("builds a deterministic stageable virt-install preview", async () => {
    const planner = createVmPlanner({
      mediaRoot: "/safe/iso",
      readDirectory: async () => [isoEntry("ubuntu-24.04.iso")],
      statFile: async () => ({ size: 4096, mtime: new Date("2026-08-14T12:00:00Z"), isFile: () => true, isSymbolicLink: () => false }),
      hostCapacity: () => ({ cpuThreads: 8, memoryMiB: 32768 }),
    });

    const result = await planner.createPlan(validInput());

    expect(result.ok).toBe(true);
    expect(result.plan).toMatchObject({
      executable: true,
      stageable: true,
      requiresRestrictedHelper: true,
      revision: "da7a1f7a5de90ce3",
      input: { name: "ubuntu-lab", network: "default" },
    });
    expect(result.plan.command.program).toBe("virt-install");
    expect(result.plan.command.arguments).toContain("/safe/iso/ubuntu-24.04.iso");
    expect(result.plan.command.display).toContain("--noautoconsole");
  });

  it("refuses a valid-looking ISO that is not in the managed library", async () => {
    const planner = createVmPlanner({
      mediaRoot: "/safe/iso",
      readDirectory: async () => [],
      hostCapacity: () => ({ cpuThreads: 4, memoryMiB: 8192 }),
    });

    const result = await planner.createPlan(validInput());

    expect(result).toEqual({ ok: false, errors: ["The selected ISO is not present in the managed media library"] });
  });

  it("refuses domain collisions and an undersized storage pool", async () => {
    const planner = createVmPlanner({
      mediaRoot: "/safe/iso",
      readDirectory: async () => [isoEntry("ubuntu-24.04.iso")],
      statFile: async () => ({ size: 4096, mtime: new Date("2026-08-14T12:00:00Z"), isFile: () => true, isSymbolicLink: () => false }),
      hostCapacity: () => ({ cpuThreads: 8, memoryMiB: 32768 }),
    });

    expect(await planner.createPlan(validInput(), { existingDomainNames: ["ubuntu-lab"] })).toEqual({
      ok: false,
      errors: ["A libvirt domain named ubuntu-lab already exists"],
    });
    expect(await planner.createPlan(validInput({ diskGiB: 80 }), { poolAvailableBytes: 40 * 1024 ** 3 })).toEqual({
      ok: false,
      errors: ["The default storage pool does not report enough free space for this virtual disk"],
    });
  });
});
