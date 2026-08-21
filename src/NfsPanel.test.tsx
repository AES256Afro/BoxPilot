import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import NfsPanel from "./NfsPanel";
import type { PendingOperation } from "./ApproveDialog";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const base = { installed: true, running: true, configured: true, error: null, config: { managed: true, scope: "tailscale", exports: [{ path: "/srv/media", readOnly: true, clients: ["100.64.0.0/10"] }] }, tailscaleDnsName: "homebox.tail1234.ts.net", tailscaleAddress: "100.64.0.5", lanAddress: "192.168.1.10" };
function setup(state: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => (input.toString() === "/api/v1/storage/nfs" ? json(state) : json({ error: "unexpected" }, 500))));
  const start = vi.fn<(operation: PendingOperation) => void>();
  render(<NfsPanel start={start} folders={["/srv/media"]} refreshKey={0} />);
  return start;
}

describe("NFS panel", () => {
  it("offers to install the NFS server when missing", async () => {
    const start = setup({ ...base, installed: false, running: null, configured: false, config: { managed: false, scope: "tailscale", exports: [] } });
    fireEvent.click(await screen.findByRole("button", { name: "Install NFS server" }));
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ operationId: "apt.install", parameters: { packages: ["nfs-kernel-server"] } }));
  });

  it("shows exports with mount hints and applies an edited list with LAN scope", async () => {
    const start = setup(base);
    expect(await screen.findByText("/srv/media")).toBeTruthy();
    expect(screen.getByText(/nfs:\/\/homebox\.tail1234\.ts\.net\/srv\/media/)).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /Tailscale \+ LAN/ }));
    fireEvent.change(screen.getByLabelText("New export folder"), { target: { value: "/srv/shared/" } });
    fireEvent.click(screen.getByRole("button", { name: "Add export" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ operationId: "nfs.apply", parameters: { scope: "lan", exports: [{ path: "/srv/media", readOnly: true }, { path: "/srv/shared", readOnly: false }] } }));
  });
});
