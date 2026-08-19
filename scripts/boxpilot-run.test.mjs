import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let directory;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-run-"));
  process.env.BOXPILOT_RUN_DIRECTORY = directory;
  vi.resetModules();
});
afterEach(async () => {
  delete process.env.BOXPILOT_RUN_DIRECTORY;
  await rm(directory, { recursive: true, force: true });
});

const id = "11111111-2222-4333-8444-555555555555";
const now = () => new Date("2026-08-19T12:00:00.000Z");

describe("boxpilot-run task runner", () => {
  it("rejects malformed, unknown, and stale specs", async () => {
    const { parseSpec } = await import("./boxpilot-run.mjs");
    expect(() => parseSpec("nope")).toThrow("valid JSON");
    expect(() => parseSpec(JSON.stringify({ task: "apt.update", parameters: {}, approvedAt: now().toISOString(), timeoutMs: 1000, extra: 1 }), now())).toThrow("unexpected fields");
    expect(() => parseSpec(JSON.stringify({ task: "rm.rf", parameters: {}, approvedAt: now().toISOString(), timeoutMs: 1000 }), now())).toThrow("not in the root task table");
    expect(() => parseSpec(JSON.stringify({ task: "apt.update", parameters: [], approvedAt: now().toISOString(), timeoutMs: 1000 }), now())).toThrow("parameters must be an object");
    expect(() => parseSpec(JSON.stringify({ task: "apt.update", parameters: {}, approvedAt: "2026-08-19T11:00:00.000Z", timeoutMs: 1000 }), now())).toThrow("stale");
    expect(() => parseSpec(JSON.stringify({ task: "apt.update", parameters: {}, approvedAt: now().toISOString(), timeoutMs: 10 }), now())).toThrow("timeout");
    expect(parseSpec(JSON.stringify({ task: "apt.update", parameters: {}, approvedAt: now().toISOString(), timeoutMs: 1000 }), now())).toMatchObject({ task: "apt.update" });
  });

  it("runs a spec from the run directory, writes the result atomically, and removes the spec", async () => {
    const { runTask } = await import("./boxpilot-run.mjs");
    await writeFile(path.join(directory, `${id}.json`), JSON.stringify({ task: "apt.update", parameters: { x: 1 }, approvedAt: now().toISOString(), timeoutMs: 5000 }));
    const taskTable = { "apt.update": vi.fn(async (parameters) => ({ echoed: parameters })) };
    await expect(runTask(id, { now, taskTable })).resolves.toEqual({ ok: true, task: "apt.update", result: { echoed: { x: 1 } } });
    expect(JSON.parse(await readFile(path.join(directory, `${id}.result.json`), "utf8"))).toMatchObject({ ok: true });
    await expect(readFile(path.join(directory, `${id}.json`), "utf8")).rejects.toThrow();
    await expect(runTask("../etc/passwd", { now, taskTable })).rejects.toThrow("UUID");
  });

  it("records task failures as a result instead of crashing", async () => {
    const { runTask } = await import("./boxpilot-run.mjs");
    await writeFile(path.join(directory, `${id}.json`), JSON.stringify({ task: "apt.update", parameters: {}, approvedAt: now().toISOString(), timeoutMs: 5000 }));
    const taskTable = { "apt.update": vi.fn(async () => { throw new Error("apt exploded"); }) };
    await expect(runTask(id, { now, taskTable })).resolves.toEqual({ ok: false, task: "apt.update", error: "apt exploded" });
  });
});
