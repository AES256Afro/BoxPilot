import { describe, expect, it, vi } from "vitest";
import { createPrerequisiteService } from "./prerequisites.mjs";

describe("prerequisite inventory", () => {
  it("reports live readiness without returning raw peer or listener output", async () => {
    const helper = { request: vi.fn(async () => ({ verified: true, helperVersion: "0.1.0", mutationPerformed: false })) };
    const runCommand = vi.fn(async (command) => {
      if (command === "docker") return { ok: false, code: "ENOENT" };
      if (command === "virsh") return { ok: true, stdout: "qemu:///system" };
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
    expect(result.checks.find((item) => item.id === "containers.docker")).toMatchObject({ status: "missing" });
    expect(result.checks.find((item) => item.id === "virtualization.libvirt")).toMatchObject({ status: "ready" });
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
    expect(result.checks).toHaveLength(7);
  });
});
