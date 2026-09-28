import { describe, expect, it, vi } from "vitest";
import { buildChecklist, gatherChecklistEvidence } from "./setup-checklist.mjs";
import { invalidateOperationEvidence } from "./diagnostic-invalidation.mjs";
import { gatherDriveChecks } from "./drive-checks.mjs";
import { createStorageReader } from "./storage-inventory.mjs";

describe("setup checklist", () => {
  it("counts the essentials and explains each item", () => {
    // Nothing answered: every essential except backups is unknown rather than "not set up", so it
    // is left out of the count instead of being held against the owner.
    const empty = buildChecklist({});
    expect(empty).toMatchObject({ total: 1, done: 0, unknown: 5, allEssentialDone: false });
    const answered = buildChecklist({ tailscale: { connected: false }, firewall: { enabled: false }, unattended: { enabled: false }, notifications: { configured: false }, driveChecks: { missingPackages: ["exfatprogs"], disksKnown: true, disks: [] } });
    expect(answered).toMatchObject({ total: 6, done: 0, unknown: 0 });
    expect(empty.items.map((item) => [item.id, item.optional])).toEqual([["tailscale", false], ["firewall", false], ["updates", false], ["notifications", false], ["backups", false], ["drive-checks", false], ["dns", true], ["shares", true], ["ups", true]]);
    const full = buildChecklist({
      tailscale: { connected: true, dnsName: "homebox.tail1234.ts.net" },
      firewall: { enabled: true }, firewallProfile: { id: "home-server", appliedAt: "2026-08-21T15:00:00Z" },
      unattended: { enabled: true }, notifications: { configured: true, kind: "ntfy" },
      cloudDestination: { provider: "b2", lastSync: "2026-08-21T02:00:00Z" },
      driveChecks: { missingPackages: [], disksKnown: true, disks: [] },
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
    const smart = { available: true, stale: false, disks: [] };
    const driveChecks = vi.fn(async ({ smart: reading }) => ({ tools: { smartctl: true, fsckExfat: true }, missingPackages: [], disksKnown: true, disks: [], smartSeen: await reading }));
    const evidence = await gatherChecklistEvidence({ state, helper, notifications: { describe: () => ({ configured: true, kind: "ntfy" }) }, inventory: { inspect: async () => ({ power: { ups: { configured: false } }, network: { tailscale: { connected: true, dnsName: "x" } }, storage: { smart } }) }, network: null, driveChecks });
    expect(evidence).toMatchObject({ firewall: { enabled: true }, firewallProfile: { id: "home-server" }, installedApps: ["pi-hole"], notifications: { configured: true }, unattended: null, tailscale: { connected: true } });
    // The drive item is handed the inventory's own SMART reading rather than reading it again.
    expect(evidence.driveChecks).toMatchObject({ missingPackages: [], smartSeen: smart });
    const list = buildChecklist(evidence);
    expect(list.done).toBe(4); // tailscale, firewall, notifications, drive checks
    expect(list.unknown).toBe(1); // automatic updates: the helper was busy, so nothing is claimed
    expect(list.total).toBe(5);
    // A drive reader that fails leaves the item unknown, not "not set up".
    const failing = await gatherChecklistEvidence({ state, helper, notifications: null, inventory: null, network: null, driveChecks: async () => { throw new Error("lsblk failed"); } });
    expect(buildChecklist(failing).items.find((item) => item.id === "drive-checks")).toMatchObject({ known: false, done: false });
  });

  it("runs lsblk and findmnt once for Overview loads within ten seconds, and again once an operation settles", async () => {
    let clock = 0;
    const collect = vi.fn(async () => ({ devices: [], mounts: [], fstab: [], availability: { devices: true, mounts: true, fstab: true } }));
    const storage = createStorageReader({ collect, now: () => clock });
    const helper = { request: async () => ({}), invalidate: vi.fn() };
    const inventory = { inspect: async () => ({ storage: { smart: null } }), forget: vi.fn() };
    const driveChecks = (options) => gatherDriveChecks({ ...options, detect: async () => ({ smartctl: true, fsckExfat: true }) });
    const load = () => gatherChecklistEvidence({ state: { getSetting: () => null }, helper, notifications: null, inventory, network: null, storage, driveChecks });
    const [first] = await Promise.all([load(), load()]);
    await load();
    expect(collect).toHaveBeenCalledTimes(1);
    expect(first.driveChecks).toMatchObject({ disksKnown: true, missingPackages: [] });
    // A mount the owner just ran is on the next load, not ten seconds later.
    invalidateOperationEvidence({ type: "op:storage.mount" }, { registry: { get: () => ({ readOnly: false }) }, inventory, prerequisites: { forget: vi.fn() }, helper, storage });
    await load();
    expect(collect).toHaveBeenCalledTimes(2);
    // And a drive plugged in with no operation at all is on a load ten seconds on.
    clock += 10_001;
    await load();
    expect(collect).toHaveBeenCalledTimes(3);
  });
});

describe("the drive checks item (M26.3)", () => {
  const item = (driveChecks) => buildChecklist({ driveChecks }).items.find((entry) => entry.id === "drive-checks");
  const disk = (targets, smart) => ({ device: `/dev/sd${targets.length}`, model: null, targets, smart });

  it("is not done while a tool is missing, and links to Repair where the fix is", () => {
    expect(item({ missingPackages: ["exfatprogs", "smartmontools"], disksKnown: true, disks: [] })).toMatchObject({ title: "This server can check its drives", view: "repairs", optional: false, known: true, done: false, detail: expect.stringMatching(/^Install smartmontools and exfatprogs: smartctl reads each disk's SMART health, and fsck\.exfat checks an exFAT drive/) });
    expect(item({ missingPackages: ["exfatprogs"], disksKnown: true, disks: [] })).toMatchObject({ known: true, done: false, detail: "fsck.exfat is not installed, so an exFAT drive cannot be checked after it drops off. Installing exfatprogs adds it and changes nothing on the drives." });
    expect(item({ missingPackages: ["smartmontools"], disksKnown: true, disks: [] })).toMatchObject({ known: true, done: false, detail: expect.stringContaining("smartctl is not installed") });
    // A missing tool is known without the drive list: the item is not done either way.
    expect(item({ missingPackages: ["exfatprogs"], disksKnown: false, disks: [] })).toMatchObject({ known: true, done: false });
  });

  it("is done when both tools are here and every USB drive answers, directly or through its bridge", () => {
    expect(item({ missingPackages: [], disksKnown: true, disks: [] })).toMatchObject({ known: true, done: true, detail: "smartctl reads each disk's SMART health and fsck.exfat can check an exFAT drive." });
    expect(item({ missingPackages: [], disksKnown: true, disks: [disk(["/mnt/media"], "answers-through-bridge")] }).detail).toBe("smartctl reads each disk's SMART health and fsck.exfat can check an exFAT drive. SMART reaches the USB drive at /mnt/media, through its USB bridge.");
    expect(item({ missingPackages: [], disksKnown: true, disks: [disk(["/mnt/media"], "answers"), disk(["/mnt/a", "/mnt/b"], "answers-through-bridge")] }).detail).toContain("SMART reaches the USB drives at /mnt/media, /mnt/a and /mnt/b (/mnt/a and /mnt/b through its USB bridge).");
    expect(item({ missingPackages: [], disksKnown: true, disks: [{ ...disk(["/mnt/a"], "answers-through-bridge"), device: "/dev/sdb" }, { ...disk(["/mnt/b"], "answers-through-bridge"), device: "/dev/sdc" }] }).detail).toContain("SMART reaches the USB drives at /mnt/a and /mnt/b, through their USB bridges.");
  });

  it("says an enclosure that passes no SMART through is the enclosure's limit, and does not hold the item open", () => {
    const result = item({ missingPackages: [], disksKnown: true, disks: [disk(["/mnt/media"], "answers"), disk(["/mnt/backup"], "bridge-unsupported")] });
    expect(result).toMatchObject({ known: true, done: true });
    expect(result.detail).toContain("SMART reaches the USB drive at /mnt/media.");
    expect(result.detail).toContain("The USB enclosure holding /mnt/backup does not pass SMART through, so that disk's health cannot be read from this server. That is a limit of the enclosure; a different one, or connecting the disk directly, would report it.");
  });

  it("is unknown, not failed, while a USB drive has no current reading or the drives cannot be listed", () => {
    expect(item({ missingPackages: [], disksKnown: true, disks: [disk(["/mnt/media"], "unread")] })).toMatchObject({ known: false, done: false, detail: expect.stringContaining("no reading for the USB drive at /mnt/media yet") });
    expect(item({ missingPackages: [], disksKnown: false, disks: [] })).toMatchObject({ known: false, done: false });
    expect(item(null)).toMatchObject({ known: false, done: false });
  });
});

describe("the notifications item speaks to what is actually installed", () => {
  it("tells an owner with ntfy running to connect it, not to install it again", () => {
    const { items } = buildChecklist({ notifications: { configured: false }, installedApps: ["ntfy", "jellyfin"] });
    const item = items.find((entry) => entry.id === "notifications");
    expect(item.done).toBe(false);
    expect(item.detail).toMatch(/ntfy is already running.*connect BoxPilot to it/);
    const bare = buildChecklist({ notifications: { configured: false }, installedApps: [] }).items.find((entry) => entry.id === "notifications");
    expect(bare.detail).toMatch(/Install ntfy or Gotify/);
  });
});
