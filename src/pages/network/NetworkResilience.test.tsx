import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import NetworkPage from "./NetworkPage";
import { mockFetch, now, resilience, singlePoint, unproven } from "./testData";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });

const route = "/api/v1/network/dns-resilience";

function open(tab: "overview" | "dns", answer: unknown, { role = "owner", staged = {} as Record<string, unknown> } = {}) {
  window.history.replaceState(null, "", `/?view=network&tab=${tab}`);
  const fetchMock = mockFetch({ [route]: answer, [`${route}?fresh=1`]: answer }, staged);
  render(<NetworkPage csrfToken="csrf" role={role} now={now} />);
  return fetchMock;
}

describe("whether the house keeps its DNS when this server is off", () => {
  it("says so at the top of the page when the whole house goes down with this server", async () => {
    open("overview", singlePoint);
    const notice = (await screen.findByText("If homebox goes down, every device on your network loses the internet")).closest(".ui-notice") as HTMLElement;
    expect(notice.textContent).toContain("hands out 192.168.1.10 (this server) as the only DNS server");
    expect(screen.getByText("Goes down with it")).toBeTruthy();
    fireEvent.click(within(notice).getByRole("button", { name: "See what to do" }));
    const panel = await screen.findByRole("region", { name: /If this server is off/ });
    expect(within(panel).getByText("goes down with it")).toBeTruthy();
    // Said once on the tab, not twice.
    expect(screen.getAllByText("If homebox goes down, every device on your network loses the internet")).toHaveLength(1);
  });

  it("lists each server the devices are given, and what becomes of it with this server off", async () => {
    open("dns", resilience);
    const table = await screen.findByRole("table", { name: "DNS servers your devices are given" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows[0].textContent).toContain("192.168.1.10");
    expect(rows[0].textContent).toContain("goes with it");
    expect(rows[1].textContent).toContain("keeps answering");
    expect(screen.getByText("Your network keeps working when homebox is off")).toBeTruthy();
    expect(screen.queryByText(/If homebox goes down/)).toBeNull();
  });

  it("gives the router steps with this server and the router filled in, for GL.iNet, OpenWrt and any router", async () => {
    open("dns", singlePoint);
    fireEvent.click(await screen.findByRole("button", { name: "Router steps…" }));
    const sheet = await screen.findByRole("dialog", { name: "Keep DNS working when this server is off" });
    expect(sheet.textContent).toContain("NETWORK, LAN, DHCP Server, Advanced");
    expect(sheet.textContent).toContain("DNS Server 1 to 192.168.1.10");
    expect(sheet.textContent).toContain("ssh root@192.168.1.1");
    expect(sheet.textContent).toContain("strictorder");
    fireEvent.click(within(sheet).getByRole("radio", { name: "OpenWrt" }));
    expect(sheet.textContent).toContain("uci add_list dhcp.@dnsmasq[0].server='192.168.1.10'");
    expect(sheet.textContent).toContain("Strict order");
    fireEvent.click(within(sheet).getByRole("radio", { name: "Any router" }));
    expect(sheet.textContent).toContain("skip the blocking");
  });

  it("offers the rehearsal for a router nobody has tried, and stages it with the router, this server and the app", async () => {
    const staged: Record<string, unknown> = {};
    open("dns", unproven, { staged });
    const panel = await screen.findByRole("region", { name: /If this server is off/ });
    const button = await within(panel).findByRole("button", { name: "Rehearse" });
    fireEvent.click(button);
    await waitFor(() => expect(staged["dns.fallback.rehearse"]).toEqual({ parameters: { router: "192.168.1.1", lanAddress: "192.168.1.10", app: "pi-hole" } }));
  });

  it("does not offer the rehearsal to a viewer", async () => {
    open("dns", unproven, { role: "viewer" });
    const panel = await screen.findByRole("region", { name: /If this server is off/ });
    await within(panel).findByText("not proven");
    expect(within(panel).queryByRole("button", { name: "Rehearse" })).toBeNull();
  });

  it("reads again rather than the kept answer when asked", async () => {
    const fetchMock = open("dns", resilience);
    const panel = await screen.findByRole("region", { name: /If this server is off/ });
    fireEvent.click(within(panel).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url) === `${route}?fresh=1`)).toBe(true));
  });

  it("shows the last rehearsal and what was checked after an outage", async () => {
    open("dns", {
      ...resilience,
      rehearsal: { router: "192.168.1.1", appName: "Pi-hole", passed: true, answered: 3, total: 3, slowestMs: 1200, at: "2026-08-15T12:00:00.000Z" },
      afterOutage: { at: "2026-08-16T11:40:00.000Z", ok: false, checks: [
        { id: "dns-app-lan", ok: true, label: "Pi-hole answers on the LAN", detail: "A lookup came back." },
        { id: "host-lookups", ok: false, label: "This server cannot look names up", detail: "github.com did not resolve." },
      ] },
    });
    const panel = await screen.findByRole("region", { name: /If this server is off/ });
    expect(await within(panel).findByText("3 of 3 answered with Pi-hole stopped")).toBeTruthy();
    const status = (text: string) => within(panel).getByText(text).closest("[data-status]")?.getAttribute("data-status");
    expect(status("Pi-hole answers on the LAN")).toBe("good");
    expect(status("This server cannot look names up")).toBe("danger");
  });

  it("says when the check could not run, with a way to try again", async () => {
    open("dns", new Response(JSON.stringify({ error: "The DNS check could not run: boom" }), { status: 500, headers: { "Content-Type": "application/json" } }));
    const panel = await screen.findByRole("region", { name: /If this server is off/ });
    expect(await within(panel).findByText("The DNS check could not run: boom")).toBeTruthy();
    expect(within(panel).getAllByRole("button", { name: "Try again" })).toHaveLength(1);
  });
});
