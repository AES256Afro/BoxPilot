import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AppCatalog from "./AppCatalog";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

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

describe("App catalog", () => {
  it("offers setup choices with the recommended ones pre-ticked and stages them with the install", async () => {
    let stagedBody: string | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/v1/catalog") return json({ applications: [{ manifest: dnsManifest, live: { id: "pi-hole", installed: false, dataPresent: false, state: null, container: { exists: false, running: false, status: "absent", health: "none", restarts: 0, image: null }, urls: [] } }], problems: [], liveError: null, host: { lanAddress: "192.168.1.10", tailscaleDnsName: null } });
      if (url.endsWith("/catalog/pi-hole/precheck")) return json({ ok: true, errors: [], conflicts: [] });
      if (url.endsWith("/operations/app.install/jobs")) { stagedBody = init?.body as string; return json({ job: { id: "job-p", type: "op:app.install", title: "Install application", state: "awaiting_approval", risk: "high", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "high", passwordRequired: true, elevated: false, mode: "tiered", reason: "high risk" } }, 201); }
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AppCatalog csrfToken="csrf-token" />);
    fireEvent.click(await screen.findByRole("button", { name: "Install" }));
    expect(await screen.findByText("Blocklists")).toBeTruthy();
    expect((screen.getByLabelText("OISD big") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("HaGeZi Threat Intelligence Feeds") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("link", { name: "Learn more" }) as HTMLAnchorElement).href).toBe("https://oisd.nl/");
    fireEvent.click(screen.getByLabelText("HaGeZi Threat Intelligence Feeds"));
    fireEvent.click(screen.getByRole("button", { name: "Continue to install" }));
    expect(await screen.findByText("High risk")).toBeTruthy();
    await waitFor(() => expect(JSON.parse(stagedBody ?? "{}")).toEqual({ parameters: { id: "pi-hole", values: { ports: {}, env: {}, volumes: {}, setup: ["oisd-big", "hagezi-tif"] } } }));
  });

  it("shows catalog apps, collects install settings, and stages app.install through the approval dialog", async () => {
    let stagedBody: string | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/v1/catalog") return json({ applications: [{ manifest, live: { id: "jellyfin", installed: false, dataPresent: false, state: null, container: { exists: false, running: false, status: "absent", health: "none", restarts: 0, image: null }, urls: [] } }], problems: [], liveError: null, host: { lanAddress: "192.168.1.10", tailscaleDnsName: null } });
      if (url.endsWith("/catalog/jellyfin/precheck")) return json({ ok: true, errors: [], conflicts: [] });
      if (url.endsWith("/operations/app.install/jobs")) { stagedBody = init?.body as string; return json({ job: { id: "job-9", type: "op:app.install", title: "Install application", state: "awaiting_approval", risk: "medium", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", reason: "medium risk" } }, 201); }
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AppCatalog csrfToken="csrf-token" />);
    expect(await screen.findByText("Jellyfin")).toBeTruthy();
    expect(screen.getByText("Not installed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    fireEvent.change(await screen.findByLabelText("Web UI port"), { target: { value: "8097" } });
    fireEvent.change(screen.getByLabelText("Media library path"), { target: { value: "/mnt/media" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to install" }));
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    expect(JSON.parse(stagedBody ?? "{}")).toEqual({ parameters: { id: "jellyfin", values: { ports: { web: 8097 }, env: {}, volumes: { media: "/mnt/media" } } } });
  });

  it("offers lifecycle, update, uninstall, and purge for an installed app", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "/api/v1/catalog") return json({ applications: [{ manifest, live: { id: "jellyfin", installed: true, dataPresent: true, state: { installedAt: "x", updatedAt: "x", manifestSha256: "abc", image: { reference: "jellyfin/jellyfin:10.10.7", id: "sha256:1" }, values: { ports: { web: 8096 }, env: {}, volumes: {} }, pinnedRollback: false, uninstalledAt: null }, container: { exists: true, running: true, status: "running", health: "healthy", restarts: 0, image: "sha256:1" }, urls: [{ id: "web", label: "Web UI", host: 8096, exposure: "lan" }] } }], problems: [], liveError: null, host: { lanAddress: "192.168.1.10", tailscaleDnsName: null } });
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AppCatalog csrfToken="csrf-token" />);
    expect(await screen.findByText("Running")).toBeTruthy();
    // The page itself came from localhost here, so the LAN address is the only useful guess.
    expect((screen.getByRole("link", { name: "Open Web UI" }) as HTMLAnchorElement).href).toBe("http://192.168.1.10:8096/");
    for (const name of ["Restart", "Stop", "Settings", "Update", "Logs", "Uninstall", "Delete data"]) expect(screen.getByRole("button", { name })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("browses a backup's files and stages a single-file restore", async () => {
    const staged: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/v1/catalog") return json({ applications: [{ manifest, live: { id: "jellyfin", installed: true, dataPresent: true, state: { installedAt: "x", updatedAt: "x", manifestSha256: "abc", image: { reference: "jellyfin/jellyfin:10.10.7", id: "sha256:1" }, values: { ports: { web: 8096 }, env: {}, volumes: {} }, pinnedRollback: false, uninstalledAt: null }, container: { exists: true, running: true, status: "running", health: "healthy", restarts: 0, image: "sha256:1" }, urls: [{ id: "web", label: "Web UI", host: 8096, exposure: "lan" }] } }], problems: [], liveError: null, host: { lanAddress: "192.168.1.10", tailscaleDnsName: null } });
      if (url.endsWith("/operations/app.backups.inspect/run")) return json({ operation: "app.backups.inspect", result: { id: "jellyfin", directory: "/x", backups: [{ artifact: "20260816T030000Z.tar.gz", createdAt: "2026-08-16T03:00:00.000Z", sizeBytes: 2 * 1024 * 1024, downtimeMs: 900, skippedHostPaths: [], image: null }] } });
      if (url.endsWith("/operations/app.backup.files/run")) return json({ operation: "app.backup.files", result: { id: "jellyfin", backup: "20260816T030000Z.tar.gz", files: [{ path: "config", sizeBytes: 0, type: "directory" }, { path: "config/system.xml", sizeBytes: 2048, type: "file" }, { path: "config/users.db", sizeBytes: 40960, type: "file" }], truncated: false } });
      if (url.endsWith("/operations/app.backup.restore-path/jobs")) { staged.push(init?.body as string); return json({ job: { id: "job-rp", type: "op:app.backup.restore-path", title: "Restore one file", state: "awaiting_approval", risk: "medium", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", reason: "medium" } }, 201); }
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AppCatalog csrfToken="csrf-token" />);
    expect(await screen.findByText("Running")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Backups" }));
    fireEvent.click(await screen.findByRole("button", { name: "Browse" }));
    expect(await screen.findByText("config/users.db")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Filter files"), { target: { value: "system" } });
    expect(screen.queryByText("config/users.db")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Restore this file" }));
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    expect(JSON.parse(staged[0] ?? "{}")).toEqual({ parameters: { id: "jellyfin", backup: "20260816T030000Z.tar.gz", path: "config/system.xml" } });
  });
});

describe("where the Open button sends you", () => {
  const installed = {
    id: "jellyfin", installed: true, dataPresent: true,
    state: { installedAt: "x", updatedAt: "x", manifestSha256: "abc", image: { reference: "jellyfin/jellyfin:10.10.7", id: "sha256:1" }, values: { ports: { web: 8096 }, env: {}, volumes: {} }, pinnedRollback: false, uninstalledAt: null },
    container: { exists: true, running: true, status: "running", health: "healthy", restarts: 0, image: "sha256:1" },
    urls: [{ id: "web", label: "Web UI", host: 8096, exposure: "lan" }],
  };
  const catalogBody = { applications: [{ manifest, live: installed }], problems: [], liveError: null, host: { lanAddress: "192.168.1.10", tailscaleDnsName: "box.tail1234.ts.net" } };

  const mount = (hostname: string, serves: Array<{ dnsName: string; port: number; target: string | null }> = []) => {
    // jsdom serves from localhost; the component reads window.location.hostname, so stub that.
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, hostname } as Location);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "/api/v1/catalog") return json(catalogBody);
      if (url.includes("app.serve.inspect")) return json({ result: { available: true, serves } });
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AppCatalog csrfToken="csrf-token" />);
  };

  it("uses the address this page was reached on, not the LAN address", async () => {
    // Preferring the LAN address pointed every Open button into the LAN even when BoxPilot was
    // open over the tailnet from somewhere else — and none of them could connect.
    mount("box.tail1234.ts.net");
    expect(await screen.findByText("Running")).toBeTruthy();
    expect((screen.getByRole("link", { name: "Open Web UI" }) as HTMLAnchorElement).href).toBe("http://box.tail1234.ts.net:8096/");
  });

  it("uses the HTTPS address when the app is published on the tailnet", async () => {
    // Tailscale Serve holds that port for HTTPS, so a plain http:// link to it answers 400.
    mount("box.tail1234.ts.net", [{ dnsName: "box.tail1234.ts.net", port: 8096, target: "http://127.0.0.1:8096" }]);
    expect(await screen.findByText("Running")).toBeTruthy();
    expect((screen.getByRole("link", { name: "Open Web UI" }) as HTMLAnchorElement).href).toBe("https://box.tail1234.ts.net:8096/");
  });
});

describe("finding things in a catalog of a hundred-odd apps", () => {
  const dockge = { id: "dockge", name: "Dockge", category: "Developer", description: "Manage compose stacks", website: null, icon: null, risk: "medium" as const, notes: null, image: { reference: "louislam/dockge:1.5.0", version: "1.5.0" }, ports: [{ id: "web", label: "Web UI", container: 5001, host: 5001, protocol: "tcp", exposure: "lan", fixed: false }], volumes: [], env: [], devices: [], capabilities: [], extraHosts: [], sysctls: [], sidecars: [], network: "bridge", networkVia: null, user: null, command: null, health: { kind: "running", stableSeconds: 1, timeoutSeconds: 10 }, setup: null, sha256: "a" };
  const runningLive = { id: "dockge", installed: true, dataPresent: true, state: { installedAt: "x", updatedAt: "x", manifestSha256: "a", image: { reference: "louislam/dockge:1.5.0", id: "sha256:1" }, values: { ports: { web: 5001 }, env: {}, volumes: {} }, pinnedRollback: false, uninstalledAt: null }, container: { exists: true, running: true, status: "running", health: "healthy", restarts: 0, image: "sha256:1" }, urls: [{ id: "web", label: "Web UI", host: 5001, exposure: "lan" }] };
  const notInstalled = { id: "jellyfin", installed: false, dataPresent: false, state: null, container: { exists: false, running: false, status: "absent", health: "none", restarts: 0, image: null }, urls: [] };

  const mount = () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "/api/v1/catalog") return json({ applications: [{ manifest, live: notInstalled }, { manifest: dockge, live: runningLive }], problems: [], liveError: null, host: { lanAddress: "192.168.1.10", tailscaleDnsName: null } });
      if (url.includes("app.serve.inspect")) return json({ result: { available: true, serves: [] } });
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AppCatalog csrfToken="csrf-token" />);
  };

  it("puts what is already running first, in its own section", async () => {
    // With well over a hundred apps in the catalog, an installed app buried alphabetically is behind a long scroll.
    mount();
    expect(await screen.findByRole("heading", { name: "On this server" })).toBeTruthy();
    expect(screen.getByText("1 running of 1 installed")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Add something else" })).toBeTruthy();
  });

  it("searches across name, category and description", async () => {
    mount();
    await screen.findByRole("heading", { name: "On this server" });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search applications" }), { target: { value: "compose stacks" } });
    expect(screen.getByText("Dockge")).toBeTruthy();
    expect(screen.queryByText("Jellyfin")).toBeNull();
  });

  it("shows a paused app as paused and offers Resume, not Stop-only", async () => {
    // Docker reports a paused container as Running=true — the process exists, it is just frozen.
    // Every check of container.running therefore has to subtract paused, or the card claims the
    // app is Running, counts it among the running apps, and offers no way to thaw it.
    const pausedLive = { ...runningLive, container: { ...runningLive.container, running: true, status: "paused" } };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "/api/v1/catalog") return json({ applications: [{ manifest: dockge, live: pausedLive }], problems: [], liveError: null, host: { lanAddress: "192.168.1.10", tailscaleDnsName: null } });
      if (url.includes("app.serve.inspect")) return json({ result: { available: true, serves: [] } });
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AppCatalog csrfToken="csrf-token" />);
    expect(await screen.findByText("Paused")).toBeTruthy();
    expect(screen.queryByText("Running")).toBeNull();
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restart" })).toBeNull(); // restarting a frozen container is not the offer
    expect(screen.getByText("0 running of 1 installed")).toBeTruthy();
  });

  it("offers a network-mode choice at install and sends it when it differs from the default", async () => {
    const hole = { ...dockge, id: "pi-hole", name: "Pi-hole", description: "DNS blocker", network: "bridge", networkModes: ["bridge", "host"], ports: [{ id: "web", label: "Admin UI", container: 80, host: 8084, protocol: "tcp", exposure: "lan", fixed: false }], env: [], signIn: null };
    let staged: string | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/v1/catalog") return json({ applications: [{ manifest: hole, live: notInstalled }], problems: [], liveError: null, host: { lanAddress: "192.168.1.10", tailscaleDnsName: null } });
      if (url.endsWith("/precheck")) return json({ ok: true, errors: [], conflicts: [] });
      if (url.endsWith("/operations/app.install/jobs")) { staged = init?.body as string; return json({ job: { id: "j", type: "op:app.install", title: "Install", state: "awaiting_approval", risk: "high", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "high", passwordRequired: true, elevated: false, mode: "tiered", reason: "high" } }, 201); }
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AppCatalog csrfToken="csrf-token" />);
    fireEvent.click(await screen.findByRole("button", { name: "Install" }));
    const select = await screen.findByLabelText("Network mode");
    expect((select as HTMLSelectElement).value).toBe("bridge"); // the first offered mode
    fireEvent.change(select, { target: { value: "host" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to install" }));
    await waitFor(() => expect(JSON.parse(staged ?? "{}").parameters.values.networkMode).toBe("host"));
  });

  it("lets you choose the sign-in password at install, and otherwise generates it", async () => {
    const hole = { ...dockge, id: "pi-hole", name: "Pi-hole", description: "DNS blocker", ports: [{ id: "web", label: "Admin UI", container: 80, host: 8084, protocol: "tcp", exposure: "lan", fixed: false }], env: [{ name: "FTLCONF_webserver_api_password", label: "Admin password", description: null, type: "password", default: null, required: false, secret: true, generate: true, options: null, fixed: false }, { name: "DB_PASSWORD", label: "Database password", description: null, type: "password", default: null, required: false, secret: true, generate: true, options: null, fixed: false }], signIn: { path: "/admin/", port: null, username: null, usernameEnv: null, passwordEnv: "FTLCONF_webserver_api_password", note: null } };
    let staged: string | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/v1/catalog") return json({ applications: [{ manifest: hole, live: notInstalled }], problems: [], liveError: null, host: { lanAddress: "192.168.1.10", tailscaleDnsName: null } });
      if (url.endsWith("/precheck")) return json({ ok: true, errors: [], conflicts: [] });
      if (url.endsWith("/operations/app.install/jobs")) { staged = init?.body as string; return json({ job: { id: "j", type: "op:app.install", title: "Install", state: "awaiting_approval", risk: "high", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "high", passwordRequired: true, elevated: false, mode: "tiered", reason: "high" } }, 201); }
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AppCatalog csrfToken="csrf-token" />);
    fireEvent.click(await screen.findByRole("button", { name: "Install" }));
    // The sign-in password is offered; the database password is not something anyone types.
    const field = await screen.findByLabelText("Admin password");
    expect(screen.queryByLabelText("Database password")).toBeNull();
    expect(screen.getByText(/Generated for you: Database password/)).toBeTruthy();
    fireEvent.change(field, { target: { value: "my own password" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to install" }));
    await waitFor(() => expect(JSON.parse(staged ?? "{}").parameters.values.env).toEqual({ FTLCONF_webserver_api_password: "my own password" }));
  });

  it("puts the sign-in page, the password and a way to change it in one place", async () => {
    const hole = { ...dockge, id: "pi-hole", name: "Pi-hole", description: "DNS blocker", ports: [{ id: "web", label: "Admin UI", container: 80, host: 8084, protocol: "tcp", exposure: "lan", fixed: false }], env: [{ name: "FTLCONF_webserver_api_password", label: "Admin password", description: null, type: "password", default: null, required: false, secret: true, generate: true, options: null, fixed: false }], signIn: { path: "/admin/", port: null, username: null, usernameEnv: null, passwordEnv: "FTLCONF_webserver_api_password", note: "Change it here, not inside Pi-hole." } };
    const live = { ...runningLive, id: "pi-hole", state: { ...runningLive.state, values: { ports: { web: 8084 }, env: {}, volumes: {} } }, urls: [{ id: "web", label: "Admin UI", host: 8084, exposure: "lan", path: "/admin/" }] };
    let staged: string | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/v1/catalog") return json({ applications: [{ manifest: hole, live }], problems: [], liveError: null, host: { lanAddress: "192.168.1.10", tailscaleDnsName: null } });
      if (url.includes("app.serve.inspect")) return json({ result: { available: true, serves: [] } });
      if (url.endsWith("/operations/app.secrets/run")) return json({ result: { secrets: [{ name: "FTLCONF_webserver_api_password", label: "Admin password", value: "s3cret-generated" }] } });
      if (url.endsWith("/operations/app.password.set/jobs")) { staged = init?.body as string; return json({ job: { id: "j", type: "op:app.password.set", title: "Change", state: "awaiting_approval", risk: "medium", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", reason: "medium" } }, 201); }
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AppCatalog csrfToken="csrf-token" />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    const link = await screen.findByRole("link", { name: "Open Pi-hole's sign-in page" });
    expect((link as HTMLAnchorElement).href).toMatch(/:8084\/admin\/$/);
    expect(screen.getByText(/asks only for the password/)).toBeTruthy();
    expect(screen.getByText("Change it here, not inside Pi-hole.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    expect(((await screen.findByLabelText("Admin password")) as HTMLInputElement).value).toBe("s3cret-generated");
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "a better password" } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    await waitFor(() => expect(JSON.parse(staged ?? "{}")).toEqual({ parameters: { id: "pi-hole", password: "a better password" } }));
  });

  it("still offers tailnet-only to an app with no web interface, and does not call it tailnet-only already", async () => {
    // A database has nothing a browser opens, so it has no Open link. It used to lose the exposure
    // switch with it — and an empty link list counted as "every link is loopback", so the pill
    // claimed the app was already tailnet-only while it sat on the LAN.
    const db = { ...dockge, id: "valkey", name: "Valkey", description: "Redis-compatible store", ports: [{ id: "redis", label: "Redis protocol", container: 6379, host: 6379, protocol: "tcp", exposure: "lan", fixed: false, tailnet: "address" }] };
    const live = { ...runningLive, id: "valkey", state: { ...runningLive.state, values: { ports: { redis: 6379 }, env: {}, volumes: {} } }, urls: [] };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "/api/v1/catalog") return json({ applications: [{ manifest: db, live }], problems: [], liveError: null, host: { lanAddress: "192.168.1.10", tailscaleDnsName: null } });
      if (url.includes("app.serve.inspect")) return json({ result: { available: true, serves: [] } });
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AppCatalog csrfToken="csrf-token" />);
    expect(await screen.findByText("home network")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /^Open / })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reach only through Tailscale" }));
    const preview = (await screen.findByText(/Recreates Valkey/)).textContent ?? "";
    expect(preview).toContain("no web interface to publish");
    expect(preview).toContain("Redis protocol does not speak HTTP, so it moves to this server's tailnet address");
  });

  it("says which ports tailnet-only will not move, before you commit to it", async () => {
    // Tailscale Serve can only front a web interface, so an app that also speaks DNS or a sync
    // protocol keeps those ports somewhere they still work. Saying so is the whole point: the
    // first version of this offered "reach only through Tailscale" on Pi-hole and would have
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
    const live = { ...runningLive, id: "pi-hole", state: { ...runningLive.state, values: { ports: { web: 8084, "dns-tcp": 53, "dns-udp": 53, sync: 22000 }, env: {}, volumes: {} } }, urls: [{ id: "dns-tcp", label: "DNS (TCP)", host: 53, exposure: "lan" }, { id: "web", label: "Admin UI", host: 8084, exposure: "lan" }] };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "/api/v1/catalog") return json({ applications: [{ manifest: dns, live }], problems: [], liveError: null, host: { lanAddress: "192.168.1.10", tailscaleDnsName: null } });
      if (url.includes("app.serve.inspect")) return json({ result: { available: true, serves: [] } });
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AppCatalog csrfToken="csrf-token" />);
    fireEvent.click(await screen.findByRole("button", { name: "Reach only through Tailscale" }));

    const preview = (await screen.findByText(/Recreates Pi-hole/)).textContent ?? "";
    expect(preview).toContain("DNS (TCP), DNS (UDP) stay on your home network");
    expect(preview).toContain("Peer sync does not speak HTTP, so it moves to this server's tailnet address");
    // The published address is the admin UI, not whichever port happened to be listed first.
    expect(preview).toContain("ts.net:8084");
    expect(preview).not.toContain("ts.net:53");
  });
});
