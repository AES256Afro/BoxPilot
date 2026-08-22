import { describe, expect, it, vi } from "vitest";
import { createPrerequisiteService, port53Occupied } from "./prerequisites.mjs";

describe("prerequisite inventory", () => {
  it("reports live readiness without returning raw peer or listener output", async () => {
    const helper = { request: vi.fn(async (operation) => operation === "prerequisite.docker.inspect"
      ? ({ installed: true, engineVersion: "29.1.3", provider: "existing-compatible-engine", installedPackageVersion: null, repairAvailable: false })
      : operation === "prerequisite.virtualization.inspect"
        ? ({ installed: true, kvmDeviceAvailable: true, serviceActive: true, connectionReady: true, connectionUri: "qemu:///system", qemuVerified: true, repairAvailable: false })
        : operation === "prerequisite.smartmontools.inspect"
          ? ({ installed: true, installedVersion: "7.5-2", repairAvailable: false })
          : operation === "prerequisite.restic.inspect"
            ? ({ installed: true, installedVersion: "0.18.1-1", repairAvailable: false })
          : operation === "prerequisite.apt-metadata.inspect"
              ? ({ available: true, state: "current", updatedAt: "2026-08-16T06:00:00.000Z", ageHours: 1, packageManagerState: "ready", refreshAvailable: false })
              : ({ verified: true, helperVersion: "0.46.0", mutationPerformed: false })) };
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
    expect(result.checks.find((item) => item.id === "containers.docker")).toMatchObject({ status: "ready", summary: expect.stringContaining("Docker Engine 29.1.3") });
    expect(runCommand).not.toHaveBeenCalledWith("docker", expect.anything());
    expect(runCommand).not.toHaveBeenCalledWith("virsh", expect.anything());
    expect(result.checks.find((item) => item.id === "virtualization.libvirt")).toMatchObject({ status: "ready" });
    expect(result.checks.find((item) => item.id === "storage.smartmontools")).toMatchObject({ status: "ready", summary: expect.stringContaining("7.5-2") });
    expect(result.checks.find((item) => item.id === "backup.restic")).toMatchObject({ status: "ready", summary: expect.stringContaining("0.18.1-1") });
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
    expect(result.checks).toHaveLength(10);
  });

  it("offers only the fixed approved smartmontools repair when configured metadata has a candidate", async () => {
    const helper = { request: vi.fn(async (operation) => {
      if (operation === "canary.verify") return { verified: true, helperVersion: "0.42.0", mutationPerformed: false };
      if (operation === "prerequisite.smartmontools.inspect") return { installed: false, candidateVersion: "7.5-2", repairAvailable: true };
      if (operation === "prerequisite.restic.inspect") return { installed: false, candidateVersion: "0.18.1-1", repairAvailable: true };
      if (operation === "prerequisite.apt-metadata.inspect") return { available: true, state: "stale", updatedAt: "2026-08-01T00:00:00.000Z", ageHours: 360, packageManagerState: "ready", refreshAvailable: true };
      if (operation === "prerequisite.docker.inspect") return { installed: false, candidateVersion: "28.2.2-0ubuntu1", repairAvailable: true };
      if (operation === "prerequisite.virtualization.inspect") return { installed: false, kvmDeviceAvailable: true, candidateSetAvailable: true, repairAvailable: true };
      throw new Error("unexpected operation");
    }) };
    const service = createPrerequisiteService({ stateDirectory: "/state", helper, runCommand: vi.fn(async () => ({ ok: true, stdout: "" })), checkAccess: vi.fn(async () => {}), getFilesystem: vi.fn(async () => ({ bavail: 2_000_000, bsize: 4096 })) });
    const result = await service.inspect();
    expect(result.checks.find((item) => item.id === "storage.smartmontools")).toMatchObject({ status: "repairable", repair: { kind: "approved" } });
    expect(result.checks.find((item) => item.id === "backup.restic")).toMatchObject({ status: "repairable", repair: { kind: "approved" } });
    expect(result.checks.find((item) => item.id === "containers.docker")).toMatchObject({ status: "repairable", repair: { kind: "approved" } });
    expect(result.checks.find((item) => item.id === "virtualization.libvirt")).toMatchObject({ status: "repairable", repair: { kind: "approved" } });
    expect(result.checks.find((item) => item.id === "host.apt-metadata")).toMatchObject({ status: "repairable", repair: { kind: "approved" } });
    expect(JSON.stringify(result)).not.toContain("apt-get");
  });
});

describe("reading port 53 from ss output", () => {
  it("sees the resolver Ubuntu ships, whose address carries an interface scope", () => {
    // 127.0.0.53%lo:53 is systemd-resolved's stub listener on a stock Ubuntu Server, and it is
    // exactly what makes a Pi-hole or AdGuard container fail to bind. It used to read as free.
    expect(port53Occupied("udp   UNCONN 0 0 127.0.0.53%lo:53 0.0.0.0:*")).toBe(true);
    expect(port53Occupied("udp   UNCONN 0 0 [fe80::1%eth0]:53 [::]:*")).toBe(true);
  });

  it("sees the ordinary forms, and is not fooled by a port that merely ends in 53", () => {
    expect(port53Occupied("udp UNCONN 0 0 0.0.0.0:53 0.0.0.0:*")).toBe(true);
    expect(port53Occupied("tcp LISTEN 0 4096 [::]:53 [::]:*")).toBe(true);
    expect(port53Occupied("tcp LISTEN 0 4096 127.0.0.1:5353 0.0.0.0:*")).toBe(false);
    expect(port53Occupied("tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*")).toBe(false);
    expect(port53Occupied("")).toBe(false);
  });
});

describe("collecting prerequisite evidence", () => {
  function slowHelper(delayMs = 40) {
    const request = vi.fn(async (operation) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (operation === "canary.verify") return { verified: true };
      return { installed: true, installedVersion: "1", repairAvailable: false, providerPresent: true };
    });
    return { request };
  }

  it("asks the helper for everything at once rather than one after another", async () => {
    const helper = slowHelper(40);
    const service = createPrerequisiteService({ stateDirectory: "/tmp", helper, runCommand: async () => ({ ok: true, stdout: "" }), checkAccess: async () => {}, getFilesystem: async () => ({ bavail: 10n ** 7n, bsize: 4096n }) });
    const started = Date.now();
    await service.inspect();
    // Six 40 ms reads: together that is ~40 ms, one after another it was ~240 ms.
    expect(Date.now() - started).toBeLessThan(200);
    expect(helper.request).toHaveBeenCalledTimes(6);
  });

  it("shares one collection between callers that arrive together", async () => {
    const helper = slowHelper(10);
    const service = createPrerequisiteService({ stateDirectory: "/tmp", helper, runCommand: async () => ({ ok: true, stdout: "" }), checkAccess: async () => {}, getFilesystem: async () => ({ bavail: 10n ** 7n, bsize: 4096n }) });
    const [first, second, third] = await Promise.all([service.inspect(), service.inspect(), service.inspect()]);
    expect(helper.request).toHaveBeenCalledTimes(6); // not eighteen
    expect(second).toBe(first);
    expect(third).toBe(first);
  });
});
