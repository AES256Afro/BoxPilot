import { describe, expect, it } from "vitest";
import { createHelperResponseReader } from "./helper-response.mjs";
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
});
