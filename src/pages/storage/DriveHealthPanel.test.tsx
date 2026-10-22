import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DriveHealthPanel, errorWords, wearWords, type SmartTrend } from "./DriveHealthPanel";

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
});
