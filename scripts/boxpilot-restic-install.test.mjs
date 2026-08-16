import { describe, expect, it, vi } from "vitest";
import { installApprovedRestic } from "./boxpilot-restic-install.mjs";

function approval() {
  return JSON.stringify({ expectedVersion: "0.18.1-1", approvedAt: "2026-08-16T12:00:00.000Z" });
}

describe("fixed restic package installer", () => {
  it("pins the independently rechecked exact version and probes only the fixed binary", async () => {
    let installed = false;
    const run = vi.fn(async (binary, args) => {
      if (binary.endsWith("apt-cache")) return { ok: true, stdout: "  Candidate: 0.18.1-1" };
      if (binary.endsWith("dpkg-query")) return installed ? { ok: true, stdout: "install ok installed\t0.18.1-1" } : { ok: false, stdout: "" };
      if (binary.endsWith("apt-get")) { expect(args).toEqual(["install", "--yes", "--no-install-recommends", "restic=0.18.1-1"]); installed = true; return { ok: true, stdout: "ignored" }; }
      if (binary.endsWith("restic")) { expect(args).toEqual(["version"]); return { ok: true, stdout: "restic 0.18.1 compiled with go1.24" }; }
      throw new Error(`unexpected ${binary}`);
    });
    await expect(installApprovedRestic({ run, loadApproval: async () => approval(), now: () => new Date("2026-08-16T12:01:00.000Z") })).resolves.toEqual({ installed: true, version: "0.18.1-1", packageChanged: true, binaryVerified: true });
  });

  it("fails before APT when metadata changes or the approval is stale", async () => {
    const run = vi.fn(async () => ({ ok: true, stdout: "  Candidate: 0.18.2-1" }));
    await expect(installApprovedRestic({ run, loadApproval: async () => approval(), now: () => new Date("2026-08-16T12:01:00.000Z") })).rejects.toThrow("no package was installed");
    expect(run.mock.calls.some(([binary]) => binary.endsWith("apt-get"))).toBe(false);
    await expect(installApprovedRestic({ run, loadApproval: async () => approval(), now: () => new Date("2026-08-16T12:06:00.001Z") })).rejects.toThrow("stale");
  });
});
