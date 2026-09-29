import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import NetworkPage from "./NetworkPage";
import { json, mockFetch, now, topology, type Answer } from "./testData";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });

const verify = "/api/v1/operations/dns.blocker.verify/run";
const clients = "/api/v1/operations/dns.blocker.clients/run";
const names = "/api/v1/operations/dns.names.inspect/inspect";
const base = {
  address: "192.168.1.10", answering: true, blocking: true,
  control: { domain: "example.com", addresses: [], error: "ESERVFAIL" },
  probe: { domain: "doubleclick.net", addresses: ["0.0.0.0"], error: null },
};
const working = { ...base, resolving: true, control: { domain: "example.com", addresses: ["93.184.216.34"], error: null }, intercepted: false, interceptorBlocking: null, reason: null };
const namesReport = { available: true, reason: null, platform: { id: "pi-hole", label: "Pi-hole", running: true }, records: [{ address: "192.168.1.10", name: "jellyfin.lan" }], apps: [{ id: "jellyfin", name: "Jellyfin", port: 8096 }, { id: "immich", name: "Immich", port: 2283 }] };

/** The DNS tab, with the blocker's answers (and who asks it) as given. */
function openDns(result: unknown, asked: Answer = { available: false, reason: null, platform: null, clients: [], self: 0 }, extra: Record<string, Answer> = {}, staged: Record<string, unknown> = {}) {
  window.history.replaceState(null, "", "/?view=network&tab=dns");
  mockFetch({
    [verify]: { operation: "dns.blocker.verify", result },
    [clients]: asked instanceof Response || typeof asked === "function" ? asked : { operation: "dns.blocker.clients", result: asked },
    [names]: { operation: "dns.names.inspect", result: namesReport },
    ...extra,
  }, staged);
  render(<NetworkPage csrfToken="csrf" now={now} />);
}
const runCheck = async () => fireEvent.click(await screen.findByRole("button", { name: "Check" }));

describe("what the DNS check tells the owner", () => {
  it("does not raise an alarm when the blocking simply lives on the router", async () => {
    // The owner's own case: a blocker on the router answers everything, so this one is idle.
    // Nothing is broken, and showing it as an error sends them to fix a network that works.
    openDns({ ...base, resolving: false, intercepted: true, interceptorBlocking: true, reason: "Your network's DNS is being handled somewhere else, and whatever is handling it blocks ads too. Local names for your apps are the one thing it costs you." });
    await runCheck();
    await waitFor(() => expect(screen.getByText("DNS is handled elsewhere")).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/Local names for your apps are the one thing/)).toBeTruthy();
  });

  it("does raise one when the interception is breaking lookups", async () => {
    openDns({ ...base, resolving: false, intercepted: true, interceptorBlocking: false, reason: "Something between this server and the internet is answering every DNS query itself." });
    await runCheck();
    await waitFor(() => expect(screen.getByText("DNS is being intercepted")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toContain("answering every DNS query itself");
    expect(screen.getByText("not working").closest("[data-status]")?.getAttribute("data-status")).toBe("danger");
  });

  it("says plainly when everything works", async () => {
    openDns(working);
    await runCheck();
    await waitFor(() => expect(screen.getByText(/will use it/)).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("cannot be run without an address to run it against", async () => {
    window.history.replaceState(null, "", "/?view=network&tab=dns");
    mockFetch({ "/api/v1/network/topology": { ...topology, eligibleLanAddresses: [] }, [names]: { operation: "dns.names.inspect", result: namesReport } });
    render(<NetworkPage csrfToken="csrf" now={now} />);
    expect(await screen.findByText("This server has no LAN address to be reached on")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check" })).toBeNull();
  });
});

describe("whether anything is actually using the blocker", () => {
  it("says so when nothing on the network has asked it, and what to do", async () => {
    // Healthy, answering, blocking, and every device still pointed somewhere else. Nothing the
    // blocker can say about itself tells this apart from working, which is the long evening.
    openDns(working, { available: true, reason: null, platform: { id: "pi-hole", label: "Pi-hole", running: true }, clients: [], self: 12 });
    await runCheck();
    await waitFor(() => expect(screen.getByText("nothing is using it")).toBeTruthy());
    expect(screen.getByText(/Point your router's DHCP at/)).toBeTruthy();
    expect(screen.getByText(/only this server's own checks \(12\)/)).toBeTruthy();
  });

  it("counts the devices when there are some", async () => {
    openDns(working, { available: true, reason: null, platform: { id: "pi-hole", label: "Pi-hole", running: true }, clients: [{ address: "192.168.1.31", queries: 812 }, { address: "192.168.1.44", queries: 40 }], self: 3 });
    await runCheck();
    await waitFor(() => expect(screen.getByText("2 devices using it")).toBeTruthy());
    expect(screen.getByText(/192\.168\.1\.31 \(812\)/)).toBeTruthy();
  });

  it("says it does not know rather than claiming nobody uses it", async () => {
    // An unreadable log is not evidence of an unused blocker, and saying so would be an invented
    // alarm of exactly the kind this codebase has shipped before.
    openDns(working, { available: false, reason: "Could not read Pi-hole's query log.", platform: null, clients: [], self: 0 });
    await runCheck();
    await waitFor(() => expect(screen.getByText("not known")).toBeTruthy());
    expect(screen.queryByText("nothing is using it")).toBeNull();
  });

  it("still reports the check when asking who uses it fails outright", async () => {
    openDns(working, () => { throw new Error("network"); });
    await runCheck();
    await waitFor(() => expect(screen.getByText(/will use it/)).toBeTruthy());
  });
});

describe("local names and the DNS change assessment", () => {
  it("shows each app's name, which are in DNS now, and stages writing them with their tier", async () => {
    const staged: Record<string, unknown> = {};
    openDns(working, undefined, {}, staged);
    const panel = await screen.findByRole("region", { name: "Local names" });
    const table = await within(panel).findByRole("table", { name: "A name for each app" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.find((row) => row.textContent?.includes("jellyfin.lan"))?.textContent).toContain("yes");
    expect(rows.find((row) => row.textContent?.includes("immich.lan"))?.textContent).toContain("not yet");
    fireEvent.change(within(panel).getByLabelText("Local domain"), { target: { value: "home.arpa" } });
    expect(within(table).getByText("immich.home.arpa")).toBeTruthy();
    const update = within(panel).getByRole("button", { name: "Update names" });
    expect(update.getAttribute("data-risk")).toBe("medium");
    fireEvent.click(update);
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    await waitFor(() => expect(staged["dns.names.apply"]).toEqual({ parameters: { address: "192.168.1.10", domain: "home.arpa" } }));
  });

  it("says why there is nothing to write names to", async () => {
    openDns(working, undefined, { [names]: { operation: "dns.names.inspect", result: { available: false, reason: "Install Pi-hole from the App catalog.", platform: null, records: [], apps: [] } } });
    const panel = await screen.findByRole("region", { name: "Local names" });
    expect(await within(panel).findByText("Install Pi-hole from the App catalog.")).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: /names/ })).toBeNull();
  });

  it("checks a DNS change from a sheet, against the live network, and shows the assessment", async () => {
    let sent: unknown = null;
    openDns(working, undefined, {
      "/api/v1/network/plans": (body: unknown) => {
        sent = body;
        return json({ plan: {
          id: "plan-one", revision: "a".repeat(64), expiresAt: "2026-08-16T13:00:00Z",
          output: {
            executable: false, readyForChangeWindow: false, topology: { summary: "One router at the edge, everything else as access points.", devices: ["Edge router: NAT, DHCP, and the LAN gateway"] },
            dns: { role: "current-external", primary: "94.140.14.49", emergency: "94.140.14.59" },
            blockers: [{ id: "router-checkpoint", summary: "Record the router configuration" }], warnings: ["Tailscale DNS override is declared off."],
            changes: ["No setting will be changed"], recovery: ["Restore router DNS"], routerMutationSupported: false, dnsCutoverSupported: false,
          },
        } }, 201);
      },
    });
    const panel = await screen.findByRole("region", { name: "DNS change" });
    fireEvent.click(within(panel).getByRole("button", { name: "Plan a DNS change…" }));
    const sheet = await screen.findByRole("dialog", { name: "Check a DNS change" });
    expect((within(sheet).getByLabelText("Live gateway") as HTMLInputElement).value).toBe("192.168.1.1");
    fireEvent.change(within(sheet).getByLabelText("Emergency DNS"), { target: { value: "not-an-address" } });
    expect((within(sheet).getByRole("button", { name: "Check this plan" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(sheet).getByLabelText("Emergency DNS"), { target: { value: "94.140.14.59" } });
    fireEvent.click(within(sheet).getByLabelText("Router configuration backup or checkpoint recorded"));
    fireEvent.click(within(sheet).getByRole("button", { name: "Check this plan" }));
    expect(await within(panel).findByText("Change window blocked")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Check a DNS change" })).toBeNull();
    expect(sent).toMatchObject({ gatewayAddress: "192.168.1.1", serverAddress: "192.168.1.10", dnsServiceAddress: "94.140.14.49", fallbackDnsAddress: "94.140.14.59", routerBackupRecorded: true, tailscaleDnsOverride: false });
    expect(within(panel).getByText("Record the router configuration")).toBeTruthy();
    expect(within(panel).getByText("Router writes locked")).toBeTruthy();
    expect(within(panel).getByText("DNS cutover locked")).toBeTruthy();
    // Device roles come from the topology, as the assessment plans around them.
    expect(within(screen.getByRole("region", { name: "Device roles" })).getByText("Edge router")).toBeTruthy();
  });

  it("does not offer the assessment to a viewer, who may not record one", async () => {
    window.history.replaceState(null, "", "/?view=network&tab=dns");
    mockFetch({ [names]: { operation: "dns.names.inspect", result: namesReport } });
    render(<NetworkPage csrfToken="csrf" role="viewer" now={now} />);
    const panel = await screen.findByRole("region", { name: "DNS change" });
    expect(within(panel).queryByRole("button", { name: "Plan a DNS change…" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Update names|Give apps names/ })).toBeNull();
  });
});
