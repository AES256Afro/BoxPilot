import { describe, expect, it } from "vitest";
import { normalizeSmartEvidence, parseBlockInventory, parseMountInventory } from "./storage-evidence.mjs";

describe("sanitized storage evidence", () => {
  it("flattens real mounts while removing option values and sensitive mount locations", () => {
    const result = parseMountInventory(JSON.stringify({ filesystems: [{
      target: "/", source: "/dev/mapper/ubuntu--vg-root", fstype: "ext4", size: 1000, used: 960, avail: 40, "use%": "96%", options: "rw,relatime,errors=remount-ro,password=secret",
      children: [{ target: "/home/private-owner/archive", source: "//private-owner:password@nas/share", fstype: "cifs", size: 2000, used: 1000, avail: 1000, "use%": "50%", options: "rw,username=private-owner,password=secret" }],
    }] }));
    expect(result).toMatchObject({ available: true, summary: { critical: 1, healthy: 1 } });
    expect(result.mounts[0]).toMatchObject({ target: "/", source: "/dev/mapper/ubuntu--vg-root", capacityState: "critical", optionNames: ["errors", "relatime", "rw"] });
    expect(result.mounts[1]).toMatchObject({ target: "/home/[redacted]", source: "[remote-or-virtual-source]" });
    expect(JSON.stringify(result)).not.toContain("password");
    expect(JSON.stringify(result)).not.toContain("private-owner");
  });

  it("returns block topology without serials, UUIDs, or unsafe device values", () => {
    const result = parseBlockInventory(JSON.stringify({ blockdevices: [{ name: "/dev/nvme0n1", type: "disk", size: 1000, rota: false, ro: false, tran: "nvme", model: "Safe Model", serial: "secret-serial", uuid: "secret-uuid", mountpoints: [], children: [{ name: "/dev/nvme0n1p1", type: "part", fstype: "ext4", size: 900, mountpoints: ["/"], rota: false, ro: false }] }] }));
    expect(result).toMatchObject({ available: true, devices: [expect.objectContaining({ name: "/dev/nvme0n1", type: "disk", model: "Safe Model" }), expect.objectContaining({ name: "/dev/nvme0n1p1", parent: "/dev/nvme0n1", filesystem: "ext4" })] });
    expect(JSON.stringify(result)).not.toContain("secret-serial");
    expect(JSON.stringify(result)).not.toContain("secret-uuid");
  });

  it("fails stale, malformed, and future SMART evidence closed", () => {
    const current = normalizeSmartEvidence({ schemaVersion: 1, generatedAt: "2026-08-16T04:00:00.000Z", available: true, reason: "fixed-root-scan", disks: [{ device: "/dev/nvme0n1", health: "healthy", passed: true, temperatureCelsius: 40, percentageUsed: 4, reason: "ok", serial: "never-export" }] }, { now: () => new Date("2026-08-16T05:00:00.000Z") });
    expect(current).toMatchObject({ available: true, status: "healthy", stale: false, summary: { healthy: 1 } });
    expect(JSON.stringify(current)).not.toContain("never-export");
    expect(normalizeSmartEvidence({ ...current, schemaVersion: 2 }).status).toBe("unavailable");
    expect(normalizeSmartEvidence({ schemaVersion: 1, generatedAt: "2026-08-17T05:00:00.000Z", available: true, disks: [] }, { now: () => new Date("2026-08-16T05:00:00.000Z") }).stale).toBe(true);
  });
});
