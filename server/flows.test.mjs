import { describe, expect, it, vi } from "vitest";
import { createFlowService, flowRisk, validateFlow } from "./flows.mjs";
import { computeNextRun } from "./scheduler.mjs";

/**
 * Flows are ADR-002: chains of registered operations, each step an ordinary job, the chain
 * answering for its riskiest step. Validation runs against the real registry, because a flow that
 * validates against a stub is a flow that breaks against the product.
 */
function fakeStore() {
  const flows = new Map();
  const jobs = new Map();
  const audits = [];
  return {
    flows, jobs, audits,
    createFlow({ name, steps, createdBy, frequency = null, minute = null, hour = null, weekday = null, nextDueAt = null }) {
      const flow = { id: `flow-${flows.size + 1}`, name, steps, createdBy, createdAt: "2026-08-26T00:00:00Z", updatedAt: "2026-08-26T00:00:00Z", lastRunAt: null, lastResult: null, lastJobIds: [], frequency, minute, hour, weekday, enabled: true, nextDueAt, triggerFlowId: arguments[0].triggerFlowId ?? null };
      flows.set(flow.id, flow);
      return flow;
    },
    getFlow: (id) => flows.get(id) ?? null,
    listFlows: () => [...flows.values()],
    updateFlow(id, changes) {
      const flow = flows.get(id);
      for (const [key, value] of Object.entries(changes)) if (value !== undefined) flow[key] = value;
      return flow;
    },
    markFlowRun(id, { result, jobIds }) { Object.assign(flows.get(id), { lastResult: result, lastJobIds: jobIds, lastRunAt: "now" }); },
    setFlowWebhook(id, hash) { const flow = flows.get(id); if (!flow) throw new Error("Flow not found"); flow.webhookHash = hash; flow.webhookEnabled = Boolean(hash); return flow; },
    deleteFlow(id) { if (!flows.delete(id)) throw new Error("Flow not found"); },
    getJob: (id) => jobs.get(id) ?? null,
    getSetting: () => null,
    findOwnerById: (id) => ({ id, username: id, role: id.startsWith("viewer") ? "viewer" : "owner" }),
    listDueFlows(nowIso) { return [...flows.values()].filter((flow) => flow.enabled !== false && flow.nextDueAt && flow.nextDueAt <= nowIso); },
    listFlowsTriggeredBy(flowId) { return [...flows.values()].filter((flow) => flow.enabled !== false && flow.triggerFlowId === flowId); },
    recordAudit: (event, detail) => audits.push({ event, ...detail }),
  };
}

function fakeJobs(store, { failAt = null, neverFinish = null, alwaysFail = false, results = {} } = {}) {
  let counter = 0;
  return {
    calls: [],
    async createOperationJob(operationId, parameters, actorId, { role }) {
      counter += 1;
      const job = { id: `job-${counter}`, operationId, parameters, actorId, role, state: "awaiting_approval" };
      store.jobs.set(job.id, job);
      this.calls.push({ operationId, parameters, actorId, role });
      return job;
    },
    async approveAndStart(jobId) {
      const job = store.jobs.get(jobId);
      job.state = "applying";
      const call = this.calls.length;
      // steps finish on their own unless told otherwise; the runner polls for the outcome
      if (neverFinish !== call) {
        setTimeout(() => {
          job.state = (alwaysFail ? call >= failAt : failAt === call) ? "failed" : "completed";
          if (job.state === "failed") job.error = "the step went wrong";
          else job.result = results[call] ?? null;
        }, 5);
      }
    },
    cancelJob: vi.fn(),
  };
}

const goodSteps = [
  { operationId: "controller.backup.create", parameters: {} },
  { operationId: "host.snapshot.create", parameters: {} },
];

describe("what may be a flow at all", () => {
  it("accepts an ordered list of real, parameterised, non-high operations", () => {
    expect(validateFlow({ name: "Update night", steps: goodSteps })).toBeNull();
  });

  it("rejects a high-risk step outright, which is the ADR-002 line", () => {
    const problem = validateFlow({ name: "x", steps: [{ operationId: "storage.format", parameters: { device: "/dev/sdb", filesystem: "ext4", label: "d", confirm: "sdb" } }] });
    expect(problem).toMatch(/high risk and cannot be part of a flow/);
  });

  it("rejects an operation that does not exist, and parameters its operation refuses", () => {
    expect(validateFlow({ name: "x", steps: [{ operationId: "no.such.op" }] })).toMatch(/not a registered operation/);
    expect(validateFlow({ name: "x", steps: [{ operationId: "apt.install", parameters: {} }] })).toMatch(/step 1/);
  });

  it("bounds the name and the step count", () => {
    expect(validateFlow({ name: "", steps: goodSteps })).toMatch(/name/);
    expect(validateFlow({ name: "x", steps: [] })).toMatch(/1 to 10/);
    expect(validateFlow({ name: "x", steps: Array.from({ length: 11 }, () => goodSteps[0]) })).toMatch(/1 to 10/);
  });

  it("answers for its riskiest step", () => {
    expect(flowRisk([goodSteps[0]])).toBe("low");
    expect(flowRisk(goodSteps)).toBe("medium");
  });
});

describe("running a flow", () => {
  it("runs the steps in order as ordinary jobs under the runner's authority", async () => {
    const store = fakeStore();
    const jobs = fakeJobs(store);
    const service = createFlowService({ store, jobs, pollMs: 2 });
    const flow = await service.create({ name: "Belt and braces", steps: goodSteps, createdBy: "owner-1" });

    const result = await service.run(flow.id, "owner-1", { role: "owner" });
    expect(result).toMatchObject({ completed: true, steps: 2, jobIds: ["job-1", "job-2"] });
    expect(jobs.calls.map((call) => call.operationId)).toEqual(["controller.backup.create", "host.snapshot.create"]);
    expect(jobs.calls.every((call) => call.actorId === "owner-1")).toBe(true);
    expect(store.getFlow(flow.id).lastResult).toBe("completed");
    expect(store.audits.some((audit) => audit.event === "flow.completed")).toBe(true);
  });

  it("stops at a failed step and says so; what ran stands, what did not never starts", async () => {
    const store = fakeStore();
    const jobs = fakeJobs(store, { failAt: 1 });
    const service = createFlowService({ store, jobs, pollMs: 2 });
    const flow = await service.create({ name: "Update night", steps: goodSteps, createdBy: "owner-1" });

    await expect(service.run(flow.id, "owner-1", { role: "owner" })).rejects.toThrow(/stopped at step 1.*Earlier steps ran and stand/s);
    expect(jobs.calls).toHaveLength(1); // step two was never created, let alone run
    expect(store.getFlow(flow.id).lastResult).toMatch(/stopped at step 1/);
  });

  it("refuses viewers, refuses always-ask approval mode, and refuses to lap itself", async () => {
    const store = fakeStore();
    const jobs = fakeJobs(store, { neverFinish: 1 });
    const service = createFlowService({ store, jobs, pollMs: 2, maxStepMs: 40 });
    const flow = await service.create({ name: "x", steps: [goodSteps[0]], createdBy: "owner-1" });

    await expect(service.run(flow.id, "viewer-1", { role: "viewer" })).rejects.toThrow(/Viewers cannot run flows/);

    store.getSetting = () => "always-password";
    await expect(service.run(flow.id, "owner-1", { role: "owner" })).rejects.toThrow(/always ask/);
    store.getSetting = () => null;

    const first = service.run(flow.id, "owner-1", { role: "owner" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(service.run(flow.id, "owner-1", { role: "owner" })).rejects.toThrow(/already running/);
    await expect(first).rejects.toThrow(/time budget/);
    // and once the stuck run has been declared dead, the record says what is actually known:
    // not "failed" (the job may still be running), not a stale "running step 1".
    expect(store.getFlow(flow.id).lastResult).toMatch(/lost sight of step 1 .*time budget/);
  });

  it("records which step is running as it goes, so a watcher and a crash both see the truth", async () => {
    const store = fakeStore();
    const seen = [];
    const original = store.markFlowRun.bind(store);
    store.markFlowRun = (id, record) => { seen.push(record.result); original(id, record); };
    const service = createFlowService({ store, jobs: fakeJobs(store), pollMs: 2 });
    const flow = await service.create({ name: "nightly", steps: [goodSteps[0], goodSteps[1]], createdBy: "owner-1" });
    await service.run(flow.id, "owner-1", { role: "owner" });
    expect(seen[0]).toMatch(/^running step 1 of 2 /);
    expect(seen[1]).toMatch(/^running step 2 of 2 /);
    expect(seen.at(-1)).toBe("completed");
    // Each progress record already carries the job ids created so far, so the page can show
    // the earlier steps' terminals while a later step is still running.
    expect(store.getFlow(flow.id).lastJobIds).toHaveLength(2);
  });

  it("hands a named step's result to the steps after it", async () => {
    const store = fakeStore();
    const jobs = fakeJobs(store, { results: { 1: { app: "immich", sizeBytes: 4096 } } });
    const service = createFlowService({ store, jobs, pollMs: 2 });
    const flow = await service.create({
      name: "chained",
      steps: [
        { operationId: "host.snapshot.create", parameters: {}, name: "snapshot" },
        { operationId: "app.backup", parameters: { id: "{{ steps.snapshot.app }}", keep: 3 } },
      ],
      createdBy: "owner-1",
    });
    await service.run(flow.id, "owner-1", { role: "owner" });
    expect(jobs.calls[1].parameters).toEqual({ id: "immich", keep: 3 });
    expect(store.getFlow(flow.id).lastResult).toBe("completed");
  });

  it("stops the chain, with the reference named, when a result lacks what a step reads", async () => {
    const store = fakeStore();
    const jobs = fakeJobs(store, { results: { 1: { somethingElse: true } } });
    const service = createFlowService({ store, jobs, pollMs: 2 });
    const flow = await service.create({
      name: "chained",
      steps: [
        { operationId: "host.snapshot.create", parameters: {}, name: "snapshot" },
        { operationId: "app.backup", parameters: { id: "{{ steps.snapshot.artifact }}" } },
      ],
      createdBy: "owner-1",
    });
    await expect(service.run(flow.id, "owner-1", { role: "owner" })).rejects.toThrow(/steps\.snapshot\.artifact, which that step's recorded result does not contain/);
    expect(store.getFlow(flow.id).lastResult).toMatch(/failed at step 2 .*does not contain/);
    // the first step ran and stands; only the reference's own step was refused
    expect(jobs.calls).toHaveLength(1);
  });

  it("refuses names and references that could not mean anything at save time", async () => {
    expect(validateFlow({ name: "x", steps: [{ ...goodSteps[0], name: "Bad Name" }] })).toMatch(/lowercase letters, digits and dashes/);
    expect(validateFlow({ name: "x", steps: [{ ...goodSteps[0], name: "twin" }, { ...goodSteps[1], name: "twin" }] })).toMatch(/already named twin/);
    expect(validateFlow({ name: "x", steps: [
      { operationId: "app.backup", parameters: { id: "{{ steps.later.value }}" } },
      { ...goodSteps[0], name: "later" },
    ] })).toMatch(/step 1 reads steps\.later, which is not the name of an earlier step/);
    // a required field fed by a reference sits out save-time validation; the rest is still checked
    expect(validateFlow({ name: "x", steps: [
      { ...goodSteps[0], name: "backup" },
      { operationId: "app.backup", parameters: { id: "{{ steps.backup.checksum }}" } },
    ] })).toBeNull();
    expect(validateFlow({ name: "x", steps: [
      { ...goodSteps[0], name: "backup" },
      { operationId: "app.backup", parameters: { id: "immich", nonsense: "{{ steps.backup.checksum }}" } },
    ] })).toMatch(/does not accept parameter "nonsense"/);
  });

  it("a step marked continue records its failure and lets the chain finish", async () => {
    const store = fakeStore();
    const jobs = fakeJobs(store, { failAt: 1 });
    const notified = [];
    const service = createFlowService({ store, jobs, pollMs: 2, notify: (message) => notified.push(message) });
    const flow = await service.create({ name: "belt", steps: [{ ...goodSteps[0], onFailure: "continue" }, goodSteps[1]], createdBy: "owner-1" });
    const outcome = await service.run(flow.id, "owner-1", { role: "owner" });
    expect(outcome.completed).toBe(true);
    expect(jobs.calls).toHaveLength(2);                       // the second step still ran
    expect(store.getFlow(flow.id).lastResult).toMatch(/^completed with problems: step 1 .*failed/);
    expect(notified).toEqual([]);                             // the failed job's own push carries the news
  });

  it("a false condition skips the step, which holds its place in the run", async () => {
    const store = fakeStore();
    const jobs = fakeJobs(store, { results: { 1: { rebootRequired: false, count: 4 } } });
    const service = createFlowService({ store, jobs, pollMs: 2 });
    const flow = await service.create({
      name: "conditional",
      steps: [
        { operationId: "host.snapshot.create", parameters: {}, name: "check" },
        { operationId: "app.backup", parameters: { id: "immich" }, when: { value: "{{ steps.check.rebootRequired }}" } },
        { operationId: "controller.backup.create", parameters: {} },
      ],
      createdBy: "owner-1",
    });
    await service.run(flow.id, "owner-1", { role: "owner" });
    const saved = store.getFlow(flow.id);
    expect(saved.lastResult).toBe("completed (1 step skipped by condition)");
    expect(saved.lastJobIds).toEqual(["job-1", null, "job-2"]);   // the skipped step holds its place
    expect(jobs.calls.map((call) => call.operationId)).toEqual(["host.snapshot.create", "controller.backup.create"]);
  });

  it("a condition can compare against a value, and a broken reference fails loudly", async () => {
    const store = fakeStore();
    const jobs = fakeJobs(store, { results: { 1: { count: 4 } } });
    const notified = [];
    const service = createFlowService({ store, jobs, pollMs: 2, notify: (message) => notified.push(message) });
    const flow = await service.create({
      name: "picky",
      steps: [
        { operationId: "host.snapshot.create", parameters: {}, name: "check" },
        { operationId: "controller.backup.create", parameters: {}, when: { value: "{{ steps.check.count }}", equals: 4 } },
      ],
      createdBy: "owner-1",
    });
    await service.run(flow.id, "owner-1", { role: "owner" });
    expect(jobs.calls).toHaveLength(2);                       // equals matched, the step ran

    const broken = await service.create({
      name: "typo",
      steps: [
        { operationId: "host.snapshot.create", parameters: {}, name: "check" },
        { operationId: "controller.backup.create", parameters: {}, when: { value: "{{ steps.check.nothing }}" } },
      ],
      createdBy: "owner-1",
    });
    await expect(service.run(broken.id, "owner-1", { role: "owner" })).rejects.toThrow(/its condition it reads steps\.check\.nothing/);
    expect(store.getFlow(broken.id).lastResult).toMatch(/failed at step 2 .*condition/);
    expect(notified).toHaveLength(1);                         // no job carries this failure; the flow tells
  });

  it("refuses a condition that reads a later step, a bad onFailure, and a mangled when", () => {
    expect(validateFlow({ name: "x", steps: [{ ...goodSteps[0], onFailure: "retry" }] })).toMatch(/onFailure is either stop or continue/);
    expect(validateFlow({ name: "x", steps: [{ ...goodSteps[0], when: { value: "{{ steps.later.x }}" } }, { ...goodSteps[1], name: "later" }] })).toMatch(/not the name of an earlier step/);
    expect(validateFlow({ name: "x", steps: [{ ...goodSteps[0], name: "a" }, { ...goodSteps[1], when: { value: "before {{ steps.a.x }}" } }] })).toMatch(/exactly one/);
    expect(validateFlow({ name: "x", steps: [{ ...goodSteps[0], name: "a" }, { ...goodSteps[1], when: { value: "{{ steps.a.x }}", equals: { deep: true } } }] })).toMatch(/plain value/);
    expect(validateFlow({ name: "x", steps: [{ ...goodSteps[0], name: "a" }, { ...goodSteps[1], when: { value: "{{ steps.a.x }}", equals: "ok" }, onFailure: "continue" }] })).toBeNull();
  });

  it("a flow wired after another runs when it completes, under its own creator's authority", async () => {
    const store = fakeStore();
    const jobs = fakeJobs(store);
    const service = createFlowService({ store, jobs, pollMs: 2 });
    const first = await service.create({ name: "backup", steps: [goodSteps[0]], createdBy: "owner-1" });
    await service.create({ name: "mirror", steps: [goodSteps[1]], createdBy: "operator-7", triggerFlowId: first.id });
    await service.run(first.id, "owner-1", { role: "owner" });
    expect(jobs.calls.map((call) => [call.operationId, call.actorId])).toEqual([
      ["controller.backup.create", "owner-1"],
      ["host.snapshot.create", "operator-7"],           // the follower's own authority, not the runner's
    ]);
    expect([...store.flows.values()].map((flow) => flow.lastResult)).toEqual(["completed", "completed"]);
  });

  it("a follower's refusal is recorded and notified on the follower, never on the finished flow", async () => {
    const store = fakeStore();
    store.findOwnerById = (id) => ({ id, username: id, role: id.startsWith("viewer") ? "viewer" : "owner" });
    const notified = [];
    const service = createFlowService({ store, jobs: fakeJobs(store), pollMs: 2, notify: (message) => notified.push(message) });
    const first = await service.create({ name: "backup", steps: [goodSteps[0]], createdBy: "owner-1" });
    await service.create({ name: "mirror", steps: [goodSteps[1]], createdBy: "viewer-9", triggerFlowId: first.id });
    await service.run(first.id, "owner-1", { role: "owner" });
    const [parent, follower] = [...store.flows.values()];
    expect(parent.lastResult).toBe("completed");
    expect(follower.lastResult).toMatch(/skipped: viewer-9 can no longer approve/);
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatch(/mirror was due to run after another flow/);
  });

  it("refuses a trigger loop, a missing flow, and triggering itself", async () => {
    const store = fakeStore();
    const service = createFlowService({ store, jobs: fakeJobs(store), pollMs: 2 });
    await expect(service.create({ name: "orphan", steps: [goodSteps[0]], createdBy: "o", triggerFlowId: "flow-99" })).rejects.toThrow(/does not exist/);
    const a = await service.create({ name: "a", steps: [goodSteps[0]], createdBy: "o" });
    const b = await service.create({ name: "b", steps: [goodSteps[0]], createdBy: "o", triggerFlowId: a.id });
    await expect(service.update(a.id, { triggerFlowId: b.id }, "o", { role: "owner" })).rejects.toThrow(/loop/);
    await expect(service.update(a.id, { triggerFlowId: a.id }, "o", { role: "owner" })).rejects.toThrow(/loop/);
  });

  it("a transient step failure is retried, and the record says which attempt counted", async () => {
    const store = fakeStore();
    const jobs = fakeJobs(store, { failAt: 1 });                       // first job fails, second succeeds
    const service = createFlowService({ store, jobs, pollMs: 2, retryDelayMs: 2 });
    const flow = await service.create({ name: "stubborn", steps: [{ ...goodSteps[0], retry: 1 }], createdBy: "owner-1" });
    const outcome = await service.run(flow.id, "owner-1", { role: "owner" });
    expect(outcome.completed).toBe(true);
    expect(jobs.calls).toHaveLength(2);                                // one retry, no more
    const saved = store.getFlow(flow.id);
    // A retry that saved the step is a footnote on success, not a problem: the run completed.
    expect(saved.lastResult).toMatch(/^completed \(step 1 .*succeeded on attempt 2 of 2\)/);
    expect(saved.lastJobIds).toEqual(["job-2"]);                       // the attempt that counted holds the slot
  });

  it("retries run out honestly, and cancellations are never retried", async () => {
    const store = fakeStore();
    const jobs = fakeJobs(store, { failAt: 1, alwaysFail: true });
    const service = createFlowService({ store, jobs, pollMs: 2, retryDelayMs: 2 });
    const flow = await service.create({ name: "doomed", steps: [{ ...goodSteps[0], retry: 2 }], createdBy: "owner-1" });
    await expect(service.run(flow.id, "owner-1", { role: "owner" })).rejects.toThrow(/after 3 attempts/);
    expect(jobs.calls).toHaveLength(3);
  });

  it("rewrites a record stranded by a restart to what is actually known", () => {
    const store = fakeStore();
    const notified = [];
    const service = createFlowService({ store, jobs: fakeJobs(store), pollMs: 2, notify: (message) => notified.push(message) });
    store.flows.set("flow-9", { id: "flow-9", name: "Update night", steps: [goodSteps[0]], createdBy: "owner-1", enabled: true, lastResult: "running step 2 of 3 (Install package updates)", lastJobIds: ["job-1", "job-2"], nextDueAt: null, triggerFlowId: null });
    store.flows.set("flow-10", { id: "flow-10", name: "Fine", steps: [goodSteps[0]], createdBy: "owner-1", enabled: true, lastResult: "completed", lastJobIds: ["job-3"], nextDueAt: null, triggerFlowId: null });
    expect(service.recover()).toBe(1);
    expect(store.flows.get("flow-9").lastResult).toMatch(/interrupted by a BoxPilot restart while running step 2 of 3.*later steps did not run/);
    expect(store.flows.get("flow-9").lastJobIds).toEqual(["job-1", "job-2"]);   // what ran is kept
    expect(store.flows.get("flow-10").lastResult).toBe("completed");
    expect(notified).toHaveLength(1);
  });

  it("a condition reading a step that never finished cascades the skip instead of failing", async () => {
    const store = fakeStore();
    const jobs = fakeJobs(store, { failAt: 1, alwaysFail: false, results: {} });
    const service = createFlowService({ store, jobs, pollMs: 2 });
    // Step 1 fails but the flow keeps going; step 2 reads step 1's result; step 3 is unconditional.
    const flow = await service.create({
      name: "cascade",
      steps: [
        { operationId: "host.snapshot.create", parameters: {}, name: "check", onFailure: "continue" },
        { operationId: "app.backup", parameters: { id: "immich" }, when: { value: "{{ steps.check.artifact }}" } },
        { operationId: "controller.backup.create", parameters: {} },
      ],
      createdBy: "owner-1",
    });
    const outcome = await service.run(flow.id, "owner-1", { role: "owner" });
    expect(outcome.completed).toBe(true);
    expect(store.getFlow(flow.id).lastJobIds).toEqual(["job-1", null, "job-2"]);
    // A missing FIELD on a step that finished still fails loudly (typo protection unchanged);
    // pinned by the earlier "broken reference fails loudly" test.
  });

  it("a saved chain always runs to its end: saving and running share one depth limit", async () => {
    const store = fakeStore();
    const jobs = fakeJobs(store);
    const service = createFlowService({ store, jobs, pollMs: 2 });
    let previous = null;
    const saved = [];
    for (let index = 0; index < 12; index += 1) {
      try {
        previous = await service.create({ name: `link-${index}`, steps: [goodSteps[0]], createdBy: "owner-1", triggerFlowId: previous?.id ?? null });
        saved.push(previous);
      } catch (error) {
        expect(error.message).toMatch(/chain at most 8 deep/);
        break;
      }
    }
    expect(saved.length).toBeLessThan(12);                    // the limit exists
    await service.run(saved[0].id, "owner-1", { role: "owner" });
    // The contract: nothing that saved may silently not run. Every link in the chain fired.
    for (const flow of saved) expect(store.getFlow(flow.id).lastResult).toBe("completed");
  });

  it("deleting a flow detaches its followers instead of stranding them", async () => {
    const store = fakeStore();
    store.deleteFlow = function (id) {
      for (const flow of store.flows.values()) if (flow.triggerFlowId === id) flow.triggerFlowId = null;
      if (!store.flows.delete(id)) throw new Error("Flow not found");
    };
    const service = createFlowService({ store, jobs: fakeJobs(store), pollMs: 2 });
    const a = await service.create({ name: "a", steps: [goodSteps[0]], createdBy: "owner-1" });
    const b = await service.create({ name: "b", steps: [goodSteps[0]], createdBy: "owner-1", triggerFlowId: a.id });
    service.remove(a.id, "owner-1", { role: "owner" });
    expect(store.flows.get(b.id).triggerFlowId).toBeNull();
    // And a legacy dangling link mid-chain no longer poisons saving a new follower.
    store.flows.get(b.id).triggerFlowId = "flow-ghost";
    await expect(service.create({ name: "c", steps: [goodSteps[0]], createdBy: "owner-1", triggerFlowId: b.id })).resolves.toMatchObject({ name: "c" });
  });

  it("a webhook fires its one flow under the creator's authority, and nothing else", async () => {
    const store = fakeStore();
    const jobs = fakeJobs(store);
    let clockMs = Date.parse("2026-08-28T01:00:00Z");
    const service = createFlowService({ store, jobs, pollMs: 2, now: () => new Date(clockMs) });
    const flow = await service.create({ name: "hooked", steps: [goodSteps[0]], createdBy: "operator-7" });
    const { token } = service.mintWebhook(flow.id, "operator-7", { role: "operator" });
    expect(token.length).toBeGreaterThan(30);
    // Only the hash is stored; the token itself exists nowhere in the store.
    expect(JSON.stringify([...store.flows.values()])).not.toContain(token);

    expect(service.fireWebhook(flow.id, token, { source: "192.168.1.50" })).toBe("accepted");
    await new Promise((resolve) => setTimeout(resolve, 25));                    // the run is fire-and-record
    expect(store.getFlow(flow.id).lastResult).toBe("completed");
    expect(jobs.calls[0].actorId).toBe("operator-7");                           // the creator, not the caller
    expect(store.audits.some((entry) => entry.event === "flow.webhook-fired" && entry.details.source === "192.168.1.50")).toBe(true);

    // A wrong token, a flow without a webhook, and a missing flow all answer identically.
    expect(service.fireWebhook(flow.id, "not-the-token")).toBe("not-found");
    const bare = await service.create({ name: "bare", steps: [goodSteps[0]], createdBy: "owner-1" });
    expect(service.fireWebhook(bare.id, token)).toBe("not-found");
    expect(service.fireWebhook("flow-ghost", token)).toBe("not-found");

    // The limit holds per flow per minute, and releases as the clock moves.
    for (let index = 0; index < 5; index += 1) service.fireWebhook(flow.id, token);
    expect(service.fireWebhook(flow.id, token)).toBe("rate-limited");
    clockMs += 61_000;
    expect(service.fireWebhook(flow.id, token)).toBe("accepted");

    service.clearWebhook(flow.id, "operator-7", { role: "operator" });
    expect(service.fireWebhook(flow.id, token)).toBe("not-found");
  });

  it("a webhook fire that the creator can no longer authorize is recorded and notified", async () => {
    const store = fakeStore();
    store.findOwnerById = (id) => ({ id, username: id, role: "viewer" });
    const notified = [];
    const service = createFlowService({ store, jobs: fakeJobs(store), pollMs: 2, notify: (message) => notified.push(message) });
    const flow = await service.create({ name: "demoted", steps: [goodSteps[0]], createdBy: "viewer-9" });
    const { token } = service.mintWebhook(flow.id, "viewer-9", { role: "owner" });
    expect(service.fireWebhook(flow.id, token)).toBe("accepted");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(store.getFlow(flow.id).lastResult).toMatch(/skipped: viewer-9 can no longer approve/);
    expect(notified[0]).toMatch(/demoted was fired by its webhook but did not run/);
  });

  it("only the creator or an owner may change or remove a flow", async () => {
    const store = fakeStore();
    const service = createFlowService({ store, jobs: fakeJobs(store), pollMs: 2 });
    const flow = await service.create({ name: "mine", steps: [goodSteps[0]], createdBy: "operator-1" });

    await expect(service.update(flow.id, { name: "taken" }, "operator-2", { role: "operator" })).rejects.toThrow(/creator or an owner/);
    expect(() => service.remove(flow.id, "operator-2", { role: "operator" })).toThrow(/creator or an owner/);
    await service.update(flow.id, { name: "renamed" }, "owner-1", { role: "owner" });
    expect(store.getFlow(flow.id).name).toBe("renamed");
    service.remove(flow.id, "operator-1", { role: "operator" });
    expect(store.getFlow(flow.id)).toBeNull();
  });
});

describe("the step palette", () => {
  it("offers exactly the operations that need no form: every field optional, never high, never read-only", async () => {
    const store = fakeStore();
    const service = createFlowService({ store, jobs: fakeJobs(store) });
    const palette = service.stepPalette();
    const ids = palette.map((step) => step.operationId);
    expect(ids).toContain("apt.upgrade");
    expect(ids).toContain("host.snapshot.create");
    expect(ids).not.toContain("storage.format"); // high
    expect(ids).not.toContain("app.backup"); // requires an app id
    expect(ids).not.toContain("app.inspect"); // read-only
    expect(palette.every((step) => step.title && step.risk)).toBe(true);
  });
});

describe("a flow on the clock", () => {
  const at = (iso) => () => new Date(iso);

  it("stores a schedule the scheduler itself would accept, with the next firing computed", async () => {
    const store = fakeStore();
    const service = createFlowService({ store, jobs: fakeJobs(store), pollMs: 2, now: at("2026-08-26T10:00:00.000Z") });
    const flow = await service.create({ name: "Update night", steps: goodSteps, createdBy: "owner-1", cadence: { frequency: "weekly", minute: 0, hour: 3, weekday: 0 } });
    expect(flow.frequency).toBe("weekly");
    // Cadences are local wall-clock times, which is what an owner means by "3am"; the scheduler's
    // own tests own computeNextRun's arithmetic, so this only pins that flows store its answer.
    const expected = computeNextRun({ frequency: "weekly", minute: 0, hour: 3, weekday: 0 }, new Date("2026-08-26T10:00:00.000Z"));
    expect(flow.nextDueAt).toBe(expected.toISOString());
    expect(new Date(flow.nextDueAt).getDay()).toBe(0);
    expect(new Date(flow.nextDueAt) > new Date("2026-08-26T10:00:00.000Z")).toBe(true);
    await expect(service.create({ name: "x", steps: goodSteps, createdBy: "owner-1", cadence: { frequency: "sometimes", minute: 0 } })).rejects.toThrow();
  });

  it("runs a due flow under its creator's authority and advances the clock first", async () => {
    const store = fakeStore();
    const jobs = fakeJobs(store);
    const service = createFlowService({ store, jobs, pollMs: 2, now: at("2026-08-30T03:00:30.000Z") });
    const flow = await service.create({ name: "Update night", steps: [goodSteps[0]], createdBy: "owner-1", cadence: { frequency: "weekly", minute: 0, hour: 3, weekday: 0 } });
    store.flows.get(flow.id).nextDueAt = "2026-08-30T03:00:00.000Z";

    const fired = await service.tick();
    expect(fired).toBe(1);
    expect(jobs.calls[0]).toMatchObject({ operationId: "controller.backup.create", actorId: "owner-1", role: "owner" });
    expect(store.getFlow(flow.id).lastResult).toBe("completed");
    // advanced beyond the firing time, so a slow run cannot fire again next tick
    expect(store.getFlow(flow.id).nextDueAt > "2026-08-30T03:00:30.000Z").toBe(true);
    expect(store.audits.some((audit) => audit.event === "flow.scheduled-run")).toBe(true);
  });

  it("skips rather than runs when the creator can no longer approve jobs", async () => {
    const store = fakeStore();
    const jobs = fakeJobs(store);
    const service = createFlowService({ store, jobs, pollMs: 2, now: at("2026-08-30T03:01:00.000Z") });
    const flow = await service.create({ name: "x", steps: [goodSteps[0]], createdBy: "viewer-9", cadence: { frequency: "daily", minute: 0, hour: 3 } });
    store.flows.get(flow.id).nextDueAt = "2026-08-30T03:00:00.000Z";

    await service.tick();
    expect(jobs.calls).toEqual([]);
    expect(store.getFlow(flow.id).lastResult).toMatch(/skipped: viewer-9 can no longer approve/);
    expect(store.audits.some((audit) => audit.event === "flow.skipped")).toBe(true);
  });

  it("does not fire a disabled flow, and re-enabling reckons the clock afresh", async () => {
    const store = fakeStore();
    const jobs = fakeJobs(store);
    const service = createFlowService({ store, jobs, pollMs: 2, now: at("2026-09-15T10:00:00.000Z") });
    const flow = await service.create({ name: "x", steps: [goodSteps[0]], createdBy: "owner-1", cadence: { frequency: "weekly", minute: 0, hour: 3, weekday: 0 } });
    store.flows.get(flow.id).nextDueAt = "2026-08-30T03:00:00.000Z"; // a month overdue
    await service.update(flow.id, { enabled: false }, "owner-1", { role: "owner" });
    expect(await service.tick()).toBe(0);

    await service.update(flow.id, { enabled: true }, "owner-1", { role: "owner" });
    // the missed Sundays are not made up; the next firing is in the future
    expect(store.getFlow(flow.id).nextDueAt > "2026-09-15T10:00:00.000Z").toBe(true);
    expect(await service.tick()).toBe(0);
  });
});
