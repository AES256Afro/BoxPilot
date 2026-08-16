import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStorageScanner, parseSmartctlEvidence, writeStorageEvidence } from "./boxpilot-storage-scan.mjs";

const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("fixed root-only storage scan", () => {
  it("extracts only bounded health fields from smartctl JSON", () => {
    const result = parseSmartctlEvidence("/dev/nvme0n1", JSON.stringify({
      serial_number: "secret-serial",
      smart_status: { passed: true },
      temperature: { current: 43 },
      power_on_time: { hours: 100 },
      nvme_smart_health_information_log: { critical_warning: 0, percentage_used: 8, media_errors: 0, unsafe_shutdowns: 2 },
    }));
    expect(result).toMatchObject({ device: "/dev/nvme0n1", health: "healthy", passed: true, temperatureCelsius: 43, percentageUsed: 8 });
    expect(JSON.stringify(result)).not.toContain("secret-serial");
  });

  it("discovers fixed disk names and never accepts a browser path", async () => {
    const run = vi.fn(async (binary, args) => {
      if (binary.endsWith("findmnt")) return { ok: true, stdout: JSON.stringify({ filesystems: [{ target: "/", source: "/dev/nvme0n1p2", fstype: "ext4", size: 1000, used: 500, avail: 500, "use%": "50%", options: "rw,relatime,password=secret" }] }) };
      if (binary.endsWith("lsblk")) return { ok: true, stdout: JSON.stringify({ blockdevices: [{ name: "/dev/nvme0n1", type: "disk" }, { name: "/dev/mapper/private", type: "disk" }, { name: "/dev/nvme0n1p1", type: "part" }] }) };
      expect(args).toEqual(["--json=c", "--all", "/dev/nvme0n1"]);
      return { ok: true, stdout: JSON.stringify({ smart_status: { passed: false }, serial_number: "secret" }) };
    });
    const scanner = createStorageScanner({ run, checkAccess: vi.fn(async () => {}), now: () => new Date("2026-08-16T05:00:00.000Z") });
    const result = await scanner.scan();
    expect(result).toMatchObject({ available: true, filesystems: { available: true, namespace: "host-pid1", mounts: [{ target: "/", readOnly: false }] }, disks: [{ device: "/dev/nvme0n1", health: "critical" }], boundary: { mutationPerformed: false, browserTriggered: false } });
    expect(run).toHaveBeenCalledWith("/usr/bin/findmnt", ["--json", "--bytes", "--real", "--tab-file", "/proc/1/mountinfo", "--output", "TARGET,SOURCE,FSTYPE,SIZE,USED,AVAIL,USE%,OPTIONS"], { timeout: 10000 });
    expect(run).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("writes fail-closed evidence when smartctl is not installed", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-storage-scan-"));
    directories.push(directory);
    const outputPath = path.join(directory, "storage-health.json");
    const scanner = createStorageScanner({ run: vi.fn(async () => ({ ok: false, stdout: "" })), checkAccess: vi.fn(async () => { throw new Error("missing path secret"); }), now: () => new Date("2026-08-16T05:00:00.000Z") });
    await writeStorageEvidence({ outputPath, stateDirectory: directory, scanner });
    const contents = await readFile(outputPath, "utf8");
    expect(JSON.parse(contents)).toMatchObject({ available: false, reason: "smartctl-not-installed", disks: [] });
    expect(contents).not.toContain("missing path secret");
  });
});
