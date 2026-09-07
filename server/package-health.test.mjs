import { describe, expect, it, vi } from "vitest";
import { inspectPackageHealth, inspectPackageLocks, lockIdentity, parsePackageLocks } from "./package-health.mjs";
const free = async () => ({ available: true, holders: [] });
const ok = (stdout = "") => ({ ok: true, stdout, stderr: "" });

describe("package lock ownership", () => {
  it("matches kernel locks by device and inode, ignoring waiting processes and unrelated locks", () => {
    expect(lockIdentity({ dev: 2049n, ino: 123n })).toBe("8:1:123");
    const locks = parsePackageLocks("1: POSIX ADVISORY WRITE 42 08:01:123 0 EOF\n1: -> POSIX ADVISORY WRITE 99 08:01:123 0 EOF\n2: FLOCK ADVISORY WRITE 44 08:01:999 0 EOF", new Map([["8:1:123", "/var/lib/dpkg/lock"]]));
    expect(locks).toEqual([{ file: "/var/lib/dpkg/lock", pid: 42, mode: "WRITE" }]);
  });
  it("does not mistake existing unlocked files for active work", async () => {
    expect(await inspectPackageLocks({ statFile: async () => ({ dev: 2049n, ino: 123n }), read: async () => "" })).toEqual({ available: true, holders: [] });
  });
  it("reports unavailable kernel evidence and inaccessible files honestly", async () => {
    expect((await inspectPackageLocks({ statFile: async () => { throw Object.assign(new Error(), { code: "EACCES" }); }, read: async () => "" })).available).toBe(false);
    expect((await inspectPackageLocks({ statFile: async () => ({ dev: 2049n, ino: 123n }), read: async () => "broken" })).available).toBe(false);
  });
});

describe("package diagnosis", () => {
  it("distinguishes a healthy package state from pending configuration", async () => {
    const run = vi.fn(async () => ok());
    expect(await inspectPackageHealth({ run, inspectLocks: free, now: () => new Date(0) })).toMatchObject({ status: "healthy", repairAvailable: false, checkedAt: "1970-01-01T00:00:00.000Z" });
    expect(run).toHaveBeenCalledWith("/usr/bin/apt-get", ["--simulate", "--fix-broken", "--no-remove", "install"], expect.anything());
    run.mockImplementation(async (binary) => ok(binary.endsWith("dpkg") ? "Packages unpacked but not configured:\n example" : "Conf example (1.0 Ubuntu)"));
    expect(await inspectPackageHealth({ run, inspectLocks: free })).toMatchObject({ status: "needs-repair", repairAvailable: true });
  });
  it("avoids expensive checks while another package manager holds a lock", async () => {
    const run = vi.fn();
    const report = await inspectPackageHealth({ run, inspectLocks: async () => ({ available: true, holders: [{ pid: 42 }] }) });
    expect(report.status).toBe("busy");
    expect(run).not.toHaveBeenCalled();
  });
  it("never reports all clear when a check fails or an updater starts during the simulation", async () => {
    expect((await inspectPackageHealth({ run: async () => ({ ok: false, stderr: "timeout" }), inspectLocks: free })).status).toBe("unknown");
    const inspectLocks = vi.fn().mockResolvedValueOnce({ available: true, holders: [] }).mockResolvedValueOnce({ available: true, holders: [{ pid: 44 }] });
    expect((await inspectPackageHealth({ run: async () => ok(), inspectLocks })).status).toBe("busy");
  });
});

it("allows pending configuration recovery when dpkg interruption prevents the simulation", async () => {
  const run = async (binary) => binary.endsWith("dpkg") ? ok("example is unpacked") : { ok: false, stderr: "E: dpkg was interrupted" };
  expect(await inspectPackageHealth({ run, inspectLocks: free })).toMatchObject({ status: "needs-repair", repairAvailable: true });
});
it("redacts repository credentials from diagnostic details", async () => {
  const report = await inspectPackageHealth({ run: async () => ({ ok: false, stderr: "https://username:secret@repo.example.test" }), inspectLocks: free });
  expect(JSON.stringify(report)).not.toContain("username:secret");
});
