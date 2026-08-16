// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { initializeApprovedLibvirtFoundation, libvirtFoundationScriptInternals } from "./boxpilot-libvirt-foundation.mjs";

const foundationId = "123e4567-e89b-42d3-a456-426614174000";
const revision = "a".repeat(64);
const approval = JSON.stringify({ approvedAt: "2026-08-16T12:00:00.000Z", expectedRevision: revision, foundationId });
const before = {
  ready: false, planAvailable: true, revision, conflicts: [],
  network: { exists: false, active: false, autostart: false },
  pool: { exists: false, active: false, autostart: false, target: { exists: false } },
};

describe("fixed libvirt foundation initializer", () => {
  it("defines, starts, and enables only the fixed default resources", async () => {
    const inspector = { inspect: vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce({ ready: true }) };
    const run = vi.fn(async () => ({ ok: true, stdout: "", stderr: "" }));
    const writeNetworkXml = vi.fn();
    const result = await initializeApprovedLibvirtFoundation({
      run,
      inspector,
      loadApproval: async () => approval,
      now: () => new Date("2026-08-16T12:01:00.000Z"),
      createWorkspace: async () => "/tmp/boxpilot-foundation-test",
      writeNetworkXml,
      removeWorkspace: vi.fn(async () => {}),
      removeEmptyTarget: vi.fn(),
    });
    expect(result).toMatchObject({ foundationId, ready: true, changed: { networkDefined: true, networkStarted: true, networkAutostart: true, poolTargetCreated: true, poolDefined: true, poolStarted: true, poolAutostart: true } });
    expect(writeNetworkXml).toHaveBeenCalledWith("/tmp/boxpilot-foundation-test/default-network.xml");
    expect(run).toHaveBeenCalledWith("/usr/bin/virsh", ["--connect", "qemu:///system", "net-define", "/tmp/boxpilot-foundation-test/default-network.xml"], { timeout: 30000 });
    expect(run).toHaveBeenCalledWith("/usr/bin/virsh", ["--connect", "qemu:///system", "pool-define-as", "default", "dir", "--target", "/var/lib/libvirt/images"], { timeout: 30000 });
    expect(run.mock.calls.flatMap(([, args]) => args).join(" ")).not.toContain("undefine");
  });

  it("rolls back only changes made by the failed job in reverse order", async () => {
    const inspector = { inspect: vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce({ ready: false }) };
    const commands = [];
    const run = vi.fn(async (_binary, args) => { commands.push(args.slice(2).join(" ")); return { ok: true, stdout: "", stderr: "" }; });
    const removeEmptyTarget = vi.fn(async () => {});
    await expect(initializeApprovedLibvirtFoundation({
      run,
      inspector,
      loadApproval: async () => approval,
      now: () => new Date("2026-08-16T12:01:00.000Z"),
      createWorkspace: async () => "/tmp/boxpilot-foundation-test",
      writeNetworkXml: vi.fn(),
      removeWorkspace: vi.fn(async () => {}),
      removeEmptyTarget,
    })).rejects.toThrow("Automatic rollback completed");
    expect(commands.slice(-6)).toEqual([
      "pool-autostart default --disable", "pool-destroy default", "pool-undefine default",
      "net-autostart default --disable", "net-destroy default", "net-undefine default",
    ]);
    expect(removeEmptyTarget).toHaveBeenCalledTimes(1);
  });

  it("accepts only a fresh exact approval marker and no browser-selected resource", () => {
    expect(() => libvirtFoundationScriptInternals.parseApproval(approval, new Date("2026-08-16T12:01:00.000Z"))).not.toThrow();
    expect(() => libvirtFoundationScriptInternals.parseApproval(JSON.stringify({ ...JSON.parse(approval), pool: "custom" }), new Date("2026-08-16T12:01:00.000Z"))).toThrow("unexpected fields");
    expect(() => libvirtFoundationScriptInternals.parseApproval(approval, new Date("2026-08-16T13:01:00.000Z"))).toThrow("stale");
    expect(libvirtFoundationScriptInternals.networkXml).toContain("<name>default</name>");
    expect(libvirtFoundationScriptInternals.networkXml).toContain("192.168.122.1");
  });
});
