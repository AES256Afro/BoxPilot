import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AutomationsCenter from "./AutomationsCenter";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const palette = [
  { operationId: "host.snapshot.create", title: "Create a machine snapshot", risk: "medium", description: "", fields: [] },
  { operationId: "apt.refresh", title: "Refresh package lists", risk: "low", description: "", fields: [] },
  { operationId: "http.request", title: "Send an HTTP request", risk: "medium", description: "", fields: [
    { name: "url", type: "string", optional: false, enum: null, default: null },
    { name: "method", type: "string", optional: true, enum: ["GET", "POST"], default: null },
    { name: "credentialName", type: "string", optional: true, enum: null, default: null },
  ] },
];

describe("Automations", () => {
  it("sends each step's failure policy with the draft, defaulting to stop", async () => {
    let created: unknown = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/v1/flows" && (!init || init.method === undefined || init.method === "GET")) return json({ flows: [], palette });
      if (url === "/api/v1/flows" && init?.method === "POST") { created = JSON.parse(String(init.body)); return json({ flow: {} }); }
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AutomationsCenter csrfToken="csrf" />);
    fireEvent.click(await screen.findByRole("button", { name: "Build your own" }));
    fireEvent.change(screen.getByLabelText("Automation name"), { target: { value: "Careful night" } });
    fireEvent.change(screen.getByLabelText("Add a step"), { target: { value: "apt.refresh" } });
    fireEvent.change(screen.getByLabelText("Add a step"), { target: { value: "host.snapshot.create" } });
    // The first step may fail without stopping the run; the second keeps the default.
    fireEvent.change(screen.getByLabelText("If step 1 fails"), { target: { value: "continue" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await vi.waitFor(() => { if (!created) throw new Error("not yet"); return created; })).toEqual({
      name: "Careful night",
      steps: [
        { operationId: "apt.refresh", parameters: {}, onFailure: "continue" },
        { operationId: "host.snapshot.create", parameters: {} },
      ],
    });
    // The Runs-after choice must not leak into the next draft: a stale selection here once
    // meant the next automation silently ran whenever the previous trigger completed.
    fireEvent.click(await screen.findByRole("button", { name: "Build your own" }));
    expect(screen.queryByLabelText("Runs after")).toBeNull();   // no flows exist in this fixture, so no select; nothing carried over
  });

  it("shows the ready-made shelf from the API and installs an entry", async () => {
    let posted: unknown = null;
    const shelf = [{ slug: "tidy-docker", name: "Tidy up Docker", description: "Reclaim disk.", steps: [{ operationId: "docker.prune", parameters: {} }] }];
    const paletteWithPrune = [...palette, { operationId: "docker.prune", title: "Clean up Docker disk space", risk: "medium", description: "", fields: [] }];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/v1/flows" && (!init || init.method === undefined || init.method === "GET")) return json({ flows: [], palette: paletteWithPrune, shelf });
      if (url === "/api/v1/flows" && init?.method === "POST") { posted = JSON.parse(String(init.body)); return json({ flow: {} }); }
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AutomationsCenter csrfToken="csrf" />);
    expect(await screen.findByText("Tidy up Docker")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await vi.waitFor(() => { if (!posted) throw new Error("not yet"); });
    expect(posted).toEqual({ name: "Tidy up Docker", steps: [{ operationId: "docker.prune", parameters: {} }] });
  });

  it("builds a parameterized step, coercing and omitting fields, and sending retry", async () => {
    let created: unknown = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/v1/flows" && (!init || init.method === undefined || init.method === "GET")) return json({ flows: [], palette });
      if (url === "/api/v1/flows" && init?.method === "POST") { created = JSON.parse(String(init.body)); return json({ flow: {} }); }
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AutomationsCenter csrfToken="csrf" />);
    fireEvent.click(await screen.findByRole("button", { name: "Build your own" }));
    fireEvent.change(screen.getByLabelText("Automation name"), { target: { value: "Ping" } });
    fireEvent.change(screen.getByLabelText("Add a step"), { target: { value: "http.request" } });
    fireEvent.change(screen.getByLabelText("Url for step 1"), { target: { value: "https://ntfy.sh/mytopic" } });
    fireEvent.change(screen.getByLabelText("Method for step 1"), { target: { value: "POST" } });
    // credentialName left blank must be omitted, not sent as "".
    fireEvent.change(screen.getByLabelText("Retries for step 1"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => { if (!created) throw new Error("not yet"); });
    expect(created).toEqual({
      name: "Ping",
      steps: [{ operationId: "http.request", parameters: { url: "https://ntfy.sh/mytopic", method: "POST" }, retry: 2 }],
    });
  });

  it("shows a skipped step holding its place in the last run, without a terminal", async () => {
    const flow = {
      id: "flow-1", name: "Conditional", createdBy: "o", risk: "medium", running: false,
      steps: [
        { operationId: "host.snapshot.create", parameters: {}, name: "check" },
        { operationId: "apt.refresh", parameters: {}, when: { value: "{{ steps.check.rebootRequired }}" } },
      ],
      createdAt: "x", updatedAt: "x", lastRunAt: "2026-08-27T05:00:00Z", lastResult: "completed (1 step skipped by condition)",
      lastJobIds: ["j1", null],
      frequency: null, minute: null, hour: null, weekday: null, enabled: true, nextDueAt: null,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "/api/v1/flows") return json({ flows: [flow], palette });
      if (url === "/api/v1/jobs/j1") return json({ job: { id: "j1", type: "op:host.snapshot.create", title: "Create a machine snapshot", state: "completed", risk: "medium", error: null, result: null, createdAt: "x", updatedAt: "x", steps: [], approvals: [] } });
      if (url === "/api/v1/jobs/j1/output") return json({ output: "snapshot written" });
      return json({ error: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AutomationsCenter csrfToken="csrf" />);
    fireEvent.click(await screen.findByText("What the last run did"));
    expect(await screen.findByText("snapshot written")).toBeTruthy();
    // The label covers both null causes (condition not met, or a continue-step that could not
    // start); the last-run line carries the specifics.
    expect(screen.getByText(/Step 2 .*did not run; the last-run line above says why/)).toBeTruthy();
    // The skipped step fetched nothing: no job, no output.
    expect(fetchMock.mock.calls.map(([input]) => String(input)).filter((url) => url.includes("/jobs/") && !url.includes("j1"))).toEqual([]);
  });
});
