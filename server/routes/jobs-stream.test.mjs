import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { describe, expect, it } from "vitest";
import { createStreamBudget } from "../event-stream.mjs";
import { createStateStore } from "../state.mjs";
import { createJobsRouter, outputTailFrom } from "./jobs.mjs";

describe("a job's output stream while the job prints nothing", () => {
  it("writes a comment line now and then, so a client that went away is noticed and its slot freed", async () => {
    // A job awaiting approval prints nothing. The stream used to write nothing either, for up to
    // three hours, so a laptop put to sleep with Activity open held one of its account's eight
    // streams until then.
    const job = { id: "11111111-1111-4111-8111-111111111111", state: "awaiting_approval", createdBy: "owner-1" };
    const state = { getJob: () => job, getJobOutput: () => null };
    const budget = createStreamBudget({ perAccount: 8, total: 32 });
    const app = express();
    app.use((request, _response, next) => { request.boxpilotSession = { owner: { id: "owner-1", role: "owner" } }; next(); });
    app.use("/api/v1", createJobsRouter({ state, jobs: {}, scheduler: {}, jobLogReader: { read: async (_id, offset) => ({ text: "", offset, exists: false }) }, auth: { requireCsrf: (_request, _response, next) => next() }, streamBudget: budget, streamPingMs: 50 }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const controller = new AbortController();
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/jobs/${job.id}/stream`, { signal: controller.signal });
      const reader = response.body.getReader();
      let text = "";
      while (!text.includes(": ping")) text += new TextDecoder().decode((await reader.read()).value);
      expect(text).toContain(": connected");
      expect(budget.stats().active).toBe(1);
      controller.abort();
      await expect.poll(() => budget.stats().active, { timeout: 4_000 }).toBe(0);
    } finally {
      controller.abort();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("the last of a job's output, after the live log is gone", () => {
  it("cuts by bytes, so a log with non-ASCII in it keeps its tail", () => {
    // compose prints "✔" (3 bytes, 1 character). Slicing the string by the byte count sent so far
    // skipped two characters per tick mark and silently dropped the end of the log.
    const final = "✔ pulled\n✔ created\nHealthy after 6s\n";
    const sentBytes = Buffer.byteLength("✔ pulled\n");
    expect(outputTailFrom(final, sentBytes)).toBe("✔ created\nHealthy after 6s\n");
  });

  it("sends nothing when everything was already streamed", () => {
    const final = "all of it\n";
    expect(outputTailFrom(final, Buffer.byteLength(final))).toBeNull();
  });

  it("sends nothing when the persisted copy is a truncated suffix", () => {
    // Only the last 2 MiB are kept, so a persisted copy shorter than what was streamed cannot be
    // sliced from the start: the offsets belong to a longer file.
    expect(outputTailFrom("tail only", 5_000_000)).toBeNull();
  });

  it("sends all of it when nothing was streamed", () => {
    expect(outputTailFrom("first line\n", 0)).toBe("first line\n");
  });
});

describe("the job list's summary view", () => {
  it("leaves out results and step logs, keeps what the state words read, and scopes the list as the full view does", async () => {
    const full = { id: "j1", state: "completed", createdBy: "owner-1", parameters: { id: "jellyfin" }, error: null, result: { big: "x".repeat(1000) }, steps: [{ name: "pull", state: "completed", detail: "y".repeat(1000), createdAt: "2026-10-18T00:00:00Z" }], approvals: [] };
    // A failure dismissed and one run again after a restart are told by their steps; a finished job's
    // notice by its result's warnings (src/jobStatus.ts). Those stay.
    const dismissed = { ...full, id: "j2", state: "failed", steps: [...full.steps, { name: "dismissed", state: "completed", detail: "Let go by the owner", createdAt: "2026-10-18T01:00:00Z" }] };
    const rerun = { ...full, id: "j3", state: "failed", steps: [{ name: "rerun", state: "started", detail: "Ran again as job j4", createdAt: "2026-10-18T02:00:00Z" }] };
    const noticed = { ...full, id: "j5", result: { warnings: ["Local retention needs attention."], big: "x".repeat(1000) } };
    const asked = [];
    const state = { listJobs: (limit, scope) => { asked.push([limit, scope]); return [full, dismissed, rerun, noticed]; } };
    const app = express();
    app.use((request, _response, next) => { request.boxpilotSession = { owner: { id: "op-1", role: "operator" } }; next(); });
    app.use("/api/v1", createJobsRouter({ state, jobs: {}, scheduler: {}, jobLogReader: { read: async () => ({ text: "", exists: false }) }, auth: { requireCsrf: (_request, _response, next) => next() }, streamBudget: createStreamBudget({ perAccount: 8, total: 32 }) }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const base = `http://127.0.0.1:${server.address().port}/api/v1/jobs?limit=200`;
      const summary = await (await fetch(`${base}&view=summary`)).json();
      expect(summary.jobs).toEqual([
        { ...full, result: null, steps: [] },
        { ...dismissed, result: null, steps: [{ name: "dismissed", state: "completed", detail: "", createdAt: "2026-10-18T01:00:00Z" }] },
        { ...rerun, result: null, steps: [{ name: "rerun", state: "started", detail: "", createdAt: "2026-10-18T02:00:00Z" }] },
        { ...noticed, result: { warnings: ["Local retention needs attention."] }, steps: [] },
      ]);
      const whole = await (await fetch(base)).json();
      expect(whole.jobs).toEqual([full, dismissed, rerun, noticed]);
      expect(asked).toEqual([["200", { createdBy: "op-1" }], ["200", { createdBy: "op-1" }]]);
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("an approval waiting behind newer work (M88)", () => {
  it("stays in the job list and the live snapshot for whoever may see it, however many jobs came since", async () => {
    // Nightly per-app backups alone make 30 jobs, and the snapshot is the newest 30: an approval
    // staged at 20:00 was gone from Today, Home, the dock badge and the command bar by morning.
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-m88-approvals-"));
    let clock = Date.parse("2026-11-24T20:00:00Z");
    const state = createStateStore({ stateDirectory: directory, now: () => new Date((clock += 1_000)) });
    const operator = state.createOwnerAccount({ username: "olly", passwordHash: "x", role: "operator", createdBy: null });
    const other = state.createOwnerAccount({ username: "otto", passwordHash: "x", role: "operator", createdBy: null });
    const waiting = state.createJob({ type: "op:app.update", title: "Update Jellyfin", risk: "medium", parameters: { id: "jellyfin" }, createdBy: operator.id });
    for (let index = 0; index < 40; index += 1) {
      const job = state.createJob({ type: "op:app.backup", title: "Back up application data", parameters: { id: `app-${index}` }, createdBy: operator.id });
      state.transitionJob(job.id, "awaiting_approval", "completed");
    }
    let as = { id: operator.id, role: "operator" };
    const app = express();
    app.use((request, _response, next) => { request.boxpilotSession = { owner: as }; next(); });
    app.use("/api/v1", createJobsRouter({ state, jobs: {}, scheduler: {}, jobLogReader: { read: async () => ({ text: "", exists: false }) }, auth: { requireCsrf: (_request, _response, next) => next() }, streamBudget: createStreamBudget({ perAccount: 8, total: 32 }) }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    const snapshot = async () => {
      const controller = new AbortController();
      const response = await fetch(`${base}/events`, { signal: controller.signal });
      const reader = response.body.getReader();
      let text = "";
      while (!/event: snapshot\ndata: [^\n]*\n\n/.test(text)) text += new TextDecoder().decode((await reader.read()).value);
      controller.abort();
      return JSON.parse(/event: snapshot\ndata: ([^\n]*)\n/.exec(text)[1]).jobs;
    };
    try {
      for (const query of ["?limit=30", "?limit=30&view=summary", ""]) {
        const listed = (await (await fetch(`${base}/jobs${query}`)).json()).jobs;
        expect(listed.map((job) => job.id), query).toContain(waiting.id);
        expect(listed.at(-1).id, query).toBe(waiting.id);                // the oldest, so last
        expect(new Set(listed.map((job) => job.id)).size, query).toBe(listed.length);
      }
      const streamed = await snapshot();
      expect(streamed).toHaveLength(31);
      expect(streamed.at(-1)).toMatchObject({ id: waiting.id, state: "awaiting_approval" });
      // Asked for enough to include it already, it is listed once.
      expect((await (await fetch(`${base}/jobs?limit=200`)).json()).jobs.filter((job) => job.id === waiting.id)).toHaveLength(1);
      // The owner sees the whole box, approvals included.
      as = { id: "owner-1", role: "owner" };
      expect((await (await fetch(`${base}/jobs?limit=30`)).json()).jobs.map((job) => job.id)).toContain(waiting.id);
      // Another operator sees only their own: none of it.
      as = { id: other.id, role: "operator" };
      expect((await (await fetch(`${base}/jobs?limit=30`)).json()).jobs).toEqual([]);
      expect(await snapshot()).toEqual([]);
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      state.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
