import { describe, expect, it } from "vitest";
import { formatDuration, jobTimeoutRecord, keepTimeout, lastOutputLine, timedOut, timeoutMessage, timeoutOf } from "./timeouts.mjs";

describe("a timeout carried on an error (M30.3)", () => {
  it("is an object on the error, not a phrase in its message", () => {
    const error = timedOut("Downloading the images did not finish within 15 minutes", { budgetMs: 900_000, step: "Downloading the images" });
    expect(error.code).toBe("timeout");
    expect(timeoutOf(error)).toEqual({ scope: "step", budgetMs: 900_000, step: "Downloading the images" });
    // The words alone are no longer a timeout: nothing reads them to decide.
    expect(timeoutOf(new Error("Helper request timed out (overall deadline reached)"))).toBeNull();
    expect(timeoutOf(new Error("timed out after 900000 ms"))).toBeNull();
  });

  it("is cleaned to known fields and sizes when it crosses the helper socket", () => {
    expect(timeoutOf({ timeout: { scope: "whatever", budgetMs: 60_000, step: "x".repeat(500), phase: "queued", extra: "dropped" } }))
      .toEqual({ scope: "step", budgetMs: 60_000, step: "x".repeat(200), phase: "queued" });
    expect(timeoutOf({ timeout: { scope: "operation", budgetMs: -1 } })).toBeNull();
    expect(timeoutOf({ timeout: { scope: "operation", budgetMs: 1.5 } })).toBeNull();
    expect(timeoutOf({ timeout: "yes" })).toBeNull();
  });

  it("survives being wrapped in the operation's own sentence", () => {
    const cause = timedOut("Downloading the new images did not finish within 30 minutes", { budgetMs: 1_800_000, step: "Downloading the new images" });
    const wrapped = keepTimeout(cause, new Error(`Jellyfin update failed before anything was restarted; the app was unchanged. ${cause.message}`));
    expect(timeoutOf(wrapped)).toEqual({ scope: "step", budgetMs: 1_800_000, step: "Downloading the new images" });
    expect(timeoutOf(keepTimeout(new Error("plain"), new Error("still plain")))).toBeNull();
  });
});

describe("the job record's timeout", () => {
  it("has the budget, the time used, the phase, and how far the log got", () => {
    const record = jobTimeoutRecord({ scope: "operation", budgetMs: 1_500_000 }, { elapsedMs: 1_500_412.7, log: "$ docker compose up\nPulling fs layer\n  abc123 Downloading 812MB/2.1GB  \n\n", moreTimeMs: 3_000_000 });
    expect(record).toEqual({ scope: "operation", budgetMs: 1_500_000, elapsedMs: 1_500_413, phase: "running", step: null, lastOutput: "abc123 Downloading 812MB/2.1GB", moreTimeMs: 3_000_000 });
    expect(jobTimeoutRecord({ scope: "operation", budgetMs: 1000, phase: "queued" }, { elapsedMs: 5 })).toMatchObject({ phase: "queued", lastOutput: null, moreTimeMs: null });
    expect(lastOutputLine("a\n" + "b".repeat(400))).toHaveLength(300);
  });

  it("is said in plain words", () => {
    expect(formatDuration(40_000)).toBe("40 seconds");
    expect(formatDuration(60_000)).toBe("1 minute");
    expect(formatDuration(25 * 60_000)).toBe("25 minutes");
    expect(formatDuration(150 * 60_000)).toBe("2 hours 30 minutes");
    expect(formatDuration(600 * 60_000)).toBe("10 hours");
    expect(timeoutMessage("Install application", { scope: "operation", budgetMs: 1_500_000 })).toBe("Install application did not finish within 25 minutes. It may still be running on the server; Activity shows how far it got.");
    expect(timeoutMessage("Install application", { scope: "operation", budgetMs: 86_400_000, phase: "queued" })).toMatch(/^Install application waited 24 hours behind other work/);
  });
});
