import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingOperation } from "../../shell/ApproveDialog";
import { DatabaseCopies, type DatabaseCopiesReport } from "./DatabaseCopies";
import SystemPage from "./SystemPage";
import { SystemPower, thresholdWords, watchdogWords, type SystemPowerProps } from "./SystemPower";
import type { PowerHardware, PowerOverview } from "./systemTypes";
import { updateLogFacts } from "./SystemUpdates";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const stagedJob = (id: string, tier = "medium") => json({ job: { id: `job-${id}`, type: `op:${id}`, title: id, state: "awaiting_approval", risk: tier, error: null, result: null, steps: [], approvals: [] }, approval: { tier, passwordRequired: tier === "high", elevated: false, mode: "tiered", reason: `${tier} risk` } }, 201);

const settings = {
  hostname: { static: "shiny-box", live: "shiny-box" },
  timezone: "Etc/UTC",
  timezones: ["Etc/UTC", "Europe/Berlin", "America/New_York"],
  locale: "en_US.UTF-8", locales: ["C.UTF-8", "en_US.UTF-8"],
  swappiness: 60,
  swap: [{ device: "/swap.img", type: "file", sizeKiB: 4194300, usedKiB: 0, priority: -2 }],
  memory: { memTotalKiB: 32768000, memAvailableKiB: 16384000, swapTotalKiB: 4194300, swapFreeKiB: 4194300 },
  fstrim: { active: "active", enabled: "enabled", nextRun: "Mon 2026-08-24 00:00:00 UTC" },
};
const release = { current: { version: "0.61.0" }, latest: { tag: "v0.62.0", version: "0.62.0", name: "BoxPilot v0.62.0", url: "https://github.com/AES256Afro/BoxPilot/releases/tag/v0.62.0", publishedAt: "2026-08-21T16:00:00Z", prerelease: false, notes: null }, updateAvailable: true, checkedAt: "2026-08-21T16:05:00Z", error: null };
const housekeeping = {
  generatedAt: "2026-09-29T10:00:00Z", totalBytes: 3 * 1024 ** 3, totalHumanBytes: "3.0 GiB",
  categories: [
    { id: "docker-unused", title: "Orphaned image layers", summary: "Layers nothing references.", items: 6, bytes: 1024 ** 3, humanBytes: "1.0 GiB", detail: ["6 orphaned layers"], keeping: [], safe: true },
    { id: "restore-leftovers", title: "Unfinished restores", summary: "May be the only original.", items: 1, bytes: 2 * 1024 ** 3, humanBytes: "2.0 GiB", detail: [], keeping: ["jellyfin.replaced"], safe: false, unavailable: "Recovery evidence." },
  ],
};

const guidance = {
  id: "power-on-after-outage", title: "Make the server start by itself when the power comes back",
  summary: "Most boards stay off after a power cut until someone presses the button.",
  why: ["\"Last State\" is not enough: after a clean shutdown, the last state is off, so the server stays off.", "With the UPS, BoxPilot shuts the server down when the battery runs low and the UPS then switches its outlets off."],
  board: { vendor: "ASUSTeK COMPUTER INC.", maker: "asus" },
  steps: [
    { maker: "ASUS", id: "asus", key: "Del or F2", path: ["Advanced", "APM Configuration", "Restore AC Power Loss"], value: "Power On", text: "", thisBoard: true },
    { maker: "Gigabyte", id: "gigabyte", key: "Del", path: ["Settings", "Platform Power", "AC BACK"], value: "Always On", text: "", thisBoard: false },
  ],
  other: "Another maker: look for \"AC power loss\".", alsoHelps: "Wake-on-LAN lets another device start the server after a clean shutdown.",
};
const overview: PowerOverview = {
  ups: { installed: true, configured: true, available: true, state: "online", reason: "ok", batteryChargePercent: 100, estimatedRuntimeSeconds: 1260, loadPercent: 18, lowBatteryPercent: 20, lowRuntimeSeconds: 300 },
  events: [
    { at: "2026-09-29T18:44:40Z", event: "on-mains", charge: 96, runtime: 1180 },
    { at: "2026-09-29T18:41:02Z", event: "on-battery", charge: 100, runtime: 1260 },
  ],
  eventsAvailable: "yes",
  policy: { shutdownAtLowBattery: true, lowBatteryPercent: 20, lowRuntimeSeconds: 300, preparationSeconds: 60, configuredAt: "2026-09-29T10:00:00Z" },
  guidance,
};
const hardware: PowerHardware = {
  watchdog: { state: "loadable", usable: true, virtualization: "none", devices: [], driver: { name: "sp5100_tco", available: "module", loaded: false, blacklisted: true }, runtimeSeconds: 0, rebootSeconds: 600, managedByBoxPilot: false },
  wakeOnLan: { ethtool: true, ports: [{ name: "enp5s0", mac: "02:00:00:00:00:01", driver: "r8169", up: true, supports: "pumbg", current: "d", supportsMagic: true, magicOn: false, linkFile: "/usr/lib/systemd/network/99-default.link", keptByBoxPilot: false }] },
  boardVendor: "ASUSTeK COMPUTER INC.",
};

/** The page's reads, and any job it stages, recorded. */
function serve(overrides: Record<string, (init?: RequestInit) => Response> = {}) {
  const staged: Record<string, unknown> = {};
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    for (const [suffix, answer] of Object.entries(overrides)) if (url.endsWith(suffix)) return answer(init);
    const job = url.match(/\/operations\/([^/]+)\/jobs$/);
    if (job) { staged[job[1]] = JSON.parse(String(init?.body)); return stagedJob(job[1], job[1] === "system.update" ? "high" : "medium"); }
    if (url.endsWith("/operations/system.settings.inspect/inspect")) return json({ operation: "system.settings.inspect", result: settings });
    if (url.endsWith("/operations/housekeeping.inspect/inspect")) return json({ operation: "housekeeping.inspect", result: housekeeping });
    if (url.endsWith("/api/v1/system/update")) return json({ ...release, updateAvailable: false, latest: { ...release.latest, tag: "v0.61.0", version: "0.61.0" } });
    if (url.endsWith("/api/v1/power/ups/detect")) return json({ devices: [], nutInstalled: false });
    if (url.endsWith("/api/v1/power/overview")) return json(overview);
    if (url.endsWith("/operations/power.hardware.inspect/inspect")) return json({ operation: "power.hardware.inspect", result: hardware });
    return json({ error: `unexpected ${url}` }, 500);
  }));
  return staged;
}

describe("System page", () => {
  it("puts the verdict and the host's facts first, and each figure opens its tab", async () => {
    serve();
    render(<SystemPage csrfToken="csrf-token" />);
    await waitFor(() => expect(document.querySelector(".ui-page-header__verdict")?.textContent).toBe("Up to date"));
    expect(document.querySelector(".ui-page-header__verdict")?.getAttribute("data-status")).toBe("good");
    expect(screen.getByRole("heading", { level: 1, name: "System" })).toBeTruthy();
    expect(document.querySelector(".ui-page-header__meta")?.textContent).toBe("shiny-box · Etc/UTC · 15.6 GiB free of 31.3 GiB · BoxPilot 0.61.0");
    expect((await screen.findAllByText("3.0 GiB")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /^Name/ }));
    expect(window.location.search).toBe("?tab=time");
    expect(screen.getByRole("tab", { name: "Time & name" }).getAttribute("aria-selected")).toBe("true");
  });

  it("stages a time zone change through the dialog, and keeps what was typed when the page reads again", async () => {
    const staged = serve();
    window.history.replaceState(null, "", "/?tab=time");
    render(<SystemPage csrfToken="csrf-token" />);
    // Until the settings arrive the zone is typed; then it is chosen from the server's list.
    await waitFor(() => expect((screen.getByLabelText("Set the time zone") as HTMLSelectElement).value).toBe("Etc/UTC"));
    const zone = screen.getByLabelText("Set the time zone");
    expect(zone.tagName).toBe("SELECT");
    const change = screen.getByRole("button", { name: "Change time zone" });
    expect((change as HTMLButtonElement).disabled).toBe(true);
    expect(change.getAttribute("data-risk")).toBe("medium");
    fireEvent.change(zone, { target: { value: "Europe/Berlin" } });
    fireEvent.click(screen.getByRole("button", { name: "Read again" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Read again" }) as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByLabelText("Set the time zone") as HTMLSelectElement).value).toBe("Europe/Berlin");
    fireEvent.click(screen.getByRole("button", { name: "Change time zone" }));
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    expect(staged["system.timezone.set"]).toEqual({ parameters: { timezone: "Europe/Berlin" } });
  });

  it("offers the newer GitHub release and stages the high-risk update with only the tag, the tag typed out", async () => {
    const staged = serve({
      "/api/v1/system/update": () => json(release),
      "/operations/system.update.status/inspect": () => json({ operation: "system.update.status", result: { units: [], log: ["[boxpilot-upgrade] BoxPilot 0.61.0 (v0.61.0) is live; 0 unit file(s) updated"], outcome: "live" } }),
    });
    render(<SystemPage csrfToken="csrf-token" />);
    expect(await screen.findByText("Update available")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Updates/ }));
    expect(screen.getByText(/Updating asks for your password, then the tag/)).toBeTruthy();
    const go = screen.getByRole("button", { name: /Update to v0.62.0/ });
    expect(go.getAttribute("data-risk")).toBe("high");
    fireEvent.click(go);
    expect(await screen.findByText("High risk")).toBeTruthy();
    expect(screen.getByLabelText("Typed confirmation")).toBeTruthy();
    expect(staged["system.update"]).toEqual({ parameters: { tag: "v0.62.0" } });
    expect(screen.getByText("Last update log, live")).toBeTruthy();
  });

  it("says the last update stopped, and why, in the verdict and on its tab", async () => {
    serve({
      "/operations/system.update.status/inspect": () => json({ operation: "system.update.status", result: { units: [], outcome: "failed", log: [
        "[boxpilot-upgrade] ERROR: could not copy the database to /var/lib/boxpilot: database or disk is full. Nothing was changed: BoxPilot 0.61.0 is still running from /opt/boxpilot.",
      ] } }),
    });
    render(<SystemPage csrfToken="csrf-token" />);
    await waitFor(() => expect(document.querySelector(".ui-page-header__verdict")?.textContent).toBe("Last update failed"));
    expect(document.querySelector(".ui-page-header__verdict")?.getAttribute("data-status")).toBe("danger");
    fireEvent.click(screen.getByRole("tab", { name: /Updates/ }));
    const notice = screen.getByText("The last update stopped").closest(".ui-notice");
    expect(notice?.getAttribute("data-status")).toBe("danger");
    expect(notice?.textContent).toMatch(/database or disk is full\. Nothing was changed/);
  });

  it("reclaims only the categories chosen, and never one that needs a review", async () => {
    const staged = serve();
    window.history.replaceState(null, "", "/?tab=housekeeping");
    render(<SystemPage csrfToken="csrf-token" />);
    const layers = await screen.findByRole("checkbox", { name: /Orphaned image layers/ });
    expect((screen.getByRole("checkbox", { name: /Unfinished restores/ }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/Review needed/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Reclaim space/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(layers);
    fireEvent.click(screen.getByRole("button", { name: /Reclaim 1.0 GiB/ }));
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    expect(staged["housekeeping.reclaim"]).toEqual({ parameters: { targets: ["docker-unused"] } });
  });

  it("switches the weekly trim through its own tiered switch", async () => {
    const staged = serve({ "/operations/system.settings.inspect/inspect": () => json({ operation: "system.settings.inspect", result: { ...settings, fstrim: { active: "inactive", enabled: "disabled", nextRun: null } } }) });
    window.history.replaceState(null, "", "/?tab=hardware");
    render(<SystemPage csrfToken="csrf-token" />);
    const trim = await screen.findByRole("switch", { name: "Weekly trim" });
    expect(trim.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/Weekly trim keeps SSDs/)).toBeTruthy();
    fireEvent.click(trim);
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    expect(staged["service.action"]).toEqual({ parameters: { unit: "fstrim.timer", action: "enable" } });
  });

  it("gives a viewer the settings and no changes, and leaves housekeeping to an operator", async () => {
    serve();
    window.history.replaceState(null, "", "/?tab=time");
    render(<SystemPage csrfToken="csrf-token" role="viewer" />);
    expect(await screen.findByText("Etc/UTC", { selector: "dd" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Change/ })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /Housekeeping/ }));
    expect(screen.getByText("Housekeeping is for an operator")).toBeTruthy();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes("housekeeping"))).toEqual([]);
  });

  it("says a release check that answered in another shape was not checked, rather than failing the page", async () => {
    serve({ "/api/v1/system/update": () => json({ status: "ok", mode: "host-aware" }) });
    render(<SystemPage csrfToken="csrf-token" />);
    await waitFor(() => expect(document.querySelector(".ui-page-header__verdict")?.textContent).toBe("Not checked"));
    fireEvent.click(screen.getByRole("tab", { name: /Updates/ }));
    expect(screen.getByText("The release check did not answer")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Update to/ })).toBeNull();
  });

  it("says when the settings could not be read, and offers to try again", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "The helper is not answering" }, 503)));
    render(<SystemPage csrfToken="csrf-token" />);
    expect(await screen.findByText("System settings could not be read")).toBeTruthy();
    expect(screen.getByText("Not read").closest(".ui-chip")?.getAttribute("data-status")).toBe("unknown");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

// M36: the update copies the database first, and says so; a copy it could not make stops it.
describe("what the update log says", () => {
  const line = (text: string) => `2026-09-29T10:15:00+0000 homebox boxpilot-upgrade[4242]: [boxpilot-upgrade] ${text}`;

  it("finds the database copy the last update took", () => {
    expect(updateLogFacts([
      line("copying the database 1.138.0 wrote to /var/lib/boxpilot/boxpilot-rollback-1.138.0-20260929T101500Z.sqlite3"),
      line("database copy: /var/lib/boxpilot/boxpilot-rollback-1.138.0-20260929T101500Z.sqlite3 (2048000 bytes, integrity ok)"),
      line("BoxPilot 1.139.0 (abc) is live; 0 unit file(s) updated; previous tree at /opt/boxpilot.prev.20260929T101500Z"),
    ])).toEqual({ error: null, databaseCopy: "/var/lib/boxpilot/boxpilot-rollback-1.138.0-20260929T101500Z.sqlite3" });
  });

  it("says why an update stopped, in the script's own words", () => {
    expect(updateLogFacts([
      line("copying the database 1.138.0 wrote to /var/lib/boxpilot/boxpilot-rollback-1.138.0-20260929T101500Z.sqlite3"),
      line("ERROR: could not copy the database to /var/lib/boxpilot: database or disk is full. Nothing was changed: BoxPilot 1.138.0 is still running from /opt/boxpilot."),
    ])).toEqual({ error: "could not copy the database to /var/lib/boxpilot: database or disk is full. Nothing was changed: BoxPilot 1.138.0 is still running from /opt/boxpilot.", databaseCopy: null });
    expect(updateLogFacts(["an unrelated journal line with ERROR: in it"])).toEqual({ error: null, databaseCopy: null });
  });
});

describe("the database copies updates took", () => {
  const copies: DatabaseCopiesReport = {
    directory: "/var/lib/boxpilot",
    rule: { keep: 3, keepDays: 30 },
    defaults: { keep: 3, keepDays: 30 },
    limits: { keep: [1, 50], keepDays: [0, 3650] },
    secretScrubVersion: "1.127.0",
    copies: [
      { name: "boxpilot-rollback-1.138.0-20260929T101500Z.sqlite3", version: "1.138.0", takenAt: "2026-09-29T10:15:00.000Z", bytes: 4, humanBytes: "46.0 MiB", heldSecrets: false, goes: false, keptBecause: "newest" },
      { name: "boxpilot-rollback-1.121.0-20260816T101700Z.sqlite3", version: "1.121.0", takenAt: "2026-08-16T10:17:00.000Z", bytes: 2, humanBytes: "38.0 MiB", heldSecrets: true, goes: true, keptBecause: null },
      { name: "boxpilot-rollback-1.121.0-20260816T101500Z.sqlite3", version: "1.121.0", takenAt: "2026-08-16T10:15:00.000Z", bytes: 2, humanBytes: "38.0 MiB", heldSecrets: true, goes: true, keptBecause: null },
    ],
    goes: ["boxpilot-rollback-1.121.0-20260816T101700Z.sqlite3", "boxpilot-rollback-1.121.0-20260816T101500Z.sqlite3"],
    goesHumanBytes: "76.0 MiB",
    totalHumanBytes: "122.0 MiB",
  };

  it("lists each copy with what the rule does with it, and stages exactly the ones that go", async () => {
    let staged: string | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/operations/housekeeping.database-copies.inspect/inspect")) return json({ operation: "housekeeping.database-copies.inspect", result: copies });
      if (url.endsWith("/operations/housekeeping.database-copies.remove/jobs")) { staged = init?.body as string; return stagedJob("housekeeping.database-copies.remove"); }
      return json({ error: `unexpected ${url}` }, 500);
    }));
    render(<DatabaseCopies csrfToken="csrf-token" role="owner" />);
    const table = await screen.findByRole("table", { name: "Database copies, newest first" });
    expect(within(table).getAllByText("Goes")).toHaveLength(2);
    expect(within(table).getByText("Kept: newest")).toBeTruthy();
    expect(screen.getByText(/2 copies were taken from a version before 1\.127\.0/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove 2 copies (76.0 MiB)" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Medium risk")).toBeTruthy();
    expect(within(dialog).getByText("boxpilot-rollback-1.121.0-20260816T101700Z.sqlite3")).toBeTruthy();
    expect(JSON.parse(staged ?? "{}")).toEqual({ parameters: { keep: 3, keepDays: 30, names: copies.goes } });
  });

  it("asks again when the rule changes, and offers nothing until the answer matches it", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/inspect")) return json({ operation: "housekeeping.database-copies.inspect", result: copies });
      if (url.endsWith("/operations/housekeeping.database-copies.inspect/run")) {
        asked.push(init?.body as string);
        return json({ operation: "housekeeping.database-copies.inspect", result: { ...copies, rule: { keep: 1, keepDays: 30 } } });
      }
      return json({ error: `unexpected ${url}` }, 500);
    }));
    render(<DatabaseCopies csrfToken="csrf-token" role="owner" />);
    const keep = await screen.findByLabelText(/Keep the newest/);
    fireEvent.change(keep, { target: { value: "1" } });
    expect((screen.getByRole("button", { name: /Remove 2 copies/ }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(asked).toEqual([JSON.stringify({ parameters: { keep: 1, keepDays: 30 } })]));
    await waitFor(() => expect((screen.getByRole("button", { name: /Remove 2 copies/ }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("shows an operator the list but not the removal, which is the owner's", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ operation: "housekeeping.database-copies.inspect", result: copies })));
    render(<DatabaseCopies csrfToken="csrf-token" role="operator" />);
    expect(await screen.findByRole("table", { name: "Database copies, newest first" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
  });
});

describe("power", () => {
  const apc = { vendorId: "051d", productId: "0002", manufacturer: "American Power Conversion", product: "Back-UPS ES 700G", driver: "usbhid-ups", confidence: "vendor-id" as const, sysfs: "1-2" };
  const notSetUp: PowerOverview = { ...overview, ups: { installed: false, configured: false, available: false, state: "unavailable", reason: "nut-client-not-installed", batteryChargePercent: null, estimatedRuntimeSeconds: null, loadPercent: null }, events: [], policy: null };
  const props = (overrides: Partial<SystemPowerProps> = {}): SystemPowerProps => ({
    role: "owner", start: vi.fn(), ups: { devices: [], nutInstalled: false }, upsError: null, onLookAgain: vi.fn(),
    overview: notSetUp, overviewError: null, hardware, hardwareError: null, hardwareLoading: false, onReadHardware: vi.fn(), ...overrides,
  });

  it("explains when nothing is found, and what is still to do", () => {
    render(<SystemPower {...props()} />);
    expect(screen.getByText("No UPS found on USB")).toBeTruthy();
    expect(screen.getByText("No UPS found on USB yet")).toBeTruthy();
    expect(screen.getByText("Not set up")).toBeTruthy();
    expect(screen.getByText("No power events yet")).toBeTruthy();
  });

  it("offers to install NUT, then sets up the detected UPS with the chosen shutdown and thresholds", () => {
    const start = vi.fn<(operation: PendingOperation) => void>();
    const { unmount } = render(<SystemPower {...props({ start, ups: { devices: [apc], nutInstalled: false } })} />);
    fireEvent.click(screen.getByRole("button", { name: /Install NUT first/ }));
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ operationId: "apt.install", parameters: { packages: ["nut"] } }));
    unmount();

    const setUp = vi.fn<(operation: PendingOperation) => void>();
    render(<SystemPower {...props({ start: setUp, ups: { devices: [apc], nutInstalled: true } })} />);
    expect(screen.getByText("Found: American Power Conversion Back-UPS ES 700G")).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Shut this server down/));
    fireEvent.change(screen.getByLabelText(/Low below/), { target: { value: "95" } });
    expect(screen.getByText("A whole number from 10 to 90")).toBeTruthy();
    const button = screen.getByRole("button", { name: /Set up monitoring/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Low below/), { target: { value: "30" } });
    fireEvent.change(screen.getByLabelText(/Or under/), { target: { value: "5" } });
    expect(button.getAttribute("data-risk")).toBe("medium");
    fireEvent.click(button);
    expect(setUp).toHaveBeenCalledWith(expect.objectContaining({ operationId: "ups.setup", parameters: { driver: "usbhid-ups", vendorId: "051d", productId: "0002", description: "American Power Conversion Back-UPS ES 700G", shutdownAtLowBattery: false, lowBatteryPercent: 30, lowRuntimeSeconds: 300 } }));
  });

  it("with the UPS watched, says its state, when the shutdown starts, what it does, and the events in words", () => {
    render(<SystemPower {...props({ overview, ups: { devices: [apc], nutInstalled: true } })} />);
    expect(screen.getByText("Watching; shuts down on a low battery")).toBeTruthy();
    expect(screen.getByText("below 20% or under 5 min left")).toBeTruthy();
    expect(screen.getByText("Apps stop, drives unmount, power off")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Apply/ })).toBeTruthy();
    const table = screen.getByRole("table", { name: "Power events, newest first" });
    expect(within(table).getByText("The power came back after 4 min")).toBeTruthy();
    expect(within(table).getByText("The power went out; the UPS took over")).toBeTruthy();
    expect(thresholdWords(20, 300)).toBe("below 20% or under 5 min left");
    expect(thresholdWords(null, null)).toBeNull();
  });

  it("turns the watchdog on with a preview that says a hang now reboots the server", () => {
    const start = vi.fn<(operation: PendingOperation) => void>();
    render(<SystemPower {...props({ start })} />);
    expect(screen.getByText(/Ubuntu does not load its driver \(sp5100_tco\) by itself/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Restart after the server is silent for/), { target: { value: "120" } });
    const button = screen.getByRole("button", { name: /Turn on/ });
    expect(button.getAttribute("data-risk")).toBe("medium");
    fireEvent.click(button);
    const staged = start.mock.calls[0][0];
    expect(staged).toMatchObject({ operationId: "power.watchdog.enable", parameters: { runtimeSeconds: 120 } });
    render(<>{staged.preview}</>);
    expect(screen.getByText("From now on a hang causes an automatic reboot.")).toBeTruthy();
  });

  it("offers the watchdog's off switch when it is on, and says why it cannot be used elsewhere", () => {
    const start = vi.fn<(operation: PendingOperation) => void>();
    const on: PowerHardware = { ...hardware, watchdog: { ...hardware.watchdog, state: "on", runtimeSeconds: 60, devices: [{ device: "/dev/watchdog0", identity: "SP5100 TCO timer", software: false, state: "active", timeoutSeconds: 60, nowayout: false }] } };
    render(<SystemPower {...props({ start, hardware: on })} />);
    const off = screen.getByRole("button", { name: /Turn off/ });
    expect(off.getAttribute("data-risk")).toBe("low");
    fireEvent.click(off);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ operationId: "power.watchdog.disable", parameters: {} }));
    expect(watchdogWords({ state: "virtual-machine", usable: false, virtualization: "kvm" }).sentence).toContain("virtual machine (kvm)");
    expect(watchdogWords({ state: "software-only", usable: false }).sentence).toContain("cannot restart a kernel that has frozen");
    expect(watchdogWords(null).status).toBe("unknown");
  });

  it("puts this board's firmware setting first, and offers Wake-on-LAN with its address", () => {
    const start = vi.fn<(operation: PendingOperation) => void>();
    render(<SystemPower {...props({ start, overview })} />);
    const panel = screen.getByRole("region", { name: "Power back on after an outage" });
    expect(panel.id).toBe("power-on");
    expect(within(panel).getByText("This board: ASUSTeK COMPUTER INC.")).toBeTruthy();
    expect(within(panel).getByText("Advanced › APM Configuration › Restore AC Power Loss")).toBeTruthy();
    expect(within(panel).getByText("02:00:00:00:00:01")).toBeTruthy();
    const wake = within(panel).getByRole("switch", { name: /Wake-on-LAN for enp5s0/ });
    fireEvent.click(wake);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ operationId: "power.wake-on-lan.set", parameters: { interface: "enp5s0", enabled: true } }));
  });

  it("keeps the root reads from a viewer and offers them nothing to start", () => {
    render(<SystemPower {...props({ role: "viewer", hardware: null, overview, ups: { devices: [apc], nutInstalled: true } })} />);
    expect(screen.getByText("Reading the watchdog is for an operator")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Turn on|Apply|Set up monitoring/ })).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    // The firmware guidance is for everyone.
    expect(screen.getByText("This board: ASUSTeK COMPUTER INC.")).toBeTruthy();
  });

  it("opens on the Power tab with the UPS, the watchdog read as an operator, and the Overview's Power figure", async () => {
    serve();
    window.history.replaceState(null, "", "/?tab=power");
    render(<SystemPage csrfToken="csrf-token" role="operator" />);
    expect(await screen.findByText("below 20% or under 5 min left")).toBeTruthy();
    expect(await screen.findByText(/Ubuntu does not load its driver/)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    const tile = await screen.findByRole("button", { name: /^Power/ });
    expect(tile.textContent).toContain("On mains");
    fireEvent.click(tile);
    expect(window.location.search).toBe("?tab=power");
  });
});
