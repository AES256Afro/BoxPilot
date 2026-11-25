import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DriveHealthPanel, errorWords, wearWords, type SmartTrend } from "./DriveHealthPanel";
import type { DriveHealth } from "./types";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const sample = (day: number, temperatureCelsius: number | null, percentageUsed: number | null, mediaErrors: number | null) => ({ at: `2026-10-${String(day).padStart(2, "0")}T06:00:00Z`, temperatureCelsius, percentageUsed, mediaErrors });

const wearing: SmartTrend = { device: "/dev/nvme0n1", days: 20, wearChange: 3, errorChange: 0, samples: [sample(1, 40, 11, 0), sample(10, 44, 12, 0), sample(21, 47, 14, 0)] };
const failing: SmartTrend = { device: "/dev/sdb", days: 9, wearChange: null, errorChange: 5, samples: [sample(8, 35, null, 2), sample(17, 36, null, 7)] };

describe("drive health over time (M31.2)", () => {
  it("says wear with how far it moved, and a rising error count as the danger it is", () => {
    expect(wearWords(wearing)).toBe("14%, up 3 in 20 days");
    expect(wearWords(failing)).toBe("—");
    expect(wearWords({ ...wearing, wearChange: 0 })).toBe("14%, steady");
    expect(errorWords(failing)).toEqual({ text: "7, up 5 in 9 days", status: "danger" });
    expect(errorWords(wearing)).toEqual({ text: "none", status: "good" });
    expect(errorWords({ ...failing, errorChange: 0 })).toEqual({ text: "7, not rising", status: "warning" });
  });

  it("lists each drive from the sampler's history, with its temperature drawn as a line", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ disks: [wearing, failing] })));
    render(<DriveHealthPanel />);
    const table = await screen.findByRole("table", { name: "Each drive's SMART readings over time" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("nvme0n1");
    expect(rows[0].textContent).toContain("47°C");
    expect(rows[0].querySelector("svg")).toBeTruthy();
    expect(rows[1].textContent).toContain("7, up 5 in 9 days");
  });

  it("says when there is nothing yet, and when the history could not be read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ disks: [] })));
    render(<DriveHealthPanel />);
    expect(await screen.findByText(/No readings yet/)).toBeTruthy();
    cleanup();
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "down" }, 503)));
    render(<DriveHealthPanel />);
    expect(await screen.findByText("The drive history could not be read.")).toBeTruthy();
  });

  it("shows each drive's health, red for a SATA disk SMART calls FAILED, and its bad sectors by kind (M91)", async () => {
    const reading = (device: string, extra: Partial<DriveHealth>): DriveHealth => ({ device, health: "healthy", reason: "ok", passed: true, temperatureCelsius: 36, percentageUsed: null, mediaErrors: null, ataErrors: null, lastHealth: null, ...extra });
    const dying = reading("/dev/sdb", { health: "critical", mediaErrors: 585, ataErrors: { reallocated: 360, reportedUncorrectable: 0, pending: 225, offlineUncorrectable: 0, notSectorCounts: [] } });
    const failed = reading("/dev/sdc", { health: "critical", passed: false });
    const passFail = reading("/dev/sdd", { temperatureCelsius: null });
    vi.stubGlobal("fetch", vi.fn(async () => json({ disks: [failing] })));
    render(<DriveHealthPanel health={[dying, failed, passFail]} mountsOf={(device) => (device === "/dev/sdb" ? ["/mnt/backup"] : [])} />);
    const table = await screen.findByRole("table", { name: "Each drive's SMART readings over time" });
    await waitFor(() => expect(within(table).getAllByRole("row").slice(1)).toHaveLength(3));
    const row = (name: string) => within(table).getAllByRole("row").find((entry) => entry.textContent?.includes(name)) as HTMLElement;
    // The backup drive is found by its mount, and its bad sectors are named.
    expect(row("sdb").textContent).toContain("/mnt/backup");
    expect(row("sdb").textContent).toContain("225 unreadable · 360 remapped");
    expect(within(row("sdb")).getByText("failing").closest(".ui-chip")?.getAttribute("data-status")).toBe("danger");
    // SMART said FAILED with no figures moving: still red, never a neutral dash.
    expect(within(row("sdc")).getByText("failing").closest(".ui-chip")?.getAttribute("data-status")).toBe("danger");
    expect(row("sdc").getAttribute("data-status")).toBe("danger");
    // A drive that answers only pass or fail says so, rather than waiting for figures that never come.
    expect(row("sdd").textContent).toContain("reports pass/fail only");
    expect(row("sdd").textContent).toContain("not yet");
  });

  it("does not count an MX500's attribute 197 (Current_Pending_ECC_Cnt) as an unreadable sector", async () => {
    const mx500: DriveHealth = { device: "/dev/sda", health: "healthy", reason: "ok", passed: true, temperatureCelsius: 33, percentageUsed: null, mediaErrors: 0, lastHealth: null, ataErrors: { reallocated: 0, reportedUncorrectable: 0, pending: 1, offlineUncorrectable: 0, notSectorCounts: ["pending"] } };
    vi.stubGlobal("fetch", vi.fn(async () => json({ disks: [] })));
    render(<DriveHealthPanel health={[mx500]} mountsOf={() => []} />);
    const table = await screen.findByRole("table", { name: "Each drive's SMART readings over time" });
    await waitFor(() => expect(within(table).getAllByRole("row").slice(1)).toHaveLength(1));
    expect(within(table).getAllByRole("row")[1].textContent).toContain("0 unreadable · 0 remapped");
  });
});
