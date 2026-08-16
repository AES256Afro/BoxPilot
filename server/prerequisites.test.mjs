import { describe, expect, it, vi } from "vitest";
import { createPrerequisiteService } from "./prerequisites.mjs";

describe("prerequisite inventory", () => {
  it("reports live readiness without returning raw peer or listener output", async () => {
    const helper = { request: vi.fn(async (operation) => operation === "container.docker.inspect"
      ? ({ available: true, version: "29.1.3" })
      : operation === "virtualization.inventory.inspect"
        ? ({ checks: [{ id: "connection", ok: true }, { id: "helper", ok: true }] })
        : operation === "prerequisite.smartmontools.inspect"
          ? ({ installed: true, installedVersion: "7.5-2", repairAvailable: false })
          : operation === "prerequisite.apt-metadata.inspect"
            ? ({ available: true, state: "current", updatedAt: "2026-08-16T06:00:00.000Z", ageHours: 1, packageManagerState: "ready", refreshAvailable: false })
          : ({ verified: true, helperVersion: "0.41.0", mutationPerformed: false })) };
    const runCommand = vi.fn(async (command) => {
      if (command === "tailscale") return { ok: true, stdout: "SECRET PEER DATA" };
      return { ok: true, stdout: "udp UNCONN 0 0 0.0.0.0:53 0.0.0.0:*" };
    });
    const service = createPrerequisiteService({
      stateDirectory: "/state",
      helper,
      runCommand,
      checkAccess: vi.fn(async () => {}),
      getFilesystem: vi.fn(async () => ({ bavail: 2_000_000, bsize: 4096 })),
    });

    const result = await service.inspect();
    expect(result.checks.find((item) => item.id === "containers.docker")).toMatchObject({ status: "ready", summary: "Docker Engine 29.1.3" });
    expect(runCommand).not.toHaveBeenCalledWith("docker", expect.anything());
    expect(runCommand).not.toHaveBeenCalledWith("virsh", expect.anything());
    expect(result.checks.find((item) => item.id === "virtualization.libvirt")).toMatchObject({ status: "ready" });
    expect(result.checks.find((item) => item.id === "storage.smartmontools")).toMatchObject({ status: "ready", summary: expect.stringContaining("7.5-2") });
    expect(result.checks.find((item) => item.id === "host.apt-metadata")).toMatchObject({ status: "ready", summary: expect.stringContaining("dpkg state is ready") });
    expect(result.checks.find((item) => item.id === "dns.port53")).toMatchObject({ status: "conflict" });
    expect(JSON.stringify(result)).not.toContain("SECRET PEER DATA");
  });

  it("degrades individual checks when state and helper access fail", async () => {
    const service = createPrerequisiteService({
      stateDirectory: "/state",
      helper: { request: vi.fn(async () => { throw new Error("offline"); }) },
      runCommand: vi.fn(async () => ({ ok: false, code: "ENOENT" })),
      checkAccess: vi.fn(async () => { throw new Error("denied"); }),
    });

    const result = await service.inspect();
    expect(result.checks.find((item) => item.id === "storage.state")?.status).toBe("missing");
    expect(result.checks.find((item) => item.id === "helper.boundary")?.status).toBe("repairable");
    expect(result.checks).toHaveLength(9);
  });

  it("offers only the fixed approved smartmontools repair when configured metadata has a candidate", async () => {
    const helper = { request: vi.fn(async (operation) => {
      if (operation === "canary.verify") return { verified: true, helperVersion: "0.41.0", mutationPerformed: false };
      if (operation === "prerequisite.smartmontools.inspect") return { installed: false, candidateVersion: "7.5-2", repairAvailable: true };
      if (operation === "prerequisite.apt-metadata.inspect") return { available: true, state: "stale", updatedAt: "2026-08-01T00:00:00.000Z", ageHours: 360, packageManagerState: "ready", refreshAvailable: true };
      if (operation === "container.docker.inspect") return { available: true, version: "29.1.3" };
      if (operation === "virtualization.inventory.inspect") return { checks: [{ id: "connection", ok: true }, { id: "helper", ok: true }] };
      throw new Error("unexpected operation");
    }) };
    const service = createPrerequisiteService({ stateDirectory: "/state", helper, runCommand: vi.fn(async () => ({ ok: true, stdout: "" })), checkAccess: vi.fn(async () => {}), getFilesystem: vi.fn(async () => ({ bavail: 2_000_000, bsize: 4096 })) });
    const result = await service.inspect();
    expect(result.checks.find((item) => item.id === "storage.smartmontools")).toMatchObject({ status: "repairable", repair: { kind: "approved" } });
    expect(result.checks.find((item) => item.id === "host.apt-metadata")).toMatchObject({ status: "repairable", repair: { kind: "approved" } });
    expect(JSON.stringify(result)).not.toContain("apt-get");
  });
});
