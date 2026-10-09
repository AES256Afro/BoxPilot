import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TopBarSlotProvider } from "../shell/TopBarSlot";
import { FactsProvider } from "./facts";
import Home from "./Home";
import { answers, ago, stubFetch } from "./testData";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderHome(role = "owner") {
  const onNavigate = vi.fn();
  render(<FactsProvider><Home csrfToken="csrf" role={role} onNavigate={onNavigate} /></FactsProvider>);
  return onNavigate;
}

describe("Home", () => {
  it("answers whether everything is OK, worst first, with each fix's tier on its button", async () => {
    vi.stubGlobal("fetch", stubFetch());
    const onNavigate = renderHome();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/^Good (morning|afternoon|evening)$/);
    expect(await screen.findByText("homebox needs you: 1 problem and 1 thing to look at. One more thing can wait.")).toBeTruthy();

    // What needs a look is down the side; what can wait is in the strip under the apps (M33.7).
    // Between them they are the verdict's whole list: one problem, one to look at, one that can wait.
    const needs = screen.getByRole("region", { name: /What needs you/ });
    const titles = within(needs).getAllByRole("button").filter((button) => button.className.includes("need__title")).map((button) => button.textContent);
    expect(titles).toEqual(["Problem: Vaultwarden is not running", "Needs a look: 4 updates available"]);
    const waiting = screen.getByRole("region", { name: /Can wait/ });
    expect(within(waiting).getAllByRole("button").filter((button) => button.className.includes("need__title")).map((button) => button.textContent)).toEqual(["Suggestion: An update for Jellyfin"]);
    // The tier is on the button and, as the study drew it, beside the words; only the button's is read out.
    const tag = within(needs).getByRole("button", { name: "Install: 4 updates available" }).closest("li")?.querySelector(".need__tier-tag");
    expect(tag?.getAttribute("aria-hidden")).toBe("true");
    expect(tag?.textContent).toBe("Medium risk");

    const start = within(needs).getByRole("button", { name: "Start: Vaultwarden is not running" });
    expect(start.getAttribute("data-risk")).toBe("low");
    expect(document.getElementById(start.getAttribute("aria-describedby") ?? "")?.textContent).toBe("Low risk.");
    expect(within(needs).getByRole("button", { name: "Install: 4 updates available" }).getAttribute("data-risk")).toBe("medium");

    // The fact opens its detail; the fix goes through the approval dialog, never around it.
    fireEvent.click(within(needs).getByRole("button", { name: "Problem: Vaultwarden is not running" }));
    expect(onNavigate).toHaveBeenCalledWith("catalog", { app: "vaultwarden" });
    fireEvent.click(start);
    expect(await screen.findByRole("dialog", { name: "Start Vaultwarden" })).toBeTruthy();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/v1/operations/app.action/jobs", expect.objectContaining({ method: "POST", body: JSON.stringify({ parameters: { id: "vaultwarden", action: "start" } }) }));
  });

  it("shows the installed apps as tiles, each opening a sheet with its facts and its tiers", async () => {
    vi.stubGlobal("fetch", stubFetch());
    const onNavigate = renderHome();
    const apps = await screen.findByRole("region", { name: /Apps/ });
    const vaultwarden = await within(apps).findByRole("button", { name: "Vaultwarden, Not running" });
    expect(vaultwarden.getAttribute("data-status")).toBe("danger");
    expect(vaultwarden.textContent).toContain("V"); // initials: no icon in its manifest
    const jellyfin = within(apps).getByRole("button", { name: "Jellyfin, Healthy, update ready" });
    expect(jellyfin.textContent).toContain("🎬");
    // Each app on its own colour square (M33.7): Jellyfin's known violet; any other app one from its id.
    expect(jellyfin.querySelector(".ui-tile__icon")?.getAttribute("data-hue")).toBe("violet");
    expect(vaultwarden.querySelector(".ui-tile__icon")?.getAttribute("data-hue")).toBe("blue");
    expect(within(apps).getByRole("button", { name: /Add an app/ }).textContent).toContain("3 in the catalog");
    expect(within(apps).queryByText("Mealie")).toBeNull();

    fireEvent.click(jellyfin);
    const sheet = screen.getByRole("dialog", { name: "Jellyfin" });
    expect(within(sheet).getByRole("link", { name: /Open Jellyfin/ }).getAttribute("href")).toBe("http://192.0.2.10:8096");
    expect(within(sheet).getByText("A new version is ready")).toBeTruthy();
    expect(within(sheet).getByText(/3 backups, the newest 10 hours ago/)).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: "Update" }).getAttribute("data-risk")).toBe("medium");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Jellyfin" })).toBeNull();

    fireEvent.click(jellyfin);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Jellyfin" })).getByRole("button", { name: "Manage in the App catalog" }));
    expect(onNavigate).toHaveBeenCalledWith("catalog", { app: "jellyfin" });
  });

  it("tells the last week's power cuts as short news under the system figures (M39)", async () => {
    const inventory = answers["/api/v1/inventory"] as Record<string, unknown>;
    vi.stubGlobal("fetch", stubFetch({ "/api/v1/inventory": { ...inventory, power: { ups: { installed: true, configured: true, available: true, state: "online", batteryChargePercent: 100 }, events: [
      { at: ago(1), event: "on-mains", charge: 96, runtime: 1180 },
      { at: ago(1.05), event: "on-battery", charge: 100, runtime: 1260 },
      { at: ago(2), event: "watching" },
      { at: ago(24 * 10), event: "on-battery" },
    ] } } }));
    renderHome();
    const news = await screen.findByRole("list", { name: "Power news" });
    const items = within(news).getAllByRole("listitem").map((item) => item.textContent);
    expect(items).toHaveLength(2);
    expect(items[0]).toContain("The power came back after 3 min, battery 96%, about 20 min left");
    expect(items[1]).toContain("The power went out; the UPS took over");
  });

  it("has no power news when there was none", async () => {
    vi.stubGlobal("fetch", stubFetch());
    renderHome();
    await screen.findByText(/homebox needs you/);
    expect(screen.queryByRole("list", { name: "Power news" })).toBeNull();
  });

  it("says it is checking while Check again reads, and that it has, even when nothing changed", async () => {
    vi.stubGlobal("fetch", stubFetch());
    renderHome();
    await screen.findByText(/homebox needs you/);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    const busy = screen.getByRole("button", { name: "Checking…" });
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(await screen.findByText(/^Checked again at /)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
  });

  it("opens each figure's page", async () => {
    vi.stubGlobal("fetch", stubFetch());
    const onNavigate = renderHome();
    await screen.findByText("load 0.84 on 8 cores");
    const processor = screen.getByRole("button", { name: /^Processor/ });
    expect(processor.textContent).toContain("11%");
    expect(processor.getAttribute("data-status")).toBe("good");
    fireEvent.click(processor);
    expect(onNavigate).toHaveBeenLastCalledWith("performance");
    fireEvent.click(screen.getByRole("button", { name: /^System disk/ }));
    expect(onNavigate).toHaveBeenLastCalledWith("storage");
    fireEvent.click(screen.getByRole("button", { name: /^Off this server/ }));
    expect(onNavigate).toHaveBeenLastCalledWith("backups");
  });

  it("never calls the server healthy when it could not read it", async () => {
    vi.stubGlobal("fetch", stubFetch({}, true));
    renderHome();
    expect(await screen.findByText(/^Nothing wrong found, but BoxPilot could not read the apps, the health alerts, Repair's problem scan/)).toBeTruthy();
    expect(screen.getAllByText("Not fully checked").length).toBeGreaterThan(0);
    expect(screen.queryByText("Healthy")).toBeNull();
    expect(screen.getByText("Which apps are installed could not be read.", { exact: false })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Processor/ }).getAttribute("data-status")).toBe("unknown");
  });

  it("names the server at the start of the shell's bar, with the verdict's mark", async () => {
    vi.stubGlobal("fetch", stubFetch());
    const slot = document.createElement("div");
    document.body.append(slot);
    render(<FactsProvider><TopBarSlotProvider value={slot}><Home csrfToken="csrf" role="owner" onNavigate={vi.fn()} /></TopBarSlotProvider></FactsProvider>);
    await vi.waitFor(() => expect(slot.querySelector(".lx-host strong")?.textContent).toBe("homebox"));
    const host = slot.querySelector(".lx-host")!;
    expect(host.getAttribute("data-status")).toBe("danger");
    expect(host.querySelector(".lx-host__facts")?.textContent).toMatch(/ · up \d+d \d+h$/);
    cleanup();
    slot.remove();
  });

  it("shows a viewer the same facts and no buttons it could not use", async () => {
    vi.stubGlobal("fetch", stubFetch());
    renderHome("viewer");
    const needs = await screen.findByRole("region", { name: /What needs you/ });
    expect(await within(needs).findByRole("button", { name: "Problem: Vaultwarden is not running" })).toBeTruthy();
    expect(within(needs).queryByRole("button", { name: /^Start:/ })).toBeNull();
    expect(within(needs).queryByRole("button", { name: /^Install:/ })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Jellyfin, Healthy, update ready" }));
    expect(within(screen.getByRole("dialog", { name: "Jellyfin" })).queryByRole("button", { name: "Update" })).toBeNull();
  });

  it("offers each of a Repair finding's fixes with its tier, runs one as Repair does, and says it is fixed (M35)", async () => {
    const backupNow = { operationId: "app.backup", parameters: { id: "vaultwarden" }, label: "Back up now", preview: "Stops Vaultwarden briefly and archives it.", risk: "medium" };
    const nightly = { kind: "schedule", operationId: "app.backup", label: "Back up nightly", preview: "Nightly.", risk: "medium", schedules: [{ parameters: { id: "vaultwarden" }, frequency: "daily", hour: 2, minute: 0 }] };
    const due = { id: "backups-due", severity: "warning", title: "Vaultwarden has never been backed up", detail: "", evidence: ["Vaultwarden: never backed up, no schedule"], fix: backupNow, fixes: [backupNow, nightly], manual: null, fingerprint: "0123456789abcdef" };
    let scans = 0;
    const base = stubFetch({ "/api/v1/remediations": { findings: [due], dismissed: [], counts: { critical: 0, warning: 1, info: 0 }, jobs: { attached: [], resolved: [], dismissed: [] }, unavailableChecks: [] } });
    const attempts: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/v1/remediations") { scans += 1; if (scans > 1) return new Response(JSON.stringify({ findings: [], dismissed: [], counts: { critical: 0, warning: 0, info: 0 }, jobs: { attached: [], resolved: [], dismissed: [] }, unavailableChecks: [] })); }
      if (url === "/api/v1/remediations/attempts") { attempts.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ recorded: true }), { status: 201 }); }
      if (url.endsWith("/approve")) return new Response(JSON.stringify({ job: { id: "staged", state: "applying" }, elevatedUntil: null }), { status: 202 });
      if (url === "/api/v1/jobs/staged") return new Response(JSON.stringify({ job: { id: "staged", type: "op:app.backup", title: "Back up application data", state: "completed", risk: "medium", error: null, result: { backedUp: true, artifact: "20260929T120000Z.tar.gz" }, steps: [], approvals: [] } }));
      return base(input, init);
    }));
    renderHome();
    const needs = await screen.findByRole("region", { name: /What needs you/ });
    const now = await within(needs).findByRole("button", { name: "Back up now: Vaultwarden has never been backed up" });
    expect(now.getAttribute("data-risk")).toBe("medium");
    expect(within(needs).getByRole("button", { name: "Back up nightly: Vaultwarden has never been backed up" }).getAttribute("data-risk")).toBe("medium");
    // Said once: Home's own backup line gives way to Repair's, which has the buttons.
    const titles = within(needs).getAllByRole("button").filter((button) => button.className.includes("need__title")).map((button) => button.textContent);
    expect(titles.filter((title) => title?.includes("backed up"))).toEqual(["Needs a look: Vaultwarden has never been backed up"]);
    fireEvent.click(now);
    fireEvent.click(await screen.findByRole("button", { name: "Run" }));
    expect(await screen.findByText(/Vaultwarden has never been backed up\. Backed up to 20260929T120000Z\.tar\.gz\./)).toBeTruthy();
    expect(attempts).toEqual([{ findingId: "backups-due", jobId: "staged" }]);
  });

  it("dismisses a failed job with M36's mark on the job itself, the one Activity reads (M35)", async () => {
    const failed = { id: "f1", type: "op:app.update", title: "Update Immich", state: "failed", risk: "medium", error: "pull failed", parameters: { id: "immich" }, steps: [], approvals: [], createdAt: new Date(Date.now() - 3_600_000).toISOString() };
    const base = stubFetch({ "/api/v1/jobs?limit=50": { jobs: [failed] } });
    const posted: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (init?.method === "POST" && url.endsWith("/dismiss")) { posted.push(url); return new Response(JSON.stringify({ job: { ...failed, steps: [{ name: "dismissed", state: "completed", detail: "Dismissed by alex." }] } })); }
      return base(input, init);
    }));
    renderHome();
    const needs = await screen.findByRole("region", { name: /What needs you/ });
    fireEvent.click(await within(needs).findByRole("button", { name: "Dismiss: Failed: Update Immich" }));
    await waitFor(() => expect(posted).toEqual(["/api/v1/jobs/f1/dismiss"]));
    // Not Repair's ledger: one mark for a failed job, wherever it is let go.
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("/remediations/dismissals"))).toBe(false);
  });
});
