import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openViewEvent } from "../../activityEvents";
import AutomationsPage from "./AutomationsPage";
import type { SchedulesSource } from "./SchedulesPanel";
import TonightPanel from "./TonightPanel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Tuesday evening, on the server's clock (UTC here); the dated fixtures below are that night's. */
const now = () => Date.parse("2026-11-10T19:52:00Z");

const schedule = (more: Record<string, unknown>) => ({
  id: "s", operationId: "backup.remote.sync", parameters: {}, frequency: "daily", minute: 30, hour: 2, weekday: null, enabled: true,
  nextDueAt: "2026-11-11T02:30:00.000Z", lastRunAt: "2026-11-10T02:30:00.000Z", lastJobId: null, lastResult: "completed", lastOutcome: "ran", lastReason: null,
  title: "Mirror backups to the SSH destination", cadence: "daily at 02:30", ...more,
});
const copy = schedule({ id: "copy", lastJobId: "j-copy" });
const snapshot = schedule({ id: "snap", operationId: "host.snapshot.create", title: "Create a machine snapshot", nextDueAt: "2026-11-11T02:00:00.000Z", lastJobId: "j-snap", cadence: "daily at 02:00" });
const updates = {
  id: "f-updates", name: "Security updates", createdBy: "o", risk: "medium", running: false, webhookEnabled: false, steps: [{ operationId: "apt.upgrade" }],
  lastRunAt: "2026-11-10T03:00:00.000Z", lastResult: "completed", lastJobIds: ["j-updates"],
  frequency: "daily", minute: 0, hour: 3, weekday: null, enabled: true, nextDueAt: "2026-11-11T03:00:00.000Z", triggerFlowId: null,
};
const jobs = [
  { id: "j-copy", state: "completed", createdAt: "2026-11-10T02:30:00.000Z", updatedAt: "2026-11-10T03:11:00.000Z" },
  { id: "j-snap", state: "completed", createdAt: "2026-11-10T02:00:00.000Z", updatedAt: "2026-11-10T02:05:00.000Z" },
  { id: "j-updates", state: "completed", createdAt: "2026-11-10T03:00:00.000Z", updatedAt: "2026-11-10T03:18:00.000Z" },
];
const agentsOff = { module: { enabled: false, paused: false, pausedUntil: null, quietHours: { start: "22:00", end: "07:00" } }, runner: {}, queue: {}, agents: [] };
const quietOn = { enabled: true, start: "22:00", end: "07:00", holdHigh: false, held: 3, quietNow: false };

interface Fixture { jobs?: unknown[] | null; quiet?: unknown; agents?: unknown; runs?: Record<string, unknown[]> }
/** Tonight's own reads; null for one that fails. */
function serve(fixture: Fixture = {}, other?: (url: string, init?: RequestInit) => Response | undefined) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const answer = other?.(url, init);
    if (answer) return answer;
    if (url.startsWith("/api/v1/jobs?")) return fixture.jobs === null ? json({ error: "the database is busy" }, 500) : json({ jobs: fixture.jobs ?? jobs });
    if (url === "/api/v1/settings/quiet-hours") return fixture.quiet === null ? json({ error: "no" }, 500) : json(fixture.quiet ?? { enabled: false, start: "22:00", end: "07:00", holdHigh: false, held: 0, quietNow: false });
    if (url === "/api/v1/agents") return fixture.agents === null ? json({ error: "no" }, 500) : json(fixture.agents ?? agentsOff);
    const runsOf = /^\/api\/v1\/agents\/([^/]+)\/runs/.exec(url);
    if (runsOf) return fixture.runs?.[runsOf[1]] ? json({ runs: fixture.runs[runsOf[1]] }) : json({ error: "no" }, 500);
    return json({ error: `unexpected ${url}` }, 500);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const source = (schedules: unknown[], unread = false): SchedulesSource => ({ schedules: schedules as SchedulesSource["schedules"], error: null, setError: () => {}, refresh: async () => {}, unread });
const draw = (props: Partial<Parameters<typeof TonightPanel>[0]> = {}) => render(
  <TonightPanel csrfToken="csrf" flows={[]} schedules={source([])} serverTimezone="Etc/UTC" onFlowsChanged={() => {}} onOpenSchedules={() => {}} now={now} {...props} />,
);
const verdict = () => document.querySelector(".automations-tonight__verdict .ui-chip");
const settled = () => vi.waitFor(() => expect(verdict()?.textContent).not.toBe("Reading…"));
const meta = () => document.querySelector(".automations-tonight .ui-panel__meta")?.textContent;

describe("Tonight", () => {
  it("says nothing is due when nothing is, without calling it good", async () => {
    serve();
    draw();
    await settled();
    expect(verdict()?.textContent).toBe("Nothing is due tonight");
    expect(verdict()?.getAttribute("data-status")).toBe("neutral");
    expect(meta()).toBe("0 jobs · quiet hours off");
    expect(screen.getByText("No schedule, automation or agent has a run between 20:00 and 08:00.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("draws the night as a real table: a row a job, a column a half hour, each mark said in words", async () => {
    serve({ quiet: quietOn });
    draw({ schedules: source([copy, snapshot]) });
    await settled();
    // The snapshot is done at 02:05, before the copy starts.
    expect(verdict()?.textContent).toBe("Nothing overlaps tonight");
    expect(verdict()?.getAttribute("data-status")).toBe("good");
    expect(meta()).toBe("2 jobs · first 02:00 · last 02:30 · quiet hours 22:00 to 07:00");

    const table = screen.getByRole("table", { name: /from 20:00 to 08:00, in half hours/ });
    expect(within(table).getAllByRole("columnheader").map((heading) => heading.textContent)).toEqual(["Job", "Starts", "Last run", "20", "21", "22", "23", "00", "01", "02", "03", "04", "05", "06", "07"]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getByRole("rowheader").querySelector(".automations-tonight__name")?.textContent)).toEqual(["Quiet hours", "Create a machine snapshot", "Mirror backups to the SSH destination"]);
    // After its name, a row is when it starts, what its last run took, and twenty-four half hours.
    for (const row of rows) expect(within(row).getAllByRole("cell")).toHaveLength(26);

    const copyRow = rows[2];
    expect(within(copyRow).getAllByRole("cell").slice(0, 2).map((cell) => cell.textContent)).toEqual(["02:30", "41 min"]);
    const marks = within(copyRow).getAllByRole("img");
    expect(marks.map((mark) => [mark.getAttribute("data-kind"), mark.getAttribute("aria-label")])).toEqual([["planned", "02:30 to 03:11"], ["spill", "its last run went on until 03:11"]]);
    // 02:30 is the fourteenth half hour from 20:00, and the run went on into the fifteenth.
    const cells = within(copyRow).getAllByRole("cell").slice(2);
    expect(cells.map((cell) => Boolean(cell.querySelector("[data-kind]"))).flatMap((filled, index) => (filled ? [index] : []))).toEqual([13, 14]);
    // The quiet hours are said once, and the pushes they hold are counted.
    expect(within(rows[0]).getAllByRole("img").map((mark) => mark.getAttribute("aria-label"))).toEqual(["quiet from 22:00 to 07:00"]);
    expect(rows[0].textContent).toContain("3 pushes held");
    expect(rows[0].querySelectorAll('[data-kind="quiet"]')).toHaveLength(18);

    // The marks are named, each with its pattern, and only the ones on the chart.
    const legend = screen.getByRole("list", { name: "What the marks mean" });
    expect(within(legend).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Starts here, as long as its last run took", "Its last run went on past the half hour it starts in", "Quiet hours"]);
    // The box scrolls sideways by keyboard too, and the foot says whose clock this is.
    expect(screen.getByRole("region", { name: "Tonight, on a time axis" }).getAttribute("tabindex")).toBe("0");
    expect(document.querySelector(".automations-tonight .ui-panel__foot")?.textContent).toContain("Times are this server's clock, Etc/UTC.");
  });

  it("calls out two jobs that will run into each other, and moves the later one with the request its card uses", async () => {
    let sent: unknown = null;
    serve({}, (url, init) => {
      if (url === "/api/v1/flows/f-updates" && init?.method === "PUT") { sent = JSON.parse(String(init.body)); return json({ flow: {} }); }
      return undefined;
    });
    const changed = vi.fn();
    draw({ schedules: source([copy]), flows: [updates] as never, onFlowsChanged: changed });
    await settled();
    expect(verdict()?.textContent).toBe("Two jobs will run into each other at 03:00");
    expect(verdict()?.getAttribute("data-status")).toBe("warning");
    expect(screen.getByText("Mirror backups to the SSH destination and Security updates will run into each other at 03:00")).toBeTruthy();
    expect(screen.getByText(/Mirror backups to the SSH destination took 41 min last time, so it will still be running when Security updates starts at 03:00/)).toBeTruthy();
    // Both rows say so in a word, and the start that collides says what it collides with.
    expect(screen.getAllByText("overlap")).toHaveLength(2);
    expect(screen.getByRole("img", { name: "03:00 to 03:18, while Mirror backups to the SSH destination is still running" }).hasAttribute("data-clash")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Move Security updates to 03:30" }));
    await vi.waitFor(() => expect(sent).toEqual({ cadence: { frequency: "daily", minute: 30, hour: 3, weekday: null } }));
    expect(await screen.findByText("Security updates now runs every day at 03:30.")).toBeTruthy();
    expect(changed).toHaveBeenCalled();
  });

  it("offers no move to someone who may not change the automation, and moves a schedule in place", async () => {
    serve();
    const first = draw({ role: "viewer", schedules: source([copy]), flows: [updates] as never });
    await settled();
    expect(verdict()?.textContent).toBe("Two jobs will run into each other at 03:00");
    expect(screen.queryByRole("button", { name: /^Move / })).toBeNull();
    expect(document.querySelector(".automations-tonight .ui-panel__foot")?.textContent).toContain("The schedules listed are the ones you made");
    first.unmount();

    // Two schedules: the later one is moved in place, the same job at another time.
    let moved: unknown = null;
    serve({ jobs: [...jobs, { id: "j-late", state: "completed", createdAt: "2026-11-10T03:00:00.000Z", updatedAt: "2026-11-10T03:02:00.000Z" }] }, (url, init) => {
      if (url === "/api/v1/schedules/late" && init?.method === "PUT") { moved = JSON.parse(String(init.body)); return json({ schedule: {} }); }
      return undefined;
    });
    const refreshed = vi.fn(async () => {});
    draw({ schedules: { ...source([copy, schedule({ id: "late", operationId: "apt.refresh", title: "Refresh package lists", nextDueAt: "2026-11-11T03:00:00.000Z", lastJobId: "j-late", frequency: "daily", minute: 0, hour: 3, weekday: null })]), refresh: refreshed } });
    await settled();
    fireEvent.click(screen.getByRole("button", { name: "Move Refresh package lists to 03:30" }));
    await vi.waitFor(() => expect(moved).toEqual({ time: { minute: 30, hour: 3, weekday: null } }));
    expect(await screen.findByText("Refresh package lists now runs every day at 03:30.")).toBeTruthy();
    expect(refreshed).toHaveBeenCalled();
  });

  it("is not read when the job history cannot be read, whatever the rows look like", async () => {
    serve({ jobs: null });
    draw({ schedules: source([copy, snapshot]) });
    await settled();
    expect(verdict()?.textContent).toBe("Not read");
    expect(verdict()?.getAttribute("data-status")).toBe("unknown");
    expect(screen.getByText("Tonight could not be read in full")).toBeTruthy();
    expect(screen.getByText(/Not read: the job history, which says how long each last run took\./)).toBeTruthy();
    // The rows that were read are still shown, their lengths said to be unread.
    expect(screen.getAllByText("not read")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("is not read when a list of jobs is missing, and says which", async () => {
    serve({ quiet: null, agents: null });
    draw({ schedules: source([], true), flowsUnread: true });
    await settled();
    expect(verdict()?.textContent).toBe("Not read");
    expect(screen.getByText("Not read: the automations; the schedules; the agents' schedules; the quiet hours. What is shown is the rest.")).toBeTruthy();
    expect(meta()).toBe("0 jobs · quiet hours not read");
    expect(screen.getByText("Nothing that could be read is due tonight")).toBeTruthy();
  });

  it("reads everything again when asked", async () => {
    const fetchMock = serve({ jobs: null });
    const refresh = vi.fn(async () => {});
    const changed = vi.fn();
    draw({ schedules: { ...source([copy]), refresh }, onFlowsChanged: changed });
    await settled();
    const before = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBe(before + 3));
    expect(refresh).toHaveBeenCalled();
    expect(changed).toHaveBeenCalled();
  });

  it("puts a scheduled agent on the night as queued, measured by its last scheduled run", async () => {
    const keeper = {
      id: "keeper", name: "Server Keeper", paused: false, pausedUntil: null, status: "idle", nextRunAt: "2026-11-11T05:30:00.000Z", waitsForQuietHours: true,
      triggers: { ask: true, schedule: { every: "daily", minute: 30, hour: 5, weekday: null, quietHours: true }, events: [], webhook: false },
    };
    const fetchMock = serve({
      agents: { ...agentsOff, module: { ...agentsOff.module, enabled: true }, agents: [keeper, { ...keeper, id: "resting", name: "Resting", paused: true }] },
      runs: { keeper: [{ id: "r1", agentId: "keeper", kind: "schedule", state: "completed", startedAt: "2026-11-10T05:30:10.000Z", finishedAt: "2026-11-10T05:39:10.000Z" }] },
    });
    draw();
    await settled();
    expect(verdict()?.textContent).toBe("Nothing overlaps tonight");
    const row = screen.getByRole("rowheader", { name: /Server Keeper/ }).closest("tr")!;
    expect(within(row).getByRole("rowheader").textContent).toContain("agent · waits for the agents' quiet hours, 22:00 to 07:00");
    expect(within(row).getAllByRole("cell").slice(0, 2).map((cell) => cell.textContent)).toEqual(["05:30", "9 min"]);
    expect(within(row).getByRole("img").getAttribute("data-kind")).toBe("queued");
    expect(within(row).getByRole("img").getAttribute("aria-label")).toBe("05:30 to 05:39, queued then, waits for the agents' quiet hours, 22:00 to 07:00");
    expect(screen.getByText("An agent's run: queued then, starts when the runner is free")).toBeTruthy();
    // A paused agent will not run: it is not on the night, and its runs are not asked for.
    expect(screen.queryByRole("rowheader", { name: /Resting/ })).toBeNull();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/runs"))).toHaveLength(1);
  });

  it("is not read when an agent's past runs cannot be read, and sends an overlap with an agent to Agents", async () => {
    const keeper = {
      id: "keeper", name: "Server Keeper", paused: false, pausedUntil: null, status: "idle", nextRunAt: "2026-11-11T03:00:00.000Z", waitsForQuietHours: false,
      triggers: { ask: true, schedule: { every: "daily", minute: 0, hour: 3, weekday: null, quietHours: false }, events: [], webhook: false },
    };
    serve({ agents: { ...agentsOff, module: { ...agentsOff.module, enabled: true }, agents: [keeper] } });
    draw({ schedules: source([copy]) });
    await settled();
    expect(verdict()?.textContent).toBe("Not read");
    expect(screen.getByText(/Not read: an agent's past runs\./)).toBeTruthy();
    const opened = vi.fn();
    window.addEventListener(openViewEvent, opened);
    fireEvent.click(screen.getByRole("button", { name: "Open Agents" }));
    window.removeEventListener(openViewEvent, opened);
    expect((opened.mock.calls[0][0] as CustomEvent<{ view: string }>).detail.view).toBe("agents");
  });

  it("says whose clock it is when the server's time zone was not read", async () => {
    serve();
    draw({ serverTimezone: null });
    await settled();
    expect(document.querySelector(".automations-tonight .ui-panel__foot")?.textContent).toContain("Times are your browser's clock: this server's time zone was not read.");
  });
});

describe("Tonight on the Automations page", () => {
  it("is a tab of its own, read when opened, and opens Schedules from its empty state", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "/api/v1/flows") return json({ flows: [], palette: [], shelf: [] });
      if (url === "/api/v1/flows/suggestions") return json({ suggestions: [] });
      if (url === "/api/v1/schedules") return json({ schedules: [] });
      if (url.startsWith("/api/v1/catalog")) return json({ applications: [] });
      if (url.includes("system.settings.inspect")) return json({ result: { timezone: "Etc/UTC" } });
      if (url.startsWith("/api/v1/jobs?")) return json({ jobs: [] });
      if (url === "/api/v1/settings/quiet-hours") return json({ enabled: false, start: "22:00", end: "07:00", holdHigh: false, held: 0, quietNow: false });
      if (url === "/api/v1/agents") return json(agentsOff);
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AutomationsPage csrfToken="csrf" />);
    await screen.findByText("No automations yet");
    // Nothing of Tonight's is read until its tab is opened.
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/v1/jobs?"))).toBe(false);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent?.replace(/[\s\d]+$/, ""))).toEqual(["Automations", "Schedules", "Tonight", "Ready to use"]);

    fireEvent.click(screen.getByRole("tab", { name: "Tonight" }));
    expect(window.location.search).toBe("?tab=tonight");
    expect(await screen.findByText("Nothing is due tonight", { selector: ".ui-chip" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Schedules" }));
    expect(window.location.search).toBe("?tab=schedules");
    expect(await screen.findByText("Nothing scheduled yet")).toBeTruthy();
  });
});
