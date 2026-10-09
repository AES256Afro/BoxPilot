import { describe, expect, it } from "vitest";
import { createHelperResponseReader, helperErrorReply, helperQueuedFrame, helperStartedFrame } from "./helper-response.mjs";
import { restartRefusalError } from "./self-restart.mjs";
const reply = (data) => `${JSON.stringify({ version: 1, id: "request", ...data })}\n`;

describe("bounded helper response parsing", () => {
  it("discards queued heartbeats rather than retaining them for hours", () => {
    const reader = createHelperResponseReader("request", { maxFrameBytes: 128 });
    for (let i = 0; i < 10_000; i += 1) reader.push(reply({ queued: true }));
    expect(reader.stats()).toMatchObject({ pendingBytes: 0, heartbeats: 10_000 });
    const final = reply({ ok: true, result: { name: "café" } });
    for (const part of final) reader.push(part);
    expect(reader.finish()).toEqual({ name: "café" });
  });
  it("caps incomplete and completed frames by UTF-8 bytes", () => {
    const reader = createHelperResponseReader("request", { maxFrameBytes: 8 });
    reader.push("éééé");
    expect(() => reader.push("x")).toThrow("byte limit");
    expect(() => createHelperResponseReader("request", { maxFrameBytes: 8 }).push("123456789\n")).toThrow("byte limit");
  });
  it("rejects mismatched, incomplete and multiple responses", () => {
    expect(() => createHelperResponseReader("other").push(reply({ ok: true }))).toThrow("id did not match");
    const queued = createHelperResponseReader("request");
    queued.push(reply({ queued: true }));
    expect(() => queued.finish()).toThrow("before sending a result");
    expect(() => createHelperResponseReader("request").push(reply({ ok: true }) + reply({ ok: true }))).toThrow("after its final response");
  });
  it("keeps helper errors and permits a final frame without a newline", () => {
    expect(() => createHelperResponseReader("request").push(reply({ ok: false, error: "operation failed" }))).toThrow("operation failed");
    const reader = createHelperResponseReader("request");
    reader.push(reply({ ok: true, result: 42 }).trim());
    expect(reader.finish()).toBe(42);
  });
  it("reports when a queued request leaves the queue, once, and never queued again after that", () => {
    const events = [];
    const reader = createHelperResponseReader("request", { onQueued: () => events.push("queued"), onStarted: () => events.push("started") });
    reader.push(`${JSON.stringify(helperQueuedFrame("request", "app:demo"))}\n`);
    reader.push(`${JSON.stringify(helperQueuedFrame("request", "app:demo"))}\n`);
    reader.push(`${JSON.stringify(helperStartedFrame("request"))}\n`);
    expect(events).toEqual(["queued", "queued", "started"]);
    expect(reader.stats()).toMatchObject({ heartbeats: 2, started: true, complete: false });
    reader.push(reply({ ok: true, result: 1 }));
    expect(reader.finish()).toBe(1);
    const twice = createHelperResponseReader("request");
    twice.push(reply({ started: true }));
    expect(() => twice.push(reply({ started: true }))).toThrow("starting twice");
    const late = createHelperResponseReader("request");
    late.push(reply({ started: true }));
    expect(() => late.push(reply({ queued: true }))).toThrow("after it started");
    expect(() => createHelperResponseReader("request").push(reply({ started: true, ok: false, error: "no" }))).toThrow("no");
  });

  it("carries a step's timeout from the reply onto the error, and nothing from an older helper's (M30.3)", () => {
    const caught = (frame) => { try { createHelperResponseReader("request").push(frame); } catch (error) { return error; } return null; };
    const ranOut = caught(reply({ ok: false, error: "Downloading the new images did not finish within 30 minutes", code: "timeout", timeout: { scope: "step", budgetMs: 1_800_000, step: "Downloading the new images" } }));
    expect(ranOut.message).toBe("Downloading the new images did not finish within 30 minutes");
    expect(ranOut.code).toBe("timeout");
    expect(ranOut.timeout).toEqual({ scope: "step", budgetMs: 1_800_000, step: "Downloading the new images" });
    // An older helper's reply: the same sentence, no structure, so no timeout is claimed.
    const older = caught(reply({ ok: false, error: "docker compose pull failed: timed out after 1800000 ms", code: "operation_failed" }));
    expect(older.timeout).toBeUndefined();
    expect(older.code).toBe("operation_failed");
  });

  it("carries whether a failed operation's own rollback worked, from the helper's reply onto the error", () => {
    const caught = (error) => { try { createHelperResponseReader("request").push(`${JSON.stringify(helperErrorReply("request", error))}\n`); } catch (thrown) { return thrown; } return null; };
    for (const rolledBack of [true, false]) {
      const error = caught(Object.assign(new Error("Demo update failed"), { rolledBack }));
      expect(error).toMatchObject({ message: "Demo update failed", code: "operation_failed", rolledBack });
    }
    // An operation that does not say claims nothing either way.
    expect(caught(new Error("Demo update failed")).rolledBack).toBeUndefined();
    // A step's timeout still rides along beside it.
    const ranOut = caught(Object.assign(new Error("Downloading did not finish within 30 minutes"), { timeout: { scope: "step", budgetMs: 1_800_000, step: "Downloading" }, rolledBack: true }));
    expect(ranOut).toMatchObject({ code: "timeout", timeout: { scope: "step", budgetMs: 1_800_000, step: "Downloading" }, rolledBack: true });
  });

  it("says a request turned away because BoxPilot is restarting did not start, in its code (sweep 5)", () => {
    // The web side sends it again once BoxPilot is back, which it can do only for one that never ran.
    const caught = (error) => { try { createHelperResponseReader("request").push(`${JSON.stringify(helperErrorReply("request", error))}\n`); } catch (thrown) { return thrown; } return null; };
    expect(caught(restartRefusalError())).toMatchObject({ code: "helper_restarting", message: expect.stringMatching(/^BoxPilot is restarting.*did not start and nothing was changed/) });
    expect(caught(restartRefusalError("The helper stopped before this began, so nothing was changed."))).toMatchObject({ code: "helper_restarting" });
    // Any other code an operation sets is not passed on as one: it is a failure.
    expect(caught(Object.assign(new Error("EACCES"), { code: "EACCES" })).code).toBe("operation_failed");
  });
});
