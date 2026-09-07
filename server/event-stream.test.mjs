import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createEventStream, createStreamBudget } from "./event-stream.mjs";
function response() {
  const value = new EventEmitter();
  Object.assign(value, { writableLength: 0, destroyed: false, writableEnded: false,
    write: vi.fn(() => true), end: vi.fn(() => value.emit("finish")), destroy: vi.fn(() => { value.destroyed = true; value.emit("close"); }),
  });
  return value;
}
describe("bounded live streams", () => {
  it("caps account and global connections and releases every count only once", () => {
    const budget = createStreamBudget({ perAccount: 2, total: 3 });
    const first = budget.acquire("one"); const second = budget.acquire("one");
    expect(budget.acquire("one")).toBeNull();
    const third = budget.acquire("two"); expect(budget.acquire("three")).toBeNull();
    first(); first(); second(); third();
    expect(budget.stats()).toMatchObject({ active: 0, accounts: 0 });
  });
  it("disconnects oversized or backed-up clients and runs cleanup", () => {
    const res = response(); const clean = vi.fn();
    const stream = createEventStream(res, { maxBufferedBytes: 64 }); stream.onClose(clean);
    expect(stream.write("x".repeat(65))).toBe(false);
    expect(res.write).not.toHaveBeenCalled(); expect(res.destroy).toHaveBeenCalledOnce(); expect(clean).toHaveBeenCalledOnce();
    expect(res.listenerCount("drain")).toBe(0);
  });
  it("stops a stalled client on its deadline and releases pending drain waiters", async () => {
    const res = response(); res.write.mockReturnValue(false);
    let expire; const cancel = vi.fn();
    const stream = createEventStream(res, { setTimeout: (fn) => { expire = fn; return 1; }, clearTimeout: cancel });
    stream.write("data"); const waiting = stream.ready();
    expire(); expect(await waiting).toBe(false); expect(stream.closed).toBe(true); expect(cancel).toHaveBeenCalledWith(1);
  });
  it("holds its budget until pending final output is flushed or disconnected", () => {
    const res = response(); res.end.mockImplementation(() => {});
    const stream = createEventStream(res); const release = vi.fn(); stream.onClose(release);
    stream.send("state", { state: "completed" }); stream.end();
    expect(release).not.toHaveBeenCalled();
    res.emit("finish"); expect(release).toHaveBeenCalledOnce();
  });
  it("resumes on drain and clears the stall timer", async () => {
    const res = response(); res.write.mockReturnValue(false);
    const cancel = vi.fn();
    const stream = createEventStream(res, { setTimeout: () => 1, clearTimeout: cancel });
    stream.write("data"); const waiting = stream.ready(); res.emit("drain");
    expect(await waiting).toBe(true); expect(cancel).toHaveBeenCalledWith(1); stream.end();
    expect(res.listenerCount("close")).toBe(0);
  });
  it("chunks large logs without losing Unicode and stops on disconnect", async () => {
    const res = response(); const stream = createEventStream(res);
    const text = "a".repeat(32767) + "😀" + "z".repeat(80000);
    expect(await stream.output(text)).toBe(true);
    const chunks = res.write.mock.calls.map(([frame]) => JSON.parse(frame.split("data: ")[1].trim()).text);
    expect(chunks.join("")).toBe(text); expect(chunks.length).toBeGreaterThan(2);
    res.emit("close"); expect(await stream.output("after close")).toBe(false);
  });
});
