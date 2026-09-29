import { describe, expect, it } from "vitest";
import type { SmartDiskFact, SmartFacts, UpsFact } from "./facts";
import { checklistSummary, diskDetail, diskHealth, serviceState, smartSummary, smartUnreadReason, upsSummary } from "./hostFacts";

const disk = (extra: Partial<SmartDiskFact> = {}): SmartDiskFact => ({ device: "/dev/sda", health: "healthy", temperature: 40, wear: 3, mediaErrors: 0, reason: null, viaBridge: false, lastHealth: null, lastReadAt: null, ...extra });
const smart = (disks: SmartDiskFact[], extra: Partial<SmartFacts> = {}): SmartFacts => ({ available: true, status: "healthy", reason: "", readAt: "2026-09-29T08:00:00Z", stale: false, disks, ...extra });
const ups = (extra: Partial<UpsFact> = {}): UpsFact => ({ installed: true, configured: true, available: true, state: "online", reason: "ok", charge: 100, runtimeSeconds: 2400, load: 20, tokens: ["OL"], ...extra });

describe("what the Classic overview said, as statuses", () => {
  it("never calls a drive healthy that was not read", () => {
    expect(diskHealth(disk())).toEqual({ status: "good", label: "healthy" });
    expect(diskHealth(disk({ health: "unavailable", reason: "usb-bridge-unsupported" }))).toEqual({ status: "unknown", label: "no SMART" });
    expect(diskHealth(disk({ health: "unavailable", reason: "asleep", lastHealth: "healthy" }))).toEqual({ status: "unknown", label: "asleep, not read" });
    expect(diskHealth(disk({ health: "warning" })).status).toBe("warning");
    expect(diskHealth(disk({ health: "critical" })).status).toBe("danger");
    expect(diskDetail(disk({ viaBridge: true, wear: null, mediaErrors: 1 }))).toBe("40°C · 1 media error · read through its USB bridge");
    expect(diskDetail(disk({ reason: "asleep", lastHealth: "healthy" }))).toBe("Asleep at the last check; last read awake: healthy");
  });

  it("sums the drives: the worst first, and not known when any could not be read", () => {
    expect(smartSummary(smart([disk(), disk({ device: "/dev/sdb" })]))).toEqual({ status: "good", label: "2 healthy" });
    expect(smartSummary(smart([disk(), disk({ device: "/dev/sdc", health: "unavailable", reason: "usb-bridge-unsupported" })]))).toEqual({ status: "unknown", label: "1 of 2 read" });
    expect(smartSummary(smart([disk(), disk({ health: "critical" })]))).toEqual({ status: "danger", label: "1 failing" });
    expect(smartSummary(smart([disk()], { stale: true })).status).toBe("warning");
    expect(smartSummary(null).status).toBe("unknown");
    expect(smartSummary(smart([], { available: false })).status).toBe("unknown");
    expect(smartUnreadReason(smart([], { available: false, readAt: null }))).toMatch(/Install smartmontools/);
  });

  it("says what the UPS is doing, and that none is set up rather than that it is fine", () => {
    expect(upsSummary(ups())).toMatchObject({ status: "good", label: "on mains" });
    expect(upsSummary(ups({ state: "on-battery" })).status).toBe("warning");
    expect(upsSummary(ups({ state: "low-battery" })).status).toBe("danger");
    expect(upsSummary(ups({ configured: false, available: false, state: "unavailable", reason: "no-local-ups-configured" }))).toMatchObject({ status: "neutral", label: "not set up" });
    expect(upsSummary(ups({ available: false, state: "unavailable" }))).toMatchObject({ status: "warning", label: "not answering" });
    expect(upsSummary(null).status).toBe("unknown");
  });

  it("reads a service's state and counts the essentials", () => {
    expect(serviceState({ unit: "ssh.service", active: "active", sub: "running", enabled: "enabled" })).toEqual({ status: "good", label: "running" });
    expect(serviceState({ unit: "x.service", active: "failed", sub: "failed", enabled: "enabled" }).status).toBe("danger");
    const items = [
      { id: "a", title: "A", detail: "", done: true, optional: false, view: "backups" as const },
      { id: "b", title: "B", detail: "", done: false, known: false, optional: false, view: "firewall" as const },
      { id: "c", title: "C", detail: "", done: false, optional: true, view: "network" as const },
    ];
    expect(checklistSummary({ items, done: 1, total: 3 })).toEqual({ status: "unknown", label: "1/2" });
    expect(checklistSummary({ items: items.map((item) => ({ ...item, done: true })), done: 3, total: 3 })).toEqual({ status: "good", label: "2/2" });
    expect(checklistSummary(null).status).toBe("unknown");
  });
});
