import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApproveDialog, useOperation, type PendingOperation } from "./ApproveDialog";

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

