import { describe, expect, it } from "vitest";
import { registry } from "./index.mjs";
import { rootTaskWaitMarginMs } from "../run-unit.mjs";

/**
 * The helper waits for a root task's unit for the task's own limit plus a margin (run-unit.mjs). A
 * job's budget is the web side's deadline. When the two met - a 44-minute task in a 45-minute
 * operation, the helper waiting 45 - the web gave up first: the job recorded the whole operation
 * running out, with nothing to say the task was still running, and "Try again with more time"
 * started a second download beside the first. So every operation that runs as a job and runs a
 * root task leaves room for the helper's whole wait inside its budget, with at least this much to
 * spare, at its normal budget and at the most "Try again with more time" can give it. (Reads and
 * BoxPilot's own plumbing are never jobs: their callers bring their own deadlines.)
 */
const spareMs = 30_000;

/** Walk an operation as far as its root tasks, noting the limit each is started with. */
async function rootTaskLimits(operation, timeScale) {
  const limits = [];
  const stop = new Error("not a root task");
  const refuse = () => { throw stop; };
  // Anything the operation reaches for besides these stops the walk where it is.
  const refusing = new Proxy(refuse, { get: refuse, apply: refuse });
  const dependencies = new Proxy({
    runUnit: { runTask: async (task, _parameters, options = {}) => { limits.push({ task, timeoutMs: options.timeoutMs }); return {}; } },
    // An installed, running app on a loopback port, and a saved credential: what the operations
    // that talk to an app or use a credential check before their root task.
    apps: { inspect: async ({ id } = {}) => ({ applications: [{ id, installed: true, container: { running: true }, urls: [{ host: 8080 }] }] }) },
    credentials: { read: async () => "x", set: async () => ({}), remove: async () => ({}) },
    jobLog: { path: null },
    progress: () => {},
    timeScale,
  }, { get: (target, key) => (key in target ? target[key] : refusing) });
  const sample = { string: "x", number: 1, boolean: false, array: [], object: {} };
  const parameters = Object.fromEntries(Object.entries(operation.parameters?.fields ?? {}).map(([name, field]) => [name, field?.enum?.[0] ?? sample[field?.type ?? "string"] ?? "x"]));
  try { await operation.run(parameters, dependencies); } catch { /* the walk ends at the first thing that is not a root task */ }
  return limits;
}

const jobOperations = () => registry.list().filter((operation) => !operation.readOnly && !operation.internal);

describe("an operation that runs a root task (sweep 4)", () => {
  it("leaves the helper's whole wait for each of its tasks inside its budget", async () => {
    const seen = new Set();
    const tight = [];
    for (const operation of jobOperations()) {
      const scales = [1, ...(operation.maxTimeoutMs ? [operation.maxTimeoutMs / operation.timeoutMs] : [])];
      for (const scale of scales) {
        const limits = await rootTaskLimits(operation, scale);
        if (!limits.length) continue;
        seen.add(operation.id);
        const waited = limits.reduce((total, limit) => total + limit.timeoutMs + rootTaskWaitMarginMs, 0);
        const spare = Math.round(operation.timeoutMs * scale) - waited;
        if (spare < spareMs) tight.push(`${operation.id}${scale === 1 ? "" : ` given ${scale}x the time`}: ${limits.map((limit) => limit.task).join(", ")} leave ${spare / 1000} s`);
      }
    }
    expect(tight).toEqual([]);
    // The walk reached the operations this is about, so the check above is not vacuous.
    expect([...seen]).toEqual(expect.arrayContaining(["agents.runtime.install", "agents.model.download", "apt.upgrade", "storage.check", "storage.dirty-mark.clear", "backup.remote.sync", "network.wake", "heartbeat.test", "system.locale.set"]));
    // Every job operation whose code starts a root task was walked to it, bar these, which reach a
    // root task only after Cloudflare's record or Zulip's own tools have answered. Their budgets
    // were checked by hand: each task, plus the helper's wait, is well inside them.
    const unreached = jobOperations().filter((operation) => /\brunTask\(/.test(String(operation.run)) && !seen.has(operation.id)).map((operation) => operation.id);
    expect(unreached.sort()).toEqual(["agents.zulip.connect", "cloudflare.publish", "cloudflare.unpublish"]);
  });

  it("says so in the registry when it can be given more time, so a whole-operation timeout is not retried beside it", async () => {
    const offered = registry.list().filter((entry) => entry.maxTimeoutMs);
    for (const operation of offered) {
      const runs = (await rootTaskLimits(operation, 1)).length > 0;
      expect({ id: operation.id, runsRootTask: operation.runsRootTask }).toEqual({ id: operation.id, runsRootTask: runs });
    }
    expect(offered.filter((operation) => operation.runsRootTask).map((operation) => operation.id).sort()).toEqual(["agents.model.download", "agents.runtime.install"]);
  });
});
