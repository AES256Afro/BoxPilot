import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigSheet } from "./ConfigSheet";
import type { LiveState, Manifest, Values } from "./types";

// Settings → Save sends only what the owner changed, and secrets show as saved (30 Oct 2026: an
// owner reopened TheySpy's Settings, saw empty API key boxes, and typed the keys again).

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const env = (name: string, extra: Record<string, unknown> = {}) => ({ name, label: name, description: null, type: "text", secret: false, required: false, fixed: false, generate: false, default: "", options: null, ...extra });
const manifest = {
  id: "theyspy", name: "TheySpy", category: "Security", description: "d", website: null, icon: null, risk: "low", notes: null,
  image: { reference: "x/theyspy:1", version: "1", digestPinned: true }, health: { kind: "healthcheck", timeoutSeconds: 120 }, sha256: "a",
  ports: [{ id: "web", label: "Dashboard", container: 8797, host: 8797, protocol: "tcp", exposure: "lan", fixed: false }],
  volumes: [],
  env: [
    env("TS_PIHOLE_URL"),
    env("TS_PIHOLE_PASSWORD", { type: "password", secret: true }),
    env("TS_NVD_API_KEY", { type: "password", secret: true }),
    env("TS_NTFY_TOKEN", { type: "password", secret: true }),
    env("TS_ADMIN_PASSWORD", { type: "password", secret: true, generate: true }),
  ],
} as unknown as Manifest;
const live = {
  id: "theyspy", installed: true, dataPresent: true,
  state: { installedAt: "x", updatedAt: "x", manifestSha256: "a", image: null, values: { ports: { web: 8797 }, env: { TS_PIHOLE_URL: "http://192.168.8.2" }, volumes: {} }, pinnedRollback: false, uninstalledAt: null, secretsSaved: ["TS_PIHOLE_PASSWORD", "TS_NVD_API_KEY"] },
  container: { exists: true, running: true, status: "running", health: "healthy", restarts: 0, image: "x" }, urls: [],
} as unknown as LiveState;

function open() {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, errors: [], conflicts: [] }), { headers: { "Content-Type": "application/json" } })));
  const onSubmit = vi.fn<(values: Values, form: Values) => void>();
  render(<ConfigSheet manifest={manifest} live={live} mode="reconfigure" csrfToken="t" onSubmit={onSubmit} onCancel={() => {}} />);
  return onSubmit;
}
const box = (name: string) => document.querySelector(`[data-secret="${name}"] input`) as HTMLInputElement;
const save = () => fireEvent.submit(document.querySelector("form.catalog-form")!);

describe("app Settings", () => {
  it("shows a saved secret as saved, and an unsaved one as empty", () => {
    open();
    expect(box("TS_NVD_API_KEY").placeholder).toBe("Saved · leave empty to keep");
    expect(box("TS_PIHOLE_PASSWORD").placeholder).toBe("Saved · leave empty to keep");
    expect(box("TS_NTFY_TOKEN").placeholder).toBe("");
    expect(box("TS_NVD_API_KEY").value).toBe(""); // the value itself never reaches the browser
  });

  it("changing only the port sends only the port: every other setting and secret stays", async () => {
    const onSubmit = open();
    fireEvent.change(screen.getByDisplayValue("8797"), { target: { value: "8798" } });
    save();
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toEqual({ ports: { web: 8798 }, env: {}, volumes: {} });
  });

  it("clears a saved secret only when asked, and typing a new one replaces instead", async () => {
    const onSubmit = open();
    fireEvent.click(within(document.querySelector('[data-secret="TS_NVD_API_KEY"]') as HTMLElement).getByRole("button", { name: "Clear" }));
    expect(within(document.querySelector('[data-secret="TS_PIHOLE_PASSWORD"]') as HTMLElement).getByRole("button", { name: "Clear" })).toBeTruthy();
    expect(box("TS_NVD_API_KEY").placeholder).toBe("Will be cleared when you save");
    save();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toEqual({ ports: {}, env: {}, volumes: {}, clearSecrets: ["TS_NVD_API_KEY"] });

    fireEvent.change(box("TS_NVD_API_KEY"), { target: { value: "a-new-key" } });
    save();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit.mock.calls[1][0]).toEqual({ ports: {}, env: { TS_NVD_API_KEY: "a-new-key" }, volumes: {} });
  });

  it("lets a port be emptied and retyped, and says why Save waits meanwhile", async () => {
    const onSubmit = open();
    const port = screen.getByDisplayValue("8797") as HTMLInputElement;
    const apply = screen.getByRole("button", { name: /Apply settings/ }) as HTMLButtonElement;
    fireEvent.change(port, { target: { value: "" } });
    expect(port.value).toBe(""); // not "0" put back
    expect(apply.disabled).toBe(true);
    expect(screen.getByText("Still needed: a port number from 1 to 65535 for Dashboard.")).toBeTruthy();
    save();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.change(port, { target: { value: "70000" } });
    expect(apply.disabled).toBe(true);
    fireEvent.change(port, { target: { value: "9000" } });
    expect(apply.disabled).toBe(false);
    expect(screen.queryByText(/Still needed/)).toBeNull();
    save();
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toEqual({ ports: { web: 9000 }, env: {}, volumes: {} });
  });

  it("draws a named option by its label, says the chosen one's hint, and sends its value", async () => {
    const named = { ...manifest, env: [env("MODE", { label: "Listening mode", description: "Which addresses it answers on.", default: "all", options: ["all", "bind"], optionLabels: [{ value: "all", label: "Everyone who asks", hint: "Answers on every address." }, { value: "bind", label: "The main connection, leaving other addresses free", hint: "Holds the port on the main interface alone." }] }), env("LEVEL", { default: "info", options: ["info", "debug"] })] } as unknown as Manifest;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, errors: [], conflicts: [] }), { headers: { "Content-Type": "application/json" } })));
    const onSubmit = vi.fn<(values: Values, form: Values) => void>();
    render(<ConfigSheet manifest={named} live={null} mode="install" csrfToken="t" onSubmit={onSubmit} onCancel={() => {}} />);
    const mode = screen.getByLabelText("Listening mode") as HTMLSelectElement;
    expect([...mode.options].map((option) => [option.value, option.textContent])).toEqual([["all", "Everyone who asks"], ["bind", "The main connection, leaving other addresses free"]]);
    expect(screen.getByText(/Answers on every address\./)).toBeTruthy();
    // A setting whose options are plain values is drawn as before.
    expect([...(screen.getByLabelText("LEVEL") as HTMLSelectElement).options].map((option) => option.textContent)).toEqual(["info", "debug"]);
    fireEvent.change(mode, { target: { value: "bind" } });
    expect(screen.getByText(/Holds the port on the main interface alone\./)).toBeTruthy();
    expect(screen.queryByText(/Answers on every address\./)).toBeNull();
    save();
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0].env).toEqual({ MODE: "bind" });
  });
});

// "Will it fit" (2026-11-10): before Install is pressed, the form says what the app takes from this
// server, the port it will get, where it will answer, and whether it is backed up from night one.
describe("installing: will it fit", () => {
  const GiB = 1024 ** 3;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const inventory = (used = 11, rootUsed = 27) => ({
    host: { hostname: "homebox", operatingSystem: "Ubuntu 24.04 LTS", kernel: "6.8.0", uptimeSeconds: 90_000 },
    compute: { cpuCount: 8, cpuModel: "fixture", load1: 0.5, loadPercent: 6, totalMemoryBytes: 32 * GiB, usedMemoryBytes: used * GiB, memoryUsedPercent: Math.round((used / 32) * 100) },
    storage: { root: { totalBytes: 100 * GiB, usedBytes: rootUsed * GiB, usedPercent: rootUsed }, filesystems: { mounts: [
      { target: "/", source: "/dev/sda2", totalBytes: 100 * GiB, usedBytes: rootUsed * GiB, usedPercent: rootUsed, capacityState: rootUsed >= 85 ? "warning" : "healthy" },
      { target: "/mnt/media", source: "/dev/sdb1", totalBytes: 4000 * GiB, usedBytes: 2720 * GiB, usedPercent: 68, capacityState: "healthy" },
    ] } },
    network: { addresses: [], tailscale: { installed: true, connected: true, dnsName: null } },
  });
  const paperless = {
    ...manifest, id: "paperless-ngx", name: "Paperless-ngx", env: [],
    ports: [{ id: "web", label: "Web UI", container: 8000, host: 8000, protocol: "tcp", exposure: "lan", fixed: false, tailnet: "serve" }],
    volumes: [
      { id: "data", label: "Data", container: "/data", path: "data", hostPath: null, readOnly: false, backup: true, configurable: false, description: null },
      { id: "documents", label: "Documents", container: "/documents", path: null, hostPath: "/mnt/media/documents", readOnly: false, backup: false, configurable: true, description: null },
    ],
    sidecars: [{ id: "db", volumes: [{ path: "db", backup: true }] }, { id: "broker" }],
  } as unknown as Manifest;
  type Answer = Response | undefined;
  /** Serves what the form reads; `precheck` answers for the ports it is asked about. */
  function serve({ inventoryBody = inventory() as unknown, forecasts = [] as unknown[], precheck = (_ports: Record<string, number>): Answer => undefined, other = (_url: string): Answer => undefined } = {}) {
    const prechecks: Array<Record<string, number>> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const answer = other(url);
      if (answer) return answer;
      if (url === "/api/v1/inventory") return inventoryBody ? json(inventoryBody) : json({ error: "The inventory is not answering" }, 503);
      if (url === "/api/v1/storage/forecast") return json({ forecasts });
      if (url.endsWith("/precheck")) {
        const ports = (JSON.parse(init?.body as string).values.ports ?? {}) as Record<string, number>;
        prechecks.push(ports);
        return precheck(ports) ?? json({ ok: true, errors: [], conflicts: [] });
      }
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    return { prechecks };
  }
  function openInstall(app: Manifest = paperless, props: Partial<Parameters<typeof ConfigSheet>[0]> = {}) {
    const onSubmit = vi.fn<(values: Values, form: Values, options: { backupNightly: boolean }) => void>();
    render(<ConfigSheet manifest={app} live={null} mode="install" csrfToken="t" onSubmit={onSubmit} onCancel={() => {}} host={{ lanAddress: "192.0.2.10", tailscaleDnsName: "homebox.tail1234.ts.net" }} nightly={{ may: true, already: null }} {...props} />);
    return onSubmit;
  }
  const verdict = () => document.querySelector(".catalog-preflight__result .ui-chip");
  /** A row of "What it takes", as its cells read across. */
  const cells = (item: string) => [...screen.getByRole("row", { name: new RegExp(`^${item}`) }).querySelectorAll("td")].map((cell) => cell.textContent);
  const taken = (port: number, app: string | null = "portainer") => json({ ok: false, errors: [], conflicts: [{ id: "web", label: "Web UI", port, protocol: "tcp", listeners: [`0.0.0.0:${port}`], containers: app ? [{ name: `boxpilot-${app}-1`, app, composeProject: null }] : [] }] });

  it("says it fits, with the inventory's own figures and \"not stated\" for what the manifest does not state", async () => {
    serve();
    openInstall();
    await waitFor(() => expect(verdict()?.textContent).toBe("Fits"));
    expect(verdict()?.getAttribute("data-status")).toBe("good");
    expect(screen.getByRole("heading", { name: "What it takes from homebox" })).toBeTruthy();
    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Item", "In use now", "This adds", "Scale", "Left after", "Check"]);
    expect(cells("Memory")).toEqual(["Memory", "11.0 GB", "not stated", "", "21.0 GB of 32.0 GB", "Pass"]);
    expect(cells("System disk")).toEqual(["System disk", "27.0 GB", "not stated", "", "73.0 GB of 100.0 GB", "Pass"]);
    expect(cells("/mnt/media")).toEqual(["/mnt/media", "2.7 TB", "not stated", "", "1.3 TB of 3.9 TB", "Pass"]);
    expect(cells("Port")).toEqual(["Port", "8000 is free", "takes 8000", "", "no clash", "Pass"]);
    // The bar is a real progressbar, named for what it measures.
    expect(screen.getByRole("progressbar", { name: "34 percent of 32.0 GB in use now" }).getAttribute("aria-valuenow")).toBe("34");
    // What it starts, from the manifest's services.
    expect(screen.getByText("Starts 3 containers (paperless-ngx, db, broker). Nothing that is running now is stopped or changed.")).toBeTruthy();
  });

  it("adds what the manifest states, and is a caution when that leaves memory thin", async () => {
    serve({ inventoryBody: inventory(24), forecasts: [{ target: "/mnt/media", daysToFull: 77, availableBytes: null, totalBytes: null, samples: 30 }] });
    openInstall({ ...paperless, needs: { memoryMb: 4096, diskMb: 2048 } } as Manifest);
    await waitFor(() => expect(verdict()?.textContent).toBe("Fits, 1 caution"));
    expect(verdict()?.getAttribute("data-status")).toBe("warning");
    expect(cells("Memory")).toEqual(["Memory", "24.0 GB", "+ 4.0 GB", "", "4.0 GB of 32.0 GB", "Caution"]);
    expect(cells("System disk")).toEqual(["System disk", "27.0 GB", "+ 2.0 GB", "", "71.0 GB of 100.0 GB", "Pass"]);
    expect(screen.getByText("Memory would be 88% in use after this, with 4.0 GB left.")).toBeTruthy();
    // Storage's own forecast for the drive its documents go to, not a number made up here.
    expect(cells("/mnt/media")[4]).toBe("1.3 TB of 3.9 TB~77 days left at the rate it has been filling");
  });

  it("says Not read when the inventory could not be read, and is never green about it", async () => {
    serve({ inventoryBody: null });
    openInstall();
    await waitFor(() => expect(verdict()?.textContent).toBe("Not read"));
    expect(verdict()?.getAttribute("data-status")).toBe("unknown");
    expect(cells("Memory")).toEqual(["Memory", "not read", "not stated", "", "not read", "Not read"]);
    expect(cells("System disk")).toEqual(["System disk", "not read", "not stated", "", "not read", "Not read"]);
    expect(cells("Port")[5]).toBe("Pass"); // the port was checked; that row is its own answer
    expect(screen.getByRole("heading", { name: "What it takes from this server" })).toBeTruthy();
    expect(screen.getByText("Memory, System disk and /mnt/media/documents could not be read, so this cannot say it fits.")).toBeTruthy();
  });

  it("moves a taken default port to the next free one, checks that one too, and installs on it", async () => {
    // 8000 is Portainer's and 8001 turns out to be something else's: the precheck is asked about each.
    const { prechecks } = serve({ precheck: (ports) => ((ports.web ?? 8000) === 8000 ? taken(8000) : ports.web === 8001 ? taken(8001, null) : undefined) });
    const onSubmit = openInstall(paperless, { appNameFor: (id) => (id === "portainer" ? "Portainer" : null) });
    await waitFor(() => expect(verdict()?.textContent).toBe("Fits"));
    expect(cells("Port")).toEqual(["Port", "8000 is Portainer's", "takes 8002", "next free one", "no clash", "Pass"]);
    expect((screen.getByLabelText("Web UI port") as HTMLInputElement).value).toBe("8002");
    expect(prechecks).toEqual([{}, { web: 8001 }, { web: 8002 }]);
    // Where it will answer carries the port it actually gets.
    expect(screen.getByText("http://192.0.2.10:8002")).toBeTruthy();
    save();
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0].ports).toEqual({ web: 8002 });
  });

  it("steps over the ports installed apps hold without asking about each", async () => {
    const { prechecks } = serve({ precheck: (ports) => ((ports.web ?? 8000) === 8000 ? taken(8000) : undefined) });
    openInstall(paperless, { heldPorts: new Set(["8001/tcp", "8002/tcp"]) });
    // The row says Pass only once the server has agreed the new port is free.
    await waitFor(() => expect(cells("Port")).toEqual(["Port", "8000 is portainer's", "takes 8003", "next free one", "no clash", "Pass"]));
    expect(prechecks).toEqual([{}, { web: 8003 }]);
  });

  it("leaves a port the owner typed where it is, and says it clashes rather than that it fits", async () => {
    serve({ precheck: (ports) => (ports.web === 9000 ? taken(9000) : undefined) });
    const onSubmit = openInstall();
    await waitFor(() => expect(verdict()?.textContent).toBe("Fits"));
    fireEvent.change(screen.getByLabelText("Web UI port"), { target: { value: "9000" } });
    await waitFor(() => expect(verdict()?.textContent).toBe("Does not fit"));
    expect(verdict()?.getAttribute("data-status")).toBe("danger");
    expect(cells("Port")).toEqual(["Port", "9000 is portainer's", "needs 9000", "pick another", "clash", "Does not fit"]);
    expect((screen.getByLabelText("Web UI port") as HTMLInputElement).value).toBe("9000");
    // Install is still the owner's to press, and the precheck still refuses it, as before.
    save();
    expect(await screen.findByText(/port 9000\/tcp is already in use on this server by portainer/)).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not guess at the ports while a setting the server asks for first is empty", async () => {
    const tokened = { ...paperless, env: [env("API_TOKEN", { label: "API token", type: "string", required: true, default: null })] } as unknown as Manifest;
    const { prechecks } = serve();
    openInstall(tokened);
    await waitFor(() => expect(cells("Memory")[5]).toBe("Pass"));
    expect(verdict()?.textContent).toBe("Not read");
    expect(cells("Port")).toEqual(["Port", "not read", "takes 8000", "", "not checked", "Not read"]);
    expect(screen.getByText("The ports are checked once the settings this app requires are filled in.")).toBeTruthy();
    expect(prechecks).toEqual([]);
    fireEvent.change(screen.getByLabelText(/API token/), { target: { value: "abc" } });
    await waitFor(() => expect(verdict()?.textContent).toBe("Fits"));
    expect(prechecks).toHaveLength(1);
  });

  it("says where it will answer from the addresses the catalog read, and invents none", async () => {
    serve();
    openInstall();
    await waitFor(() => expect(verdict()?.textContent).toBe("Fits"));
    const answers = within(screen.getByRole("region", { name: "Where it will answer" }));
    expect(answers.getByText("http://192.0.2.10:8000")).toBeTruthy();
    expect(answers.getByText("http://homebox:8000")).toBeTruthy();
    expect(answers.getByText("Not published. Installing it opens nothing on your router.")).toBeTruthy();
    cleanup();
    serve();
    openInstall(paperless, { host: undefined });
    const unread = within(await screen.findByRole("region", { name: "Where it will answer" }));
    expect(unread.getByText("Port 8000 on this server; its network address was not read.")).toBeTruthy();
    expect(unread.getByText("No tailnet name is known for this server.")).toBeTruthy();
    expect(unread.queryByText(/^http/)).toBeNull();
  });

  it("offers the nightly backup ticked, for an app that holds data, and hands the choice on with the install", async () => {
    serve();
    const onSubmit = openInstall();
    const night = within(screen.getByRole("region", { name: "From the first night" }));
    const box = night.getByLabelText("Back it up every night") as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(night.getByText(/a backup every night at 02:00/)).toBeTruthy();
    save();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][2]).toEqual({ backupNightly: true });
    fireEvent.click(box);
    save();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit.mock.calls[1][2]).toEqual({ backupNightly: false });
  });

  it("does not offer it for an app with nothing to back up, to a role that cannot back up, or on Settings", async () => {
    serve();
    const stateless = { ...paperless, volumes: [], sidecars: [] } as unknown as Manifest;
    const onSubmit = openInstall(stateless);
    expect(screen.queryByRole("region", { name: "From the first night" })).toBeNull();
    save();
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][2]).toEqual({ backupNightly: false });
    cleanup();
    serve();
    openInstall(paperless, { nightly: { may: false, already: null } });
    expect(screen.queryByRole("region", { name: "From the first night" })).toBeNull();
    cleanup();
    // Settings is the form it always was: nothing about fitting, and no question about backups.
    open();
    expect(document.querySelector(".catalog-preflight")).toBeNull();
    expect(screen.queryByText(/^Starts /)).toBeNull();
  });

  it("says a backup schedule the app already has is kept, rather than offering a second", async () => {
    serve();
    const onSubmit = openInstall(paperless, { nightly: { may: true, already: "daily at 02:00" } });
    const night = within(screen.getByRole("region", { name: "From the first night" }));
    expect(night.getByText("Paperless-ngx already has a backup scheduled from before, daily at 02:00. It is kept.")).toBeTruthy();
    expect(night.queryByRole("checkbox")).toBeNull();
    save();
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][2]).toEqual({ backupNightly: false });
  });
});
