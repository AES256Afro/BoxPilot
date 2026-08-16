import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectFilesystemErrors, createStorageScanner, parseSmartctlEvidence, writeStorageEvidence } from "./boxpilot-storage-scan.mjs";

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
      if (binary.endsWith("lsblk") && args[0] === "--noheadings") return { ok: true, stdout: "nvme0n1p2" };
      if (binary.endsWith("lsblk")) return { ok: true, stdout: JSON.stringify({ blockdevices: [{ name: "/dev/nvme0n1", type: "disk" }, { name: "/dev/mapper/private", type: "disk" }, { name: "/dev/nvme0n1p1", type: "part" }] }) };
      expect(args).toEqual(["--json=c", "--all", "/dev/nvme0n1"]);
      return { ok: true, stdout: JSON.stringify({ smart_status: { passed: false }, serial_number: "secret" }) };
    });
    const loadFile = vi.fn(async (file) => file === "/sys/fs/ext4/nvme0n1p2/errors_count" ? "0\n" : Promise.reject(new Error("unexpected path")));
    const scanner = createStorageScanner({ run, loadFile, checkAccess: vi.fn(async () => {}), now: () => new Date("2026-08-16T05:00:00.000Z") });
    const result = await scanner.scan();
    expect(result).toMatchObject({ schemaVersion: 2, available: true, filesystems: { available: true, namespace: "host-pid1", mounts: [{ target: "/", readOnly: false, errorEvidence: { supported: true, state: "healthy", errorsCount: 0 } }], errors: { healthy: 1, critical: 0, unavailable: 0, unsupported: 0 } }, disks: [{ device: "/dev/nvme0n1", health: "critical" }], boundary: { mutationPerformed: false, browserTriggered: false, filesystemCheckTriggered: false } });
    expect(run).toHaveBeenCalledWith("/usr/bin/findmnt", ["--json", "--bytes", "--real", "--tab-file", "/proc/1/mountinfo", "--output", "TARGET,SOURCE,FSTYPE,SIZE,USED,AVAIL,USE%,OPTIONS"], { timeout: 10000 });
    expect(loadFile).toHaveBeenCalledWith("/sys/fs/ext4/nvme0n1p2/errors_count", "utf8");
    expect(run).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("writes fail-closed evidence when smartctl is not installed", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-storage-scan-"));
    directories.push(directory);
    const outputPath = path.join(directory, "storage-health.json");
    const scanner = createStorageScanner({ run: vi.fn(async () => ({ ok: false, stdout: "" })), loadFile: vi.fn(async () => "0"), checkAccess: vi.fn(async () => { throw new Error("missing path secret"); }), now: () => new Date("2026-08-16T05:00:00.000Z") });
    await writeStorageEvidence({ outputPath, stateDirectory: directory, scanner });
    const contents = await readFile(outputPath, "utf8");
    expect(JSON.parse(contents)).toMatchObject({ schemaVersion: 2, available: false, reason: "smartctl-not-installed", disks: [], boundary: { filesystemCheckTriggered: false } });
    expect(contents).not.toContain("missing path secret");
  });

  it("reports ext4 counters and unsupported filesystems without running a filesystem check", async () => {
    const run = vi.fn(async (_binary, args) => args.at(-1) === "/dev/sda2" ? { ok: true, stdout: "sda2" } : { ok: false, stdout: "" });
    const result = await collectFilesystemErrors({ available: true, mounts: [
      { target: "/", source: "/dev/sda2", filesystem: "ext4" },
      { target: "/boot/efi", source: "/dev/sda1", filesystem: "vfat" },
      { target: "/srv", source: "[remote-or-virtual-source]", filesystem: "ext4" },
    ] }, { run, loadFile: vi.fn(async () => "3\n") });
    expect(result).toMatchObject({ errors: { healthy: 0, critical: 1, unavailable: 1, unsupported: 1 }, mounts: [
      { errorEvidence: { state: "critical", errorsCount: 3, reason: "errors-recorded" } },
      { errorEvidence: { state: "unsupported", supported: false } },
      { errorEvidence: { state: "unavailable", reason: "local-device-unavailable" } },
    ] });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
