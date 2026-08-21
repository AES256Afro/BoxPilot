import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SambaPanel from "./SambaPanel";
import type { PendingOperation } from "./ApproveDialog";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const base = { installed: true, running: true, configured: true, error: null, config: { managed: true, workgroup: "WORKGROUP", scope: "tailscale", interfaces: ["lo", "tailscale0"], shares: [{ name: "Media", path: "/mnt/nas-media", comment: "Films", readOnly: true, guest: true, users: [], forceUser: "homebox" }] }, users: ["jamie"], tailscaleDnsName: "homebox.tail1234.ts.net", tailscaleAddress: "100.64.0.5", lanAddress: "192.168.1.10" };

function setup(state: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => (input.toString() === "/api/v1/storage/samba" ? json(state) : json({ error: "unexpected" }, 500))));
  const start = vi.fn<(operation: PendingOperation) => void>();
  render(<SambaPanel start={start} folders={["/mnt/nas-media", "/srv"]} refreshKey={0} />);
  return start;
}

describe("Samba panel", () => {
  it("offers to install Samba when it is missing", async () => {
    const start = setup({ ...base, installed: false, running: null, configured: false, config: { ...base.config, managed: false, shares: [] }, users: [] });
    fireEvent.click(await screen.findByRole("button", { name: "Install Samba" }));
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ operationId: "apt.install", parameters: { packages: ["samba"] } }));
  });

  it("shows live shares and the tailnet connect hint, and applies an edited share list", async () => {
    const start = setup(base);
    expect(await screen.findByText("Films", { exact: false })).toBeTruthy();
    expect(screen.getByText(/smb:\/\/homebox\.tail1234\.ts\.net\/Media/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Apply changes" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("New share name"), { target: { value: "Private" } });
    fireEvent.change(screen.getByLabelText("New share folder"), { target: { value: "/srv/private/" } });
    fireEvent.change(screen.getByLabelText("New share access"), { target: { value: "selected" } });
    fireEvent.click(screen.getByLabelText("Allow jamie"));
    fireEvent.click(screen.getByRole("button", { name: "Add share" }));
    expect(screen.getByText("Changes are not live until you apply.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "samba.apply",
      parameters: { workgroup: "WORKGROUP", scope: "tailscale", shares: [
        { name: "Media", path: "/mnt/nas-media", comment: "Films", readOnly: true, guest: true, users: [] },
        { name: "Private", path: "/srv/private", comment: null, readOnly: false, guest: false, users: ["jamie"] },
      ] },
    }));
  });

  it("switches scope to the LAN, adds users with an in-memory password, and removes shares", async () => {
    const start = setup(base);
    await screen.findByText("Films", { exact: false });
    fireEvent.click(screen.getByRole("radio", { name: /Tailscale \+ LAN/ }));
    fireEvent.change(screen.getByLabelText("New user name"), { target: { value: "Sam" } });
    fireEvent.change(screen.getByLabelText("New user password"), { target: { value: "long enough pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Add user" }));
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ operationId: "samba.user.set", parameters: { username: "sam", password: "long enough pw" } }));
    fireEvent.click(screen.getByRole("button", { name: "Remove jamie" }));
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ operationId: "samba.user.remove", parameters: { username: "jamie" } }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    await waitFor(() => expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ operationId: "samba.apply", parameters: { workgroup: "WORKGROUP", scope: "lan", shares: [] } })));
  });
});
