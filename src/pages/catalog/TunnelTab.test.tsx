import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CatalogPage from "./CatalogPage";
import { nameProblem, tokenProblem } from "./TunnelTab";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); window.history.replaceState(null, "", "/"); });
const json = (body: unknown, status = 201) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const token = "cf-test-token-0000000000000000000000";

const base = { category: "Network", website: null, icon: null, risk: "medium", notes: null, image: { reference: "x/y:1", version: "1", digestPinned: false }, volumes: [], env: [], health: { kind: "running", stableSeconds: 1, timeoutSeconds: 10 }, sha256: "a" };
const tunnelApp = { ...base, id: "cloudflared", name: "Cloudflare Tunnel", description: "Publish an app to the internet", network: "host", ports: [] };
const pingvin = { ...base, id: "pingvin-share", name: "Pingvin Share", category: "Files", description: "Send big files", ports: [{ id: "web", label: "Web UI", container: 3000, host: 3022, protocol: "tcp", exposure: "lan", fixed: false }] };
const gitea = { ...base, id: "forgejo", name: "Forgejo", category: "Developer", description: "Git", ports: [{ id: "web", label: "Web UI", container: 3000, host: 3030, protocol: "tcp", exposure: "lan", fixed: false }, { id: "ssh", label: "SSH", container: 22, host: 2222, protocol: "tcp", exposure: "lan", fixed: false, tailnet: "address" }] };

const running = (id: string, ports: Record<string, number> = {}, published: unknown[] = []) => ({
  id, installed: true, dataPresent: true,
  state: { installedAt: "2026-09-01T10:00:00.000Z", updatedAt: "2026-09-01T10:00:00.000Z", manifestSha256: "a", image: { reference: "x/y:1", id: "sha256:1" }, values: { ports, env: {}, volumes: {} }, pinnedRollback: false, uninstalledAt: null },
  container: { exists: true, running: true, status: "running", health: "none", restarts: 0, image: "sha256:1" },
  urls: Object.keys(ports).filter((port) => port === "web").map((port) => ({ id: port, label: "Web UI", host: ports[port], exposure: "lan" })),
  published,
});
const absent = (id: string) => ({ id, installed: false, dataPresent: false, state: null, container: { exists: false, running: false, status: "absent", health: "none", restarts: 0, image: null }, urls: [] });

const notConnected = { connected: false, account: null, tunnel: null, plannedTunnelName: "boxpilot-homebox", zones: [], routes: [], connectedAt: null, problem: null };
const zone = { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "example.com" };
const connected = {
  connected: true, account: { id: "acc", name: "Example household" }, tunnel: { id: "tun", name: "boxpilot-homebox" }, plannedTunnelName: "boxpilot-homebox",
  zones: [zone, { id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "example.org" }],
  routes: [{ hostname: "files.example.com", url: "https://files.example.com", appId: "pingvin-share", portId: "web", hostPort: 3022, service: "http://127.0.0.1:3022", publishedAt: "2026-10-01T10:00:00.000Z" }],
  connectedAt: "2026-10-01T09:00:00.000Z", problem: null,
};

function serve({ tunnel = connected, installed = true, check = null as unknown }: { tunnel?: unknown; installed?: boolean; check?: unknown } = {}) {
  const staged: Record<string, unknown> = {};
  const catalog = { applications: [
    { manifest: tunnelApp, live: installed ? running("cloudflared") : absent("cloudflared") },
    { manifest: pingvin, live: running("pingvin-share", { web: 3022 }, [{ id: "web", host: 3022, protocol: "tcp", bind: "0.0.0.0", fixed: false, web: true }]) },
    { manifest: gitea, live: running("forgejo", { web: 3030, ssh: 2222 }, [{ id: "web", host: 3030, protocol: "tcp", bind: "0.0.0.0", fixed: false, web: true }, { id: "ssh", host: 2222, protocol: "tcp", bind: "100.64.0.10", fixed: false, web: false }]) },
  ], problems: [], liveError: null, host: { lanAddress: "192.168.1.10", tailscaleDnsName: null } };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url === "/api/v1/catalog") return json(catalog, 200);
    if (url === "/api/v1/operations/cloudflare.tunnel.inspect/inspect") return json({ operation: "cloudflare.tunnel.inspect", result: tunnel }, 200);
    if (url === "/api/v1/operations/cloudflare.tunnel.check/inspect") return check ? json({ operation: "cloudflare.tunnel.check", result: check }, 200) : json({ error: "no" }, 503);
    if (url.includes("app.serve.inspect")) return json({ result: { available: true, serves: [] } }, 200);
    if (url === "/api/v1/schedules") return json({ schedules: [] }, 200);
    const match = url.match(/\/operations\/([a-z0-9.-]+)\/jobs$/);
    if (match) {
      staged[match[1]] = JSON.parse(String(init?.body));
      const tier = ["cloudflare.connect", "cloudflare.publish"].includes(match[1]) ? "high" : "medium";
      return json({ job: { id: `job-${match[1]}`, type: `op:${match[1]}`, title: match[1], state: "awaiting_approval", risk: tier, error: null, result: null, steps: [], approvals: [] }, approval: { tier, passwordRequired: tier === "high", elevated: false, mode: "tiered", reason: tier } });
    }
    return json({ error: `unexpected ${url}` }, 500);
  }));
  return staged;
}

async function openTunnelTab(role = "owner") {
  render(<CatalogPage csrfToken="csrf" role={role} />);
  fireEvent.click(await screen.findByRole("button", { name: /^Cloudflare Tunnel, / }));
  const sheet = await screen.findByRole("dialog", { name: "Cloudflare Tunnel" });
  return sheet;
}

describe("the Cloudflare Tunnel app's Tunnel tab", () => {
  it("is the owner's alone", async () => {
    serve();
    const sheet = await openTunnelTab("operator");
    expect(within(sheet).queryByRole("tab", { name: "Tunnel" })).toBeNull();
  });

  it("explains, lists the token's permissions, and stages Connect with the token kept out of the preview", async () => {
    const staged = serve({ tunnel: notConnected, installed: false });
    render(<CatalogPage csrfToken="csrf" role="owner" />);
    fireEvent.click(await screen.findByRole("tab", { name: /Catalog/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^Cloudflare Tunnel: / }));
    const sheet = await screen.findByRole("dialog", { name: "Cloudflare Tunnel" });
    fireEvent.click(within(sheet).getByRole("tab", { name: "Tunnel" }));
    expect(await within(sheet).findByText("Account · Cloudflare Tunnel · Edit")).toBeTruthy();
    expect(within(sheet).getByText("Zone · DNS · Edit")).toBeTruthy();
    expect(within(sheet).getByText("Zone · Zone · Read")).toBeTruthy();
    expect(within(sheet).getByRole("link", { name: /API tokens page/ }).getAttribute("href")).toBe("https://dash.cloudflare.com/profile/api-tokens");
    const field = within(sheet).getByLabelText("API token") as HTMLInputElement;
    expect(field.type).toBe("password");
    const button = within(sheet).getByRole("button", { name: /Connect Cloudflare/ });
    expect(button.getAttribute("data-risk")).toBe("high");
    fireEvent.change(field, { target: { value: "too short" } });
    expect(await within(sheet).findByText(/no spaces/)).toBeTruthy();
    fireEvent.change(field, { target: { value: ` ${token}\n` } });
    fireEvent.click(within(sheet).getByRole("button", { name: /Connect Cloudflare/ }));
    await waitFor(() => expect(staged["cloudflare.connect"]).toEqual({ parameters: { token } }));
    const dialog = await screen.findByRole("dialog", { name: "Connect Cloudflare" });
    expect(dialog.textContent).toContain("boxpilot-homebox");
    expect(dialog.textContent).toContain("installs the Cloudflare Tunnel app");
    expect(dialog.textContent).toContain("Nothing is published yet");
    expect(document.body.textContent).not.toContain(token);
  });

  it("says Connect replaces the token an installed tunnel app runs with", async () => {
    serve({ tunnel: notConnected, installed: true });
    const sheet = await openTunnelTab();
    fireEvent.click(within(sheet).getByRole("tab", { name: "Tunnel" }));
    fireEvent.change(await within(sheet).findByLabelText("API token"), { target: { value: token } });
    fireEvent.click(within(sheet).getByRole("button", { name: /Connect Cloudflare/ }));
    const dialog = await screen.findByRole("dialog", { name: "Connect Cloudflare" });
    expect(dialog.textContent).toContain("replacing the token it runs with now");
  });

  it("shows the tunnel and what is published, and stages publishing an app with its name, domain and port", async () => {
    const staged = serve();
    const sheet = await openTunnelTab();
    fireEvent.click(within(sheet).getByRole("tab", { name: "Tunnel" }));
    expect(await within(sheet).findByText("Example household")).toBeTruthy();
    expect(within(sheet).getByText("boxpilot-homebox")).toBeTruthy();
    const link = within(sheet).getByRole("link", { name: "https://files.example.com" });
    expect(link.getAttribute("target")).toBe("_blank");
    const form = within(sheet).getByRole("form", { name: "Publish an app" });
    const publish = within(form).getByRole("button", { name: /^Publish/ }) as HTMLButtonElement;
    expect(publish.getAttribute("data-risk")).toBe("high");
    expect(publish.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText("App"), { target: { value: "pingvin-share" } });
    // One port: no port to pick. The name follows the app until one is typed.
    expect(within(form).queryByLabelText("Port")).toBeNull();
    expect((within(form).getByLabelText("Name") as HTMLInputElement).value).toBe("pingvin-share");
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "share.x" } });
    expect(await within(form).findByText(/One word only/)).toBeTruthy();
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Share" } });
    expect((await within(form).findAllByText("https://share.example.com", { selector: "code" })).length).toBeGreaterThan(0);
    expect(within(form).getByText("Two settings in Pingvin Share")).toBeTruthy();
    fireEvent.click(within(form).getByRole("button", { name: /^Publish/ }));
    await waitFor(() => expect(staged["cloudflare.publish"]).toEqual({ parameters: { appId: "pingvin-share", portId: "web", domain: "example.com", name: "share" } }));
    const dialog = await screen.findByRole("dialog", { name: "Publish Pingvin Share at share.example.com" });
    expect(dialog.textContent).toContain("anyone on the internet");
    expect(dialog.textContent).toContain("Pingvin Share's own sign-in is the only lock");
    expect(dialog.textContent).toContain("Behind a reverse proxy");
    expect(dialog.textContent).toContain("App URL");
  });

  it("offers the port when an app has several, says HTTPS when asked, and will not publish a port the tunnel cannot reach", async () => {
    const staged = serve();
    const sheet = await openTunnelTab();
    fireEvent.click(within(sheet).getByRole("tab", { name: "Tunnel" }));
    const form = await within(sheet).findByRole("form", { name: "Publish an app" });
    fireEvent.change(within(form).getByLabelText("App"), { target: { value: "forgejo" } });
    expect((within(form).getByLabelText("Port") as HTMLSelectElement).value).toBe("web");
    fireEvent.change(within(form).getByLabelText("Port"), { target: { value: "ssh" } });
    expect(await within(form).findByText(/It listens only at 100\.64\.0\.10/)).toBeTruthy();
    expect((within(form).getByRole("button", { name: /^Publish/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText("Port"), { target: { value: "web" } });
    fireEvent.change(within(form).getByLabelText("Domain"), { target: { value: "example.org" } });
    fireEvent.click(within(form).getByLabelText("This port speaks HTTPS"));
    fireEvent.click(within(form).getByRole("button", { name: /^Publish/ }));
    await waitFor(() => expect(staged["cloudflare.publish"]).toEqual({ parameters: { appId: "forgejo", portId: "web", domain: "example.org", name: "forgejo", https: true } }));
  });

  it("stages unpublishing a name, and disconnecting with what it leaves running", async () => {
    const staged = serve();
    const sheet = await openTunnelTab();
    fireEvent.click(within(sheet).getByRole("tab", { name: "Tunnel" }));
    fireEvent.click(await within(sheet).findByRole("button", { name: "Unpublish files.example.com" }));
    await waitFor(() => expect(staged["cloudflare.unpublish"]).toEqual({ parameters: { hostname: "files.example.com" } }));
    const dialog = await screen.findByRole("dialog", { name: "Stop publishing files.example.com" });
    expect(dialog.textContent).toContain("Pingvin Share keeps running");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    // Back on the Tunnel tab it was started from.
    const again = await screen.findByRole("dialog", { name: "Cloudflare Tunnel" });
    expect(within(again).getByRole("tab", { name: "Tunnel" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(await within(again).findByRole("button", { name: /Disconnect Cloudflare/ }));
    await waitFor(() => expect(staged["cloudflare.disconnect"]).toEqual({ parameters: {} }));
    expect((await screen.findByRole("dialog", { name: "Disconnect Cloudflare" })).textContent).toContain("stays on the internet");
  });

  it("asks Cloudflare, and says what is missing there and what was added outside BoxPilot", async () => {
    serve({ check: { status: "healthy", connectors: 2, routesAtCloudflare: ["wiki.example.com"], checkedAt: "2026-10-03T10:00:00.000Z" } });
    const sheet = await openTunnelTab();
    fireEvent.click(within(sheet).getByRole("tab", { name: "Tunnel" }));
    fireEvent.click(await within(sheet).findByRole("button", { name: "Check with Cloudflare" }));
    expect(await within(sheet).findByText("Healthy, 2 connectors")).toBeTruthy();
    expect(within(sheet).getByText("Missing")).toBeTruthy();
    expect(within(sheet).getByText(/wiki\.example\.com\. They were set up in the Cloudflare dashboard/)).toBeTruthy();
  });

  it("checks a name and a token the way the server does", () => {
    expect(nameProblem("share")).toBeUndefined();
    expect(nameProblem("share.files")).toMatch(/One word/);
    expect(nameProblem("-share")).toMatch(/Lower-case/);
    expect(tokenProblem(token)).toBeUndefined();
    expect(tokenProblem("abc")).toMatch(/too short/);
    expect(tokenProblem("abc def ghi jkl mno pqr")).toMatch(/no spaces/);
  });
});
