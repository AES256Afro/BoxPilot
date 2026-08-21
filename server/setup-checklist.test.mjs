import { describe, expect, it, vi } from "vitest";
import { buildChecklist, gatherChecklistEvidence } from "./setup-checklist.mjs";

describe("setup checklist", () => {
  it("counts the essentials and explains each item", () => {
    const empty = buildChecklist({});
    expect(empty.total).toBe(5);
    expect(empty.done).toBe(0);
    expect(empty.items.map((item) => [item.id, item.optional])).toEqual([["tailscale", false], ["firewall", false], ["updates", false], ["notifications", false], ["backups", false], ["dns", true], ["shares", true], ["ups", true]]);
    const full = buildChecklist({
      tailscale: { connected: true, dnsName: "homebox.tail1234.ts.net" },
      firewall: { enabled: true }, firewallProfile: { id: "home-server", appliedAt: "2026-08-21T15:00:00Z" },
      unattended: { enabled: true }, notifications: { configured: true, kind: "ntfy" }, cloudDestination: { provider: "b2" },
      installedApps: ["pi-hole", "jellyfin"], samba: { configured: true }, ups: { configured: true },
    });
    expect(full.allEssentialDone).toBe(true);
    expect(full.items.every((item) => item.done)).toBe(true);
    expect(full.items.find((item) => item.id === "firewall").detail).toContain("home-server");
    const partial = buildChecklist({ firewall: { enabled: true }, backupDestination: { host: "nas" } });
    expect(partial.items.find((item) => item.id === "firewall")).toMatchObject({ done: false, detail: expect.stringContaining("apply a profile") });
    expect(partial.items.find((item) => item.id === "backups")).toMatchObject({ done: true, detail: "Mirroring over SSH to nas." });
  });

  it("gathers evidence from the helper and settings, tolerating failures", async () => {
    const helper = { request: vi.fn(async (id) => {
      if (id === "firewall.inspect") return { installed: true, enabled: true };
      if (id === "app.inspect") return { applications: [{ id: "pi-hole", installed: true }, { id: "jellyfin", installed: false }] };
      if (id === "apt.unattended.inspect") throw new Error("helper busy");
      return { configured: false };
    }) };
    const state = { getSetting: (key) => (key === "firewallProfile" ? { id: "home-server" } : null) };
    const evidence = await gatherChecklistEvidence({ state, helper, notifications: { describe: () => ({ configured: true, kind: "ntfy" }) }, inventory: { inspect: async () => ({ power: { ups: { configured: false } }, network: { tailscale: { connected: true, dnsName: "x" } } }) }, network: null });
    expect(evidence).toMatchObject({ firewall: { enabled: true }, firewallProfile: { id: "home-server" }, installedApps: ["pi-hole"], notifications: { configured: true }, unattended: null, tailscale: { connected: true } });
    const list = buildChecklist(evidence);
    expect(list.done).toBe(3); // tailscale, firewall, notifications
  });
});
