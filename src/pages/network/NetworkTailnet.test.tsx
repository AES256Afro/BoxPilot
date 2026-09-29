import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import NetworkPage from "./NetworkPage";
import { mockFetch, now, tailnet, topology } from "./testData";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });
const openTailnet = () => window.history.replaceState(null, "", "/?view=network&tab=tailnet");

describe("the Network page's Tailnet tab", () => {
  it("offers the exit node and the subnet router as one tailscale.set, with its tier", async () => {
    const staged: Record<string, unknown> = {};
    openTailnet();
    mockFetch({}, staged);
    render(<NetworkPage csrfToken="csrf" now={now} />);
    const panel = await screen.findByRole("region", { name: "Tailscale" });
    await within(panel).findByText("homebox.example.ts.net", { selector: ".ui-kv__value" });
    const apply = within(panel).getByRole("button", { name: "Apply" });
    expect(apply.getAttribute("data-risk")).toBe("medium");
    expect((apply as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(panel).getByLabelText(/exit node/));
    fireEvent.click(within(panel).getByLabelText(/subnet router/));
    fireEvent.click(apply);
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    expect(screen.getByText(/--advertise-routes=192\.168\.1\.0\/24/)).toBeTruthy();
    await waitFor(() => expect(staged["tailscale.set"]).toEqual({ parameters: { exitNode: true, subnetRouter: true } }));
  });

  it("says what is offered and what still waits for approval in the admin console", async () => {
    openTailnet();
    mockFetch({ "/api/v1/network/topology": { ...topology, tailscale: { ...topology.tailscale, exitNodeAdvertised: true, advertisedRoutes: ["192.168.1.0/24"], approvedRoutes: [] } } });
    render(<NetworkPage csrfToken="csrf" now={now} />);
    expect(await screen.findByText("waiting for approval: 192.168.1.0/24")).toBeTruthy();
    expect((screen.getByLabelText(/exit node/) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("link", { name: "Approve in the Tailscale admin console" })).toBeTruthy();
  });

  it("says the server is not on a tailnet, and leaves the options off", async () => {
    openTailnet();
    mockFetch({
      "/api/v1/network/topology": { ...topology, tailscale: { ...topology.tailscale, connected: false, dnsName: null, address: null } },
      "/api/v1/network/tailnet": { available: false, connected: false, self: null, peers: [] },
    });
    render(<NetworkPage csrfToken="csrf" now={now} />);
    expect(await screen.findByText("Not on a tailnet")).toBeTruthy();
    expect((screen.getByLabelText(/exit node/) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("Tailscale is not on this server")).toBeTruthy();
  });

  it("lists every device with how it is reached, and leaves the options out for a viewer", async () => {
    openTailnet();
    mockFetch();
    render(<NetworkPage csrfToken="csrf" role="viewer" now={now} />);
    const table = await screen.findByRole("table", { name: "Every device on your tailnet" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("homebox"),
      expect.stringContaining("Direct"),
      expect.stringContaining("last seen 3 hours ago"),
    ]);
    expect(screen.getByText(`2 of ${1 + tailnet.peers.length} online`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  });
});
