// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createLedger } from "./ledger.mjs";

/*
 * The gateway's own count of the month's spend (M45.3): a call reserves what it could cost before
 * it is made, the reservation becomes what it did cost after, and a new month starts at zero.
 */

function files(initial = {}) {
  const disk = new Map(Object.entries(initial));
  return {
    disk,
    read: async (file) => { if (!disk.has(file)) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return disk.get(file); },
    write: async (file, text) => { disk.set(file, text); },
  };
}

const october = Date.parse("2026-10-08T12:00:00Z");

describe("the gateway's ledger", () => {
  it("reserves before a call, settles to the real cost after, and writes both down", async () => {
    const store = files();
    const ledger = createLedger({ file: "/spend.json", now: () => october, ...store });
    const held = await ledger.reserve(0.4, 10);
    expect(held).toMatchObject({ ok: true, month: "2026-10", reserved: 0.4, spentUsd: 0.4 });
    expect(JSON.parse(store.disk.get("/spend.json"))).toEqual({ month: "2026-10", spentUsd: 0.4, calls: 1 });
    expect(await ledger.settle(held, 0.0738)).toMatchObject({ spentUsd: 0.0738 });
    expect(JSON.parse(store.disk.get("/spend.json")).spentUsd).toBe(0.0738);
  });

  it("refuses a call that could pass the cap, and one with no cap at all", async () => {
    const ledger = createLedger({ file: "/spend.json", now: () => october, ...files({ "/spend.json": JSON.stringify({ month: "2026-10", spentUsd: 9.8, calls: 40 }) }) });
    expect(await ledger.reserve(0.4, 10)).toMatchObject({ ok: false, spentUsd: 9.8, capUsd: 10 });
    expect(await ledger.reserve(0.1, 10)).toMatchObject({ ok: true, spentUsd: 9.9 });
    expect(await ledger.reserve(0.01, 0)).toMatchObject({ ok: false });
  });

  it("keeps a reservation counted when the cost is unknown, and gives it back when nothing was spent", async () => {
    const ledger = createLedger({ file: "/spend.json", now: () => october, ...files() });
    expect(await ledger.settle(await ledger.reserve(0.5, 10), null)).toMatchObject({ spentUsd: 0.5 });
    expect(await ledger.settle(await ledger.reserve(0.5, 10), 0)).toMatchObject({ spentUsd: 0.5 });
  });

  it("counts two calls at once one after the other, never both from the same total", async () => {
    const ledger = createLedger({ file: "/spend.json", now: () => october, ...files() });
    const [first, second, third] = await Promise.all([ledger.reserve(4, 10), ledger.reserve(4, 10), ledger.reserve(4, 10)]);
    expect([first.ok, second.ok, third.ok]).toEqual([true, true, false]);
    expect((await ledger.current()).spentUsd).toBe(8);
  });

  it("starts a new month at zero, and drops a reservation made last month", async () => {
    let clock = Date.parse("2026-10-31T23:59:00Z");
    const ledger = createLedger({ file: "/spend.json", now: () => clock, ...files({ "/spend.json": JSON.stringify({ month: "2026-10", spentUsd: 7, calls: 3 }) }) });
    const held = await ledger.reserve(1, 10);
    clock = Date.parse("2026-11-01T00:01:00Z");
    expect(await ledger.current()).toEqual({ month: "2026-11", spentUsd: 0, calls: 0 });
    expect(await ledger.settle(held, 0.2)).toEqual({ month: "2026-11", spentUsd: 0, calls: 0 });
  });

  it("reads a damaged file as an empty month rather than failing every call", async () => {
    const ledger = createLedger({ file: "/spend.json", now: () => october, ...files({ "/spend.json": "{not json" }) });
    expect(await ledger.current()).toEqual({ month: "2026-10", spentUsd: 0, calls: 0 });
  });
});
