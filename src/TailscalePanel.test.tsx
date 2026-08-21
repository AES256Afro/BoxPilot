import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TailscalePanel from "./TailscalePanel";
import type { PendingOperation } from "./ApproveDialog";

afterEach(() => cleanup());

describe("Tailscale panel", () => {
  it("offers exit node and subnet router and stages tailscale.set", () => {
    const start = vi.fn<(operation: PendingOperation) => void>();
    render(<TailscalePanel start={start} tailscale={{ connected: true, dnsName: "homebox.tail1234.ts.net", address: "100.64.0.5", exitNodeAdvertised: false, advertisedRoutes: [], approvedRoutes: [], lanSubnets: ["192.168.1.0/24"] }} />);
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/exit node/));
    fireEvent.click(screen.getByLabelText(/subnet router/));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ operationId: "tailscale.set", parameters: { exitNode: true, subnetRouter: true } }));
  });

  it("shows what is offered and what still needs approval, and disables the toggles when offline", () => {
    render(<TailscalePanel start={vi.fn()} tailscale={{ connected: true, dnsName: "homebox.tail1234.ts.net", exitNodeAdvertised: true, advertisedRoutes: ["192.168.1.0/24"], approvedRoutes: [], lanSubnets: ["192.168.1.0/24"] }} />);
    expect(screen.getByText(/waiting for approval: 192\.168\.1\.0\/24/)).toBeTruthy();
    expect((screen.getByLabelText(/exit node/) as HTMLInputElement).checked).toBe(true);
    cleanup();
    render(<TailscalePanel start={vi.fn()} tailscale={{ connected: false, dnsName: null, lanSubnets: ["192.168.1.0/24"] }} />);
    expect((screen.getByLabelText(/exit node/) as HTMLInputElement).disabled).toBe(true);
  });
});
