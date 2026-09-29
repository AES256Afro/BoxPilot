import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PerformancePage from "./PerformancePage";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const perf = {
  generatedAt: "2026-09-29T10:00:00.000Z",
  cpu: { model: "AMD Ryzen 7 7800X3D 8-Core Processor", cores: 16, usagePercent: 12, perCore: [], load1: 0.52, load5: 0.61, load15: 0.7, loadPercent: 3 },
  memory: { totalBytes: 32 * 1024 ** 3, usedBytes: 30 * 1024 ** 3, availableBytes: 2 * 1024 ** 3, usedPercent: 93 },
  swap: { totalBytes: 0, usedBytes: 0, usedPercent: 0 },
  uptimeSeconds: 3 * 86400 + 4 * 3600,
  temps: [{ label: "Tctl: CPU", celsius: 54 }],
  disks: [{ mount: "/", fstype: "ext4", totalBytes: 100 * 1024 ** 3, usedBytes: 40 * 1024 ** 3, availableBytes: 60 * 1024 ** 3, usedPercent: 40 }],
  statsAvailable: true,
  apps: [
    { id: "jellyfin", state: "running", running: true, cpuPercent: 30.2, memBytes: 900 * 1024 ** 2, containers: 1 },
    { id: "ollama", state: "running", running: true, cpuPercent: 0.4, memBytes: 4 * 1024 ** 3, containers: 1 },
    { id: "sonarr", state: "paused", running: true, cpuPercent: 0, memBytes: 200 * 1024 ** 2, containers: 1 },
    { id: "radarr", state: "exited", running: false, cpuPercent: 0, memBytes: 0, containers: 1 },
  ],
};
const catalog = { applications: [
  { manifest: { id: "jellyfin", name: "Jellyfin", icon: "🎬", category: "Media" } },
  { manifest: { id: "ollama", name: "Ollama", icon: null, category: "AI" } },
  { manifest: { id: "sonarr", name: "Sonarr", icon: null, category: "Media" } },
  { manifest: { id: "radarr", name: "Radarr", icon: null, category: "Media" } },
] };

const mount = (role?: string) => {
  const calls: Array<{ url: string; body?: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    calls.push({ url, body: init?.body as string | undefined });
    if (url.endsWith("/operations/system.performance.inspect/inspect")) return json({ result: perf });
    if (url.startsWith("/api/v1/catalog")) return json(catalog);
    if (url.endsWith("/operations/app.action/jobs")) return json({ job: { id: "j", type: "op:app.action", title: "App", state: "awaiting_approval", risk: "low", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "low", passwordRequired: false, elevated: false, mode: "tiered", reason: "low" } }, 201);
    return json({ error: `unexpected ${url}` }, 500);
  }));
  render(<PerformancePage csrfToken="csrf-token" role={role} pollMs={60_000} />);
  return calls;
};

describe("Performance page", () => {
  it("names the busiest measure first, then the figures, then every app with the AI ones pinned", async () => {
    mount();
    expect(await screen.findByText("Jellyfin")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Performance" })).toBeTruthy();
    const verdict = document.querySelector(".ui-page-header__verdict");
    expect(verdict?.textContent).toBe("Memory 93%");
    expect(verdict?.getAttribute("data-status")).toBe("warning");
    expect(document.querySelector(".ui-page-header__meta")?.textContent).toBe("up 3d 4h · 16 threads · load 0.52 · 2 of 4 apps running · read every 60 s");
    expect(screen.getByText("30.0 GiB")).toBeTruthy();
    expect(screen.getByText("of 32.0 GiB · 93% used")).toBeTruthy();
    expect(screen.getByText("no swap file")).toBeTruthy();
    const table = screen.getByRole("table", { name: "Each app's live CPU and memory" });
    const rows = within(table).getAllByRole("row").slice(1);
    // AI first however idle, then the heaviest.
    expect(rows[0].textContent).toContain("Ollama");
    expect(rows[1].textContent).toContain("Jellyfin");
    expect(within(rows[0]).getByText("AI")).toBeTruthy();
    // A paused app says so, and a stopped one shows no numbers.
    const paused = rows.find((row) => row.textContent?.includes("Sonarr"))!;
    expect(paused.getAttribute("data-status")).toBe("warning");
    const stopped = rows.find((row) => row.textContent?.includes("Radarr"))!;
    expect(within(stopped).getAllByText("—").length).toBe(2);
    expect(screen.getByRole("table", { name: "Each filesystem's use" }).textContent).toContain("ext4");
  });

  it("offers pause, restart and stop where the cost shows, each through the approval dialog at its tier", async () => {
    const calls = mount();
    await screen.findByText("Jellyfin");
    expect(screen.getByRole("button", { name: "Resume Sonarr" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pause Sonarr" })).toBeNull();
    expect(screen.getByRole("button", { name: "Start Radarr" })).toBeTruthy();
    const pause = screen.getByRole("button", { name: "Pause Jellyfin" });
    expect(pause.getAttribute("data-risk")).toBe("low");
    fireEvent.click(pause);
    expect(await screen.findByText("Low risk")).toBeTruthy();
    expect(JSON.parse(calls.find((call) => call.url.endsWith("/operations/app.action/jobs"))?.body ?? "{}")).toEqual({ parameters: { id: "jellyfin", action: "pause" } });
  });

  it("gives a viewer the numbers and no controls", async () => {
    mount("viewer");
    await screen.findByText("Jellyfin");
    expect(document.querySelectorAll("button[data-risk]").length).toBe(0);
  });

  it("says when the numbers could not be read, never that all is well", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "The helper is not answering" }, 503)));
    render(<PerformancePage csrfToken="csrf-token" pollMs={60_000} />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    const verdict = document.querySelector(".ui-page-header__verdict");
    expect(verdict?.textContent).toContain("Not read");
    expect(verdict?.getAttribute("data-status")).toBe("unknown");
  });
});
