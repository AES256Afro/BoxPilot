import { describe, expect, it, vi } from "vitest";
import { installApprovedDriveTools } from "./boxpilot-smartmontools-install.mjs";

const approvedAt = "2026-08-16T05:00:00.000Z";
const now = () => new Date("2026-08-16T05:01:00.000Z");

function approval() {
  return JSON.stringify({ expectedVersion: "7.5-2", approvedAt });
}

/** apt-cache/dpkg-query/apt-get/systemctl as a fresh Ubuntu answers them, with `installed` holding what dpkg knows. */
function packageHost({ candidates, installed = {} }) {
  const calls = [];
  const run = vi.fn(async (binary, args) => {
    calls.push([binary, args]);
    const name = args.at(-1);
    if (binary.endsWith("apt-cache")) return { ok: true, stdout: `${name}:\n  Candidate: ${candidates[name]}` };
    if (binary.endsWith("dpkg-query")) return installed[name] ? { ok: true, stdout: `install ok installed\t${installed[name]}` } : { ok: false, stdout: "" };
    if (binary.endsWith("apt-get")) { for (const pinned of args.slice(4)) { const [pinnedName, version] = pinned.split("="); installed[pinnedName] = version; } return { ok: true, stdout: "ignored" }; }
    if (binary.endsWith("systemctl")) { expect(args).toEqual(["start", "boxpilot-storage-scan.service"]); return { ok: true, stdout: "" }; }
    throw new Error(`unexpected ${binary}`);
  });
  return { run, calls, installed };
}

describe("fixed drive tools package installer", () => {
  it("pins the independently rechecked exact version and starts only the fixed scan", async () => {
    let installed = false;
    const run = vi.fn(async (binary, args) => {
      if (binary.endsWith("apt-cache")) return { ok: true, stdout: "  Candidate: 7.5-2" };
      if (binary.endsWith("dpkg-query")) return installed ? { ok: true, stdout: "install ok installed\t7.5-2" } : { ok: false, stdout: "" };
      if (binary.endsWith("apt-get")) { expect(args).toEqual(["install", "--yes", "--no-install-recommends", "--no-remove", "smartmontools=7.5-2"]); installed = true; return { ok: true, stdout: "ignored" }; }
      if (binary.endsWith("systemctl")) { expect(args).toEqual(["start", "boxpilot-storage-scan.service"]); return { ok: true, stdout: "" }; }
      throw new Error(`unexpected ${binary}`);
    });
    await expect(installApprovedDriveTools({ run, loadApproval: async () => approval(), now })).resolves.toEqual({ installed: true, packages: { smartmontools: "7.5-2" }, packagesChanged: ["smartmontools"] });
  });

  it("fails before APT when metadata changes or the approval is stale", async () => {
    const run = vi.fn(async () => ({ ok: true, stdout: "  Candidate: 7.6-1" }));
    await expect(installApprovedDriveTools({ run, loadApproval: async () => approval(), now })).rejects.toThrow("no package was installed");
    expect(run.mock.calls.some(([binary]) => binary.endsWith("apt-get"))).toBe(false);
    await expect(installApprovedDriveTools({ run, loadApproval: async () => approval(), now: () => new Date("2026-08-16T05:06:00.001Z") })).rejects.toThrow("stale");
  });

  it("installs only the approved packages that are missing, in one pinned apt-get call", async () => {
    const host = packageHost({ candidates: { exfatprogs: "1.2.2-1", smartmontools: "7.4-2build1" }, installed: { smartmontools: "7.4-2build1" } });
    const marker = JSON.stringify({ packages: { exfatprogs: "1.2.2-1", smartmontools: "7.4-2build1" }, approvedAt });
    await expect(installApprovedDriveTools({ run: host.run, loadApproval: async () => marker, now })).resolves.toEqual({ installed: true, packages: { exfatprogs: "1.2.2-1", smartmontools: "7.4-2build1" }, packagesChanged: ["exfatprogs"] });
    expect(host.calls.filter(([binary]) => binary.endsWith("apt-get")).map(([, args]) => args)).toEqual([["install", "--yes", "--no-install-recommends", "--no-remove", "exfatprogs=1.2.2-1"]]);
    const both = packageHost({ candidates: { exfatprogs: "1.2.2-1", smartmontools: "7.4-2build1" } });
    await installApprovedDriveTools({ run: both.run, loadApproval: async () => JSON.stringify({ packages: { smartmontools: "7.4-2build1", exfatprogs: "1.2.2-1" }, approvedAt }), now });
    expect(both.calls.filter(([binary]) => binary.endsWith("apt-get")).map(([, args]) => args)).toEqual([["install", "--yes", "--no-install-recommends", "--no-remove", "exfatprogs=1.2.2-1", "smartmontools=7.4-2build1"]]);
  });

  it("refuses a marker that names anything outside the fixed set, before running anything", async () => {
    const run = vi.fn(async () => ({ ok: true, stdout: "" }));
    for (const packages of [{ curl: "8.5.0-2" }, { exfatprogs: "1.2.2-1", "exfatprogs; rm": "1" }, {}, { exfatprogs: "$(id)" }, ["exfatprogs"]]) {
      await expect(installApprovedDriveTools({ run, loadApproval: async () => JSON.stringify({ packages, approvedAt }), now })).rejects.toThrow(/fixed set|lists no packages|invalid/);
    }
    await expect(installApprovedDriveTools({ run, loadApproval: async () => JSON.stringify({ packages: { exfatprogs: "1.2.2-1" }, approvedAt, extra: true }), now })).rejects.toThrow("unexpected fields");
    expect(run).not.toHaveBeenCalled();
  });

  it("changes nothing when one approved package moved, even if the other still matches", async () => {
    const host = packageHost({ candidates: { exfatprogs: "1.2.3-1", smartmontools: "7.4-2build1" } });
    const marker = JSON.stringify({ packages: { exfatprogs: "1.2.2-1", smartmontools: "7.4-2build1" }, approvedAt });
    await expect(installApprovedDriveTools({ run: host.run, loadApproval: async () => marker, now })).rejects.toThrow("APT metadata for exfatprogs changed after approval");
    expect(host.calls.some(([binary]) => binary.endsWith("apt-get"))).toBe(false);
  });
});
