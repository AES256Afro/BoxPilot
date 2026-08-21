import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import FirewallCenter from "./FirewallCenter";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

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
const job = (id: string, type: string, risk: string) => ({ job: { id, type: `op:${type}`, title: type, state: "awaiting_approval", risk, error: null, result: null, steps: [], approvals: [] }, approval: { tier: risk, passwordRequired: risk === "high", elevated: false, mode: "tiered", reason: `${risk} risk` } });

function mockFetch(data: Record<string, unknown>, staged: Record<string, string>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url === "/api/v1/firewall/overview") return json(data);
    if (url.startsWith("/api/v1/firewall/plan?")) {
      const query = new URL(url, "http://localhost").searchParams;
      return json({ profile: { id: query.get("profile"), name: "Home server" }, services: (query.get("services") ?? "").split(",").filter(Boolean), steps: [{ args: ["allow", "22/tcp", "comment", "BoxPilot keeps SSH reachable"], label: "Keep SSH reachable (22/tcp)" }, { args: ["--force", "enable"], label: "Turn the firewall on" }] });
    }
    const match = url.match(/\/operations\/([a-z.]+)\/jobs$/);
    if (match) { staged[match[1]] = init?.body as string; return json(job(`job-${match[1]}`, match[1], match[1] === "firewall.set" || match[1] === "firewall.profile.apply" ? "high" : "medium"), 201); }
    return json({ error: `unexpected ${url}` }, 500);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Firewall center", () => {
  it("shows state and stages enabling as a high-risk change with the lockout guard in the preview", async () => {
    const staged: Record<string, string> = {};
    mockFetch(overview(), staged);
    render(<FirewallCenter csrfToken="csrf-token" />);

    expect(await screen.findByText("Disabled")).toBeTruthy();
    expect(screen.getByText("None applied")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    expect(await screen.findByText("High risk")).toBeTruthy();
    expect(screen.getByText(/keeping SSH \(22\/tcp\), Tailscale \(41641\/udp\), and the/)).toBeTruthy();
    await waitFor(() => expect(JSON.parse(staged["firewall.set"] ?? "{}")).toEqual({ parameters: { enabled: true } }));
  });

  it("lists rules, hides Delete for protected allow rules, and stages a deletion", async () => {
    const staged: Record<string, string> = {};
    mockFetch(overview(), staged);
    render(<FirewallCenter csrfToken="csrf-token" />);

    expect(await screen.findByText("Jellyfin")).toBeTruthy();
    const rows = screen.getAllByRole("row");
    expect(rows.find((row) => row.textContent?.includes("BoxPilot keeps SSH"))?.textContent).not.toContain("Delete");
    expect(rows.find((row) => row.textContent?.includes("41641"))?.textContent).not.toContain("Delete");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    await waitFor(() => expect(JSON.parse(staged["firewall.rule.delete"] ?? "{}")).toEqual({ parameters: { action: "allow", port: 8096, protocol: "tcp" } }));
  });

  it("refuses to stage a deny on a protected port and explains why", async () => {
    mockFetch(overview(), {});
    render(<FirewallCenter csrfToken="csrf-token" />);
    await screen.findByText("Jellyfin");
    fireEvent.change(screen.getByLabelText("Rule action"), { target: { value: "deny" } });
    fireEvent.change(screen.getByLabelText("Port"), { target: { value: "8787" } });
    expect((screen.getByRole("button", { name: "Add rule" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("note").textContent).toContain("BoxPilot and stays open");
    fireEvent.change(screen.getByLabelText("Port"), { target: { value: "8080" } });
    expect((screen.getByRole("button", { name: "Add rule" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("applies a profile with the ticked services after showing the exact plan", async () => {
    const staged: Record<string, string> = {};
    mockFetch(overview(), staged);
    render(<FirewallCenter csrfToken="csrf-token" />);

    const homeServer = await screen.findByRole("radio", { name: /Home server/ });
    expect((homeServer as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByLabelText("DNS server"));
    fireEvent.click(screen.getByLabelText("Rate-limit SSH logins"));
    fireEvent.click(screen.getByRole("button", { name: "Review and apply" }));
    expect(await screen.findByText("High risk")).toBeTruthy();
    expect(screen.getByText("Keep SSH reachable (22/tcp)", { exact: false })).toBeTruthy();
    await waitFor(() => expect(JSON.parse(staged["firewall.profile.apply"] ?? "{}")).toEqual({ parameters: { profile: "home-server", services: ["dns"], replace: false, sshRateLimit: true } }));
  });

  it("drops services for a profile that locks them", async () => {
    const staged: Record<string, string> = {};
    mockFetch(overview({ current: { id: "home-server", services: ["web"], sshRateLimit: false, appliedAt: "2026-08-21T15:00:00.000Z" } }), staged);
    render(<FirewallCenter csrfToken="csrf-token" />);
    expect(await screen.findByText("In force")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /Tailscale only/ }));
    expect((screen.getByLabelText("Web (HTTP/HTTPS)") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Review and apply" }));
    await waitFor(() => expect(JSON.parse(staged["firewall.profile.apply"] ?? "{}")).toEqual({ parameters: { profile: "tailscale-only", services: [], replace: false, sshRateLimit: false } }));
  });

  it("turns advice into one-click operations", async () => {
    const staged: Record<string, string> = {};
    mockFetch(overview({ advice: [
      { id: "app-jellyfin-8096-tcp", level: "info", title: "Jellyfin is blocked for other devices", detail: "No rule allows 8096/tcp.", operationId: "firewall.rule.add", parameters: { action: "allow", port: 8096, protocol: "tcp", comment: "Jellyfin" }, actionLabel: "Allow Jellyfin" },
      { id: "ssh-limit", level: "info", title: "Rate-limit SSH logins", detail: "Apply a profile.", focus: "profiles" },
    ] }), staged);
    render(<FirewallCenter csrfToken="csrf-token" />);
    const item = (await screen.findByText("Jellyfin is blocked for other devices")).closest(".advice-item") as HTMLElement;
    fireEvent.click(within(item).getByRole("button", { name: "Allow Jellyfin" }));
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    await waitFor(() => expect(JSON.parse(staged["firewall.rule.add"] ?? "{}")).toEqual({ parameters: { action: "allow", port: 8096, protocol: "tcp", comment: "Jellyfin" } }));
    expect(screen.getByRole("button", { name: "Choose a profile" })).toBeTruthy();
  });

  it("offers to install ufw when it is missing", async () => {
    mockFetch(overview({ report: { installed: false, enabled: null, defaults: null, rules: [] }, advice: [{ id: "install", level: "action", title: "Install ufw", detail: "x", focus: "install" }] }), {});
    render(<FirewallCenter csrfToken="csrf-token" />);
    expect(await screen.findByRole("button", { name: "Install ufw" })).toBeTruthy();
  });
});
