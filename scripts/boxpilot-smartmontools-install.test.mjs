import { describe, expect, it, vi } from "vitest";
import { installApprovedSmartmontools } from "./boxpilot-smartmontools-install.mjs";

function approval() {
  return JSON.stringify({ expectedVersion: "7.5-2", approvedAt: "2026-08-16T05:00:00.000Z" });
}

describe("fixed smartmontools package installer", () => {
  it("pins the independently rechecked exact version and starts only the fixed scan", async () => {
    let installed = false;
    const run = vi.fn(async (binary, args) => {
      if (binary.endsWith("apt-cache")) return { ok: true, stdout: "  Candidate: 7.5-2" };
      if (binary.endsWith("dpkg-query")) return installed ? { ok: true, stdout: "install ok installed\t7.5-2" } : { ok: false, stdout: "" };
      if (binary.endsWith("apt-get")) { expect(args).toEqual(["install", "--yes", "--no-install-recommends", "smartmontools=7.5-2"]); installed = true; return { ok: true, stdout: "ignored" }; }
      if (binary.endsWith("systemctl")) { expect(args).toEqual(["start", "boxpilot-storage-scan.service"]); return { ok: true, stdout: "" }; }
      throw new Error(`unexpected ${binary}`);
    });
    await expect(installApprovedSmartmontools({ run, loadApproval: async () => approval(), now: () => new Date("2026-08-16T05:01:00.000Z") })).resolves.toEqual({ installed: true, version: "7.5-2", packageChanged: true });
  });

  it("fails before APT when metadata changes or the approval is stale", async () => {
    const run = vi.fn(async () => ({ ok: true, stdout: "  Candidate: 7.6-1" }));
    await expect(installApprovedSmartmontools({ run, loadApproval: async () => approval(), now: () => new Date("2026-08-16T05:01:00.000Z") })).rejects.toThrow("no package was installed");
    expect(run.mock.calls.some(([binary]) => binary.endsWith("apt-get"))).toBe(false);
    await expect(installApprovedSmartmontools({ run, loadApproval: async () => approval(), now: () => new Date("2026-08-16T05:06:00.001Z") })).rejects.toThrow("stale");
  });
});
