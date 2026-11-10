import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApproveDialog, useOperation, type PendingOperation } from "./ApproveDialog";
import approveCss from "./approve.css?raw";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const stagedJob = { id: "job-1", type: "op:storage.format", title: "Erase and format a disk", state: "awaiting_approval", risk: "high", parameters: { device: "/dev/sdb" }, recovery: {}, steps: [], approvals: [], createdAt: "2026-08-22T00:00:00Z", updatedAt: "2026-08-22T00:00:00Z" };

/** Records what the dialog sends, and answers every endpoint it touches. */
function stubApi({ passwordRequired = false, confirmText = "/dev/sdb", expiresAt = null as string | null, expired = false, result = null as unknown } = {}) {
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
  const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    calls.push({ url, method, body });
    if (url.includes("/jobs") && method === "POST" && url.endsWith("/jobs")) return json({ job: stagedJob, approval: { tier: "high", passwordRequired, elevated: !passwordRequired, mode: "tiered", confirmText, expiresAt, expired } });
    if (url.endsWith("/approve")) {
      // The server refuses unless the exact text was typed — the bug this test exists for.
      if (confirmText && body.confirmText !== confirmText) return json({ error: `Type ${confirmText} to confirm this high-risk job`, code: "job_approval_failed" }, 409);
      return json({ job: { ...stagedJob, state: "applying" }, elevatedUntil: null }, 202);
    }
    if (url.includes("/jobs/job-1") && method === "DELETE") return json({ job: { ...stagedJob, state: "cancelled" } });
    if (url.endsWith("/output")) return json({ jobId: "job-1", state: "completed", output: "", live: false });
    return json({ job: { ...stagedJob, state: "completed", result } });
  }));
  return calls;
}

describe("approval dialog", () => {
  it("keeps a successful backup warning visible even when it has no live output", async () => {
    stubApi({ confirmText: "", result: { warnings: ["The new backup passed, but old copies could not be removed."] } });
    render(<ApproveDialog operationId="controller.backup.create" title="Back up database" parameters={{}} csrfToken="csrf" onClose={() => {}} />);
    const run = await screen.findByRole("button", { name: "Confirm and run" });
    await waitFor(() => expect(run.hasAttribute("disabled")).toBe(false));
    fireEvent.click(run);
    expect(await screen.findByText("Completed with follow-up needed.")).toBeTruthy();
    expect(screen.getByText("The new backup passed, but old copies could not be removed.")).toBeTruthy();
    expect(screen.queryByText("Completed.")).toBeNull();
  });

  // M38: Zulip's organization link. The job never stored it; the dialog asks for it once.
  it("shows a result that is given once, asks for it once, and says it will not be shown again", async () => {
    const link = "https://homebox.tail1234.ts.net:8543/new/abcdefghij2345klmnopqrst";
    const calls = stubApi({ confirmText: "", result: { expiresInDays: 7, host: "homebox.tail1234.ts.net:8543", oneTime: ["link"] } });
    const answered = vi.mocked(fetch).getMockImplementation()!;
    let taken = 0;
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (input.toString().endsWith("/jobs/job-1/once")) {
        taken += 1;
        calls.push({ url: input.toString(), method: init?.method ?? "GET", body: {} });
        return Promise.resolve(taken === 1
          ? new Response(JSON.stringify({ jobId: "job-1", value: { link } }), { status: 200, headers: { "Content-Type": "application/json" } })
          : new Response(JSON.stringify({ error: "This was shown once already" }), { status: 410, headers: { "Content-Type": "application/json" } }));
      }
      return answered(input, init);
    });
    render(<ApproveDialog operationId="app.zulip.organization.link" title="Create your organization (Zulip)" parameters={{ id: "zulip" }} csrfToken="csrf" onClose={() => {}} />);
    const run = await screen.findByRole("button", { name: "Confirm and run" });
    await waitFor(() => expect(run.hasAttribute("disabled")).toBe(false));
    fireEvent.click(run);
    expect(await screen.findByText(link)).toBeTruthy();
    expect((screen.getByRole("link", { name: "Open" }) as HTMLAnchorElement).href).toBe(link);
    expect(screen.getByRole("button", { name: /Copy/ })).toBeTruthy();
    expect(screen.getByText(/Shown this once: BoxPilot did not keep it/)).toBeTruthy();
    expect(taken).toBe(1);
    expect(calls.find((call) => call.url.endsWith("/once"))?.method).toBe("POST");
  });

  // An agent's or the assistant's step: its reason is the model's own words, which text the model
  // read can steer, so what the operation is actually given is shown in full, not folded away.
  it("shows everything a suggested step is given, and says whose reason it is", async () => {
    stubApi({ confirmText: "" });
    const answered = vi.mocked(fetch).getMockImplementation()!;
    const suggested = { ...stagedJob, type: "op:users.add", title: "Add a user", risk: "medium", parameters: { username: "backup", githubUser: "someone-else" } };
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (input.toString().endsWith("/jobs") && init?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ job: suggested, approval: { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", confirmText: null, expiresAt: null, expired: false } }), { status: 201, headers: { "Content-Type": "application/json" } }));
      }
      return answered(input, init);
    });
    render(<ApproveDialog operationId="users.add" title="Add a user" parameters={{ username: "backup", githubUser: "someone-else" }} preview={<span>A service account for the nightly backup</span>} proposedBy="Server Keeper" csrfToken="csrf" onClose={() => {}} />);
    await screen.findByRole("button", { name: "Confirm and run" });
    expect(screen.getByText("someone-else").closest("details")).toBeNull();
    expect(screen.getByText(/Server Keeper's reason, in its own words/)).toBeTruthy();
  });

  it("contains keyboard focus and returns it to the opener", async () => {
    stubApi({ confirmText: "" });
    const opener = document.createElement("button"); document.body.append(opener); opener.focus();
    const { unmount } = render(<ApproveDialog operationId="apt.repair" title="Repair packages" parameters={{}} csrfToken="csrf" onClose={() => {}} />);
    await screen.findByText("High risk");
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close dialog" }));
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Confirm and run" }));
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close dialog" }));
    opener.focus();
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
    unmount(); expect(document.activeElement).toBe(opener); opener.remove();
  });

  it("withdraws a staging reply that arrives after the dialog was removed", async () => {
    let reply!: (value: Response) => void;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => init?.method === "DELETE" ? Promise.resolve(new Response("{}")) : new Promise<Response>((resolve) => { reply = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = render(<ApproveDialog operationId="apt.repair" title="Repair packages" parameters={{}} csrfToken="csrf" onClose={() => {}} />);
    unmount();
    reply(new Response(JSON.stringify({ job: stagedJob, approval: { tier: "medium" } })));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/jobs/job-1", expect.objectContaining({ method: "DELETE" })));
  });

  it("aborts job observation on unmount without cancelling an accepted host job", async () => {
    const calls = stubApi();
    const api = vi.mocked(fetch); const normal = api.getMockImplementation()!;
    let observed: AbortSignal | undefined;
    api.mockImplementation((input, init) => {
      // The dialog's own wait for the end carries a signal; JobProgress's display reads do not.
      if (input.toString() === "/api/v1/jobs/job-1" && !init?.method && init?.signal) return new Promise<Response>((_resolve, reject) => {
        observed = init?.signal ?? undefined;
        observed?.addEventListener("abort", () => reject(observed?.reason), { once: true });
      });
      return normal(input, init);
    });
    const finished = vi.fn();
    const { unmount } = render(<ApproveDialog operationId="storage.format" title="Erase disk" parameters={{ device: "/dev/sdb" }} csrfToken="csrf" onClose={() => {}} onFinished={finished} />);
    fireEvent.change(await screen.findByLabelText("Typed confirmation"), { target: { value: "/dev/sdb" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm and run" }));
    await waitFor(() => expect(observed).toBeTruthy());
    unmount();
    expect(observed?.aborted).toBe(true);
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(finished).not.toHaveBeenCalled();
  });

  it("explains expired credentials and disables approval", async () => {
    const calls = stubApi({ confirmText: "", expiresAt: "2026-01-01T12:30:00Z", expired: true });
    render(<ApproveDialog operationId="samba.user.set" title="Update share password" parameters={{ username: "sam" }} csrfToken="csrf" onClose={() => {}} />);
    expect(await screen.findByText(/This approval expired/)).toBeTruthy();
    const button = screen.getByRole("button", { name: "Confirm and run" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(calls.some((call) => call.url.endsWith("/approve"))).toBe(false);
  });

  it("sends the confirmation the owner typed, even when no password is asked for", async () => {
    const calls = stubApi({ passwordRequired: false });
    const onFinished = vi.fn();
    render(<ApproveDialog operationId="storage.format" title="Erase and format a disk" parameters={{ device: "/dev/sdb" }} csrfToken="csrf" onClose={() => {}} onFinished={onFinished} />);

    const confirm = await screen.findByLabelText("Typed confirmation");
    const run = screen.getByRole("button", { name: /Confirm and run|Run/ });
    expect(run.hasAttribute("disabled")).toBe(true); // nothing typed yet
    fireEvent.change(confirm, { target: { value: "/dev/sdb" } });
    fireEvent.click(screen.getByRole("button", { name: /Confirm and run|Run/ }));

    await waitFor(() => expect(calls.some((call) => call.url.endsWith("/approve"))).toBe(true));
    expect(calls.find((call) => call.url.endsWith("/approve"))?.body).toEqual({ confirmText: "/dev/sdb" });
    await waitFor(() => expect(onFinished).toHaveBeenCalled());
  });

  it("asks for the password when the elevated session lapsed after staging", async () => {
    const calls = stubApi({ passwordRequired: false, confirmText: "" });
    const api = vi.mocked(fetch); const normal = api.getMockImplementation()!;
    const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
    api.mockImplementation((input, init) => {
      const url = input.toString();
      if (url.endsWith("/approve")) {
        calls.push({ url, method: "POST", body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
        return json({ error: "Enter the owner password: high-risk job needs the owner password", code: "job_approval_failed" }, 409);
      }
      if (url.endsWith("/approval")) return json({ jobId: "job-1", tier: "high", passwordRequired: true, elevated: false, mode: "tiered", reason: "" });
      return normal(input, init);
    });
    render(<ApproveDialog operationId="apt.repair" title="Repair packages" parameters={{}} csrfToken="csrf" onClose={() => {}} />);
    const run = await screen.findByRole("button", { name: "Confirm and run" });
    expect(screen.queryByLabelText("Approval password")).toBeNull();
    fireEvent.click(run);
    expect(await screen.findByLabelText("Approval password")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/owner password/);
    expect(screen.queryByText(/Session elevated/)).toBeNull();
  });

  it("withdraws the staged job when the dialog is dismissed", async () => {
    const calls = stubApi();
    const onClose = vi.fn();
    render(<ApproveDialog operationId="storage.format" title="Erase and format a disk" parameters={{ device: "/dev/sdb" }} csrfToken="csrf" onClose={onClose} onFinished={() => {}} />);
    await screen.findByLabelText("Typed confirmation");
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    await waitFor(() => expect(calls.some((call) => call.method === "DELETE" && call.url.includes("/jobs/job-1"))).toBe(true));
    expect(onClose).toHaveBeenCalled();
  });

  // An agent's card was decided when its job was staged: cancelling withdrew the job, and the card
  // stayed decided with nothing run. A page that needs to know the job will run is told on approval.
  it("tells a page its job was approved once it is accepted, and never when it is withdrawn", async () => {
    stubApi({ confirmText: "" });
    const approved = vi.fn();
    const { unmount } = render(<ApproveDialog operationId="controller.backup.create" title="Back up database" parameters={{}} csrfToken="csrf" onClose={() => {}} onApproved={approved} />);
    await screen.findByRole("button", { name: "Confirm and run" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(approved).not.toHaveBeenCalled();
    unmount();
    render(<ApproveDialog operationId="controller.backup.create" title="Back up database" parameters={{}} csrfToken="csrf" onClose={() => {}} onApproved={approved} />);
    const run = await screen.findByRole("button", { name: "Confirm and run" });
    await waitFor(() => expect(run.hasAttribute("disabled")).toBe(false));
    fireEvent.click(run);
    await waitFor(() => expect(approved).toHaveBeenCalledTimes(1));
    expect(approved).toHaveBeenCalledWith(expect.objectContaining({ id: "job-1" }));
    await screen.findByText("Completed.");
    expect(approved).toHaveBeenCalledTimes(1);
  });

  // An agent's card reads itself again once its step's job is withdrawn (sweep 3): before the cancel
  // landed it would still read the job as waiting.
  it("tells a page once the job it withdrew has been cancelled, and never for a job that ran", async () => {
    const calls = stubApi({ confirmText: "" });
    const withdrawn = vi.fn((_jobId: string) => calls.map((call) => call.method));
    const { unmount } = render(<ApproveDialog operationId="controller.backup.create" title="Back up database" parameters={{}} csrfToken="csrf" onClose={() => {}} onWithdrawn={withdrawn} />);
    await screen.findByRole("button", { name: "Confirm and run" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(withdrawn).toHaveBeenCalledWith("job-1"));
    expect(withdrawn.mock.results[0].value).toContain("DELETE");
    unmount();
    withdrawn.mockClear();
    render(<ApproveDialog operationId="controller.backup.create" title="Back up database" parameters={{}} csrfToken="csrf" onClose={() => {}} onWithdrawn={withdrawn} />);
    const run = await screen.findByRole("button", { name: "Confirm and run" });
    await waitFor(() => expect(run.hasAttribute("disabled")).toBe(false));
    fireEvent.click(run);
    await screen.findByText("Completed.");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(withdrawn).not.toHaveBeenCalled();
  });

  // A form closes before its approval opens; the page puts it back unless the job completed.
  it("tells a page how the job ended when the dialog is closed: nothing when it was cancelled", async () => {
    stubApi({ confirmText: "" });
    const closed = vi.fn();
    const { unmount } = render(<ApproveDialog operationId="controller.backup.create" title="Back up database" parameters={{}} csrfToken="csrf" onClose={() => {}} onClosed={closed} />);
    await screen.findByRole("button", { name: "Confirm and run" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(closed).toHaveBeenCalledWith(null);
    unmount();
    closed.mockClear();
    render(<ApproveDialog operationId="controller.backup.create" title="Back up database" parameters={{}} csrfToken="csrf" onClose={() => {}} onClosed={closed} />);
    const run = await screen.findByRole("button", { name: "Confirm and run" });
    await waitFor(() => expect(run.hasAttribute("disabled")).toBe(false));
    fireEvent.click(run);
    await screen.findByText("Completed.");
    expect(closed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(closed).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledWith(expect.objectContaining({ id: "job-1", state: "completed" }));
  });
});

describe("a job that ran out of time (M30.3)", () => {
  const install = { ...stagedJob, type: "op:app.install", title: "Install application", risk: "medium", parameters: { id: "jellyfin", values: {} } };
  const timeout = { scope: "step", budgetMs: 15 * 60_000, elapsedMs: 17 * 60_000, phase: "running", step: "Downloading the images and starting the app", lastOutput: "abc123 Downloading 812MB/2.1GB", moreTimeMs: 50 * 60_000 };
  const medium = { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", reason: "medium risk" };

  /** The dialog's endpoints; `ended` is how the first run finishes. */
  function stubRun(ended: Record<string, unknown>) {
    const calls: Array<{ url: string; method: string }> = [];
    const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString(); const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url === "/api/v1/operations/app.install/jobs") return json({ job: install, approval: medium });
      if (url === "/api/v1/jobs/job-1/more-time" && method === "POST") return json({ job: { ...install, id: "job-2", recovery: { budgetMs: 50 * 60_000, retryOf: "job-1" } }, approval: medium }, 201);
      if (url.endsWith("/approve")) return json({ job: { ...install, state: "applying" }, elevatedUntil: null }, 202);
      if (url.endsWith("/output")) return json({ jobId: "job-1", state: "failed", output: "", live: false });
      return json({ job: { ...install, ...ended } });
    }));
    return calls;
  }

  it("says it ran out of time, and stages it again with more time through the same approval", async () => {
    const calls = stubRun({ state: "failed", error: "Jellyfin installation failed and was rolled back. Downloading the images and starting the app did not finish within 15 minutes", timeout });
    render(<ApproveDialog operationId="app.install" title="Install Jellyfin" parameters={install.parameters} csrfToken="csrf" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Confirm and run" }));
    const retry = await screen.findByRole("button", { name: "Try again with more time" });
    expect(screen.getAllByText("Ran out of time")).toHaveLength(2); // the heading and the notice
    expect(screen.getByText("Downloading the images and starting the app had 15 minutes and did not finish. The job ran for 17 minutes.")).toBeTruthy();
    expect(screen.getByText("abc123 Downloading 812MB/2.1GB")).toBeTruthy();
    expect(screen.getByText("Trying again gives it 50 minutes, and asks for approval like any other job.")).toBeTruthy();
    expect(retry.dataset.risk).toBe("medium"); // the tier shows before the click, as on every action

    fireEvent.click(retry);
    // Staged, then approved like anything else: nothing runs until the button below is pressed.
    const again = await screen.findByRole("button", { name: "Confirm and run" });
    expect(screen.getByText("Approval · more time")).toBeTruthy();
    // What is being approved: the same job, with the larger budget.
    expect(screen.getByText("Runs it again with the same settings and gives it 50 minutes to finish.")).toBeTruthy();
    expect(calls.filter((call) => call.url.endsWith("/approve"))).toHaveLength(1);
    fireEvent.click(again);
    await waitFor(() => expect(calls.some((call) => call.url === "/api/v1/jobs/job-2/approve" && call.method === "POST")).toBe(true));
  });

  it("shows the timeout but offers no more time where the job's record does not", async () => {
    stubRun({ state: "failed", error: "Install application did not finish within 1 hour 40 minutes.", timeout: { ...timeout, scope: "operation", budgetMs: 100 * 60_000, elapsedMs: 100 * 60_000, step: null, moreTimeMs: null } });
    render(<ApproveDialog operationId="app.install" title="Install Jellyfin" parameters={install.parameters} csrfToken="csrf" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Confirm and run" }));
    expect(await screen.findByText("It had 1 hour 40 minutes and used all of it. It may still be running on the server.")).toBeTruthy();
    // The job's error is the same timeout in other words; it is said once, not twice in two colours.
    expect(screen.queryByText("Install application did not finish within 1 hour 40 minutes.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again with more time" })).toBeNull();
  });

  it("keeps an ordinary failure a failure", async () => {
    stubRun({ state: "failed", error: "docker compose up failed: port is already allocated", timeout: null });
    render(<ApproveDialog operationId="app.install" title="Install Jellyfin" parameters={install.parameters} csrfToken="csrf" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Confirm and run" }));
    expect(await screen.findByText("Needs attention")).toBeTruthy();
    expect(screen.queryByText("Ran out of time")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again with more time" })).toBeNull();
  });
});

// M36: Home, Ops and Activity approve a job someone already staged.
describe("approving a job that was already staged", () => {
  function existingApi(state = "awaiting_approval") {
    const calls: Array<{ url: string; method: string }> = [];
    const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.endsWith("/jobs/job-1/approval")) return json({ jobId: "job-1", tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", reason: "medium risk", confirmText: null });
      if (url.endsWith("/jobs/job-1") && method === "GET") return json({ job: { ...stagedJob, risk: "medium", state } });
      return json({ error: "unexpected" }, 500);
    }));
    return calls;
  }

  it("opens it at its own tier without staging another, and leaves it waiting when closed", async () => {
    const calls = existingApi();
    const onClose = vi.fn();
    render(<ApproveDialog operationId="storage.format" title="Erase and format a disk" parameters={{}} existingJobId="job-1" csrfToken="csrf" onClose={onClose} />);
    expect(await screen.findByText("Medium risk")).toBeTruthy();
    // What it was staged with, since the approver may not be who staged it.
    expect(screen.getByText("device").closest("li")?.textContent).toBe("device /dev/sdb");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("says so when the job is no longer waiting", async () => {
    existingApi("completed");
    render(<ApproveDialog operationId="storage.format" title="Erase and format a disk" parameters={{}} existingJobId="job-1" csrfToken="csrf" onClose={vi.fn()} />);
    expect(await screen.findByText((text) => text.startsWith("This job is no longer waiting for approval (completed)"))).toBeTruthy();
  });
});

// M33.13: the dialog in the console's look. The tier leads, in words, and asks what its tier asks.
describe("the approval dialog's tiers", () => {
  function stubTier(approval: Record<string, unknown>, finished: Record<string, unknown> = { state: "completed" }) {
    const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
    const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {} });
      if (method === "POST" && url.endsWith("/jobs")) return json({ job: { ...stagedJob, risk: approval.tier, recovery: { reason: "Formats the disk with a new filesystem." } }, approval: { mode: "tiered", elevated: false, ...approval } }, 201);
      if (url.endsWith("/approve")) return json({ job: { ...stagedJob, state: "applying" }, elevatedUntil: null }, 202);
      if (url.endsWith("/output")) return json({ output: "" });
      return json({ job: { ...stagedJob, ...finished } });
    }));
    return calls;
  }

  it("runs a low-risk operation with one click, and nothing more asked", async () => {
    stubTier({ tier: "low", passwordRequired: false, confirmText: null });
    render(<ApproveDialog operationId="apt.refresh" title="Refresh package lists" parameters={{}} preview={<span>Runs apt-get update.</span>} csrfToken="csrf" onClose={() => {}} />);
    expect(await screen.findByText("Low risk")).toBeTruthy();
    expect(screen.getByText("One click: nothing more is asked.")).toBeTruthy();
    expect(screen.getByText("Runs apt-get update.")).toBeTruthy();
    expect(screen.queryByLabelText("Approval password")).toBeNull();
    expect(screen.queryByLabelText("Typed confirmation")).toBeNull();
    expect((screen.getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled).toBe(false);
    // It is drawn over the page in the console's look, wherever it opened.
    expect(screen.getByRole("dialog").classList.contains("look-console")).toBe(true);
  });

  it("asks a high-risk one for the password and the typed confirmation, and sends both", async () => {
    const calls = stubTier({ tier: "high", passwordRequired: true, confirmText: "/dev/sdb" });
    render(<ApproveDialog operationId="storage.format" title="Erase and format a disk" parameters={{ device: "/dev/sdb" }} csrfToken="csrf" onClose={() => {}} />);
    expect(await screen.findByText("High risk")).toBeTruthy();
    expect(screen.getByText("Your password and the typed confirmation.")).toBeTruthy();
    // With no preview from the page, the operation's own description says what it does.
    expect(screen.getByText("Formats the disk with a new filesystem.")).toBeTruthy();
    const approve = screen.getByRole("button", { name: "Approve and run" }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Approval password"), { target: { value: "correct horse battery" } });
    expect(approve.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Typed confirmation"), { target: { value: "/dev/sdb" } });
    expect(approve.disabled).toBe(false);
    fireEvent.click(approve);
    await waitFor(() => expect(calls.find((call) => call.url.endsWith("/approve"))?.body).toEqual({ password: "correct horse battery", confirmText: "/dev/sdb" }));
    expect(await screen.findByText("Completed.")).toBeTruthy();
  });

  it("follows the run with JobProgress once it is approved", async () => {
    stubTier({ tier: "medium", passwordRequired: false, confirmText: null }, { state: "applying" });
    render(<ApproveDialog operationId="apt.upgrade" title="Install package updates" parameters={{}} csrfToken="csrf" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Confirm and run" }));
    const progress = await screen.findByRole("progressbar", { name: /Install package updates/ });
    expect(progress).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close dialog" }).hasAttribute("disabled")).toBe(true);
  });

  it("tells a page the job it staged, and hands the run over when asked to (Repair, M35)", async () => {
    const calls = stubTier({ tier: "medium", passwordRequired: false, confirmText: null });
    const staged = vi.fn();
    const handoff = vi.fn();
    render(<ApproveDialog operationId="storage.writable" title="Let apps write to the drive" parameters={{}} csrfToken="csrf" onClose={() => {}} onStaged={staged} handoff={handoff} />);
    fireEvent.click(await screen.findByRole("button", { name: "Confirm and run" }));
    await waitFor(() => expect(handoff).toHaveBeenCalledWith(expect.objectContaining({ id: "job-1" })));
    expect(staged).toHaveBeenCalledWith(expect.objectContaining({ id: "job-1" }));
    // Handed over: the dialog does not wait for the end itself.
    expect(calls.filter((call) => call.url === "/api/v1/jobs/job-1" && call.method === "GET")).toHaveLength(0);
  });
});

// Agents: one step after another (install, download, start the runner), each its own approval.
describe("an operation with a next step", () => {
  const medium = { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", reason: "medium risk", confirmText: null };
  /** Stages each operation as a job named after it; `ended` is how every job finishes. */
  function stubSteps(ended = "completed") {
    const calls: Array<{ url: string; method: string }> = [];
    const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
    const job = (id: string, state: string) => ({ ...stagedJob, id, type: `op:${id}`, title: id, risk: "medium", parameters: {}, state, error: state === "failed" ? "It did not work" : null });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString(); const method = init?.method ?? "GET";
      calls.push({ url, method });
      const staging = url.match(/^\/api\/v1\/operations\/([^/]+)\/jobs$/);
      if (staging && method === "POST") return json({ job: job(staging[1], "awaiting_approval"), approval: medium }, 201);
      const approving = url.match(/^\/api\/v1\/jobs\/([^/]+)\/approve$/);
      if (approving) return json({ job: job(approving[1], "applying"), elevatedUntil: null }, 202);
      if (url.endsWith("/output")) return json({ output: "" });
      const reading = url.match(/^\/api\/v1\/jobs\/([^/]+)$/);
      if (reading && method === "GET") return json({ job: job(reading[1], ended) });
      return json({ error: "unexpected" }, 500);
    }));
    return calls;
  }
  const staged = (calls: Array<{ url: string; method: string }>) => calls.filter((call) => call.method === "POST" && call.url.endsWith("/jobs")).map((call) => call.url.split("/")[4]);
  const install: PendingOperation = { operationId: "agents.runtime.install", title: "Install Unsloth for agents", parameters: {}, next: { operationId: "agents.runtime.enable", title: "Start the agents runner", parameters: {} } };
  function Page({ operation }: { operation: PendingOperation }) {
    const { start, dialog } = useOperation("csrf");
    return <><button type="button" onClick={() => start(operation)}>Begin</button>{dialog}</>;
  }

  it("offers the next once this one has completed, and stages it only when pressed, at its own tier", async () => {
    const calls = stubSteps();
    render(<Page operation={install} />);
    fireEvent.click(screen.getByRole("button", { name: "Begin" }));
    expect(await screen.findByRole("dialog", { name: "Install Unsloth for agents" })).toBeTruthy();
    // Nothing is offered before it has run.
    expect(screen.queryByRole("button", { name: /^Next/ })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm and run" }));
    expect(await screen.findByText("Completed.")).toBeTruthy();
    const next = screen.getByRole("button", { name: "Next: Start the agents runner" });
    expect(next.getAttribute("data-risk")).toBe("medium");
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    expect(staged(calls)).toEqual(["agents.runtime.install"]);

    fireEvent.click(next);
    // Its own dialog, staged fresh and waiting for its own confirmation.
    expect(await screen.findByRole("dialog", { name: "Start the agents runner" })).toBeTruthy();
    await waitFor(() => expect(staged(calls)).toEqual(["agents.runtime.install", "agents.runtime.enable"]));
    expect(calls.filter((call) => call.url.endsWith("/approve")).map((call) => call.url)).toEqual(["/api/v1/jobs/agents.runtime.install/approve"]);
    fireEvent.click(await screen.findByRole("button", { name: "Confirm and run" }));
    expect(await screen.findByText("Completed.")).toBeTruthy();
    // The last step offers nothing more.
    expect(screen.queryByRole("button", { name: /^Next/ })).toBeNull();
  });

  it("offers no next step after a job that did not complete", async () => {
    stubSteps("failed");
    render(<Page operation={install} />);
    fireEvent.click(screen.getByRole("button", { name: "Begin" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm and run" }));
    expect(await screen.findByText("Needs attention")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Next/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });

  it("offers nothing more where the page gives no way to open it", async () => {
    stubSteps();
    render(<ApproveDialog {...install} csrfToken="csrf" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Confirm and run" }));
    expect(await screen.findByText("Completed.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Next/ })).toBeNull();
  });
});

// The dialog on a phone held in one hand, and a clearer ending. What is asserted here is what the
// markup says; how it is drawn at 375 px is approve.css's, checked by its rules below and in a browser.
describe("the approval dialog on a phone, and how it ends", () => {
  // Local times, so "21:16" is 21:16 in whatever zone the tests run in; the clock is passed in.
  const at = (hour: number, minute: number, second = 0, day = 10) => new Date(2026, 10, day, hour, minute, second).toISOString();
  const clock = (hour: number, minute: number) => () => new Date(2026, 10, 10, hour, minute).getTime();
  const asked = { ...stagedJob, type: "op:app.restart", title: "Restart Immich", risk: "medium", parameters: { id: "immich" }, createdAt: at(21, 16), updatedAt: at(21, 16) };

  /** The dialog's endpoints for one job: how it is staged, what approving needs, and how it ends. */
  function stubPhone({ job = asked as Record<string, unknown>, approval = {} as Record<string, unknown>, ended = { state: "completed" } as Record<string, unknown> } = {}) {
    const calls: Array<{ url: string; method: string }> = [];
    const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
    const policy = { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", reason: "medium risk", confirmText: null, expiresAt: null, expired: false, ...approval };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString(); const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (method === "POST" && url.endsWith("/jobs")) return json({ job, approval: policy }, 201);
      if (url.endsWith("/approval")) return json({ jobId: "job-1", ...policy });
      if (url.endsWith("/approve")) return json({ job: { ...job, state: "applying" }, elevatedUntil: null }, 202);
      if (url.endsWith("/output")) return json({ output: "" });
      // Read before it is approved (a job someone else staged), it still waits.
      return json({ job: calls.some((call) => call.url.endsWith("/approve")) ? { ...job, ...ended } : job });
    }));
    return calls;
  }
  const open = (props: Partial<Parameters<typeof ApproveDialog>[0]> = {}) => render(<ApproveDialog operationId="app.restart" title="Restart Immich" parameters={{ id: "immich" }} csrfToken="csrf" onClose={() => {}} now={clock(21, 17)} {...props} />);

  it("says when it was asked, and when the approval lapses only where the job says it does", async () => {
    stubPhone();
    const first = open();
    await screen.findByRole("button", { name: "Confirm and run" });
    const when = screen.getByText("Asked", { exact: false, selector: ".approve-when__item" });
    expect(when.textContent).toBe("Asked 21:16");
    expect(when.querySelector("time")?.getAttribute("datetime")).toBe(asked.createdAt);
    // No approvalExpiresAt on the job, so nothing is said about lapsing: not a guess at seven days.
    expect(screen.queryByText(/Laps/)).toBeNull();
    // Under what it will do and above what approving needs, in the part that scrolls.
    const body = screen.getByRole("dialog").querySelector(".approve-body")!;
    expect([...body.children].map((child) => child.className.split(" ").at(-1))).toEqual(["approve-section", "approve-when", "approve-form"]);
    first.unmount();

    stubPhone({ approval: { expiresAt: at(21, 30) } });
    open();
    await screen.findByRole("button", { name: "Confirm and run" });
    const lapses = screen.getByText("Lapses", { exact: false, selector: ".approve-when__item" });
    expect(lapses.textContent).toBe("Lapses 21:30");
    expect(lapses.querySelector("time")?.getAttribute("datetime")).toBe(at(21, 30));
    expect(screen.getByText("Credentials are held temporarily. Approve before 21:30, or stage the operation again.")).toBeTruthy();
  });

  it("says it lapsed once that time has passed, and gives the day when it was not asked today", async () => {
    stubPhone({ job: { ...asked, createdAt: at(21, 16, 0, 7) }, approval: { expiresAt: at(21, 30) } });
    open({ now: clock(21, 31) });
    expect(await screen.findByText(/This approval expired/)).toBeTruthy();
    expect(screen.getByText("Lapsed", { exact: false, selector: ".approve-when__item" }).textContent).toBe("Lapsed 21:30");
    // Three days ago: the time alone would read as this evening.
    expect(screen.getByText("Asked", { exact: false, selector: ".approve-when__item" }).textContent).toMatch(/^Asked \S.*7.* 21:16$/);
  });

  it("names the agent that asks, from the page or from the job's own record", async () => {
    stubPhone();
    const plain = open();
    await screen.findByRole("button", { name: "Confirm and run" });
    expect(screen.getByRole("dialog").querySelector(".approve-kicker")?.textContent).toBe("Approval");
    plain.unmount();

    // Opened from a push or from Activity: no page to say who staged it, but the job does.
    stubPhone({ job: { ...asked, recovery: { reason: "Stops the app's containers and starts them again.", agent: { agentId: "keeper", agentName: "Server Keeper", runId: "run-1" } } } });
    open({ existingJobId: "job-1", parameters: {} });
    await screen.findByRole("button", { name: "Confirm and run" });
    expect(screen.getByRole("dialog").querySelector(".approve-kicker")?.textContent).toBe("Server Keeper asks");
    expect(screen.getByText("What it was staged with")).toBeTruthy();
    expect(screen.getByText("Asked", { exact: false, selector: ".approve-when__item" }).textContent).toBe("Asked 21:16");
  });

  it("says the phone can be put down only while the job runs", async () => {
    stubPhone({ ended: { state: "applying" } });
    const running = open();
    const run = await screen.findByRole("button", { name: "Confirm and run" });
    expect(screen.queryByText(/It finishes either way/)).toBeNull();
    fireEvent.click(run);
    await screen.findByRole("progressbar", { name: /Restart Immich/ });
    const away = screen.getByText(/It finishes either way, and Activity will say how it went\./);
    expect(away.textContent).toBe("You can put the phone down. It finishes either way, and Activity will say how it went.");
    // "The phone" is its own span, which the stylesheet shows only on a phone.
    expect(away.querySelector(".approve-away__phone")?.textContent).toBe("You can put the phone down. ");
    expect(screen.getByRole("dialog").querySelector(".approve-kicker")?.textContent).toBe("Running");
    running.unmount();

    stubPhone();
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm and run" }));
    await screen.findByText("Completed.");
    expect(screen.queryByText(/It finishes either way/)).toBeNull();
  });

  it("ends with a plain result line, then how long it took counted from the approval", async () => {
    // Staged at 15:16 by an agent, approved at 21:16:10, finished 38 seconds later: 38s, not six hours.
    const ended = { state: "completed", createdAt: at(15, 16), updatedAt: at(21, 16, 48), approvals: [{ ownerId: "owner", createdAt: at(21, 16, 10) }], steps: [{ name: "verify", state: "completed", detail: "Immich answers its health check.", createdAt: at(21, 16, 48) }] };
    stubPhone({ job: { ...asked, createdAt: at(15, 16) }, ended });
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm and run" }));
    const line = (await screen.findByText("Completed.")).closest(".approve-result")!;
    expect(line.getAttribute("data-status")).toBe("good");
    expect(line.querySelector(".approve-result__line")?.textContent).toBe("Completed. Immich answers its health check.");
    expect(line.querySelector(".approve-result__took")?.textContent).toBe("Took 38s, from your approval");
    // First in the ending, above the job log.
    const section = line.closest(".approve-section")!;
    expect([...section.children].map((child) => child.className.split(" ")[0])).toEqual(["approve-section__title", "approve-result", "jobs-log"]);
  });

  it("says nothing about how long it took without the approval's own time", async () => {
    stubPhone({ ended: { state: "completed", updatedAt: at(21, 17), approvals: [] } });
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm and run" }));
    await screen.findByText("Completed.");
    expect(screen.queryByText(/Took/)).toBeNull();
  });

  it("says what did not complete first, and leaves the reason to the job log, said once", async () => {
    stubPhone({ ended: { state: "failed", error: "docker compose up failed: port is already allocated", updatedAt: at(21, 16, 15), approvals: [{ ownerId: "owner", createdAt: at(21, 16, 10) }] } });
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm and run" }));
    const line = (await screen.findByText("Restart Immich did not complete.")).closest(".approve-result")!;
    expect(line.getAttribute("data-status")).toBe("danger");
    expect(line.querySelector(".approve-result__took")?.textContent).toBe("Took 5s, from your approval");
    expect(screen.getAllByText("docker compose up failed: port is already allocated")).toHaveLength(1);
    // The polite region says that it failed; the reason is the job log's alert, not said twice.
    expect(within(screen.getByRole("dialog")).getByRole("status").textContent).toBe("Restart Immich did not complete. Took 5s, from your approval. The job log says why.");
    expect(screen.getByRole("alert").textContent).toBe("docker compose up failed: port is already allocated");
    expect(screen.queryByText("Completed.")).toBeNull();
  });

  it("announces each change of state from one live region", async () => {
    stubPhone({ approval: { expiresAt: at(21, 30) }, ended: { state: "completed", updatedAt: at(21, 16, 48), approvals: [{ ownerId: "owner", createdAt: at(21, 16, 10) }] } });
    open();
    const dialog = screen.getByRole("dialog");
    // There from the start and empty, so what it comes to say is a change and is read out.
    const status = within(dialog).getByRole("status");
    expect(status.textContent).toBe("");
    const run = await screen.findByRole("button", { name: "Confirm and run" });
    expect(status.textContent).toBe("Waiting for your approval: medium risk.");
    expect(within(dialog).getAllByRole("status")).toHaveLength(1);
    fireEvent.click(run);
    await waitFor(() => expect(status.textContent).toBe("Restart Immich finished. Took 38s, from your approval."));
    expect(within(dialog).getAllByRole("status")).toHaveLength(1);
    expect(dialog.getAttribute("aria-labelledby")).toBe(screen.getByRole("heading", { name: "Restart Immich" }).id);
  });

  it("says it is running in that same region", async () => {
    stubPhone({ ended: { state: "applying" } });
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm and run" }));
    await screen.findByRole("progressbar", { name: /Restart Immich/ });
    expect(within(screen.getByRole("dialog")).getByRole("status").textContent).toBe("Approved. It is running.");
  });

  it("keeps the actions out of the part that scrolls, and the fields before them for the keyboard", async () => {
    stubPhone({ approval: { tier: "high", passwordRequired: true, confirmText: "immich" } });
    open();
    await screen.findByLabelText("Approval password");
    const dialog = screen.getByRole("dialog");
    // Head, tier, the live region, the scrolling body, then the footer: a sibling of the body, so
    // it cannot lie over a field inside it.
    expect([...dialog.children].map((child) => child.className.split(" ").at(-1))).toEqual(["approve-head", "approve-tier", "approve-status", "approve-body", "approve-foot"]);
    const foot = dialog.querySelector(".approve-foot")!;
    expect(dialog.querySelector(".approve-body")!.contains(screen.getByLabelText("Approval password"))).toBe(true);
    expect(foot.contains(screen.getByLabelText("Typed confirmation"))).toBe(false);
    // Both actions carry the class the phone rules size; only the one that approves is primary.
    const approve = screen.getByRole("button", { name: "Approve and run" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect([...foot.querySelectorAll(".approve-act")]).toEqual([cancel, approve]);
    expect(approve.classList.contains("approve-act--primary")).toBe(true);
    expect(cancel.classList.contains("approve-act--primary")).toBe(false);
    // The order the keyboard meets them in: close, what is typed, then the actions.
    const order = [...dialog.querySelectorAll<HTMLElement>("button, input, summary")].map((element) => element.getAttribute("aria-label") ?? (element instanceof HTMLInputElement ? element.labels?.[0]?.textContent : element.textContent));
    expect(order).toEqual(["Close dialog", "Exactly what it is given (1)", "Typed confirmation", "Approval password", "Show", "Cancel", expect.stringContaining("Approve and run")]);
  });

  it("sends the approval from the keyboard, and keeps focus in the dialog once the fields are gone", async () => {
    const calls = stubPhone({ approval: { tier: "high", passwordRequired: true, confirmText: null }, ended: { state: "applying" } });
    open();
    const password = await screen.findByLabelText("Approval password");
    password.focus();
    fireEvent.change(password, { target: { value: "correct horse battery" } });
    // Enter in the field: the form's own submit, which is also the phone keyboard's Go.
    fireEvent.submit(password.closest("form")!);
    await screen.findByRole("progressbar", { name: /Restart Immich/ });
    expect(calls.some((call) => call.url.endsWith("/approve"))).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
  });

  it("sizes the sheet to what an on-screen keyboard leaves, and says when that is short", async () => {
    stubPhone();
    const listeners = new Map<string, () => void>();
    const viewport = { height: 760, offsetTop: 0, scale: 1, addEventListener: (type: string, listener: () => void) => { listeners.set(type, listener); }, removeEventListener: (type: string) => { listeners.delete(type); } };
    vi.stubGlobal("visualViewport", viewport);
    const { unmount } = open();
    await screen.findByRole("button", { name: "Confirm and run" });
    const dialog = screen.getByRole("dialog");
    const backdrop = dialog.parentElement!;
    expect(backdrop.style.getPropertyValue("--approve-visible-height")).toBe("760px");
    expect(dialog.hasAttribute("data-compact")).toBe(false);
    // The keyboard opens: 336 px of the screen are under it, and the browser scrolled the page 12 px.
    Object.assign(viewport, { height: 424, offsetTop: 12 });
    fireEvent(window, new Event("resize"));
    await waitFor(() => expect(dialog.hasAttribute("data-compact")).toBe(true));
    expect(backdrop.style.getPropertyValue("--approve-visible-height")).toBe("424px");
    expect(backdrop.style.getPropertyValue("--approve-visible-top")).toBe("12px");
    // Pinched in, the visual viewport is the magnified page, not what a keyboard left: full height again.
    Object.assign(viewport, { height: 300, offsetTop: 40, scale: 2 });
    listeners.get("resize")?.();
    await waitFor(() => expect(backdrop.style.getPropertyValue("--approve-visible-height")).toBe(""));
    expect(listeners.has("resize") && listeners.has("scroll")).toBe(true);
    unmount();
    expect(listeners.size).toBe(0);
  });

  describe("its stylesheet", () => {
    const css = approveCss.replace(/\/\*[\s\S]*?\*\//g, "");
    /** The body of the first @media block whose query starts with this. */
    const media = (query: string) => {
      const start = css.indexOf(`@media ${query}`);
      const open = css.indexOf("{", start);
      let depth = 1; let close = open + 1;
      for (; close < css.length && depth; close += 1) depth += css[close] === "{" ? 1 : css[close] === "}" ? -1 : 0;
      return start < 0 ? "" : css.slice(open + 1, close - 1);
    };
    const rule = (block: string, selector: string) => block.split("}").find((part) => part.trim().startsWith(`${selector} {`))?.split("{")[1] ?? "";
    const phone = media("(max-width: 760px)");

    it("makes it a sheet at the shell's phone width: the whole screen, the actions above the home indicator", () => {
      expect(css).not.toContain("640px");
      expect(rule(phone, ".approve-backdrop")).toMatch(/height: var\(--approve-visible-height, 100%\)/);
      expect(rule(phone, ".approve-backdrop")).toMatch(/padding: 0 env\(safe-area-inset-right, 0px\) 0 env\(safe-area-inset-left, 0px\)/);
      expect(rule(phone, ".approve-dialog")).toMatch(/width: 100%; max-height: none;/);
      expect(rule(phone, ".approve-head")).toContain("env(safe-area-inset-top, 0px)");
      // Above the home indicator, and above what the shell keeps along the bottom edge (the demo's bar covered Cancel).
      expect(rule(phone, ".approve-foot")).toMatch(/flex-direction: column-reverse;.*padding-bottom: calc\(10px \+ env\(safe-area-inset-bottom, 0px\) \+ var\(--shell-bottom-inset, 0px\)\)/);
      // The body is the only part that scrolls, in the base rules; the footer never shrinks.
      expect(rule(css, ".approve-body")).toMatch(/flex: 1 1 auto;.*min-height: 0;.*overflow-y: auto/);
      expect(rule(css, ".approve-foot")).toMatch(/flex: none/);
    });

    it("gives a thumb 52 px to approve with and 44 px for everything else", () => {
      expect(rule(phone, ".approve-dialog[data-phase] .approve-foot .approve-act--primary.ui-button")).toContain("min-height: 52px");
      expect(rule(phone, ".approve-dialog[data-phase] .approve-foot .approve-act.ui-button")).toMatch(/min-height: 44px;.*white-space: normal/);
      expect(rule(phone, ".approve-dialog.approve-dialog[data-phase] .approve-close")).toBe(" width: 44px; height: 44px; ");
      // 16 px type in the fields: iOS zooms the page into anything smaller.
      expect(rule(phone, ".approve-dialog.approve-dialog[data-phase] .approve-form .ui-input")).toBe(" min-height: 44px; font-size: var(--font-size-lg); ");
      for (const selector of [".approve-form .ui-secret__toggle", ".approve-body .ui-button", ".approve-body .ui-job__toggle", ".approve-body .ui-code__copy"]) expect(rule(phone, `.approve-dialog.approve-dialog[data-phase] ${selector}`), selector).toContain("min-height: 44px");
    });

    it("lets the whole sheet scroll when little height is left, the actions still at the bottom", () => {
      expect(rule(phone, ".approve-dialog[data-compact]")).toMatch(/overflow-y: auto;.*scroll-padding-bottom: calc\(84px \+ env\(safe-area-inset-bottom, 0px\)\)/);
      expect(rule(phone, ".approve-dialog[data-compact][data-phase] .approve-foot")).toMatch(/position: sticky; bottom: 0; flex-direction: row;/);
    });

    it("says \"the phone\" only on a phone, and takes its new radii from the look", () => {
      expect(rule(css, ".approve-away__phone")).toBe(" display: none; ");
      expect(rule(phone, ".approve-away__phone")).toBe(" display: inline; ");
      expect(rule(css, ".approve-result")).toContain("border-radius: var(--radius-control)");
    });
  });
});
