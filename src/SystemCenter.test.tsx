import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SystemCenter, { updateLogFacts } from "./SystemCenter";
import DatabaseCopiesPanel, { type DatabaseCopies } from "./DatabaseCopiesPanel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const settings = {
  hostname: { static: "shiny-box", live: "shiny-box" },
  timezone: "Etc/UTC",
  timezones: ["Etc/UTC", "Europe/Berlin", "America/New_York"],
  swappiness: 60,
  swap: [{ device: "/swap.img", type: "file", sizeKiB: 4194300, usedKiB: 0, priority: -2 }],
  memory: { memTotalKiB: 32768000, memAvailableKiB: 16384000, swapTotalKiB: 4194300, swapFreeKiB: 4194300 },
  fstrim: { active: "active", enabled: "enabled", nextRun: "Mon 2026-08-24 00:00:00 UTC" },
};

describe("System center", () => {
  it("shows live settings and stages a time zone change through the dialog", async () => {
    let staged: string | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/operations/system.settings.inspect/inspect")) return json({ operation: "system.settings.inspect", result: settings });
      if (url.endsWith("/operations/system.timezone.set/jobs")) { staged = init?.body as string; return json({ job: { id: "job-tz", type: "op:system.timezone.set", title: "Change the time zone", state: "awaiting_approval", risk: "medium", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", reason: "medium risk" } }, 201); }
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SystemCenter csrfToken="csrf-token" />);

    expect(await screen.findByText("shiny-box")).toBeTruthy();
    expect(screen.getAllByText("Etc/UTC").length).toBeGreaterThan(0);
    const changeButton = screen.getByRole("button", { name: "Change" });
    expect((changeButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Time zone"), { target: { value: "Europe/Berlin" } });
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    expect(JSON.parse(staged ?? "{}")).toEqual({ parameters: { timezone: "Europe/Berlin" } });
  });

  it("offers the newer GitHub release and stages the high-risk update with only the tag", async () => {
    let staged: string | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/operations/system.settings.inspect/inspect")) return json({ operation: "system.settings.inspect", result: settings });
      if (url.endsWith("/api/v1/system/update")) return json({ current: { version: "0.61.0" }, latest: { tag: "v0.62.0", version: "0.62.0", name: "BoxPilot v0.62.0", url: "https://github.com/AES256Afro/BoxPilot/releases/tag/v0.62.0", publishedAt: "2026-08-21T16:00:00Z", prerelease: false, notes: null }, updateAvailable: true, checkedAt: "2026-08-21T16:05:00Z", error: null });
      if (url.endsWith("/operations/system.update.status/inspect")) return json({ operation: "system.update.status", result: { units: [], log: ["[boxpilot-upgrade] BoxPilot 0.61.0 (v0.61.0) is live; 0 unit file(s) updated"], outcome: "live" } });
      if (url.endsWith("/operations/system.update/jobs")) { staged = init?.body as string; return json({ job: { id: "job-up", type: "op:system.update", title: "Update BoxPilot", state: "awaiting_approval", risk: "high", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "high", passwordRequired: true, elevated: false, mode: "tiered", reason: "high risk" } }, 201); }
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SystemCenter csrfToken="csrf-token" />);

    fireEvent.click(await screen.findByRole("button", { name: "Update to v0.62.0" }));
    expect(await screen.findByText("High risk")).toBeTruthy();
    expect(screen.getByLabelText("Typed confirmation")).toBeTruthy();
    expect(JSON.parse(staged ?? "{}")).toEqual({ parameters: { tag: "v0.62.0" } });
    expect(screen.getByText(/Last update log, live/)).toBeTruthy();
  });

  it("offers to enable the trim timer when it is disabled", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/operations/system.settings.inspect/inspect")) return json({ operation: "system.settings.inspect", result: { ...settings, fstrim: { active: "inactive", enabled: "disabled", nextRun: null } } });
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SystemCenter csrfToken="csrf-token" />);
    expect(await screen.findByRole("button", { name: "Enable" })).toBeTruthy();
    expect(screen.getByText(/Weekly trim keeps SSDs/)).toBeTruthy();
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
  const copies: DatabaseCopies = {
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
      if (url.endsWith("/operations/housekeeping.database-copies.remove/jobs")) { staged = init?.body as string; return json({ job: { id: "job-copies", type: "op:housekeeping.database-copies.remove", title: "Remove old database copies", state: "awaiting_approval", risk: "medium", error: null, result: null, steps: [], approvals: [] }, approval: { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", reason: "medium risk" } }, 201); }
      return json({ error: `unexpected ${url}` }, 500);
    }));
    render(<DatabaseCopiesPanel csrfToken="csrf-token" role="owner" />);

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
    render(<DatabaseCopiesPanel csrfToken="csrf-token" role="owner" />);
    const keep = await screen.findByLabelText(/Keep the newest/);
    fireEvent.change(keep, { target: { value: "1" } });
    expect((screen.getByRole("button", { name: /Remove 2 copies/ }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(asked).toEqual([JSON.stringify({ parameters: { keep: 1, keepDays: 30 } })]));
    await waitFor(() => expect((screen.getByRole("button", { name: /Remove 2 copies/ }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("shows an operator the list but not the removal, which is the owner's", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ operation: "housekeeping.database-copies.inspect", result: copies })));
    render(<DatabaseCopiesPanel csrfToken="csrf-token" role="operator" />);
    expect(await screen.findByRole("table", { name: "Database copies, newest first" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
  });
});
