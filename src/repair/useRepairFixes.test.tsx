import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { resetConnection } from "../pwa/connection";
import { pageIsFollowing } from "../shell/refresh";
import type { Finding } from "./types";
import { useRepairFixes, type RepairFixes } from "./useRepairFixes";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); resetConnection(); });

const finding = (id: string): Finding => ({
  id, severity: "warning", title: `Finding ${id}`, detail: "", evidence: [], manual: null,
  fix: { operationId: "apt.update", label: `Fix ${id}`, preview: "Runs it", risk: "low" },
});

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const lowApproval = { tier: "low", passwordRequired: false, elevated: false, mode: "tiered", reason: "" };

const completedJob = (jobId: string) => ({ id: jobId, title: "Fix", state: "completed", steps: [], error: null });

function runBatch(stage: (call: number) => Promise<Response>, approve: (jobId: string) => Promise<Response> = async (jobId) => json({ job: { id: jobId, state: "applying" }, elevatedUntil: null }), jobFor: (jobId: string) => unknown = completedJob) {
  let stages = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url.endsWith("/jobs") && url.includes("/operations/")) { stages += 1; return stage(stages); }
    if (url.endsWith("/approve")) return approve(decodeURIComponent(url.split("/jobs/")[1]!.split("/")[0]!));
    if (url.includes("/api/v1/jobs/")) return json({ job: jobFor(decodeURIComponent(url.split("/jobs/")[1]!)) });
    if (url.includes("/api/v1/health")) return json({ ok: true });
    return json({});
  }));
  const state: { current: RepairFixes | null } = { current: null };
  const entries = ["a", "b", "c"].map((id) => ({ finding: finding(id), fix: finding(id).fix! }));
  function Harness() {
    const fixes = useRepairFixes({ csrfToken: "t", recheck: async () => null });
    state.current = fixes;
    return <>{fixes.dialog}<button type="button" onClick={() => fixes.startBatch(entries)}>start</button></>;
  }
  const view = render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "start" }));
  fireEvent.click(screen.getByRole("button", { name: "Run all 3" }));
  return { state, stages: () => stages, unmount: view.unmount };
}

it("stops the batch when BoxPilot stops answering, instead of staging the rest into it (M89)", async () => {
  const { state, stages } = runBatch(async (call) => {
    if (call === 2) throw new TypeError("Failed to fetch");
    return json({ job: { id: `job-${call}`, state: "awaiting_approval" }, approval: lowApproval });
  });
  await waitFor(() => expect(state.current?.busy).toBe(false));
  expect(stages()).toBe(2);
  expect(state.current?.notice).toMatch(/BoxPilot stopped answering, so the batch stopped here/);
  const b = state.current?.runs.b;
  expect(b).toMatchObject({ phase: "still", error: expect.stringMatching(/^BoxPilot did not answer\./) });
  expect(state.current?.runs.c).toMatchObject({ phase: "still", error: expect.stringMatching(/^Not started/) });
});

it("keeps the job on the card when the approval got no answer, so its log can still be found", async () => {
  const { state, stages } = runBatch(
    async (call) => json({ job: { id: `job-${call}`, state: "awaiting_approval" }, approval: lowApproval }),
    async () => { throw new TypeError("Load failed"); },
  );
  await waitFor(() => expect(state.current?.busy).toBe(false));
  expect(stages()).toBe(1);
  expect(state.current?.runs.a).toMatchObject({ phase: "still", jobId: "job-1", error: expect.stringMatching(/It may still be running/) });
  expect(state.current?.runs.c).toMatchObject({ error: expect.stringMatching(/^Not started/) });
});

it("stops the batch when a fix failed because the admin service did not answer, though the web side still does (M89)", async () => {
  // The health route answers, so the connection reads as fine; the job's own code is what says the
  // next fix would wait its ten minutes for the same silence.
  const { state, stages } = runBatch(
    async (call) => json({ job: { id: `job-${call}`, state: "awaiting_approval" }, approval: lowApproval }),
    undefined,
    (jobId) => ({ id: jobId, title: "Fix", state: "failed", steps: [], error: "BoxPilot was not back within 10 minutes, so this did not start and nothing was changed.", recovery: { helperCode: "helper_unavailable" } }),
  );
  await waitFor(() => expect(state.current?.busy).toBe(false));
  expect(stages()).toBe(1);
  expect(state.current?.notice).toMatch(/^BoxPilot's admin service is not answering, so the batch stopped here/);
  expect(state.current?.runs.a).toMatchObject({ phase: "still", jobId: "job-1" });
  expect(state.current?.runs.b).toMatchObject({ phase: "still", jobId: null, error: expect.stringMatching(/^Not started: BoxPilot's admin service/) });
  expect(state.current?.runs.c).toMatchObject({ phase: "still", jobId: null });
});

it("goes on after a fix that failed for its own reasons", async () => {
  const { state, stages } = runBatch(
    async (call) => json({ job: { id: `job-${call}`, state: "awaiting_approval" }, approval: lowApproval }),
    undefined,
    (jobId) => ({ id: jobId, title: "Fix", state: "failed", steps: [], error: "apt-get failed", recovery: {} }),
  );
  await waitFor(() => expect(state.current?.busy).toBe(false));
  expect(stages()).toBe(3);
});

it("follows its own jobs to the end, so the job feed does not ask the page for a second scan of each (M89)", async () => {
  const { state, unmount } = runBatch(async (call) => json({ job: { id: `job-${call}`, state: "awaiting_approval" }, approval: lowApproval }));
  await waitFor(() => expect(state.current?.busy).toBe(false));
  expect(["job-1", "job-2", "job-3"].map(pageIsFollowing)).toEqual([true, true, true]);
  unmount();
  expect(["job-1", "job-2", "job-3"].map(pageIsFollowing)).toEqual([false, false, false]);
});
