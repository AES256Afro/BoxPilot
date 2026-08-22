import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApproveDialog } from "./ApproveDialog";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const stagedJob = { id: "job-1", type: "op:storage.format", title: "Erase and format a disk", state: "awaiting_approval", risk: "high", parameters: { device: "/dev/sdb" }, recovery: {}, steps: [], approvals: [], createdAt: "2026-08-22T00:00:00Z", updatedAt: "2026-08-22T00:00:00Z" };

/** Records what the dialog sends, and answers every endpoint it touches. */
function stubApi({ passwordRequired = false, confirmText = "/dev/sdb" } = {}) {
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
  const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    calls.push({ url, method, body });
    if (url.includes("/jobs") && method === "POST" && url.endsWith("/jobs")) return json({ job: stagedJob, approval: { tier: "high", passwordRequired, elevated: !passwordRequired, mode: "tiered", confirmText } });
    if (url.endsWith("/approve")) {
      // The server refuses unless the exact text was typed — the bug this test exists for.
      if (body.confirmText !== confirmText) return json({ error: `Type ${confirmText} to confirm this high-risk job`, code: "job_approval_failed" }, 409);
      return json({ job: { ...stagedJob, state: "applying" }, elevatedUntil: null }, 202);
    }
    if (url.includes("/jobs/job-1") && method === "DELETE") return json({ job: { ...stagedJob, state: "cancelled" } });
    if (url.endsWith("/output")) return json({ jobId: "job-1", state: "completed", output: "", live: false });
    return json({ job: { ...stagedJob, state: "completed" } });
  }));
  return calls;
}

describe("approval dialog", () => {
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

  it("withdraws the staged job when the dialog is dismissed", async () => {
    const calls = stubApi();
    const onClose = vi.fn();
    render(<ApproveDialog operationId="storage.format" title="Erase and format a disk" parameters={{ device: "/dev/sdb" }} csrfToken="csrf" onClose={onClose} onFinished={() => {}} />);
    await screen.findByLabelText("Typed confirmation");
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    await waitFor(() => expect(calls.some((call) => call.method === "DELETE" && call.url.includes("/jobs/job-1"))).toBe(true));
    expect(onClose).toHaveBeenCalled();
  });
});
