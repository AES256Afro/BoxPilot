import { describe, expect, it, vi } from "vitest";
import { buildChecklist, gatherChecklistEvidence } from "./setup-checklist.mjs";

describe("setup checklist", () => {
  it("counts the essentials and explains each item", () => {
    // Nothing answered: every essential except backups is unknown rather than "not set up", so it
    // is left out of the count instead of being held against the owner.
    const empty = buildChecklist({});
    expect(empty).toMatchObject({ total: 1, done: 0, unknown: 4, allEssentialDone: false });
    const answered = buildChecklist({ tailscale: { connected: false }, firewall: { enabled: false }, unattended: { enabled: false }, notifications: { configured: false } });
    expect(answered).toMatchObject({ total: 5, done: 0, unknown: 0 });
    expect(empty.items.map((item) => [item.id, item.optional])).toEqual([["tailscale", false], ["firewall", false], ["updates", false], ["notifications", false], ["backups", false], ["dns", true], ["shares", true], ["ups", true]]);
    const full = buildChecklist({
      tailscale: { connected: true, dnsName: "homebox.tail1234.ts.net" },
      firewall: { enabled: true }, firewallProfile: { id: "home-server", appliedAt: "2026-08-21T15:00:00Z" },
      unattended: { enabled: true }, notifications: { configured: true, kind: "ntfy" },
      cloudDestination: { provider: "b2", lastSync: "2026-08-21T02:00:00Z" },
      installedApps: ["pi-hole", "jellyfin"], samba: { configured: true, running: true }, ups: { configured: true },
    });
    expect(full.allEssentialDone).toBe(true);
    expect(full.items.every((item) => item.done)).toBe(true);
    expect(full.items.find((item) => item.id === "firewall").detail).toContain("home-server");
    const partial = buildChecklist({ firewall: { enabled: true }, backupDestination: { host: "nas" }, samba: { configured: true, running: false } });
    expect(partial.items.find((item) => item.id === "firewall")).toMatchObject({ done: false, detail: expect.stringContaining("apply a profile") });
    // A destination that has never mirrored is not a copy of anything.
    expect(partial.items.find((item) => item.id === "backups")).toMatchObject({ done: false, detail: expect.stringContaining("nothing has been mirrored to it yet") });
    // Neither is a share nothing is serving.
    expect(partial.items.find((item) => item.id === "shares")).toMatchObject({ done: false, detail: expect.stringContaining("not running") });
    const mirrored = buildChecklist({ backupDestination: { host: "nas", lastSync: "2026-08-20T02:00:00Z" } });
    expect(mirrored.items.find((item) => item.id === "backups")).toMatchObject({ done: true, detail: expect.stringContaining("nas") });
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
    expect(list.unknown).toBe(1); // automatic updates: the helper was busy, so nothing is claimed
    expect(list.total).toBe(4);
  });
});
