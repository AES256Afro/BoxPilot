import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import NetworkPage from "./NetworkPage";
import { mockFetch, now } from "./testData";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });

const inspect = "/api/v1/operations/router.inspect/inspect";
const leases = "/api/v1/operations/router.leases/inspect";
const connected = { configured: true, reachable: true, host: "192.168.1.1", username: "root", model: "Example router", firmware: "4.7.0", reason: null };

function openRouter(report: unknown, extra: Record<string, unknown> = {}, staged: Record<string, unknown> = {}, role = "owner") {
  window.history.replaceState(null, "", "/?view=network&tab=router");
  const fetchMock = mockFetch({ [inspect]: { operation: "router.inspect", result: report }, ...extra }, staged);
  render(<NetworkPage csrfToken="csrf" role={role} now={now} />);
  return fetchMock;
}

describe("the Network page's Router tab", () => {
  it("shows the connected router and the devices it has handed addresses to", async () => {
    openRouter(connected, { [leases]: { operation: "router.leases", result: { host: "192.168.1.1", leases: [
      { name: "homebox", address: "192.168.1.10", mac: "aa:bb:cc:dd:ee:02", online: true, reserved: true },
      { name: null, address: "192.168.1.51", mac: null, online: false, reserved: false },
    ] } } });
    const router = await screen.findByRole("region", { name: "Router" });
    expect(await within(router).findByText("Example router")).toBeTruthy();
    const table = await screen.findByRole("table", { name: "Devices your router has given addresses to" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows[0].textContent).toContain("reserved");
    expect(rows[1].textContent).toContain("unnamed");
    expect(rows[1].textContent).toContain("offline");
    expect(rows[1].textContent).toContain("from the pool");
  });

  it("connects a router from a sheet, with the gateway filled in and the password cleared after", async () => {
    const staged: Record<string, unknown> = {};
    openRouter({ configured: false, reachable: false, host: null, username: null, model: null, firmware: null, reason: "No router is connected yet." }, {}, staged);
    fireEvent.click(await screen.findByRole("button", { name: "Connect the router…" }));
    const sheet = await screen.findByRole("dialog", { name: "Connect the router" });
    expect((within(sheet).getByLabelText("Router address") as HTMLInputElement).value).toBe("192.168.1.1");
    const connect = within(sheet).getByRole("button", { name: "Connect" });
    expect(connect.getAttribute("data-risk")).toBe("medium");
    expect((connect as HTMLButtonElement).disabled).toBe(true);
    expect(within(sheet).getByText("Enter the router's admin password.")).toBeTruthy();
    const password = within(sheet).getByLabelText("Router password") as HTMLInputElement;
    expect(password.type).toBe("password");
    fireEvent.change(password, { target: { value: "placeholder-pass" } });
    // The control the server's error names when the account is not root (server/tasks/router.mjs).
    fireEvent.click(within(sheet).getByRole("button", { name: "This router asks for a username too" }));
    fireEvent.change(within(sheet).getByLabelText("Username"), { target: { value: "admin" } });
    fireEvent.click(connect);
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    await waitFor(() => expect(staged["router.connect"]).toEqual({ parameters: { kind: "glinet", host: "192.168.1.1", username: "admin", password: "placeholder-pass" } }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(await screen.findByRole("button", { name: "Connect the router…" }));
    expect((within(await screen.findByRole("dialog", { name: "Connect the router" })).getByLabelText("Router password") as HTMLInputElement).value).toBe("");
  });

  it("says when a router connected before is not answering, and offers to connect again", async () => {
    openRouter({ configured: true, reachable: false, host: "192.168.1.1", username: "root", model: null, firmware: null, reason: "The router did not accept that password." });
    expect(await screen.findByText("The router is not answering")).toBeTruthy();
    expect(screen.getByText(/did not accept that password/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect again…" })).toBeTruthy();
  });

  it("lets an operator read the router but not connect one, and tells a viewer who reads it", async () => {
    openRouter({ configured: false, reachable: false, host: null, username: null, model: null, firmware: null, reason: null }, {}, {}, "operator");
    expect(await screen.findByText("No router connected")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect the router…" })).toBeNull();
    cleanup();
    const fetchMock = openRouter(connected, {}, {}, "viewer");
    expect(await screen.findByText("Reading the router needs an operator")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("router.inspect"))).toBe(false);
  });
});
