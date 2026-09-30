import express from "express";
import { describe, expect, it } from "vitest";
import { createStreamBudget } from "../event-stream.mjs";
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
