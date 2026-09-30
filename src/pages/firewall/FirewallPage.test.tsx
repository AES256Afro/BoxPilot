import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import FirewallPage from "./FirewallPage";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const now = () => Date.parse("2026-08-24T15:00:00.000Z");

const report = {
  installed: true,
  enabled: false,
  defaults: { incoming: "drop", outgoing: "accept", routed: "reject" },
  rules: [
    { action: "allow", protocol: "tcp", port: 22, app: null, direction: "in", interface: null, comment: "BoxPilot keeps SSH reachable", family: "v4" },
    { action: "allow", protocol: "udp", port: 41641, app: null, direction: "in", interface: null, comment: "BoxPilot keeps Tailscale reachable", family: "both" },
    { action: "allow", protocol: "tcp", port: 8096, app: null, direction: "in", interface: null, comment: "Jellyfin", family: "both" },
  ],
};
const protectedRules = [
  { port: 22, protocol: "tcp", label: "SSH", reason: "Your way back in.", allow: true },
  { port: 41641, protocol: "udp", label: "Tailscale", reason: "WireGuard port.", allow: true },
  { port: 8787, protocol: "tcp", label: "BoxPilot", reason: "This page.", allow: false },
];
const profiles = [
  { id: "home-server", name: "Home server", recommended: true, summary: "Block everything that was not asked for.", detail: "Default deny.", defaults: { incoming: "deny", outgoing: "allow" }, rules: [] },
  { id: "tailscale-only", name: "Tailscale only", recommended: false, summary: "Tailnet only.", detail: "No LAN services.", defaults: { incoming: "deny", outgoing: "allow" }, rules: [], lockServices: true },
];
const services = [
  { id: "web", name: "Web (HTTP/HTTPS)", hint: "Reverse proxies", ports: [{ port: 80, protocol: "tcp" }, { port: 443, protocol: "tcp" }] },
  { id: "dns", name: "DNS server", hint: "Pi-hole", ports: [{ port: 53, protocol: "tcp" }, { port: 53, protocol: "udp" }] },
];
const overview = (extra: Record<string, unknown> = {}) => ({ report, reportError: null, web: { port: 8787, lanExposed: false }, protected: protectedRules, profiles, services, current: null, advice: [], ...extra });
const fail2banOn = { installed: true, running: true, configured: true, config: { managed: true, maxRetry: 3, findTimeMinutes: 15, banTimeMinutes: 120, ignoreLan: true, ignore: ["127.0.0.1/8", "::1", "100.64.0.0/10", "192.168.1.0/24"], sshd: true }, currentlyBanned: 2, totalBanned: 9 };
const job = (id: string, risk: string) => ({ job: { id: `job-${id}`, type: `op:${id}`, title: id, state: "awaiting_approval", risk, error: null, result: null, steps: [], approvals: [] }, approval: { tier: risk, passwordRequired: risk === "high", elevated: false, mode: "tiered", reason: `${risk} risk` } });
const tierOf: Record<string, string> = { "firewall.set": "high", "firewall.profile.apply": "high" };

function mockFetch(data: Record<string, unknown>, staged: Record<string, unknown> = {}, fail2ban: unknown = fail2banOn) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url === "/api/v1/firewall/overview") return json(data);
    if (url.endsWith("/operations/fail2ban.inspect/inspect")) return json({ operation: "fail2ban.inspect", result: fail2ban });
    if (url.startsWith("/api/v1/firewall/plan?")) {
      const query = new URL(url, "http://localhost").searchParams;
      return json({ profile: { id: query.get("profile"), name: "Home server" }, services: (query.get("services") ?? "").split(",").filter(Boolean), steps: [{ args: ["allow", "22/tcp", "comment", "BoxPilot keeps SSH reachable"], label: "Keep SSH reachable (22/tcp)" }, { args: ["--force", "enable"], label: "Turn the firewall on" }] });
    }
    const match = url.match(/\/operations\/([a-z0-9.-]+)\/jobs$/);
    if (match) { staged[match[1]] = JSON.parse(String(init?.body)); return json(job(match[1], tierOf[match[1]] ?? "medium"), 201); }
    return json({ error: `unexpected ${url}` }, 500);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Firewall page", () => {
  it("says first whether the firewall is on, and stages turning it on as high risk with the lockout guard", async () => {
    const staged: Record<string, unknown> = {};
    mockFetch(overview(), staged);
    render(<FirewallPage csrfToken="csrf" now={now} />);
    expect(await screen.findByText("Off")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Firewall" })).toBeTruthy();
    expect(screen.getByText("All incoming traffic is accepted.")).toBeTruthy();
    await waitFor(() => expect(document.querySelector(".ui-page-header__meta")?.textContent).toBe("in drop · out accept · 3 rules · fail2ban on, 2 banned"));
    const turnOn = screen.getByRole("button", { name: "Turn on" });
    expect(turnOn.getAttribute("data-risk")).toBe("high");
    fireEvent.click(turnOn);
    expect(await screen.findByText("High risk")).toBeTruthy();
    expect(screen.getByText(/keeping SSH \(22\/tcp\), Tailscale \(41641\/udp\), and the/)).toBeTruthy();
    await waitFor(() => expect(staged["firewall.set"]).toEqual({ parameters: { enabled: true } }));
  });

  it("lists the rules, keeps the protected ones, and stages deleting another", async () => {
    const staged: Record<string, unknown> = {};
    window.history.replaceState(null, "", "/?view=firewall&tab=rules");
    mockFetch(overview(), staged);
    render(<FirewallPage csrfToken="csrf" now={now} />);
    const table = await screen.findByRole("table", { name: "Firewall rules from ufw" });
    await within(table).findByText("Jellyfin");
    const rows = within(table).getAllByRole("row");
    const ssh = rows.find((row) => row.textContent?.includes("BoxPilot keeps SSH"));
    expect(within(ssh as HTMLElement).queryByRole("button", { name: /Delete/ })).toBeNull();
    expect(ssh?.textContent).toContain("kept open");
    expect(rows.find((row) => row.textContent?.includes("41641"))?.textContent).not.toContain("Delete");
    const remove = within(table).getByRole("button", { name: "Delete allow 8096/tcp" });
    expect(remove.getAttribute("data-risk")).toBe("medium");
    fireEvent.click(remove);
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    await waitFor(() => expect(staged["firewall.rule.delete"]).toEqual({ parameters: { action: "allow", port: 8096, protocol: "tcp" } }));
  });

  it("adds a rule from a sheet, and refuses a deny on a port that stays open", async () => {
    const staged: Record<string, unknown> = {};
    window.history.replaceState(null, "", "/?view=firewall&tab=rules");
    mockFetch(overview(), staged);
    render(<FirewallPage csrfToken="csrf" now={now} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add a rule…" }));
    const sheet = await screen.findByRole("dialog", { name: "Add a rule" });
    fireEvent.change(within(sheet).getByLabelText("Action"), { target: { value: "deny" } });
    fireEvent.change(within(sheet).getByLabelText("Port"), { target: { value: "8787" } });
    const add = within(sheet).getByRole("button", { name: "Add rule" });
    expect((add as HTMLButtonElement).disabled).toBe(true);
    expect(within(sheet).getByText(/is BoxPilot and stays open: This page\./)).toBeTruthy();
    fireEvent.change(within(sheet).getByLabelText("Port"), { target: { value: "8080" } });
    fireEvent.change(within(sheet).getByLabelText(/Comment/), { target: { value: "test box" } });
    expect((add as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(add);
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Add a rule" })).toBeNull();
    await waitFor(() => expect(staged["firewall.rule.add"]).toEqual({ parameters: { action: "deny", port: 8080, protocol: "tcp", comment: "test box" } }));
  });

  it("applies a profile with the ticked services after showing the exact plan", async () => {
    const staged: Record<string, unknown> = {};
    mockFetch(overview(), staged);
    render(<FirewallPage csrfToken="csrf" now={now} />);
    fireEvent.click(await screen.findByRole("button", { name: "Choose a profile…" }));
    const sheet = await screen.findByRole("dialog", { name: "Choose a firewall profile" });
    expect(within(sheet).getByRole("radio", { name: "Home server" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(sheet).getByLabelText("DNS server"));
    fireEvent.click(within(sheet).getByLabelText("Rate-limit SSH logins"));
    const review = within(sheet).getByRole("button", { name: "Review and apply" });
    expect(review.getAttribute("data-risk")).toBe("high");
    fireEvent.click(review);
    expect(await screen.findByText("High risk")).toBeTruthy();
    expect(screen.getByText("Keep SSH reachable (22/tcp)", { exact: false })).toBeTruthy();
    await waitFor(() => expect(staged["firewall.profile.apply"]).toEqual({ parameters: { profile: "home-server", services: ["dns"], replace: false, sshRateLimit: true } }));
  });

  it("says why the plan could not be built in the sheet, where the owner is, not on the page under it", async () => {
    const fetchMock = mockFetch(overview());
    const answer = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => (input.toString().startsWith("/api/v1/firewall/plan?") ? json({ error: "ufw is not installed" }, 409) : answer(input, init)));
    render(<FirewallPage csrfToken="csrf" now={now} />);
    fireEvent.click(await screen.findByRole("button", { name: "Choose a profile…" }));
    const sheet = await screen.findByRole("dialog", { name: "Choose a firewall profile" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Review and apply" }));
    expect(await within(sheet).findByText("ufw is not installed")).toBeTruthy();
    expect(within(sheet).getByRole("alert")).toBeTruthy();
    // Said once: not again on the page the sheet covers.
    expect(screen.getAllByText("ufw is not installed")).toHaveLength(1);
  });

  it("drops the services for a profile that opens nothing, and moves between profiles with the arrow keys", async () => {
    const staged: Record<string, unknown> = {};
    mockFetch(overview({ current: { id: "home-server", services: ["web"], sshRateLimit: false, appliedAt: "2026-08-21T15:00:00.000Z" } }), staged);
    render(<FirewallPage csrfToken="csrf" now={now} />);
    const profile = await screen.findByRole("region", { name: "Profile" });
    await within(profile).findByText("Home server");
    expect(within(profile).getByText("Web (HTTP/HTTPS)")).toBeTruthy();
    expect(within(profile).getByText("applied 3 days ago")).toBeTruthy();
    fireEvent.click(within(profile).getByRole("button", { name: "Choose a profile…" }));
    const sheet = await screen.findByRole("dialog", { name: "Choose a firewall profile" });
    expect(within(sheet).getByText("in force")).toBeTruthy();
    const home = within(sheet).getByRole("radio", { name: "Home server" });
    home.focus();
    fireEvent.keyDown(home, { key: "ArrowRight" });
    expect(within(sheet).getByRole("radio", { name: "Tailscale only" }).getAttribute("aria-checked")).toBe("true");
    expect((within(sheet).getByLabelText("Web (HTTP/HTTPS)") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(within(sheet).getByRole("button", { name: "Review and apply" }));
    await waitFor(() => expect(staged["firewall.profile.apply"]).toEqual({ parameters: { profile: "tailscale-only", services: [], replace: false, sshRateLimit: false } }));
  });

  it("turns suggestions into one-click operations with their tier", async () => {
    const staged: Record<string, unknown> = {};
    mockFetch(overview({ advice: [
      { id: "app-jellyfin-8096-tcp", level: "info", title: "Jellyfin is blocked for other devices", detail: "No rule allows 8096/tcp.", operationId: "firewall.rule.add", parameters: { action: "allow", port: 8096, protocol: "tcp", comment: "Jellyfin" }, actionLabel: "Allow Jellyfin" },
      { id: "ssh-limit", level: "action", title: "Rate-limit SSH logins", detail: "Apply a profile.", focus: "profiles" },
      { id: "fail2ban", level: "warn", title: "Turn on brute-force protection", detail: "SSH is open.", focus: "fail2ban" },
      { id: "orphan-53-udp", level: "info", title: "Nothing is listening on port 53", detail: "A rule allows 53/udp.", operationId: "firewall.rule.delete", parameters: { action: "allow", port: 53, protocol: "udp" } },
    ] }), staged);
    render(<FirewallPage csrfToken="csrf" now={now} />);
    const suggestions = await screen.findByRole("region", { name: "Suggestions" });
    const item = (await within(suggestions).findByText("Jellyfin is blocked for other devices")).closest("li") as HTMLElement;
    expect(within(suggestions).getByText("Do this")).toBeTruthy();
    const allow = within(item).getByRole("button", { name: "Allow Jellyfin" });
    expect(allow.getAttribute("data-risk")).toBe("medium");
    fireEvent.click(allow);
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    await waitFor(() => expect(staged["firewall.rule.add"]).toEqual({ parameters: { action: "allow", port: 8096, protocol: "tcp", comment: "Jellyfin" } }));
    expect(within(suggestions).getByRole("button", { name: "Choose a profile" })).toBeTruthy();
    // A suggestion that names no label is said by what it does.
    expect(within(suggestions).getByRole("button", { name: "Remove 53/udp" }).getAttribute("data-risk")).toBe("medium");
    // The fail2ban suggestion opens its tab rather than starting anything.
    fireEvent.click(within(suggestions).getByRole("button", { name: "Set it up" }));
    expect(screen.getByRole("tab", { name: /Brute force/ }).getAttribute("aria-selected")).toBe("true");
    expect(window.location.search).toContain("tab=bans");
  });

  it("offers to install ufw when it is missing", async () => {
    const staged: Record<string, unknown> = {};
    mockFetch(overview({ report: { installed: false, enabled: null, defaults: null, rules: [] }, advice: [{ id: "install", level: "action", title: "Install ufw", detail: "x", focus: "install" }] }), staged);
    render(<FirewallPage csrfToken="csrf" now={now} />);
    expect(await screen.findByText("Not installed")).toBeTruthy();
    const install = screen.getByRole("button", { name: "Install ufw" });
    expect(install.getAttribute("data-risk")).toBe("medium");
    fireEvent.click(install);
    await waitFor(() => expect(staged["apt.install"]).toEqual({ parameters: { packages: ["ufw"] } }));
  });

  it("shows the bans and thresholds, applies changes and turns protection off", async () => {
    const staged: Record<string, unknown> = {};
    window.history.replaceState(null, "", "/?view=firewall&tab=bans");
    mockFetch(overview(), staged);
    render(<FirewallPage csrfToken="csrf" now={now} />);
    await screen.findByText("192.168.1.0/24");
    const bans = screen.getByRole("region", { name: "Brute-force protection" });
    expect(within(bans).getByText("3 failures in 15 min")).toBeTruthy();
    expect((screen.getByLabelText("Failed logins before a ban") as HTMLInputElement).value).toBe("3");
    fireEvent.change(screen.getByLabelText("Ban for (minutes)"), { target: { value: "240" } });
    fireEvent.click(screen.getByLabelText("Never ban my LAN"));
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    await waitFor(() => expect(staged["fail2ban.apply"]).toEqual({ parameters: { enabled: true, maxRetry: 3, findTimeMinutes: 15, banTimeMinutes: 240, ignoreLan: false } }));
  });

  it("stages turning brute-force protection off", async () => {
    const staged: Record<string, unknown> = {};
    window.history.replaceState(null, "", "/?view=firewall&tab=bans");
    mockFetch(overview(), staged);
    render(<FirewallPage csrfToken="csrf" now={now} />);
    fireEvent.click(await screen.findByRole("button", { name: "Turn off protection" }));
    await waitFor(() => expect(staged["fail2ban.apply"]).toEqual({ parameters: { enabled: false } }));
  });

  it("offers to install fail2ban when it is missing", async () => {
    const staged: Record<string, unknown> = {};
    window.history.replaceState(null, "", "/?view=firewall&tab=bans");
    mockFetch(overview(), staged, { installed: false, running: null, configured: false, config: { managed: false, maxRetry: null, findTimeMinutes: null, banTimeMinutes: null, ignoreLan: true, ignore: [], sshd: false }, currentlyBanned: null, totalBanned: null });
    render(<FirewallPage csrfToken="csrf" now={now} />);
    fireEvent.click(await screen.findByRole("button", { name: "Install fail2ban" }));
    await waitFor(() => expect(staged["apt.install"]).toEqual({ parameters: { packages: ["fail2ban"] } }));
  });

  it("shows a viewer the rules and the banned addresses, and no buttons that change anything", async () => {
    window.history.replaceState(null, "", "/?view=firewall&tab=bans");
    mockFetch(overview({ advice: [{ id: "app-jellyfin-8096-tcp", level: "info", title: "Jellyfin is blocked", detail: "x", operationId: "firewall.rule.add", parameters: { action: "allow", port: 8096, protocol: "tcp" }, actionLabel: "Allow Jellyfin" }] }));
    render(<FirewallPage csrfToken="csrf" role="viewer" now={now} />);
    await screen.findByText("192.168.1.0/24");
    const bans = screen.getByRole("region", { name: "Brute-force protection" });
    expect(within(bans).getByText("Banned now").nextElementSibling?.textContent).toBe("2");
    expect(screen.queryByRole("region", { name: "Thresholds" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Turn on" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /Rules/ }));
    const table = await screen.findByRole("table", { name: "Firewall rules from ufw" });
    expect(within(table).queryAllByRole("button").filter((button) => !button.classList.contains("ui-table__sort"))).toEqual([]);
    expect(screen.queryByRole("button", { name: "Add a rule…" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /Overview/ }));
    expect(await screen.findByText("Jellyfin is blocked")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow Jellyfin" })).toBeNull();
  });

  it("says when the firewall could not be read, and offers to try again", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "The helper is not answering" }, 503)));
    render(<FirewallPage csrfToken="csrf" now={now} />);
    expect((await screen.findByRole("alert")).textContent).toContain("The helper is not answering");
    expect(screen.getByText("Not read").closest(".ui-chip")?.getAttribute("data-status")).toBe("unknown");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
