import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import HostedPage from "./HostedPage";
import { hostedStatus, json, mockFetch, now, share } from "./testData";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });

describe("Hosted domains page", () => {
  it("puts the verdict and the facts first, then one row per name with what to do", async () => {
    mockFetch();
    render(<HostedPage csrfToken="csrf" now={now} />);
    expect((await screen.findByText("1 down")).closest(".ui-chip")?.getAttribute("data-status")).toBe("danger");
    expect(screen.getByRole("heading", { level: 1, name: "Hosted domains" })).toBeTruthy();
    const strip = document.querySelector(".hosted-strip") as HTMLElement;
    expect(within(strip).getByText("Connected")).toBeTruthy();
    expect(within(strip).getByText("4 connections · for 31 hours")).toBeTruthy();
    expect(within(strip).getByText("boxpilot-homebox")).toBeTruthy();
    expect(within(strip).getByText("every 15 min")).toBeTruthy();
    await waitFor(() => expect(document.querySelector(".ui-page-header__meta")?.textContent).toBe("3 domains · tunnel connected · checked 3 minutes ago · every 15 min"));
    const table = screen.getByRole("table", { name: "Public names this server answers for" });
    expect(within(table).getByRole("link", { name: "news.example.com" }).getAttribute("href")).toBe("https://news.example.com");
    // Worst first: the one that is down, then the one to look at, then the one that is up.
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getByRole("link").textContent)).toEqual(["news.example.com", "wiki.example.com", "share.example.com"]);
    expect(within(rows[0]).getByText("Down").closest(".ui-chip")?.getAttribute("data-status")).toBe("danger");
    expect(within(rows[0]).getByText(/Start it from its Overview tab in the App catalog/)).toBeTruthy();
    expect(within(rows[0]).getByText("HTTP 530")).toBeTruthy();
    expect(within(rows[0]).getByText("Never")).toBeTruthy();
    expect(within(rows[0]).getByText("Space news")).toBeTruthy();
    expect(within(rows[0]).getByText("a cloudflared config, added by hand")).toBeTruthy();
    expect(within(rows[1]).getByText("Needs a look")).toBeTruthy();
    expect(within(rows[1]).getByText("9 days").closest(".ui-chip")?.getAttribute("data-status")).toBe("warning");
    expect(within(rows[2]).getByText("Up")).toBeTruthy();
    expect(within(rows[2]).getByText("Cloudflare")).toBeTruthy();
    expect(within(rows[2]).getByText("100% / 99.9%")).toBeTruthy();
    expect(within(rows[2]).getByText("27 hours ago")).toBeTruthy(); // the backup
    expect(within(rows[2]).queryByText(/Start it from/)).toBeNull(); // nothing to do for a name that is up
    // What the page is for waits behind the info toggle.
    expect(screen.getByRole("button", { name: "About Hosted domains" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("says all is well, and says when there is nothing to watch yet", async () => {
    mockFetch({ "/api/v1/hosted-domains": { ...hostedStatus, domains: [share] } });
    render(<HostedPage csrfToken="csrf" now={now} />);
    expect((await screen.findByText("All up")).closest(".ui-chip")?.getAttribute("data-status")).toBe("good");
    cleanup();
    mockFetch({ "/api/v1/hosted-domains": { ...hostedStatus, domains: [], manual: [], tunnel: { ...hostedStatus.tunnel!, installed: false, running: false, cloudflare: { connected: false, tunnelName: null } }, alertsTarget: false } });
    render(<HostedPage csrfToken="csrf" now={now} />);
    expect((await screen.findByText("No domains")).closest(".ui-chip")?.getAttribute("data-status")).toBe("neutral");
    expect(screen.getByText("No public names found")).toBeTruthy();
    const strip = document.querySelector(".hosted-strip") as HTMLElement;
    expect(within(strip).getByText("Not installed")).toBeTruthy();
    expect(within(strip).getByText("No target")).toBeTruthy();
    cleanup();
    mockFetch({ "/api/v1/hosted-domains": json({ error: "The hosted domains could not be checked: the helper did not answer" }, 500) });
    render(<HostedPage csrfToken="csrf" now={now} />);
    expect(await screen.findByText("The hosted domains could not be read")).toBeTruthy();
    expect(screen.getByText(/the helper did not answer/)).toBeTruthy();
  });

  it("opens a name's facts and what to do in a sheet", async () => {
    mockFetch();
    render(<HostedPage csrfToken="csrf" now={now} />);
    fireEvent.click(await screen.findByRole("button", { name: "Details of wiki.example.com" }));
    const sheet = await screen.findByRole("dialog", { name: "wiki.example.com" });
    expect(within(sheet).getByText("Certificate expires in 9 days")).toBeTruthy();
    expect(within(sheet).getByText(/orange cloud/)).toBeTruthy();
    expect(within(sheet).getByText("http://127.0.0.1:8120")).toBeTruthy();
    expect(within(sheet).getByText("104.16.132.229, 104.16.133.229")).toBeTruthy();
    expect(within(sheet).getByText("Let's Encrypt", { exact: false })).toBeTruthy();
    expect(within(sheet).getByText("the app's own settings")).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: "Stop watching" })).toBeNull(); // not added by hand
    fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("adds a name by hand, sent with the CSRF token, and shows the server's refusal in words", async () => {
    const sent: Array<{ method: string; url: string; body: unknown; headers: Record<string, string> }> = [];
    mockFetch({}, sent);
    render(<HostedPage csrfToken="csrf" role="operator" now={now} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add a domain…" }));
    const sheet = await screen.findByRole("dialog", { name: "Add a domain" });
    const add = within(sheet).getByRole("button", { name: "Add" });
    expect(add.hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(sheet).getByLabelText(/^Name/), { target: { value: "Status.Example.com" } });
    fireEvent.change(within(sheet).getByLabelText(/Answered on this server at/), { target: { value: "http://127.0.0.1:3001" } });
    await within(sheet).findByRole("option", { name: "BookStack" });
    fireEvent.change(within(sheet).getByLabelText(/^App/), { target: { value: "bookstack" } });
    fireEvent.change(within(sheet).getByLabelText(/^Label/), { target: { value: "Status page" } });
    fireEvent.click(add);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: "POST", url: "/api/v1/hosted-domains/manual", body: { hostname: "Status.Example.com", service: "http://127.0.0.1:3001", appId: "bookstack", label: "Status page", expectedAddress: null }, headers: { "X-BoxPilot-CSRF": "csrf" } });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText("x is watched from the next check.")).toBeTruthy();
    cleanup();

    mockFetch({ "POST /api/v1/hosted-domains/manual": json({ error: "homebox.lan is a name for your own network, not one the internet can reach", code: "invalid_domain" }, 400) }, sent);
    render(<HostedPage csrfToken="csrf" now={now} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add a domain…" }));
    const again = await screen.findByRole("dialog", { name: "Add a domain" });
    fireEvent.change(within(again).getByLabelText(/^Name/), { target: { value: "homebox.lan" } });
    fireEvent.click(within(again).getByRole("button", { name: "Add" }));
    expect(await within(again).findByText(/not one the internet can reach/)).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Add a domain" })).toBeTruthy(); // stays open to fix
  });

  it("lets the owner set the cadence, and keeps every button from a viewer", async () => {
    const sent: Array<{ method: string; url: string; body: unknown; headers: Record<string, string> }> = [];
    mockFetch({}, sent);
    render(<HostedPage csrfToken="csrf" now={now} />);
    const cadence = await screen.findByRole("combobox", { name: "Check every" });
    fireEvent.change(cadence, { target: { value: "30" } });
    await waitFor(() => expect(sent).toEqual([expect.objectContaining({ method: "PUT", url: "/api/v1/hosted-domains/settings", body: { intervalMinutes: 30 } })]));
    expect(await screen.findByText("The names are checked every 30 minutes from now on.")).toBeTruthy();
    await waitFor(() => expect(document.querySelector(".ui-page-header__meta")?.textContent).toContain("every 30 min"));
    cleanup();

    mockFetch();
    render(<HostedPage csrfToken="csrf" role="operator" now={now} />);
    await screen.findByText("1 down");
    expect(screen.queryByRole("combobox", { name: "Check every" })).toBeNull();
    expect(screen.getByRole("button", { name: "Check now" })).toBeTruthy();
    cleanup();

    mockFetch();
    render(<HostedPage csrfToken="csrf" role="viewer" now={now} />);
    await screen.findByText("1 down");
    expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a domain…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop watching news.example.com" })).toBeNull();
    expect(screen.getByRole("button", { name: "Details of news.example.com" })).toBeTruthy();
  });

  it("checks again on request, and stops watching a name added by hand", async () => {
    const sent: Array<{ method: string; url: string; body: unknown; headers: Record<string, string> }> = [];
    const fetchMock = mockFetch({}, sent);
    render(<HostedPage csrfToken="csrf" now={now} />);
    fireEvent.click(await screen.findByRole("button", { name: "Check now" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url.toString() === "/api/v1/hosted-domains?fresh=1")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Stop watching news.example.com" }));
    await waitFor(() => expect(sent).toEqual([expect.objectContaining({ method: "DELETE", url: "/api/v1/hosted-domains/manual/news.example.com", headers: { "X-BoxPilot-CSRF": "csrf" } })]));
    expect(await screen.findByText("news.example.com is no longer watched.")).toBeTruthy();
  });
});
