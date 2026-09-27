import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SystemLogs from "./SystemLogs";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("Logs page", () => {
  it("reads the BoxPilot group by default and switches to a container", async () => {
    const reads: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/operations/logs.sources/inspect")) return json({ operation: "logs.sources", result: { groups: [{ id: "boxpilot", label: "BoxPilot" }, { id: "kernel", label: "Kernel" }], units: [{ unit: "docker.service", description: "Docker", active: "active" }], containers: [{ name: "bp-jellyfin", state: "running", image: "jellyfin" }], dockerAvailable: true } });
      if (url.endsWith("/operations/logs.read/run")) { reads.push(init?.body as string); const parameters = JSON.parse(init?.body as string).parameters; return json({ operation: "logs.read", result: { kind: parameters.kind, target: parameters.target, lines: [`line from ${parameters.target}`], truncated: false } }); }
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SystemLogs csrfToken="csrf-token" />);
    expect(await screen.findByText("line from boxpilot")).toBeTruthy();
    expect(JSON.parse(reads[0]).parameters).toEqual({ kind: "group", target: "boxpilot", lines: 300 });
    fireEvent.change(await screen.findByLabelText("Container"), { target: { value: "bp-jellyfin" } });
    expect(await screen.findByText("line from bp-jellyfin")).toBeTruthy();
    expect(JSON.parse(reads.at(-1) as string).parameters).toMatchObject({ kind: "container", target: "bp-jellyfin" });
    fireEvent.click(screen.getByRole("button", { name: "Kernel" }));
    expect(await screen.findByText("line from kernel")).toBeTruthy();
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
    render(<SystemLogs csrfToken="csrf-token" />);
    expect(await screen.findByText(/boxpilot\[1\]: up/)).toBeTruthy();
    fireEvent.change(await screen.findByLabelText("Container"), { target: { value: "bp-jellyfin" } });
    expect(await screen.findByText(/hello/)).toBeTruthy();
    vi.useFakeTimers();
    fireEvent.click(screen.getByLabelText(/Follow/));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(reads.at(-1)).toMatchObject({ kind: "container", since: "2026-08-21T01:00:00Z" });
  });
});
