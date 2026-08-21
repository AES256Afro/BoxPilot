import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import UpsPanel from "./UpsPanel";
import type { PendingOperation } from "./ApproveDialog";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const apc = { vendorId: "051d", productId: "0002", manufacturer: "American Power Conversion", product: "Back-UPS ES 700G", driver: "usbhid-ups", confidence: "vendor-id", sysfs: "1-2" };

describe("UPS panel", () => {
  it("explains when nothing is found", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ devices: [], nutInstalled: false })));
    render(<UpsPanel start={vi.fn()} />);
    expect(await screen.findByText(/No UPS found on USB/)).toBeTruthy();
  });

  it("offers to install NUT, then sets up the detected UPS with the chosen shutdown behaviour", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ devices: [apc], nutInstalled: false })));
    const start = vi.fn<(operation: PendingOperation) => void>();
    render(<UpsPanel start={start} />);
    fireEvent.click(await screen.findByRole("button", { name: "Install NUT first" }));
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ operationId: "apt.install", parameters: { packages: ["nut"] } }));
    cleanup();

    vi.stubGlobal("fetch", vi.fn(async () => json({ devices: [apc], nutInstalled: true })));
    const start2 = vi.fn<(operation: PendingOperation) => void>();
    render(<UpsPanel start={start2} />);
    expect(await screen.findByText(/American Power Conversion Back-UPS ES 700G/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/shut this server down/));
    fireEvent.click(screen.getByRole("button", { name: "Set up monitoring" }));
    expect(start2).toHaveBeenCalledWith(expect.objectContaining({ operationId: "ups.setup", parameters: { driver: "usbhid-ups", vendorId: "051d", productId: "0002", description: "American Power Conversion Back-UPS ES 700G", shutdownAtLowBattery: false } }));
  });
});
