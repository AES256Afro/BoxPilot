import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import LogsPage from "./LogsPage";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("Logs page", () => {
  it("reads the BoxPilot group by default, says what it shows, and switches to a container", async () => {
    const reads: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/operations/logs.sources/inspect")) return json({ operation: "logs.sources", result: { groups: [{ id: "boxpilot", label: "BoxPilot" }, { id: "kernel", label: "Kernel" }], units: [{ unit: "docker.service", description: "Docker", active: "active" }], containers: [{ name: "bp-jellyfin", state: "running", image: "jellyfin" }], dockerAvailable: true } });
      if (url.endsWith("/operations/logs.read/run")) { reads.push(init?.body as string); const parameters = JSON.parse(init?.body as string).parameters; return json({ operation: "logs.read", result: { kind: parameters.kind, target: parameters.target, lines: [`line from ${parameters.target}`], truncated: false } }); }
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<LogsPage csrfToken="csrf-token" />);
    expect(await screen.findByText("line from boxpilot")).toBeTruthy();
    expect(JSON.parse(reads[0]).parameters).toEqual({ kind: "group", target: "boxpilot", lines: 300 });
    expect(screen.getByRole("heading", { level: 1, name: "Logs" })).toBeTruthy();
    expect(document.querySelector(".ui-page-header__meta")?.textContent).toContain("journal group BoxPilot · last 300 lines");
    fireEvent.change(await screen.findByLabelText("Container"), { target: { value: "bp-jellyfin" } });
    expect(await screen.findByText("line from bp-jellyfin")).toBeTruthy();
    expect(JSON.parse(reads.at(-1) as string).parameters).toMatchObject({ kind: "container", target: "bp-jellyfin" });
    // A journal group is one of a few: a radio in a group, chosen with a click or the arrow keys.
    fireEvent.click(screen.getByRole("radio", { name: "Kernel" }));
    expect(await screen.findByText("line from kernel")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Lines"), { target: { value: "1000" } });
    await vi.waitFor(() => expect(JSON.parse(reads.at(-1) as string).parameters).toMatchObject({ kind: "group", target: "kernel", lines: 1000 }));
  });

  it("opens a unit found by name", async () => {
    const reads: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/operations/logs.sources/inspect")) return json({ operation: "logs.sources", result: { groups: [{ id: "boxpilot", label: "BoxPilot" }], units: [{ unit: "docker.service", description: "Docker", active: "active" }], containers: [], dockerAvailable: false } });
      const parameters = JSON.parse(init?.body as string).parameters as Record<string, unknown>;
      reads.push(parameters);
      return json({ operation: "logs.read", result: { lines: [`line from ${String(parameters.target)}`] } });
    }));
    render(<LogsPage csrfToken="csrf-token" />);
    await screen.findByText("line from boxpilot");
    const open = screen.getByRole("button", { name: "Open unit" }) as HTMLButtonElement;
    expect(open.disabled).toBe(true);
    await vi.waitFor(() => expect(document.querySelectorAll("#logs-units option")).toHaveLength(1));
    fireEvent.change(screen.getByRole("combobox", { name: "Find a unit" }), { target: { value: "docker.service" } });
    fireEvent.click(open);
    expect(await screen.findByText("line from docker.service")).toBeTruthy();
    expect(reads.at(-1)).toMatchObject({ kind: "unit", target: "docker.service" });
  });

  it("follows a container from its newest line's UTC time, keeping the zone", async () => {
    const reads: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/operations/logs.sources/inspect")) return json({ operation: "logs.sources", result: { groups: [{ id: "boxpilot", label: "BoxPilot" }], units: [], containers: [{ name: "bp-jellyfin", state: "running", image: "jellyfin" }], dockerAvailable: true } });
      const parameters = JSON.parse(init?.body as string).parameters as Record<string, unknown>;
      reads.push(parameters);
      return json({ operation: "logs.read", result: { lines: parameters.kind === "container" ? ["2026-08-21T01:00:00.123456789Z hello"] : ["2026-08-21T03:00:00+0200 host boxpilot[1]: up"] } });
    }));
    render(<LogsPage csrfToken="csrf-token" />);
    expect(await screen.findByText(/boxpilot\[1\]: up/)).toBeTruthy();
    fireEvent.change(await screen.findByLabelText("Container"), { target: { value: "bp-jellyfin" } });
    expect(await screen.findByText(/hello/)).toBeTruthy();
    vi.useFakeTimers();
    const follow = screen.getByRole("switch", { name: "Follow" });
    fireEvent.click(follow);
    expect(follow.getAttribute("aria-checked")).toBe("true");
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(reads.at(-1)).toMatchObject({ kind: "container", since: "2026-08-21T01:00:00Z" });
  });

  it("follows one read at a time when the journal answers slower than the follow ticks", async () => {
    // A filter matching nothing leaves no newest line, so each tick is a full scan. Slower than five
    // seconds, the ticks stacked scans on the server and each discarded the answer before it.
    let started = 0;
    const answers: Array<() => void> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/operations/logs.sources/inspect")) return json({ operation: "logs.sources", result: { groups: [{ id: "boxpilot", label: "BoxPilot" }], units: [], containers: [], dockerAvailable: false } });
      started += 1;
      if (started === 1) return json({ operation: "logs.read", result: { lines: [] } });
      return new Promise<Response>((resolve) => { answers.push(() => resolve(json({ operation: "logs.read", result: { lines: [] } }))); });
    }));
    render(<LogsPage csrfToken="csrf-token" />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("switch", { name: "Follow" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(started).toBe(2);
    // Twenty seconds of ticks while that scan is still going: none of them starts another.
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(started).toBe(2);
    await act(async () => { answers.shift()?.(); await vi.advanceTimersByTimeAsync(5000); });
    expect(started).toBe(3);
  });

  it("downloads the support bundle from the header, and says why when it cannot", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/api/v1/support-bundle")) return json({ error: "The helper did not answer" }, 503);
      if (url.endsWith("/operations/logs.sources/inspect")) return json({ operation: "logs.sources", result: { groups: [], units: [], containers: [], dockerAvailable: false } });
      return json({ operation: "logs.read", result: { lines: [] } });
    }));
    render(<LogsPage csrfToken="csrf-token" />);
    fireEvent.click(await screen.findByRole("button", { name: "Download support bundle" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("The helper did not answer")).toBeTruthy();
  });

  it("tells a viewer that logs need an operator, and reads nothing", async () => {
    const fetchMock = vi.fn(async () => json({ operation: "logs.sources", result: { groups: [], units: [], containers: [], dockerAvailable: false } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<LogsPage csrfToken="csrf-token" role="viewer" />);
    expect(screen.getByText("Reading logs needs an operator")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Download support bundle" })).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
