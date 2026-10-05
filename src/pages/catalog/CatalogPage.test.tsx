import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CatalogPage from "./CatalogPage";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); window.history.replaceState(null, "", "/"); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const stagedJob = (type: string, tier = "medium", passwordRequired = false) => json({ job: { id: `job-${type}`, type: `op:${type}`, title: type, state: "awaiting_approval", risk: tier, error: null, result: null, steps: [], approvals: [] }, approval: { tier, passwordRequired, elevated: false, mode: "tiered", reason: tier } }, 201);

const manifest = {
  id: "jellyfin", name: "Jellyfin", category: "Media", description: "Media server", website: "https://jellyfin.org", icon: "🎬", risk: "medium", notes: "Setup wizard on first run",
  image: { reference: "jellyfin/jellyfin:10.10.7", version: "10.10.7", digestPinned: false },
  ports: [{ id: "web", label: "Web UI", container: 8096, host: 8096, protocol: "tcp", exposure: "lan", fixed: false }],
  volumes: [{ id: "config", label: "Configuration", container: "/config", path: "config", hostPath: null, readOnly: false, backup: true, configurable: false, description: null }, { id: "media", label: "Media library", container: "/media", path: null, hostPath: "/srv/media", readOnly: true, backup: false, configurable: true, description: "Your media folder" }],
  env: [{ name: "TZ", label: "Time zone", description: null, type: "timezone", default: "Etc/UTC", required: false, secret: false, generate: false, options: null, fixed: false }],
  health: { kind: "healthcheck", stableSeconds: 10, timeoutSeconds: 240 }, sha256: "abc",
};
const dnsManifest = {
  ...manifest, id: "pi-hole", name: "Pi-hole", category: "DNS", description: "DNS blocker", website: "https://pi-hole.net", notes: null, ports: [], volumes: [], env: [],
  setup: { title: "Blocklists", note: "Pick lists.", finalize: ["pihole", "-g"], finalizeLabel: null, choices: [
    { id: "oisd-big", label: "OISD big", description: "All-round list.", website: "https://oisd.nl", recommended: true, exec: ["sh", "-c", "x"] },
    { id: "hagezi-tif", label: "HaGeZi Threat Intelligence Feeds", description: null, website: null, recommended: false, exec: ["sh", "-c", "y"] },
  ] },
};
const absent = (id: string) => ({ id, installed: false, dataPresent: false, state: null, container: { exists: false, running: false, status: "absent", health: "none", restarts: 0, image: null }, urls: [] });
const running = (id: string, port = 8096, extra: Record<string, unknown> = {}) => ({
  id, installed: true, dataPresent: true,
  state: { installedAt: "2026-08-01T10:00:00.000Z", updatedAt: "2026-08-01T10:00:00.000Z", manifestSha256: "abc", image: { reference: "r", id: "sha256:1" }, values: { ports: { web: port }, env: {}, volumes: {} }, pinnedRollback: false, uninstalledAt: null },
  container: { exists: true, running: true, status: "running", health: "healthy", restarts: 0, image: "sha256:1" },
  urls: [{ id: "web", label: "Web UI", host: port, exposure: "lan" }],
  ...extra,
});
const catalogOf = (applications: unknown[], host: Record<string, unknown> = { lanAddress: "192.168.1.10", tailscaleDnsName: null }) => ({ applications, problems: [], liveError: null, host });

/** Answers the catalog and whatever `other` knows; the rest of the page's extras fail quietly. */
function serve(catalog: unknown, other?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const answer = other?.(url, init);
    if (answer) return answer;
    if (url === "/api/v1/catalog") return json(catalog);
    if (url.includes("app.serve.inspect")) return json({ result: { available: true, serves: [] } });
    if (url === "/api/v1/schedules") return json({ schedules: [] });
    return json({ error: `unexpected ${url}` }, 500);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function openApp(name: string) {
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${name}, `) }));
  return screen.findByRole("dialog", { name });
}

async function openInstall(name: string) {
  fireEvent.click(await screen.findByRole("tab", { name: /Catalog/ }));
  fireEvent.click(await screen.findByRole("button", { name: `Install ${name}` }));
  return screen.findByRole("dialog", { name });
}

const dockge = { id: "dockge", name: "Dockge", category: "Developer", description: "Manage compose stacks", website: null, icon: null, risk: "medium" as const, notes: null, image: { reference: "louislam/dockge:1.5.0", version: "1.5.0" }, ports: [{ id: "web", label: "Web UI", container: 5001, host: 5001, protocol: "tcp", exposure: "lan", fixed: false }], volumes: [], env: [], devices: [], capabilities: [], extraHosts: [], sysctls: [], sidecars: [], network: "bridge", networkVia: null, user: null, command: null, health: { kind: "running", stableSeconds: 1, timeoutSeconds: 10 }, setup: null, sha256: "a" };
const dockgeLive = { ...running("dockge", 5001), state: { ...running("dockge", 5001).state, values: { ports: { web: 5001 }, env: {}, volumes: {} } } };

describe("App catalog: the page", () => {
  it("puts the verdict and the counts first, the installed apps as squares with their health, and the catalog in its own tab", async () => {
    serve(catalogOf([{ manifest, live: absent("jellyfin") }, { manifest: dockge, live: dockgeLive }]));
    render(<CatalogPage csrfToken="csrf-token" />);
    expect(await screen.findByRole("button", { name: "Dockge, Running" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "App catalog" })).toBeTruthy();
    const verdict = document.querySelector(".ui-page-header__verdict");
    expect(verdict?.textContent).toBe("All running");
    expect(verdict?.getAttribute("data-status")).toBe("good");
    expect(document.querySelector(".ui-page-header__meta")?.textContent).toBe("1 installed · 1 running · 0 updates · 2 in the catalog · 2 categories");
    // What is already on this server comes first, in its own tab.
    expect(screen.getByText("1 running of 1 installed")).toBeTruthy();
    expect(screen.queryByText("Jellyfin")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /Catalog/ }));
    expect(window.location.search).toBe("?tab=browse");
    expect(screen.getByRole("heading", { name: /Add something else/ })).toBeTruthy();
    expect(screen.getByText("Jellyfin")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Install Jellyfin" })).toBeTruthy();
  });

  it("searches across name, category and description, in both tabs", async () => {
    serve(catalogOf([{ manifest, live: absent("jellyfin") }, { manifest: dockge, live: dockgeLive }]));
    render(<CatalogPage csrfToken="csrf-token" />);
    await screen.findByRole("button", { name: "Dockge, Running" });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search applications" }), { target: { value: "compose stacks" } });
    expect(screen.getByRole("button", { name: "Dockge, Running" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Catalog/ }));
    expect(screen.getByText("Nothing in the catalog matches that")).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search applications" }), { target: { value: "media" } });
    expect(screen.getByText("Jellyfin")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Category" }), { target: { value: "Developer" } });
    expect(screen.queryByText("Jellyfin")).toBeNull();
  });

  it("says a helper container is broken instead of a green Running", async () => {
    // A VPN sidecar crash-looped for an hour behind a green "Running"; the app container being up
    // is not the app working when the container it routes through is down.
    serve(catalogOf([{ manifest, live: running("jellyfin", 8096, { sidecars: [{ id: "vpn", running: true, status: "restarting", restarts: 5 }] }) }]));
    render(<CatalogPage csrfToken="csrf-token" />);
    const tile = await screen.findByRole("button", { name: "Jellyfin, Running · vpn is restarting" });
    expect(tile.getAttribute("data-status")).toBe("warning");
    expect(document.querySelector(".ui-page-header__verdict")?.textContent).toBe("1 needs a look");
  });

  it("shows a paused app as paused and offers Resume, not Stop-only", async () => {
    // Docker reports a paused container as Running=true: the process exists, it is just frozen.
    // Every check of container.running therefore has to subtract paused.
    serve(catalogOf([{ manifest: dockge, live: { ...dockgeLive, container: { ...dockgeLive.container, running: true, status: "paused" } } }]));
    render(<CatalogPage csrfToken="csrf-token" />);
    expect(await screen.findByText("0 running of 1 installed")).toBeTruthy();
    const sheet = await openApp("Dockge");
    expect(within(sheet).getByText("Paused")).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: "Resume" })).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: "Restart" })).toBeNull(); // restarting a frozen container is not the offer
  });

  it("lists compose stacks that live here but are not BoxPilot's, in their own tab", async () => {
    serve(catalogOf([]), (url) => {
      if (url === "/api/v1/operations/compose.projects.inspect/inspect") return json({ operation: "compose.projects.inspect", result: { available: true, projects: [{ name: "old-wordpress", status: "exited(2)", configFiles: ["/opt/wordpress/docker-compose.yml"] }, { name: "handmade", status: "running(3)", configFiles: ["/home/user/compose.yaml"] }] } });
      if (url.endsWith("/operations/compose.project.logs/run")) return json({ result: { name: "handmade", lines: ["stack says hello"] } });
      return undefined;
    });
    render(<CatalogPage csrfToken="csrf-token" />);
    fireEvent.click(await screen.findByRole("tab", { name: /Other stacks/ }));
    expect(await screen.findByText("old-wordpress")).toBeTruthy();
    expect(screen.getByText("/opt/wordpress/docker-compose.yml")).toBeTruthy();
    // An exited stack offers Start; a running one offers Stop and Restart. Both offer Logs.
    expect(screen.getByRole("button", { name: "Start old-wordpress" }).getAttribute("data-risk")).toBe("medium");
    expect(screen.getByRole("button", { name: "Stop handmade" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restart handmade" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Logs of handmade" }));
    const sheet = await screen.findByRole("dialog", { name: "handmade" });
    expect(await within(sheet).findByText("stack says hello")).toBeTruthy();
  });

  // Logs that answered late went into whatever sheet was open then: another stack's, or a closed one.
  it("never shows a stack's late logs in a closed sheet or another stack's", async () => {
    const answers = new Map<string, () => void>();
    serve(catalogOf([]), (url, init) => {
      if (url === "/api/v1/operations/compose.projects.inspect/inspect") return json({ operation: "compose.projects.inspect", result: { available: true, projects: [{ name: "old-wordpress", status: "exited(2)", configFiles: ["/opt/wordpress/docker-compose.yml"] }, { name: "handmade", status: "running(3)", configFiles: ["/home/user/compose.yaml"] }] } });
      if (url.endsWith("/operations/compose.project.logs/run")) {
        const name = (JSON.parse(String(init?.body)) as { parameters: { name: string } }).parameters.name;
        return new Promise<Response>((resolve) => { answers.set(name, () => resolve(json({ result: { name, lines: [`logs of ${name}`] } }))); });
      }
      return undefined;
    });
    render(<CatalogPage csrfToken="csrf-token" />);
    fireEvent.click(await screen.findByRole("tab", { name: /Other stacks/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Logs of handmade" }));
    fireEvent.keyDown(await screen.findByRole("dialog", { name: "handmade" }), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Logs of old-wordpress" }));
    const sheet = await screen.findByRole("dialog", { name: "old-wordpress" });
    await waitFor(() => expect(answers.size).toBe(2));
    answers.get("handmade")!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByRole("dialog", { name: "old-wordpress" }).textContent).not.toContain("logs of handmade");
    fireEvent.keyDown(sheet, { key: "Escape" });
    answers.get("old-wordpress")!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens straight at an app's sheet from a link, and leaves the address when it closes", async () => {
    window.history.replaceState(null, "", "/?view=catalog&app=jellyfin");
    serve(catalogOf([{ manifest, live: absent("jellyfin") }, { manifest: dockge, live: dockgeLive }]));
    render(<CatalogPage csrfToken="csrf-token" focusApp="jellyfin" />);
    const sheet = await screen.findByRole("dialog", { name: "Jellyfin" });
    expect(within(sheet).getByText("Not installed", { selector: ".ui-chip" })).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: "Install" })).toBeTruthy();
    // Not installed, so the page behind it is on the catalog.
    expect(screen.getByRole("tab", { name: /Catalog/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(sheet, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(new URLSearchParams(window.location.search).get("app")).toBeNull();
    expect(new URLSearchParams(window.location.search).get("view")).toBe("catalog");
  });

  it("opens at a tab of the sheet when the link names one, and keeps the tab in the address", async () => {
    window.history.replaceState(null, "", "/?view=catalog&app=jellyfin&sheet=backups");
    serve(catalogOf([{ manifest, live: running("jellyfin") }]), (url) => (url.endsWith("/operations/app.backups.inspect/run") ? json({ result: { id: "jellyfin", backups: [] } }) : undefined));
    render(<CatalogPage csrfToken="csrf-token" focusApp="jellyfin" />);
    const sheet = await screen.findByRole("dialog", { name: "Jellyfin" });
    expect(within(sheet).getByRole("tab", { name: "Backups" }).getAttribute("aria-selected")).toBe("true");
    expect(await within(sheet).findByText("No backups yet")).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("tab", { name: "Reach" }));
    expect(new URLSearchParams(window.location.search).get("sheet")).toBe("reach");
    fireEvent.click(within(sheet).getByRole("tab", { name: "Overview" }));
    expect(new URLSearchParams(window.location.search).get("sheet")).toBeNull();
  });

  it("gives a viewer the apps and their facts, and nothing that would run", async () => {
    serve(catalogOf([{ manifest, live: running("jellyfin") }, { manifest: dockge, live: absent("dockge") }]));
    render(<CatalogPage csrfToken="csrf-token" role="viewer" />);
    const sheet = await openApp("Jellyfin");
    expect(within(sheet).queryAllByRole("button").filter((button) => button.hasAttribute("data-risk"))).toEqual([]);
    expect(within(sheet).queryByRole("tab", { name: "Logs" })).toBeNull();
    expect(within(sheet).queryByRole("tab", { name: "Backups" })).toBeNull();
    fireEvent.keyDown(sheet, { key: "Escape" });
    fireEvent.click(screen.getByRole("tab", { name: /Catalog/ }));
    expect(screen.queryByRole("button", { name: "Install Dockge" })).toBeNull();
  });

  it("says when the catalog could not be read, never that all is running", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "The helper is not answering" }, 503)));
    render(<CatalogPage csrfToken="csrf-token" />);
    expect(await screen.findByText("The helper is not answering")).toBeTruthy();
    const verdict = document.querySelector(".ui-page-header__verdict");
    expect(verdict?.textContent).toBe("Not read");
    expect(verdict?.getAttribute("data-status")).toBe("unknown");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

describe("App catalog: installing", () => {
  it("offers setup choices with the recommended ones pre-ticked and stages them with the install", async () => {
    let stagedBody: string | undefined;
    serve(catalogOf([{ manifest: dnsManifest, live: absent("pi-hole") }]), (url, init) => {
      if (url.endsWith("/catalog/pi-hole/precheck")) return json({ ok: true, errors: [], conflicts: [] });
      if (url.endsWith("/operations/app.install/jobs")) { stagedBody = init?.body as string; return stagedJob("app.install", "high", true); }
      return undefined;
    });
    render(<CatalogPage csrfToken="csrf-token" />);
    // Nothing installed yet: the first tab says so and points at the catalog.
    expect(await screen.findByText("No apps installed yet")).toBeTruthy();
    const sheet = await openInstall("Pi-hole");
    expect(within(sheet).getByText("Blocklists")).toBeTruthy();
    expect((within(sheet).getByLabelText("OISD big") as HTMLInputElement).checked).toBe(true);
    expect((within(sheet).getByLabelText("HaGeZi Threat Intelligence Feeds") as HTMLInputElement).checked).toBe(false);
    expect((within(sheet).getByRole("link", { name: "Learn more" }) as HTMLAnchorElement).href).toBe("https://oisd.nl/");
    fireEvent.click(within(sheet).getByLabelText("HaGeZi Threat Intelligence Feeds"));
    const install = within(sheet).getByRole("button", { name: "Continue to install" });
    expect(install.getAttribute("data-risk")).toBe("medium");
    fireEvent.click(install);
    expect(await screen.findByText("High risk")).toBeTruthy();
    await waitFor(() => expect(JSON.parse(stagedBody ?? "{}")).toEqual({ parameters: { id: "pi-hole", values: { ports: {}, env: {}, volumes: {}, setup: ["oisd-big", "hagezi-tif"] } } }));
  });

  it("collects install settings in a sheet and stages app.install through the approval dialog", async () => {
    let stagedBody: string | undefined;
    serve(catalogOf([{ manifest, live: absent("jellyfin") }]), (url, init) => {
      if (url.endsWith("/catalog/jellyfin/precheck")) return json({ ok: true, errors: [], conflicts: [] });
      if (url.endsWith("/operations/app.install/jobs")) { stagedBody = init?.body as string; return stagedJob("app.install"); }
      return undefined;
    });
    render(<CatalogPage csrfToken="csrf-token" />);
    const sheet = await openInstall("Jellyfin");
    fireEvent.change(within(sheet).getByLabelText("Web UI port"), { target: { value: "8097" } });
    fireEvent.change(within(sheet).getByLabelText("Media library"), { target: { value: "/mnt/media" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Continue to install" }));
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Jellyfin" })).toBeNull();
    expect(JSON.parse(stagedBody ?? "{}")).toEqual({ parameters: { id: "jellyfin", values: { ports: { web: 8097 }, env: {}, volumes: { media: "/mnt/media" } } } });
  });

  it("marks Install with the tier the server will approve it at: the manifest's, when higher", async () => {
    // Installing a DNS server the house leans on is high since the security audit; the button said medium.
    serve(catalogOf([{ manifest: { ...dnsManifest, risk: "high" }, live: absent("pi-hole") }, { manifest, live: absent("jellyfin") }]), (url) => (url.endsWith("/precheck") ? json({ ok: true, errors: [], conflicts: [] }) : undefined));
    render(<CatalogPage csrfToken="csrf-token" />);
    fireEvent.click(await screen.findByRole("tab", { name: /Catalog/ }));
    expect((await screen.findByRole("button", { name: "Install Pi-hole" })).getAttribute("data-risk")).toBe("high");
    expect(screen.getByRole("button", { name: "Install Jellyfin" }).getAttribute("data-risk")).toBe("medium");
    fireEvent.click(screen.getByRole("button", { name: "Install Pi-hole" }));
    const sheet = await screen.findByRole("dialog", { name: "Pi-hole" });
    expect(within(sheet).getByRole("button", { name: /Continue to install/ }).getAttribute("data-risk")).toBe("high");
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    // The app's own sheet says the same.
    fireEvent.click(await screen.findByRole("button", { name: /^Pi-hole: / }));
    const app = await screen.findByRole("dialog", { name: "Pi-hole" });
    expect(within(app).getByRole("button", { name: "Install" }).getAttribute("data-risk")).toBe("high");
  });

  it("opens the app on the Installed tab once its install has finished, rather than leaving it to vanish from the list", async () => {
    let installed = false;
    serve(catalogOf([{ manifest, live: absent("jellyfin") }]), (url) => {
      if (url.endsWith("/catalog/jellyfin/precheck")) return json({ ok: true, errors: [], conflicts: [] });
      if (url.endsWith("/operations/app.install/jobs")) return stagedJob("app.install");
      if (url.endsWith("/jobs/job-app.install/approve")) return json({ job: { id: "job-app.install", state: "applying" }, elevatedUntil: null }, 202);
      if (url.endsWith("/jobs/job-app.install")) { installed = true; return json({ job: { id: "job-app.install", type: "op:app.install", title: "Install Jellyfin", state: "completed", risk: "medium", error: null, result: {}, steps: [], approvals: [] } }); }
      if (url === "/api/v1/catalog" && installed) return json(catalogOf([{ manifest, live: running("jellyfin") }]));
      return undefined;
    });
    render(<CatalogPage csrfToken="csrf-token" />);
    const sheet = await openInstall("Jellyfin");
    fireEvent.click(within(sheet).getByRole("button", { name: "Continue to install" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm and run" }));
    fireEvent.click(await screen.findByRole("button", { name: "Close" }, { timeout: 4000 }));
    expect(await screen.findByRole("dialog", { name: "Jellyfin" })).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("tab")).not.toBe("browse");
    expect(screen.getByRole("tab", { name: /Installed|On this server/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("goes back to the app's sheet when an action started there is approved or cancelled", async () => {
    serve(catalogOf([{ manifest, live: running("jellyfin") }]), (url) => (url.includes("/jobs") ? stagedJob("app.action") : undefined));
    render(<CatalogPage csrfToken="csrf-token" />);
    const sheet = await openApp("Jellyfin");
    fireEvent.click(within(sheet).getByRole("button", { name: /^Restart/ }));
    expect(screen.queryByRole("dialog", { name: "Jellyfin" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("dialog", { name: "Jellyfin" })).toBeTruthy();
  });

  it("says what the precheck found, and stages nothing", async () => {
    const staged = vi.fn();
    serve(catalogOf([{ manifest, live: absent("jellyfin") }]), (url) => {
      if (url.endsWith("/catalog/jellyfin/precheck")) return json({ ok: false, errors: [], conflicts: [{ label: "Web UI", port: 8096, protocol: "tcp", listeners: ["0.0.0.0:8096"], containers: [{ name: "emby", app: "emby", composeProject: null }] }] });
      if (url.endsWith("/jobs")) { staged(); return stagedJob("app.install"); }
      return undefined;
    });
    render(<CatalogPage csrfToken="csrf-token" />);
    const sheet = await openInstall("Jellyfin");
    fireEvent.click(within(sheet).getByRole("button", { name: "Continue to install" }));
    expect(await within(sheet).findByText(/port 8096\/tcp is already in use on this server by emby/)).toBeTruthy();
    expect(staged).not.toHaveBeenCalled();
  });

  it("contains the form's focus and returns to Install when Escape closes it", async () => {
    serve(catalogOf([{ manifest, live: absent("jellyfin") }]));
    render(<CatalogPage csrfToken="csrf-token" />);
    fireEvent.click(await screen.findByRole("tab", { name: /Catalog/ }));
    const opener = await screen.findByRole("button", { name: "Install Jellyfin" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(document.activeElement).toBe(dialog));
    fireEvent.keyDown(document, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("offers the server's mounted drives and network shares as a folder list at setup", async () => {
    serve(catalogOf([{ manifest, live: absent("jellyfin") }]), (url) => {
      if (url === "/api/v1/storage/overview") return json({ mounts: [{ target: "/mnt/the-dump" }, { target: "/" }], shares: [{ mountpoint: "/mnt/nas-media" }], fstab: [] });
      return undefined;
    });
    render(<CatalogPage csrfToken="csrf-token" />);
    const sheet = await openInstall("Jellyfin");
    const input = within(sheet).getByLabelText("Media library") as HTMLInputElement;
    const options = await waitFor(() => {
      const list = document.getElementById(input.getAttribute("list") ?? "");
      const values = list ? [...list.querySelectorAll("option")].map((option) => (option as HTMLOptionElement).value) : [];
      expect(values).toContain("/mnt/the-dump");
      return values;
    });
    expect(options).toContain("/mnt/nas-media"); // a network share, offered too
    expect(options).not.toContain("/"); // system mounts are filtered out
  });

  it("offers a network-mode choice at install and sends it when it differs from the default", async () => {
    const hole = { ...dockge, id: "pi-hole", name: "Pi-hole", description: "DNS blocker", network: "bridge", networkModes: ["bridge", "host"], ports: [{ id: "web", label: "Admin UI", container: 80, host: 8084, protocol: "tcp", exposure: "lan", fixed: false }], env: [], signIn: null };
    let staged: string | undefined;
    serve(catalogOf([{ manifest: hole, live: absent("pi-hole") }]), (url, init) => {
      if (url.endsWith("/precheck")) return json({ ok: true, errors: [], conflicts: [] });
      if (url.endsWith("/operations/app.install/jobs")) { staged = init?.body as string; return stagedJob("app.install", "high", true); }
      return undefined;
    });
    render(<CatalogPage csrfToken="csrf-token" />);
    const sheet = await openInstall("Pi-hole");
    const select = within(sheet).getByLabelText("Network mode") as HTMLSelectElement;
    expect(select.value).toBe("bridge"); // the first offered mode
    fireEvent.change(select, { target: { value: "host" } });
    expect(within(sheet).getByText(/Shares this server's network/)).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: "Continue to install" }));
    await waitFor(() => expect(JSON.parse(staged ?? "{}").parameters.values.networkMode).toBe("host"));
  });

  it("lets you choose the sign-in password at install, and otherwise generates it", async () => {
    const hole = { ...dockge, id: "pi-hole", name: "Pi-hole", description: "DNS blocker", ports: [{ id: "web", label: "Admin UI", container: 80, host: 8084, protocol: "tcp", exposure: "lan", fixed: false }], env: [{ name: "FTLCONF_webserver_api_password", label: "Admin password", description: null, type: "password", default: null, required: false, secret: true, generate: true, options: null, fixed: false }, { name: "DB_PASSWORD", label: "Database password", description: null, type: "password", default: null, required: false, secret: true, generate: true, options: null, fixed: false }], signIn: { path: "/admin/", port: null, username: null, usernameEnv: null, passwordEnv: "FTLCONF_webserver_api_password", note: null } };
    let staged: string | undefined;
    serve(catalogOf([{ manifest: hole, live: absent("pi-hole") }]), (url, init) => {
      if (url.endsWith("/precheck")) return json({ ok: true, errors: [], conflicts: [] });
      if (url.endsWith("/operations/app.install/jobs")) { staged = init?.body as string; return stagedJob("app.install", "high", true); }
      return undefined;
    });
    render(<CatalogPage csrfToken="csrf-token" />);
    const sheet = await openInstall("Pi-hole");
    // The sign-in password is offered; the database password is not something anyone types.
    const field = within(sheet).getByLabelText("Admin password");
    expect(within(sheet).queryByLabelText("Database password")).toBeNull();
    expect(within(sheet).getByText(/Generated for you: Database password/)).toBeTruthy();
    fireEvent.change(field, { target: { value: "my own password" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Continue to install" }));
    await waitFor(() => expect(JSON.parse(staged ?? "{}").parameters.values.env).toEqual({ FTLCONF_webserver_api_password: "my own password" }));
  });

  it.each(["port", "origin"])("prechecks effective settings while staging only the changed %s", async (changed) => {
    const origin = "https://portal.example.test";
    const app = { ...dockge, env: [{ name: "PUBLIC_URL", label: "Portal origin", description: null, type: "string", default: null, required: true, secret: false, generate: false, options: null, fixed: false }] };
    const live = { ...dockgeLive, state: { ...dockgeLive.state, values: { ports: { web: 5002 }, env: { PUBLIC_URL: origin }, volumes: {} } } };
    let checked: { ports: Record<string, number>; env: Record<string, string> } | undefined;
    let staged: string | undefined;
    serve(catalogOf([{ manifest: app, live }]), (url, init) => {
      if (url.endsWith("/precheck")) {
        checked = JSON.parse(init?.body as string).values;
        return checked?.env.PUBLIC_URL ? json({ ok: true, errors: [], conflicts: [] }) : json({ ok: false, errors: ["PUBLIC_URL is required"], conflicts: [] }, 400);
      }
      if (url.endsWith("/operations/app.reconfigure/jobs")) { staged = init?.body as string; return stagedJob("app.reconfigure"); }
      return undefined;
    });
    render(<CatalogPage csrfToken="csrf-token" />);
    const sheet = await openApp("Dockge");
    fireEvent.click(within(sheet).getByRole("button", { name: "Settings" }));
    const form = await screen.findByRole("dialog", { name: "Dockge" });
    if (changed === "port") fireEvent.change(within(form).getByRole("spinbutton", { name: "Web UI port" }), { target: { value: "5001" } });
    else fireEvent.change(within(form).getByLabelText(/Portal origin/), { target: { value: `${origin}/new` } });
    fireEvent.click(within(form).getByRole("button", { name: "Apply settings" }));
    await waitFor(() => expect(staged).toBeDefined());
    expect(checked).toEqual({ ports: changed === "port" ? {} : { web: 5002 }, env: { PUBLIC_URL: changed === "port" ? origin : `${origin}/new` }, volumes: {} });
    expect(JSON.parse(staged!).parameters.values).toEqual({ ports: changed === "port" ? { web: 5001 } : {}, env: changed === "port" ? {} : { PUBLIC_URL: `${origin}/new` }, volumes: {} });
  });

  it("puts the install form back as it was filled in when its approval is cancelled", async () => {
    // The form closed before the approval opened, and cancelling the approval opened only the app's
    // sheet: everything typed into the form was gone.
    serve(catalogOf([{ manifest, live: absent("jellyfin") }]), (url) => {
      if (url.endsWith("/catalog/jellyfin/precheck")) return json({ ok: true, errors: [], conflicts: [] });
      if (url.endsWith("/operations/app.install/jobs")) return stagedJob("app.install");
      if (url.endsWith("/jobs/job-app.install")) return json({ job: { id: "job-app.install", state: "cancelled" } });
      return undefined;
    });
    render(<CatalogPage csrfToken="csrf-token" />);
    const sheet = await openInstall("Jellyfin");
    fireEvent.change(within(sheet).getByLabelText("Web UI port"), { target: { value: "8097" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Continue to install" }));
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const form = await screen.findByRole("dialog", { name: "Jellyfin" });
    expect(within(form).getByText("Install", { selector: ".ui-sheet__kicker" })).toBeTruthy();
    expect((within(form).getByLabelText("Web UI port") as HTMLInputElement).value).toBe("8097");
  });

  it("puts the settings form back as it was when the job fails, and the app's sheet once one succeeds", async () => {
    let outcome = "failed";
    serve(catalogOf([{ manifest: dockge, live: dockgeLive }]), (url) => {
      if (url.endsWith("/catalog/dockge/precheck")) return json({ ok: true, errors: [], conflicts: [] });
      if (url.endsWith("/operations/app.reconfigure/jobs")) return stagedJob("app.reconfigure");
      if (url.endsWith("/jobs/job-app.reconfigure/approve")) return json({ job: { id: "job-app.reconfigure", state: "applying" }, elevatedUntil: null }, 202);
      if (url.endsWith("/jobs/job-app.reconfigure")) return json({ job: { id: "job-app.reconfigure", type: "op:app.reconfigure", title: "Change Dockge settings", state: outcome, risk: "medium", error: outcome === "failed" ? "port 5002 is taken" : null, result: {}, steps: [], approvals: [] } });
      return undefined;
    });
    render(<CatalogPage csrfToken="csrf-token" />);
    const sheet = await openApp("Dockge");
    fireEvent.click(within(sheet).getByRole("button", { name: "Settings" }));
    let form = await screen.findByRole("dialog", { name: "Dockge" });
    fireEvent.change(within(form).getByLabelText("Web UI port"), { target: { value: "5002" } });
    fireEvent.click(within(form).getByRole("button", { name: "Apply settings" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm and run" }));
    fireEvent.click(await screen.findByRole("button", { name: "Close" }, { timeout: 4000 }));
    form = await screen.findByRole("dialog", { name: "Dockge" });
    expect(within(form).getByText("Settings", { selector: ".ui-sheet__kicker" })).toBeTruthy();
    expect((within(form).getByLabelText("Web UI port") as HTMLInputElement).value).toBe("5002");
    outcome = "completed";
    fireEvent.click(within(form).getByRole("button", { name: "Apply settings" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm and run" }));
    fireEvent.click(await screen.findByRole("button", { name: "Close" }, { timeout: 4000 }));
    const back = await screen.findByRole("dialog", { name: "Dockge" });
    expect(within(back).getByRole("tab", { name: "Overview" })).toBeTruthy();
  });

  it("goes back to the app's sheet when its settings are cancelled", async () => {
    serve(catalogOf([{ manifest: dockge, live: dockgeLive }]));
    render(<CatalogPage csrfToken="csrf-token" />);
    const sheet = await openApp("Dockge");
    fireEvent.click(within(sheet).getByRole("button", { name: "Settings" }));
    const form = await screen.findByRole("dialog", { name: "Dockge" });
    expect(within(form).getByText("Settings", { selector: ".ui-sheet__kicker" })).toBeTruthy();
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    const back = await screen.findByRole("dialog", { name: "Dockge" });
    expect(within(back).getByRole("tab", { name: "Overview" })).toBeTruthy();
  });
});

describe("App catalog: an installed app's sheet", () => {
  it("offers lifecycle, update, uninstall and purge, each at its tier", async () => {
    serve(catalogOf([{ manifest, live: running("jellyfin") }]));
    render(<CatalogPage csrfToken="csrf-token" />);
    const sheet = await openApp("Jellyfin");
    expect(within(sheet).getByText("Running and healthy")).toBeTruthy();
    // The page itself came from localhost here, so the LAN address is the only useful guess.
    expect((within(sheet).getByRole("link", { name: "Open Web UI" }) as HTMLAnchorElement).href).toBe("http://192.168.1.10:8096/");
    for (const [name, tier] of [["Restart", "low"], ["Stop", "low"], ["Update", "medium"], ["Back up", "medium"], ["Uninstall", "medium"], ["Delete data", "high"]]) {
      expect(within(sheet).getByRole("button", { name }).getAttribute("data-risk")).toBe(tier);
    }
    expect(within(sheet).getByRole("button", { name: "Settings" })).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: "Install" })).toBeNull();
    expect(within(sheet).getByText("Setup wizard on first run")).toBeTruthy();
    for (const tab of ["Reach", "Backups", "Logs", "Config"]) expect(within(sheet).getByRole("tab", { name: tab })).toBeTruthy();
  });

  // M38: what an app's manifest offers to do inside it, like Zulip's "Create your organization".
  const zulip = {
    ...manifest, id: "zulip", name: "Zulip", category: "Communication", description: "Team chat", notes: null, defaultExposure: "tailnet",
    ports: [{ id: "web", label: "Web UI and apps", container: 80, host: 8543, protocol: "tcp", exposure: "lan", fixed: false }], volumes: [], env: [],
    actions: [{ id: "create-organization", label: "Create your organization", description: "Zulip makes a single-use link.", operation: "app.zulip.organization.link" }],
  };
  it("offers the app's own actions to the owner, and stages them with the app's id", async () => {
    let staged: string | undefined;
    serve(catalogOf([{ manifest: zulip, live: running("zulip", 8543) }]), (url, init) => {
      if (url.endsWith("/operations/app.zulip.organization.link/jobs")) { staged = init?.body as string; return stagedJob("app.zulip.organization.link"); }
      return undefined;
    });
    render(<CatalogPage csrfToken="csrf-token" />);
    const sheet = await openApp("Zulip");
    expect(within(sheet).getByRole("heading", { name: "In Zulip" })).toBeTruthy();
    expect(within(sheet).getByText("Zulip makes a single-use link.")).toBeTruthy();
    const button = within(sheet).getByRole("button", { name: "Create your organization" });
    expect(button.getAttribute("data-risk")).toBe("medium");
    fireEvent.click(button);
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    expect(JSON.parse(staged ?? "{}")).toEqual({ parameters: { id: "zulip" } });
  });

  it("keeps an owner-only action from an operator, and waits for a stopped app", async () => {
    serve(catalogOf([{ manifest: zulip, live: running("zulip", 8543) }]));
    render(<CatalogPage csrfToken="csrf-token" role="operator" />);
    const sheet = await openApp("Zulip");
    expect(within(sheet).queryByRole("button", { name: "Create your organization" })).toBeNull();
    cleanup();
    serve(catalogOf([{ manifest: zulip, live: running("zulip", 8543, { container: { exists: true, running: false, status: "exited", health: "none", restarts: 0, image: "sha256:1" } }) }]));
    render(<CatalogPage csrfToken="csrf-token" />);
    const stopped = await openApp("Zulip");
    expect((within(stopped).getByRole("button", { name: "Create your organization" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(stopped).getByText("Zulip is not running; start it first.")).toBeTruthy();
  });

  it("says at install that a tailnet-only app is published with Tailscale Serve", async () => {
    serve(catalogOf([{ manifest: zulip, live: absent("zulip") }]));
    render(<CatalogPage csrfToken="csrf-token" />);
    const sheet = await openInstall("Zulip");
    expect(within(sheet).getByText(/Reached through Tailscale only: its web page stays on this server and Tailscale Serve publishes it/)).toBeTruthy();
    expect(within(sheet).getByText(/your tailnet, over HTTPS/)).toBeTruthy();
  });

  it("closes the sheet and stages an update through the approval dialog", async () => {
    let staged: string | undefined;
    serve(catalogOf([{ manifest, live: running("jellyfin", 8096, { updateAvailable: true, installedImage: "jellyfin/jellyfin:10.10.6" }) }]), (url, init) => {
      if (url.endsWith("/operations/app.update/jobs")) { staged = init?.body as string; return stagedJob("app.update"); }
      return undefined;
    });
    render(<CatalogPage csrfToken="csrf-token" />);
    expect(await screen.findByText("Update ready")).toBeTruthy();
    const sheet = await openApp("Jellyfin");
    expect(within(sheet).getByText(/update ready: jellyfin\/jellyfin:10.10.6 → jellyfin\/jellyfin:10.10.7/)).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: "Update available" }));
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Jellyfin" })).toBeNull();
    expect(JSON.parse(staged ?? "{}")).toEqual({ parameters: { id: "jellyfin" } });
  });

  it("shows where an installed app's data lives, so a wrong drive is obvious at a glance", async () => {
    const withWritableVolume = { ...manifest, volumes: [{ id: "media", label: "Downloads", container: "/data", path: null, hostPath: "/srv/media", readOnly: false, backup: false, configurable: true, description: null }] };
    serve(catalogOf([{ manifest: withWritableVolume, live: running("jellyfin", 8096, { state: { ...running("jellyfin").state, values: { ports: {}, env: {}, volumes: { media: "/mnt/the-dump/torrents" } } } }) }]));
    render(<CatalogPage csrfToken="csrf-token" />);
    const sheet = await openApp("Jellyfin");
    // The chosen path wins over the manifest default, so the sheet shows where the data actually is.
    expect(within(sheet).getByText("/mnt/the-dump/torrents")).toBeTruthy();
  });

  it("says an app cannot write to its folder, and offers the fix at its tier", async () => {
    let staged: string | undefined;
    serve(catalogOf([{ manifest, live: running("jellyfin", 8096, { folderProblems: [{ path: "/mnt/media", volume: "media", reason: "owned by root" }] }) }]), (url, init) => {
      if (url.endsWith("/operations/app.reconfigure/jobs")) { staged = init?.body as string; return stagedJob("app.reconfigure"); }
      return undefined;
    });
    render(<CatalogPage csrfToken="csrf-token" />);
    const tile = await screen.findByRole("button", { name: "Jellyfin, Cannot write to its folder" });
    expect(tile.getAttribute("data-status")).toBe("danger");
    const sheet = await openApp("Jellyfin");
    expect(within(sheet).getByText(/owned by root/)).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: "Fix folder access" }));
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    expect(JSON.parse(staged ?? "{}")).toEqual({ parameters: { id: "jellyfin", values: {} } });
  });

  it("closes on Escape and gives focus back to the app's square", async () => {
    serve(catalogOf([{ manifest, live: running("jellyfin") }]));
    render(<CatalogPage csrfToken="csrf-token" />);
    const opener = await screen.findByRole("button", { name: "Jellyfin, Running" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "Jellyfin" });
    await waitFor(() => expect(document.activeElement).toBe(dialog));
    expect(new URLSearchParams(window.location.search).get("app")).toBe("jellyfin");
    fireEvent.keyDown(document, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("shows where a tunneled app's traffic leaves, and proves its kill switch", async () => {
    const tunneled = { ...manifest, id: "qbt", name: "qBittorrent", networkVia: "vpn", sidecars: [{ id: "vpn" }] };
    let staged: string | undefined;
    serve(catalogOf([{ manifest: tunneled, live: running("qbt", 8080, { urls: [], sidecars: [{ id: "vpn", running: true, status: "running", restarts: 0 }] }) }]), (url, init) => {
      if (url === "/api/v1/operations/app.vpn.inspect/run") return json({ operation: "app.vpn.inspect", result: { id: "qbt", tunneled: true, sidecarId: "vpn", running: true, status: "running", exit: { ip: "212.92.104.227", location: "Netherlands, North Brabant, Breda", at: "x" }, forwardedPort: 51413 } });
      if (url.endsWith("/operations/app.vpn.killswitch.drill/jobs")) { staged = init?.body as string; return stagedJob("app.vpn.killswitch.drill"); }
      return undefined;
    });
    render(<CatalogPage csrfToken="csrf-token" />);
    await screen.findByRole("button", { name: /^qBittorrent, / });
    await waitFor(() => expect(document.querySelector(".ui-page-header__meta")).toBeTruthy());
    const sheet = await openApp("qBittorrent");
    expect(await within(sheet).findByText("Netherlands, North Brabant, Breda · 212.92.104.227")).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("tab", { name: "VPN" }));
    expect(within(sheet).getByText("51413")).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: "Verify weekly" })).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: "Prove the kill switch" }));
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    expect(JSON.parse(staged ?? "{}")).toEqual({ parameters: { id: "qbt" } });
  });

  it("puts the sign-in page, the password and a way to change it in one place", async () => {
    const hole = { ...dockge, id: "pi-hole", name: "Pi-hole", description: "DNS blocker", ports: [{ id: "web", label: "Admin UI", container: 80, host: 8084, protocol: "tcp", exposure: "lan", fixed: false }], env: [{ name: "FTLCONF_webserver_api_password", label: "Admin password", description: null, type: "password", default: null, required: false, secret: true, generate: true, options: null, fixed: false }], signIn: { path: "/admin/", port: null, username: null, usernameEnv: null, passwordEnv: "FTLCONF_webserver_api_password", note: "Change it here, not inside Pi-hole." } };
    const live = { ...dockgeLive, id: "pi-hole", state: { ...dockgeLive.state, values: { ports: { web: 8084 }, env: {}, volumes: {} } }, urls: [{ id: "web", label: "Admin UI", host: 8084, exposure: "lan", path: "/admin/" }] };
    let staged: string | undefined;
    serve(catalogOf([{ manifest: hole, live }]), (url, init) => {
      if (url.endsWith("/operations/app.secrets/run")) return json({ result: { secrets: [{ name: "FTLCONF_webserver_api_password", label: "Admin password", value: "s3cret-generated" }] } });
      if (url.endsWith("/operations/app.password.set/jobs")) { staged = init?.body as string; return stagedJob("app.password.set"); }
      return undefined;
    });
    render(<CatalogPage csrfToken="csrf-token" />);
    const sheet = await openApp("Pi-hole");
    fireEvent.click(within(sheet).getByRole("tab", { name: "Sign-in" }));
    const link = within(sheet).getByRole("link", { name: "Open Pi-hole's sign-in page" });
    expect((link as HTMLAnchorElement).href).toMatch(/:8084\/admin\/$/);
    expect(within(sheet).getByText(/asks only for the password/)).toBeTruthy();
    expect(within(sheet).getByText("Change it here, not inside Pi-hole.")).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: "Reveal" }));
    expect(((await within(sheet).findByLabelText("Admin password")) as HTMLInputElement).value).toBe("s3cret-generated");
    fireEvent.change(within(sheet).getByLabelText("New password"), { target: { value: "a better password" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Change password" }));
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    await waitFor(() => expect(JSON.parse(staged ?? "{}")).toEqual({ parameters: { id: "pi-hole", password: "a better password" } }));
  });

  it("asks for the owner's password before it shows an app's secrets", async () => {
    const vault = { ...dockge, id: "vault", name: "Vault", env: [{ name: "ADMIN_TOKEN", label: "Admin token", description: null, type: "password", default: null, required: false, secret: true, generate: true, options: null, fixed: false }] };
    let elevated = false;
    serve(catalogOf([{ manifest: vault, live: { ...dockgeLive, id: "vault" } }]), (url) => {
      if (url.endsWith("/auth/elevate")) { elevated = true; return json({ ok: true }); }
      if (url.endsWith("/operations/app.secrets/run")) return elevated ? json({ result: { secrets: [{ name: "ADMIN_TOKEN", label: "Admin token", value: "tok-123" }] } }) : json({ code: "elevation_required", error: "Enter the owner password" }, 401);
      return undefined;
    });
    render(<CatalogPage csrfToken="csrf-token" />);
    const sheet = await openApp("Vault");
    fireEvent.click(within(sheet).getByRole("tab", { name: "Secrets" }));
    fireEvent.change(await within(sheet).findByLabelText("Owner password"), { target: { value: "correct horse battery" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Reveal" }));
    expect(((await within(sheet).findByLabelText("Admin token")) as HTMLInputElement).value).toBe("tok-123");
  });

  it("puts earlier versions a click from going back", async () => {
    let staged: string | undefined;
    serve(catalogOf([{ manifest, live: running("jellyfin", 8096, { updateHistory: [{ at: "2026-08-10T10:00:00.000Z", from: { jellyfin: "jellyfin/jellyfin:10.10.5" }, to: { jellyfin: "jellyfin/jellyfin:10.10.7" } }] }) }]), (url, init) => {
      if (url.endsWith("/operations/app.rollback/jobs")) { staged = init?.body as string; return stagedJob("app.rollback"); }
      return undefined;
    });
    render(<CatalogPage csrfToken="csrf-token" />);
    const sheet = await openApp("Jellyfin");
    fireEvent.click(within(sheet).getByRole("button", { name: "Go back to jellyfin/jellyfin:10.10.5" }));
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    expect(JSON.parse(staged ?? "{}")).toEqual({ parameters: { id: "jellyfin", at: "2026-08-10T10:00:00.000Z" } });
  });

  it("reads an app's logs, and a helper container's", async () => {
    const bodies: unknown[] = [];
    serve(catalogOf([{ manifest: { ...manifest, sidecars: [{ id: "vpn" }] }, live: running("jellyfin") }]), (url, init) => {
      if (url.endsWith("/operations/app.logs/run")) { const parameters = JSON.parse(String(init?.body)).parameters; bodies.push(parameters); return json({ result: { lines: [parameters.container ? "tunnel up" : "server started"] } }); }
      return undefined;
    });
    render(<CatalogPage csrfToken="csrf-token" />);
    const sheet = await openApp("Jellyfin");
    fireEvent.click(within(sheet).getByRole("tab", { name: "Logs" }));
    expect(await within(sheet).findByText("server started")).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("radio", { name: "vpn" }));
    expect(await within(sheet).findByText("tunnel up")).toBeTruthy();
    expect(bodies).toEqual([{ id: "jellyfin", lines: 200 }, { id: "jellyfin", lines: 200, container: "vpn" }]);
  });

  it("says an app with no container has no logs, rather than failing a read that Read again would fail the same way", async () => {
    const fetchMock = serve(catalogOf([{ manifest, live: running("jellyfin", 8096, { container: { exists: false, running: false, status: "absent", health: "none", restarts: 0, image: null } }) }]));
    render(<CatalogPage csrfToken="csrf-token" />);
    const sheet = await openApp("Jellyfin");
    fireEvent.click(within(sheet).getByRole("tab", { name: "Logs" }));
    expect(await within(sheet).findByText("Jellyfin has no container right now")).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: "Read again" })).toBeNull();
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/operations/app.logs/run"))).toBe(false);
  });
});

describe("App catalog: reach", () => {
  it("answers \"Can't reach it?\" with a verdict per address, from the doctor's op", async () => {
    const report = { headline: null, probedFrom: "this server", addresses: [
      { id: "probe-0", portId: "web", portLabel: "Web UI", kind: "lan", url: "http://192.168.1.10:8096", probe: true, note: null, outcome: "answered", status: 200, ms: 14, verdict: "Answers (HTTP 200 in 14ms)." },
      { id: "probe-1", portId: "web", portLabel: "Web UI", kind: "tailnet", url: "http://100.64.0.9:8096", probe: true, note: null, outcome: "timeout", ms: 4000, verdict: "The connection was silently dropped, which is what a firewall in the path looks like." },
    ] };
    serve(catalogOf([{ manifest, live: running("jellyfin") }]), (url, init) => {
      if (url === "/api/v1/operations/app.reachability.inspect/run") {
        expect(JSON.parse(String(init?.body))).toEqual({ parameters: { id: "jellyfin" } });
        return json({ operation: "app.reachability.inspect", result: report });
      }
      return undefined;
    });
    render(<CatalogPage csrfToken="csrf-token" />);
    const sheet = await openApp("Jellyfin");
    fireEvent.click(within(sheet).getByRole("tab", { name: "Reach" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Can't reach it?" }));
    expect(await within(sheet).findByText("Answers (HTTP 200 in 14ms).")).toBeTruthy();
    expect(within(sheet).getByText(/silently dropped/)).toBeTruthy();
    // Once in the address list, once in the doctor's report.
    expect(within(sheet).getAllByText("http://192.168.1.10:8096").length).toBeGreaterThanOrEqual(2);
  });

  it("shows the wiring between apps with real addresses, in both directions", async () => {
    const sonarr = { ...manifest, id: "sonarr", name: "Sonarr", ports: [{ id: "web", label: "Web UI", container: 8989, host: 8989, protocol: "tcp" as const, exposure: "lan" as const, fixed: false }], connections: [
      { app: "jellyfin", role: "library server", where: "Settings, Connect", note: null },
      { app: "prowlarr", role: "indexer source", where: "nothing to do here", note: null },
    ] };
    serve(catalogOf([
      { manifest: sonarr, live: running("sonarr", 8989) },
      { manifest: { ...manifest, id: "jellyfin", name: "Jellyfin" }, live: { ...running("jellyfin"), urls: [{ id: "web", label: "Web UI", host: 8096, exposure: "tailnet" }] } },
      { manifest: { ...manifest, id: "prowlarr", name: "Prowlarr" }, live: null },
    ]));
    render(<CatalogPage csrfToken="csrf-token" />);
    let sheet = await openApp("Sonarr");
    fireEvent.click(within(sheet).getByRole("tab", { name: "Reach" }));
    const wiring = within(sheet).getByRole("region", { name: /Wiring/ });
    // Outgoing: a target moved off the LAN gets the truth, never a dead LAN address.
    expect(within(wiring).getByText(/reachable only through Tailscale right now/)).toBeTruthy();
    expect(within(wiring).queryByText("http://192.168.1.10:8096")).toBeNull();
    expect(within(wiring).getByText(/Install Prowlarr first/)).toBeTruthy();
    fireEvent.keyDown(sheet, { key: "Escape" });
    // Incoming, on Jellyfin's sheet: Sonarr announces itself with this app's address.
    sheet = await openApp("Jellyfin");
    fireEvent.click(within(sheet).getByRole("tab", { name: "Reach" }));
    expect(within(within(sheet).getByRole("region", { name: /Wiring/ })).getByText(/connects here as its library server/)).toBeTruthy();
  });

  it("still offers tailnet-only to an app with no web interface, and does not call it tailnet-only already", async () => {
    // A database has nothing a browser opens, so it has no Open link. It used to lose the exposure
    // switch with it, and an empty link list counted as "every link is loopback".
    const db = { ...dockge, id: "valkey", name: "Valkey", description: "Redis-compatible store", ports: [{ id: "redis", label: "Redis protocol", container: 6379, host: 6379, protocol: "tcp", exposure: "lan", fixed: false, tailnet: "address" }] };
    serve(catalogOf([{ manifest: db, live: { ...dockgeLive, id: "valkey", state: { ...dockgeLive.state, values: { ports: { redis: 6379 }, env: {}, volumes: {} } }, urls: [] } }]));
    render(<CatalogPage csrfToken="csrf-token" />);
    const sheet = await openApp("Valkey");
    expect(within(sheet).queryByRole("link", { name: /^Open / })).toBeNull();
    fireEvent.click(within(sheet).getByRole("tab", { name: "Reach" }));
    expect(within(sheet).getByText(/Your home network; the firewall decides/)).toBeTruthy();
    fireEvent.click(await within(sheet).findByRole("button", { name: "Reach only through Tailscale" }));
    const preview = (await screen.findByText(/Recreates Valkey/)).textContent ?? "";
    expect(preview).toContain("no web interface to publish");
    expect(preview).toContain("Redis protocol does not speak HTTP, so it moves to this server's tailnet address");
  });

  it("says which ports tailnet-only will not move, before you commit to it", async () => {
    // Tailscale Serve can only front a web interface, so an app that also speaks DNS or a sync
    // protocol keeps those ports somewhere they still work. The first version of this would have
    // taken the house's DNS down while reporting that it had succeeded.
    const dns = {
      ...dockge, id: "pi-hole", name: "Pi-hole", description: "Network-wide ad blocking",
      ports: [
        { id: "dns-tcp", label: "DNS (TCP)", container: 53, host: 53, protocol: "tcp", exposure: "lan", fixed: false, tailnet: "unchanged" },
        { id: "dns-udp", label: "DNS (UDP)", container: 53, host: 53, protocol: "udp", exposure: "lan", fixed: false, tailnet: "unchanged" },
        { id: "sync", label: "Peer sync", container: 22000, host: 22000, protocol: "tcp", exposure: "lan", fixed: false, tailnet: "address" },
        { id: "web", label: "Admin UI", container: 80, host: 8084, protocol: "tcp", exposure: "lan", fixed: false },
      ],
    };
    const live = { ...dockgeLive, id: "pi-hole", state: { ...dockgeLive.state, values: { ports: { web: 8084, "dns-tcp": 53, "dns-udp": 53, sync: 22000 }, env: {}, volumes: {} } }, urls: [{ id: "dns-tcp", label: "DNS (TCP)", host: 53, exposure: "lan" }, { id: "web", label: "Admin UI", host: 8084, exposure: "lan" }] };
    serve(catalogOf([{ manifest: dns, live }]));
    render(<CatalogPage csrfToken="csrf-token" />);
    const sheet = await openApp("Pi-hole");
    fireEvent.click(within(sheet).getByRole("tab", { name: "Reach" }));
    fireEvent.click(await within(sheet).findByRole("button", { name: "Reach only through Tailscale" }));
    const preview = (await screen.findByText(/Recreates Pi-hole/)).textContent ?? "";
    expect(preview).toContain("DNS (TCP), DNS (UDP) stay on your home network");
    expect(preview).toContain("Peer sync does not speak HTTP, so it moves to this server's tailnet address");
    // The published address is the admin UI, not whichever port happened to be listed first.
    expect(preview).toContain("ts.net:8084");
    expect(preview).not.toContain("ts.net:53");
  });

  it("lists tailnet addresses that lead nowhere, and withdraws one at its tier", async () => {
    let staged: string | undefined;
    serve(catalogOf([{ manifest, live: running("jellyfin") }]), (url, init) => {
      if (url.includes("app.serve.inspect")) return json({ result: { available: true, serves: [{ dnsName: "box.tail1234.ts.net", port: 8084, target: "http://127.0.0.1:8084" }] } });
      if (url.endsWith("/operations/app.serve.withdraw/jobs")) { staged = init?.body as string; return stagedJob("app.serve.withdraw"); }
      return undefined;
    });
    render(<CatalogPage csrfToken="csrf-token" />);
    expect(await screen.findByText("https://box.tail1234.ts.net:8084")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop publishing port 8084" }));
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    expect(JSON.parse(staged ?? "{}")).toEqual({ parameters: { port: 8084 } });
  });
});

describe("App catalog: where the Open button sends you", () => {
  const catalogBody = catalogOf([{ manifest, live: running("jellyfin") }], { lanAddress: "192.168.1.10", tailscaleDnsName: "box.tail1234.ts.net" });
  const mount = (hostname: string, serves: Array<{ dnsName: string; port: number; target: string | null }> = []) => {
    // jsdom serves from localhost; the page reads window.location.hostname, so stub that.
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, hostname } as Location);
    serve(catalogBody, (url) => (url.includes("app.serve.inspect") ? json({ result: { available: true, serves } }) : undefined));
    render(<CatalogPage csrfToken="csrf-token" />);
  };

  it("uses the address this page was reached on, not the LAN address", async () => {
    // Preferring the LAN address pointed every Open button into the LAN even when BoxPilot was
    // open over the tailnet from somewhere else, and none of them could connect.
    mount("box.tail1234.ts.net");
    const sheet = await openApp("Jellyfin");
    expect((within(sheet).getByRole("link", { name: "Open Web UI" }) as HTMLAnchorElement).href).toBe("http://box:8096/");
  });

  it("uses the HTTPS address when the app is published on the tailnet", async () => {
    // Tailscale Serve holds that port for HTTPS, so a plain http:// link to it answers 400.
    mount("box.tail1234.ts.net", [{ dnsName: "box.tail1234.ts.net", port: 8096, target: "http://127.0.0.1:8096" }]);
    await screen.findByRole("button", { name: /^Jellyfin, / });
    await waitFor(() => expect(document.querySelector(".ui-page-header__meta")).toBeTruthy());
    const sheet = await openApp("Jellyfin");
    await waitFor(() => expect((within(sheet).getByRole("link", { name: "Open Web UI" }) as HTMLAnchorElement).href).toBe("https://box.tail1234.ts.net:8096/"));
  });
});

describe("App catalog: backups", () => {
  const withBackups = (backups: unknown[], other?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined) => serve(catalogOf([{ manifest, live: running("jellyfin") }]), (url, init) => {
    const answer = other?.(url, init);
    if (answer) return answer;
    if (url.endsWith("/operations/app.backups.inspect/run")) return json({ operation: "app.backups.inspect", result: { id: "jellyfin", directory: "/x", backups } });
    return undefined;
  });
  const backup = { artifact: "20260816T030000Z.tar.gz", createdAt: "2026-08-16T03:00:00.000Z", sizeBytes: 2 * 1024 * 1024, downtimeMs: 900, skippedHostPaths: [], image: null };

  it("browses a backup's files and stages a single-file restore", async () => {
    const staged: string[] = [];
    withBackups([backup], (url, init) => {
      if (url.endsWith("/operations/app.backup.files/run")) return json({ operation: "app.backup.files", result: { id: "jellyfin", backup: "20260816T030000Z.tar.gz", files: [{ path: "config", sizeBytes: 0, type: "directory" }, { path: "config/system.xml", sizeBytes: 2048, type: "file" }, { path: "config/users.db", sizeBytes: 40960, type: "file" }], truncated: false } });
      if (url.endsWith("/operations/app.backup.restore-path/jobs")) { staged.push(init?.body as string); return stagedJob("app.backup.restore-path"); }
      return undefined;
    });
    render(<CatalogPage csrfToken="csrf-token" />);
    const sheet = await openApp("Jellyfin");
    fireEvent.click(within(sheet).getByRole("tab", { name: "Backups" }));
    expect(await within(sheet).findByText("under a second")).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: /^Browse / }));
    expect(await within(sheet).findByText("config/users.db")).toBeTruthy();
    fireEvent.change(within(sheet).getByRole("searchbox", { name: "Filter files" }), { target: { value: "system" } });
    expect(within(sheet).queryByText("config/users.db")).toBeNull();
    fireEvent.click(within(sheet).getByRole("button", { name: "Restore config/system.xml" }));
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    expect(JSON.parse(staged[0] ?? "{}")).toEqual({ parameters: { id: "jellyfin", backup: "20260816T030000Z.tar.gz", path: "config/system.xml" } });
  });

  it("puts a whole restore behind the password, and a delete and a rehearsal behind a preview", async () => {
    withBackups([backup]);
    render(<CatalogPage csrfToken="csrf-token" />);
    const sheet = await openApp("Jellyfin");
    fireEvent.click(within(sheet).getByRole("tab", { name: "Backups" }));
    await within(sheet).findByText("under a second");
    expect(within(sheet).getByRole("button", { name: /^Restore / }).getAttribute("data-risk")).toBe("high");
    expect(within(sheet).getByRole("button", { name: /^Rehearse restoring / }).getAttribute("data-risk")).toBe("medium");
    expect(within(sheet).getByRole("button", { name: /^Delete / }).getAttribute("data-risk")).toBe("medium");
  });

  // Sweep 4: a whole restore asks the server first what the backup would start. A compose file
  // started exactly as it was backed up, giving the app more than the catalog does, is listed in the
  // dialog and staged allowing exactly that file, with the typed confirmation the server asks for;
  // one that cannot be restored at all says why, and nothing is staged.
  it("shows what a backup's compose file would hand the app, and stages the restore allowing exactly it", async () => {
    const hash = "d".repeat(64);
    const review = { id: "jellyfin", backup: backup.artifact, verbatim: true, reason: "edited", findings: [{ service: "jellyfin", setting: "privileged", value: "true", detail: "runs privileged: every device and capability, no confinement - root on this server", system: true }], refusals: [], sha256: hash, sameAsRunning: false, needsAllow: true };
    const staged: string[] = [];
    withBackups([backup], (url, init) => {
      if (url.endsWith("/operations/app.backup.review/run")) return json({ operation: "app.backup.review", result: review });
      if (url.endsWith("/operations/app.backup.restore/jobs")) {
        staged.push(init?.body as string);
        return json({ job: { id: "job-restore", type: "op:app.backup.restore", title: "restore", state: "awaiting_approval", risk: "high", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "high", passwordRequired: true, elevated: false, mode: "tiered", reason: "high", confirmText: "allow jellyfin" } }, 201);
      }
      return undefined;
    });
    render(<CatalogPage csrfToken="csrf-token" />);
    const sheet = await openApp("Jellyfin");
    fireEvent.click(within(sheet).getByRole("tab", { name: "Backups" }));
    await within(sheet).findByText("under a second");
    fireEvent.click(within(sheet).getByRole("button", { name: /^Restore / }));
    expect(await screen.findByText("Jellyfin's compose file would start exactly as it was backed up")).toBeTruthy();
    expect(screen.getByText(/runs privileged: every device and capability/)).toBeTruthy();
    expect(await screen.findByText("Typed confirmation")).toBeTruthy();
    expect(screen.getByText("allow jellyfin")).toBeTruthy();
    expect(JSON.parse(staged[0] ?? "{}")).toEqual({ parameters: { id: "jellyfin", backup: "20260816T030000Z.tar.gz", allowCompose: hash } });
  });

  it("says why a backup cannot be restored, and stages nothing", async () => {
    const review = { id: "jellyfin", backup: backup.artifact, verbatim: true, reason: "edited", findings: [], refusals: ["Media folder is set to \"/etc\", which points at a protected system location"], sha256: null, sameAsRunning: false, needsAllow: false };
    const staged: string[] = [];
    withBackups([backup], (url, init) => {
      if (url.endsWith("/operations/app.backup.review/run")) return json({ operation: "app.backup.review", result: review });
      if (url.endsWith("/operations/app.backup.restore/jobs")) { staged.push(init?.body as string); return stagedJob("app.backup.restore", "high", true); }
      return undefined;
    });
    render(<CatalogPage csrfToken="csrf-token" />);
    const sheet = await openApp("Jellyfin");
    fireEvent.click(within(sheet).getByRole("tab", { name: "Backups" }));
    await within(sheet).findByText("under a second");
    fireEvent.click(within(sheet).getByRole("button", { name: /^Restore / }));
    expect(await within(sheet).findByText(/^Jellyfin cannot be restored from /)).toBeTruthy();
    expect(within(sheet).getByText(/points at a protected system location/)).toBeTruthy();
    expect(staged).toEqual([]);
  });

  it("restores as before when the backup's compose file is written again from the catalog", async () => {
    const staged: string[] = [];
    withBackups([backup], (url, init) => {
      if (url.endsWith("/operations/app.backup.review/run")) return json({ operation: "app.backup.review", result: { id: "jellyfin", verbatim: false, reason: null, findings: [], refusals: [], sha256: null, sameAsRunning: false, needsAllow: false } });
      if (url.endsWith("/operations/app.backup.restore/jobs")) { staged.push(init?.body as string); return stagedJob("app.backup.restore", "high", true); }
      return undefined;
    });
    render(<CatalogPage csrfToken="csrf-token" />);
    const sheet = await openApp("Jellyfin");
    fireEvent.click(within(sheet).getByRole("tab", { name: "Backups" }));
    await within(sheet).findByText("under a second");
    fireEvent.click(within(sheet).getByRole("button", { name: /^Restore / }));
    expect(await screen.findByText("High risk")).toBeTruthy();
    expect(screen.queryByText(/compose file would start exactly as it was backed up/)).toBeNull();
    expect(JSON.parse(staged[0] ?? "{}")).toEqual({ parameters: { id: "jellyfin", backup: "20260816T030000Z.tar.gz" } });
  });

  it("reports a refused rehearsal schedule and blocks a second click while it is out", async () => {
    let answer!: (response: Response) => void;
    let posts = 0;
    withBackups([backup], (url, init) => {
      if (url === "/api/v1/schedules" && init?.method === "POST") { posts += 1; return new Promise<Response>((resolve) => { answer = resolve; }); }
      return undefined;
    });
    render(<CatalogPage csrfToken="csrf-token" />);
    const sheet = await openApp("Jellyfin");
    fireEvent.click(within(sheet).getByRole("tab", { name: "Backups" }));
    const rehearse = await within(sheet).findByRole("button", { name: "Rehearse weekly" });
    fireEvent.click(rehearse);
    await waitFor(() => expect((rehearse as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(rehearse);
    expect(posts).toBe(1);
    answer(json({ error: "Only operators can add schedules" }, 403));
    expect(await within(sheet).findByText("Only operators can add schedules")).toBeTruthy();
    await waitFor(() => expect((within(sheet).getByRole("button", { name: "Rehearse weekly" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("offers the first backup when there is none yet", async () => {
    withBackups([]);
    render(<CatalogPage csrfToken="csrf-token" />);
    const sheet = await openApp("Jellyfin");
    fireEvent.click(within(sheet).getByRole("tab", { name: "Backups" }));
    expect(await within(sheet).findByText("No backups yet")).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: "Back up now" }).getAttribute("data-risk")).toBe("medium");
  });
});

describe("App catalog: configuration", () => {
  const withConfig = (other: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined) => serve(catalogOf([{ manifest: dockge, live: dockgeLive }]), other);

  it("reads raw Compose only through the owner verification endpoint before allowing editing", async () => {
    let elevated = false;
    const compose = "services:\n  dockge:\n    environment:\n      TOKEN: owner-only-fixture\n";
    withConfig((url) => {
      if (url.includes("app.config.inspect")) return json({ result: { id: "dockge", name: "Dockge", env: [], compose: "ignore-legacy-raw-response" } });
      if (url.includes("app.compose.inspect")) return elevated ? json({ result: { compose } }) : json({ code: "elevation_required" }, 401);
      if (url.endsWith("/auth/elevate")) { elevated = true; return json({ ok: true }); }
      return undefined;
    });
    render(<CatalogPage csrfToken="csrf-token" />);
    const sheet = await openApp("Dockge");
    fireEvent.click(within(sheet).getByRole("tab", { name: "Config" }));
    fireEvent.click(await within(sheet).findByRole("button", { name: "Read Compose file" }));
    expect(within(sheet).queryByText("ignore-legacy-raw-response")).toBeNull();
    fireEvent.change(await within(sheet).findByLabelText("Owner password for Compose"), { target: { value: "correct horse battery" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Unlock and read Compose file" }));
    expect(await within(sheet).findByText(/owner-only-fixture/)).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: "Edit raw" }));
    expect((within(sheet).getByLabelText("Compose file") as HTMLTextAreaElement).value).toBe(compose);
    expect(within(sheet).getByRole("button", { name: "Apply" }).getAttribute("data-risk")).toBe("high");
  });

  it("keeps an edited Compose file when applying it is cancelled", async () => {
    const compose = "services:\n  dockge:\n    image: louislam/dockge:1.5.0\n";
    withConfig((url) => {
      if (url.includes("app.config.inspect")) return json({ result: { id: "dockge", name: "Dockge", env: [] } });
      if (url.includes("app.compose.inspect")) return json({ result: { compose } });
      if (url.endsWith("/operations/app.compose.edit/jobs")) return stagedJob("app.compose.edit", "high", true);
      if (url.includes("/jobs/")) return json({ job: { id: "job-app.compose.edit", state: "cancelled" } });
      return undefined;
    });
    render(<CatalogPage csrfToken="csrf-token" />);
    const sheet = await openApp("Dockge");
    fireEvent.click(within(sheet).getByRole("tab", { name: "Config" }));
    fireEvent.click(await within(sheet).findByRole("button", { name: "Read Compose file" }));
    fireEvent.click(await within(sheet).findByRole("button", { name: "Edit raw" }));
    const edited = `${compose}    restart: always\n`;
    fireEvent.change(within(sheet).getByLabelText("Compose file"), { target: { value: edited } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Apply" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    const back = await screen.findByRole("dialog", { name: "Dockge" });
    expect(within(back).getByRole("tab", { name: "Config" }).getAttribute("aria-selected")).toBe("true");
    expect((await within(back).findByLabelText("Compose file") as HTMLTextAreaElement).value).toBe(edited);
  });

  it("offers to read the configuration again when the first read fails", async () => {
    let reads = 0;
    withConfig((url) => {
      if (url.includes("app.config.inspect")) { reads += 1; return reads === 1 ? json({ error: "The helper did not answer" }, 503) : json({ result: { id: "dockge", name: "Dockge", directory: "/opt/boxpilot/apps/dockge", env: [] } }); }
      return undefined;
    });
    render(<CatalogPage csrfToken="csrf-token" />);
    const sheet = await openApp("Dockge");
    fireEvent.click(within(sheet).getByRole("tab", { name: "Config" }));
    expect(await within(sheet).findByText("The helper did not answer")).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(within(sheet).queryByText("The helper did not answer")).toBeNull());
    expect(reads).toBe(2);
  });

  it("keeps a raw Compose read that starts before the opened tab's effects have run", async () => {
    // React commits the opened tab first and runs its effects in a later task. A cleanup keyed on
    // the app ran in that task and aborted a read clicked in between, leaving the button stuck on
    // "Reading Compose file...".
    withConfig((url) => {
      if (url.includes("app.config.inspect")) return json({ result: { id: "dockge", name: "Dockge", env: [] } });
      if (url.includes("app.compose.inspect")) return json({ code: "elevation_required" }, 401);
      return undefined;
    });
    render(<CatalogPage csrfToken="csrf-token" />);
    const sheet = await openApp("Dockge");
    // A MutationObserver callback runs straight after the commit that shows the button, before
    // the task in which React runs that commit's effects: the click lands in between, every time.
    let clicked = false;
    const observer = new MutationObserver(() => {
      const read = screen.queryByRole("button", { name: "Read Compose file" });
      if (!read) return;
      observer.disconnect(); fireEvent.click(read); clicked = true;
    });
    observer.observe(document.body, { childList: true, subtree: true });
    fireEvent.click(within(sheet).getByRole("tab", { name: "Config" }));
    await waitFor(() => expect(clicked).toBe(true));
    expect(await within(sheet).findByLabelText("Owner password for Compose")).toBeTruthy();
  });

  it("aborts a raw configuration read when its sheet closes", async () => {
    let signal: AbortSignal | undefined;
    withConfig((url, options) => {
      if (url.includes("app.config.inspect")) return json({ result: { id: "dockge", name: "Dockge", env: [] } });
      if (url.includes("app.compose.inspect")) return new Promise<Response>((_resolve, reject) => { signal = options?.signal ?? undefined; signal?.addEventListener("abort", () => reject(signal?.reason), { once: true }); });
      return undefined;
    });
    render(<CatalogPage csrfToken="csrf-token" />);
    const opener = await screen.findByRole("button", { name: "Dockge, Running" });
    opener.focus();
    fireEvent.click(opener);
    const sheet = await screen.findByRole("dialog", { name: "Dockge" });
    await waitFor(() => expect(document.activeElement).toBe(sheet));
    fireEvent.click(within(sheet).getByRole("tab", { name: "Config" }));
    fireEvent.click(await within(sheet).findByRole("button", { name: "Read Compose file" }));
    await waitFor(() => expect(signal).toBeTruthy());
    fireEvent.keyDown(sheet, { key: "Escape" });
    expect(document.activeElement).toBe(opener);
    expect(signal?.aborted).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("still shows the configuration when the answer is missing a section", async () => {
    // A partial result used to throw on env.length while rendering, losing the whole dialog.
    withConfig((url) => (url.includes("app.config.inspect") ? json({ result: { id: "dockge", name: "Dockge" } }) : undefined));
    render(<CatalogPage csrfToken="csrf-token" />);
    const sheet = await openApp("Dockge");
    fireEvent.click(within(sheet).getByRole("tab", { name: "Config" }));
    expect(await within(sheet).findByText("—")).toBeTruthy();
    expect(within(sheet).getByRole("region", { name: "compose.yaml" })).toBeTruthy();
  });

  it("lists a model runner's models, and pulls and removes them at their tier", async () => {
    let staged: string | undefined;
    const ollama = { ...dockge, id: "ollama", name: "Ollama", modelRunner: { kind: "ollama", service: "ollama" } };
    serve(catalogOf([{ manifest: ollama, live: { ...dockgeLive, id: "ollama" } }]), (url, init) => {
      if (url.endsWith("/operations/app.models.inspect/run")) return json({ result: { available: true, reason: null, totalBytes: 2e9, models: [{ name: "llama3.2:3b", id: "a", size: "2.0 GB", modified: "2 days ago", bytes: 2e9 }] } });
      if (url.endsWith("/operations/app.model.pull/jobs")) { staged = init?.body as string; return stagedJob("app.model.pull"); }
      return undefined;
    });
    render(<CatalogPage csrfToken="csrf-token" />);
    const sheet = await openApp("Ollama");
    fireEvent.click(within(sheet).getByRole("tab", { name: "Models" }));
    expect(await within(sheet).findByText("llama3.2:3b")).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: "Remove llama3.2:3b" }).getAttribute("data-risk")).toBe("medium");
    fireEvent.change(within(sheet).getByLabelText("Model to download"), { target: { value: "hermes3:8b" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Download" }));
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    expect(JSON.parse(staged ?? "{}")).toEqual({ parameters: { id: "ollama", model: "hermes3:8b" } });
  });
});
