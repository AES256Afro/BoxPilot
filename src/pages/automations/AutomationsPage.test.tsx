import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AutomationsPage from "./AutomationsPage";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });
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
const baseFlow = {
  id: "flow-1", name: "Nightly", createdBy: "o", risk: "low", running: false, webhookEnabled: false,
  steps: [{ operationId: "apt.refresh", parameters: {} }],
  createdAt: "x", updatedAt: "x", lastRunAt: null, lastResult: null, lastJobIds: [],
  frequency: null, minute: null, hour: null, weekday: null, enabled: true, nextDueAt: null, triggerFlowId: null,
};
const schedule = {
  id: "s1", operationId: "app.backup", parameters: { id: "jellyfin" }, frequency: "daily", minute: 0, hour: 3, weekday: null,
  enabled: true, nextDueAt: "2026-08-21T03:00:00.000Z", lastRunAt: "2026-08-20T03:00:05.000Z", lastJobId: "j1", lastResult: "failed: tar failed", lastOutcome: "failed", lastReason: "tar failed",
  title: "Back up application data", cadence: "daily at 03:00",
};

/** The page's reads, answered from a fixture; anything else goes to `other`. */
function serve(fixture: { flows?: unknown[]; shelf?: unknown[]; schedules?: unknown[]; suggestions?: unknown[] }, other?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const answer = other?.(url, init);
    if (answer) return answer;
    if (url === "/api/v1/flows") return json({ flows: fixture.flows ?? [], palette, shelf: fixture.shelf ?? [] });
    if (url === "/api/v1/flows/suggestions") return json({ suggestions: fixture.suggestions ?? [] });
    if (url === "/api/v1/schedules") return json({ schedules: fixture.schedules ?? [] });
    if (url.startsWith("/api/v1/catalog")) return json({ applications: [] });
    if (url.includes("system.settings.inspect")) return json({ result: { timezone: "Etc/UTC" } });
    return json({ error: `unexpected ${url}` }, 500);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Automations page", () => {
  it("says first whether anything failed, then the counts, with the automations in the first tab", async () => {
    serve({ flows: [{ ...baseFlow, lastRunAt: "2026-08-27T05:00:00Z", lastResult: "failed at step 1 (Refresh package lists): apt is locked", lastJobIds: ["j9"] }], schedules: [schedule] });
    render(<AutomationsPage csrfToken="csrf" />);
    expect(await screen.findByRole("heading", { level: 3, name: "Nightly" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Automations" })).toBeTruthy();
    const verdict = document.querySelector(".ui-page-header__verdict");
    await vi.waitFor(() => expect(verdict?.textContent).toBe("2 failed"));
    expect(verdict?.getAttribute("data-status")).toBe("danger");
    expect(document.querySelector(".ui-page-header__meta")?.textContent).toBe("1 automation · 0 running · 1 schedule");
    expect(screen.getByText("last run failed")).toBeTruthy();
    expect(screen.getByText(/apt is locked/)).toBeTruthy();
    // The flow's tier is on the row, in words.
    expect(within(screen.getByRole("heading", { level: 3, name: "Nightly" }).parentElement!).getByText("Low")).toBeTruthy();
    // The schedules have their own tab, which says one failed.
    fireEvent.click(screen.getByRole("tab", { name: /Schedules/ }));
    expect(window.location.search).toBe("?tab=schedules");
    expect(await screen.findByText("daily at 03:00")).toBeTruthy();
    expect(screen.getByText("tar failed")).toBeTruthy();
  });

  it("sends each step's failure policy with the draft, defaulting to stop", async () => {
    let created: unknown = null;
    serve({}, (url, init) => {
      if (url === "/api/v1/flows" && init?.method === "POST") { created = JSON.parse(String(init.body)); return json({ flow: {} }); }
      return undefined;
    });
    render(<AutomationsPage csrfToken="csrf" />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Build your own" }))[0]);
    const sheet = await screen.findByRole("dialog", { name: "Build your own" });
    fireEvent.change(within(sheet).getByLabelText("Automation name"), { target: { value: "Careful night" } });
    fireEvent.change(within(sheet).getByLabelText("Add a step"), { target: { value: "apt.refresh" } });
    fireEvent.change(within(sheet).getByLabelText("Add a step"), { target: { value: "host.snapshot.create" } });
    // The first step may fail without stopping the run; the second keeps the default.
    fireEvent.change(within(sheet).getByLabelText("If step 1 fails"), { target: { value: "continue" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    expect(await vi.waitFor(() => { if (!created) throw new Error("not yet"); return created; })).toEqual({
      name: "Careful night",
      steps: [
        { operationId: "apt.refresh", parameters: {}, onFailure: "continue" },
        { operationId: "host.snapshot.create", parameters: {} },
      ],
    });
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The Runs-after choice must not leak into the next draft: a stale selection here once meant
    // the next automation silently ran whenever the previous trigger completed.
    fireEvent.click((await screen.findAllByRole("button", { name: "Build your own" }))[0]);
    expect(within(await screen.findByRole("dialog")).queryByLabelText("Runs after")).toBeNull();
  });

  it("shows the ready-made shelf from the API, the suggested one first, and adds an entry", async () => {
    let posted: unknown = null;
    const shelf = [
      { slug: "plain", name: "Refresh lists weekly", description: "Keep lists fresh.", steps: [{ operationId: "apt.refresh", parameters: {} }] },
      { slug: "tidy-docker", name: "Tidy up Docker", description: "Reclaim disk.", steps: [{ operationId: "host.snapshot.create", parameters: {} }] },
    ];
    serve({ shelf, suggestions: [{ slug: "tidy-docker", because: "Docker holds 40 GB it can give back." }] }, (url, init) => {
      if (url === "/api/v1/flows" && init?.method === "POST") { posted = JSON.parse(String(init.body)); return json({ flow: {} }); }
      return undefined;
    });
    render(<AutomationsPage csrfToken="csrf" />);
    fireEvent.click(await screen.findByRole("tab", { name: /Ready to use/ }));
    expect(await screen.findByText("Docker holds 40 GB it can give back.")).toBeTruthy();
    const names = screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
    expect(names).toEqual(["Tidy up Docker", "Refresh lists weekly"]);
    fireEvent.click(screen.getByRole("button", { name: "Add Tidy up Docker" }));
    await vi.waitFor(() => { if (!posted) throw new Error("not yet"); });
    expect(posted).toEqual({ name: "Tidy up Docker", steps: [{ operationId: "host.snapshot.create", parameters: {} }] });
  });

  it("builds a parameterized step, coercing and omitting fields, and sending retry", async () => {
    let created: unknown = null;
    serve({}, (url, init) => {
      if (url === "/api/v1/flows" && init?.method === "POST") { created = JSON.parse(String(init.body)); return json({ flow: {} }); }
      return undefined;
    });
    render(<AutomationsPage csrfToken="csrf" />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Build your own" }))[0]);
    const sheet = await screen.findByRole("dialog");
    fireEvent.change(within(sheet).getByLabelText("Automation name"), { target: { value: "Ping" } });
    fireEvent.change(within(sheet).getByLabelText("Add a step"), { target: { value: "http.request" } });
    fireEvent.change(within(sheet).getByLabelText("Url for step 1"), { target: { value: "https://ntfy.sh/mytopic" } });
    fireEvent.change(within(sheet).getByLabelText("Method for step 1"), { target: { value: "POST" } });
    // credentialName left blank must be omitted, not sent as "".
    fireEvent.change(within(sheet).getByLabelText("Retries for step 1"), { target: { value: "2" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    await vi.waitFor(() => { if (!created) throw new Error("not yet"); });
    expect(created).toEqual({
      name: "Ping",
      steps: [{ operationId: "http.request", parameters: { url: "https://ntfy.sh/mytopic", method: "POST" }, retry: 2 }],
    });
  });

  it("shows a skipped step holding its place in the last run, without a terminal", async () => {
    const flow = {
      ...baseFlow, id: "flow-1", name: "Conditional", risk: "medium",
      steps: [
        { operationId: "host.snapshot.create", parameters: {}, name: "check" },
        { operationId: "apt.refresh", parameters: {}, when: { value: "{{ steps.check.rebootRequired }}" } },
      ],
      lastRunAt: "2026-08-27T05:00:00Z", lastResult: "completed (1 step skipped by condition)", lastJobIds: ["j1", null],
    };
    const fetchMock = serve({ flows: [flow] }, (url) => {
      if (url === "/api/v1/jobs/j1") return json({ job: { id: "j1", type: "op:host.snapshot.create", title: "Create a machine snapshot", state: "completed", risk: "medium", error: null, result: null, createdAt: "x", updatedAt: "x", steps: [], approvals: [] } });
      if (url === "/api/v1/jobs/j1/output") return json({ output: "snapshot written" });
      return undefined;
    });
    render(<AutomationsPage csrfToken="csrf" />);
    fireEvent.click(await screen.findByRole("button", { name: "What the last run did" }));
    const sheet = await screen.findByRole("dialog", { name: "Conditional" });
    expect(await within(sheet).findByText("snapshot written")).toBeTruthy();
    // The label covers both null causes (condition not met, or a continue-step that could not
    // start); the last-run line carries the specifics.
    expect(within(sheet).getByText(/Step 2 .*did not run; the last-run line above says why/)).toBeTruthy();
    expect(within(sheet).getByText(/completed \(1 step skipped by condition\)/)).toBeTruthy();
    // The skipped step fetched nothing: no job, no output.
    expect(fetchMock.mock.calls.map(([input]) => String(input)).filter((url) => url.includes("/jobs/") && !url.includes("j1"))).toEqual([]);
  });

  it("asks before regenerating a webhook or removing a flow, and keeps the new URL until dismissed", async () => {
    const flow = { ...baseFlow, webhookEnabled: true };
    const calls: string[] = [];
    serve({ flows: [flow] }, (url, init) => {
      const method = init?.method ?? "GET";
      if (method !== "GET") calls.push(`${method} ${url}`);
      if (url === "/api/v1/flows/flow-1/webhook" && method === "POST") return json({ token: "t", path: "/api/v1/hooks/flow-1/secret-token" });
      if (url.startsWith("/api/v1/flows/flow-1")) return json({ flow });
      return undefined;
    });
    render(<AutomationsPage csrfToken="csrf" />);
    fireEvent.click(await screen.findByRole("button", { name: "Regenerate the webhook" }));
    expect(calls).toEqual([]);
    fireEvent.click(within(screen.getByRole("group", { name: /Confirm regenerating/ })).getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Regenerate the webhook" }));
    fireEvent.click(screen.getByRole("button", { name: "Regenerate it" }));
    const url = await screen.findByLabelText("Webhook URL");
    expect(url.textContent).toBe(`${window.location.origin}/api/v1/hooks/flow-1/secret-token`);
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
    // Shown in the automation's own card, beside the button that made it, not at the top of the page.
    expect(url.closest(".automations-flow")?.querySelector(".automations-flow__name")?.textContent).toBe("Nightly");
    // Another action does not wipe it.
    fireEvent.click(screen.getByRole("button", { name: "Run it every Sunday at 03:00" }));
    await vi.waitFor(() => expect(calls).toContain("PUT /api/v1/flows/flow-1"));
    expect(screen.getByLabelText("Webhook URL")).toBeTruthy();
    fireEvent.click(within(screen.getByText("New webhook for Nightly").closest(".ui-notice")!).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByLabelText("Webhook URL")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(calls.some((call) => call.startsWith("DELETE"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    await vi.waitFor(() => expect(calls).toContain("DELETE /api/v1/flows/flow-1"));
  });

  it("gives a viewer the automations to read, and nothing to run or change", async () => {
    serve({ flows: [{ ...baseFlow, webhookEnabled: true }], schedules: [schedule] });
    render(<AutomationsPage csrfToken="csrf" role="viewer" />);
    await screen.findByRole("heading", { level: 3, name: "Nightly" });
    expect(screen.queryByRole("button", { name: "Run now" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Build your own" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /Schedules/ }));
    expect(await screen.findByText("daily at 03:00")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Pause / })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a schedule" })).toBeNull();
  });

  it("says when the automations could not be read, and never that none failed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Flows are not available" }, 503)));
    render(<AutomationsPage csrfToken="csrf" />);
    expect(await screen.findByText("Flows are not available")).toBeTruthy();
    const verdict = document.querySelector(".ui-page-header__verdict");
    expect(verdict?.textContent).toBe("Not read");
    expect(verdict?.getAttribute("data-status")).toBe("unknown");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

/**
 * A step only the owner may run, put in an operator's flow before steps were checked, does not run
 * until the owner keeps it. The refusal said "open it and save the flow", and the page cannot edit
 * an existing flow's steps: the owner had no way to do it.
 */
describe("an owner-only step the owner has not kept", () => {
  const send = { operationId: "http.request", parameters: { url: "https://ntfy.example/topic", method: "POST" } };
  const tidy = { ...baseFlow, id: "flow-7", name: "Tidy", createdBy: "operator-1", steps: [{ operationId: "apt.refresh", parameters: {} }, send], ownerToKeep: { step: 2, title: "Send an HTTP request" } };

  it("offers the owner Keep this step, which saves the steps as they are", async () => {
    let saved: unknown = null;
    let kept = false;
    serve({ flows: [tidy] }, (url, init) => {
      if (url === "/api/v1/flows" && kept) return json({ flows: [{ ...tidy, ownerToKeep: null }], palette, shelf: [] });
      if (url === "/api/v1/flows/flow-7" && init?.method === "PUT") { saved = JSON.parse(String(init.body)); kept = true; return json({ flow: { ...tidy, ownerToKeep: null } }); }
      return undefined;
    });
    render(<AutomationsPage csrfToken="csrf" role="owner" />);
    const card = (await screen.findByRole("heading", { level: 3, name: "Tidy" })).closest("li")!;
    expect(within(card).getByText(/Step 2 \(Send an HTTP request\) is one only you may run/)).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Keep this step" }));
    await vi.waitFor(() => expect(saved).toEqual({ steps: tidy.steps }));
    await vi.waitFor(() => expect(within(card).queryByRole("button", { name: "Keep this step" })).toBeNull());
    expect(within(card).getByText(/Step 2 is kept/)).toBeTruthy();
  });

  it("offers it to nobody else", async () => {
    serve({ flows: [tidy] });
    render(<AutomationsPage csrfToken="csrf" role="operator" />);
    await screen.findByRole("heading", { level: 3, name: "Tidy" });
    expect(screen.queryByRole("button", { name: "Keep this step" })).toBeNull();
  });
});
