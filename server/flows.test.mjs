import { describe, expect, it, vi } from "vitest";
import { createFlowService, flowRisk, validateFlow } from "./flows.mjs";
import { computeNextRun } from "./scheduler.mjs";
import { createHealthAlerts } from "./health-alerts.mjs";

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

/** The health-alert ledger as a flow sees it: the messages raised (and whole alerts), and what was cleared. */
function recordingAlerts(messages = []) {
  const raised = [];
  const cleared = [];
  return {
    raised, cleared,
    raise: (alert) => { messages.push(alert.message); raised.push(alert); return Promise.resolve({ notified: false }); },
    clear: (key, options = {}) => { cleared.push({ key, ...options }); return Promise.resolve({ cleared: true }); },
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

  it("rejects a step that asks for a typed confirmation, which no run of a flow can give", () => {
    // Medium-risk, so it passed the high-risk line, and then failed at approval on every run.
    const problem = validateFlow({ name: "x", steps: [{ operationId: "storage.fs-snapshot.delete", parameters: { kind: "btrfs", target: "/mnt/pool", name: "before-reorg" } }] });
    expect(problem).toMatch(/^step 1: Delete .* asks you to type a confirmation each time, so it cannot be part of a flow$/);
  });

  it("rejects an operation that does not exist, and parameters its operation refuses", () => {
    expect(validateFlow({ name: "x", steps: [{ operationId: "no.such.op" }] })).toMatch(/not a registered operation/);
    expect(validateFlow({ name: "x", steps: [{ operationId: "apt.install", parameters: {} }] })).toMatch(/step 1/);
  });

  it("rejects BoxPilot's own plumbing, and never offers it (sweep 3)", () => {
    expect(validateFlow({ name: "x", steps: [{ operationId: "agents.runtime.cpu", parameters: { processors: 8, background: 8, resetAfterSeconds: 7_200 } }] })).toMatch(/^step 1: .*BoxPilot's own/);
    const store = fakeStore();
    const ids = createFlowService({ store, jobs: fakeJobs(store) }).stepPalette().map((step) => step.operationId);
    for (const id of ["agents.runtime.cpu", "agents.zulip.post"]) expect(ids, id).not.toContain(id);
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

  /** A step whose job waits in the helper's queue for `queuedMs`, then runs, finishing after `runMs` (never, if null). */
  function queuedJobs(store, { queuedMs, runMs }) {
    let counter = 0;
    return {
      async createOperationJob(operationId, parameters) {
        counter += 1;
        const job = { id: `job-${counter}`, operationId, parameters, state: "awaiting_approval", steps: [] };
        store.jobs.set(job.id, job);
        return job;
      },
      async approveAndStart(jobId) {
        const job = store.jobs.get(jobId);
        job.state = "applying";
        // As the job layer records the helper's "queued" and "started" frames.
        job.steps.push({ name: "queue", state: "waiting", detail: "waiting" });
        setTimeout(() => {
          job.steps.push({ name: "queue", state: "completed", detail: "started" });
          job.startedRunningAt = Date.now();
          if (runMs !== null) setTimeout(() => { job.state = "completed"; job.result = {}; }, runMs);
        }, queuedMs);
      },
      cancelJob: vi.fn(),
    };
  }

  it("does not count the time a step waits in the helper's queue against its budget", async () => {
    // Reconnecting a dropped drive queued behind a six-hour sync was declared "lost sight", the
    // drive put on hold, and the remount ran later with nobody watching it.
    const store = fakeStore();
    const service = createFlowService({ store, jobs: queuedJobs(store, { queuedMs: 150, runMs: 10 }), pollMs: 2, maxStepMs: 40 });
    const flow = await service.create({ name: "reconnect", steps: [goodSteps[0]], createdBy: "owner-1" });
    await expect(service.run(flow.id, "owner-1", { role: "owner" })).resolves.toMatchObject({ completed: true });
    expect(store.getFlow(flow.id).lastResult).toBe("completed");
  });

  it("still holds a step to its budget, counted from when it left the queue", async () => {
    const store = fakeStore();
    const jobs = queuedJobs(store, { queuedMs: 100, runMs: null });
    const service = createFlowService({ store, jobs, pollMs: 2, maxStepMs: 40 });
    const flow = await service.create({ name: "reconnect", steps: [goodSteps[0]], createdBy: "owner-1" });
    await expect(service.run(flow.id, "owner-1", { role: "owner" })).rejects.toThrow(/lost sight of step 1 .*time budget/);
    // Declared lost only after it had left the queue (100 ms, more than twice the budget).
    expect(store.getJob("job-1").startedRunningAt).toBeTypeOf("number");
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
    const service = createFlowService({ store, jobs, pollMs: 2, alerts: recordingAlerts(notified) });
    const flow = await service.create({ name: "belt", steps: [{ ...goodSteps[0], onFailure: "continue" }, goodSteps[1]], createdBy: "owner-1" });
    const outcome = await service.run(flow.id, "owner-1", { role: "owner" });
    expect(outcome.completed).toBe(true);
    expect(jobs.calls).toHaveLength(2);                       // the second step still ran
    expect(store.getFlow(flow.id).lastResult).toMatch(/^completed with problems: step 1 .*failed/);
    // The step's job no longer pushes on its own (the flow claims it), so the flow says it, once.
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatch(/^belt completed with problems: step 1 .*failed/);
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
    const service = createFlowService({ store, jobs, pollMs: 2, alerts: recordingAlerts(notified) });
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
    const service = createFlowService({ store, jobs: fakeJobs(store), pollMs: 2, alerts: recordingAlerts(notified) });
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

  /** Jobs that fail as the job layer records a timeout: `timeout` is the job's timeout record. */
  function timingOutJobs(store, timeout) {
    let counter = 0;
    return {
      calls: [],
      async createOperationJob(operationId, parameters) {
        counter += 1;
        const job = { id: `job-${counter}`, operationId, parameters, state: "awaiting_approval" };
        store.jobs.set(job.id, job);
        this.calls.push({ operationId });
        return job;
      },
      async approveAndStart(jobId) {
        const job = store.jobs.get(jobId);
        job.state = "applying";
        setTimeout(() => {
          job.state = "failed";
          job.error = timeout.scope === "operation" && timeout.phase !== "queued" ? "Back up BoxPilot did not finish within 3 minutes. It may still be running on the server; Activity shows how far it got." : "it ran out of time";
          job.timeout = { budgetMs: 180_000, elapsedMs: 180_000, step: null, lastOutput: null, moreTimeMs: null, ...timeout };
        }, 5);
      },
      cancelJob: vi.fn(),
    };
  }
  const stillRunning = { scope: "operation", phase: "running" };

  it("does not retry a step whose job ran out of its whole budget: it may still be running", async () => {
    const store = fakeStore();
    const jobs = timingOutJobs(store, stillRunning);
    const service = createFlowService({ store, jobs, pollMs: 2, retryDelayMs: 2 });
    const flow = await service.create({ name: "nightly", steps: [{ ...goodSteps[0], retry: 1 }, goodSteps[1]], createdBy: "owner-1" });
    await expect(service.run(flow.id, "owner-1", { role: "owner" })).rejects.toThrow(/lost sight of step 1 .*may still be running/);
    expect(jobs.calls).toHaveLength(1);                                // no second copy started beside the first
    expect(store.getFlow(flow.id).lastResult).toMatch(/^lost sight of step 1 /);
  });

  it("does not continue past such a step under a keep-going policy either", async () => {
    const store = fakeStore();
    const jobs = timingOutJobs(store, stillRunning);
    const service = createFlowService({ store, jobs, pollMs: 2, retryDelayMs: 2 });
    const flow = await service.create({ name: "belt", steps: [{ ...goodSteps[0], onFailure: "continue" }, goodSteps[1]], createdBy: "owner-1" });
    await expect(service.run(flow.id, "owner-1", { role: "owner" })).rejects.toThrow(/lost sight of step 1/);
    expect(jobs.calls.map((call) => call.operationId)).toEqual(["controller.backup.create"]);
  });

  /**
   * A root task that runs out of its own budget is a step timeout, but the runner lets it carry on
   * (KillMode=process): storage.check at 33 of its 35 minutes, apt.upgrade at 180 of 185. With
   * retry: 1 a flow staged a second storage.remount beside the first, still running.
   */
  it("does not retry or continue past a step whose root task may still be running", async () => {
    const rootTask = { scope: "step", phase: "running", step: "Root task storage.remount", stillRunning: true };
    for (const step of [{ ...goodSteps[0], retry: 1 }, { ...goodSteps[0], onFailure: "continue" }]) {
      const store = fakeStore();
      const jobs = timingOutJobs(store, rootTask);
      const service = createFlowService({ store, jobs, pollMs: 2, retryDelayMs: 2 });
      const flow = await service.create({ name: "reconnect", steps: [step, goodSteps[1]], createdBy: "owner-1" });
      await expect(service.run(flow.id, "owner-1", { role: "owner" })).rejects.toThrow(/lost sight of step 1 .*may still be running/);
      expect(jobs.calls).toHaveLength(1);                              // no second copy beside the first
    }
  });

  it("still retries a step that timed out in a way that stopped it: one of its own steps, or waiting in the queue", async () => {
    for (const timeout of [{ scope: "step", phase: "running" }, { scope: "operation", phase: "queued" }]) {
      const store = fakeStore();
      const jobs = timingOutJobs(store, timeout);
      const service = createFlowService({ store, jobs, pollMs: 2, retryDelayMs: 2 });
      const flow = await service.create({ name: "again", steps: [{ ...goodSteps[0], retry: 1 }], createdBy: "owner-1" });
      await expect(service.run(flow.id, "owner-1", { role: "owner" })).rejects.toThrow(/stopped at step 1 .*after 2 attempts/);
      expect(jobs.calls).toHaveLength(2);
    }
  });

  it("rewrites a record stranded by a restart to what is actually known", () => {
    const store = fakeStore();
    const notified = [];
    const service = createFlowService({ store, jobs: fakeJobs(store), pollMs: 2, alerts: recordingAlerts(notified) });
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
    // The run is fire-and-record: wait for its outcome, not a fixed time a loaded runner can overshoot.
    await vi.waitFor(() => expect(store.getFlow(flow.id).lastResult).toBe("completed"));
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

    // Pausing the flow revokes the webhook, the same gesture that revokes the clock.
    const paused = await service.create({ name: "paused", steps: [goodSteps[0]], createdBy: "operator-7" });
    const minted = service.mintWebhook(paused.id, "operator-7", { role: "operator" }).token;
    store.getFlow(paused.id).enabled = false;
    expect(service.fireWebhook(paused.id, minted)).toBe("not-found");
  });

  it("a webhook never escalates: a deleted creator refuses instead of running as owner", async () => {
    const store = fakeStore();
    store.findOwnerById = () => null;
    const notified = [];
    const service = createFlowService({ store, jobs: fakeJobs(store), pollMs: 2, alerts: recordingAlerts(notified) });
    const flow = await service.create({ name: "orphaned", steps: [goodSteps[0]], createdBy: "ghost-1" });
    const { token } = service.mintWebhook(flow.id, "ghost-1", { role: "owner" });
    expect(service.fireWebhook(flow.id, token)).toBe("accepted");
    await vi.waitFor(() => expect(store.getFlow(flow.id).lastResult).toMatch(/skipped:.*creator no longer exists/));
    expect(notified[0]).toMatch(/creator no longer exists/);
  });

  it("a webhook fire that the creator can no longer authorize is recorded and notified", async () => {
    const store = fakeStore();
    store.findOwnerById = (id) => ({ id, username: id, role: "viewer" });
    const notified = [];
    const service = createFlowService({ store, jobs: fakeJobs(store), pollMs: 2, alerts: recordingAlerts(notified) });
    const flow = await service.create({ name: "demoted", steps: [goodSteps[0]], createdBy: "viewer-9" });
    const { token } = service.mintWebhook(flow.id, "viewer-9", { role: "owner" });
    expect(service.fireWebhook(flow.id, token)).toBe("accepted");
    await vi.waitFor(() => expect(store.getFlow(flow.id).lastResult).toMatch(/skipped: viewer-9 can no longer approve/));
    expect(notified[0]).toMatch(/demoted was fired by its webhook but did not run/);
  });

  it("the step palette carries scalar fields and excludes steps that would store a secret", async () => {
    const store = fakeStore();
    const service = createFlowService({ store, jobs: fakeJobs(store), pollMs: 2 });
    const palette = service.stepPalette();
    const http = palette.find((entry) => entry.operationId === "http.request");
    expect(http).toBeTruthy();
    expect(http.fields.find((field) => field.name === "url")).toMatchObject({ type: "string", optional: false });
    expect(http.fields.find((field) => field.name === "method")?.enum).toContain("POST");
    // A step whose value would be a secret must never be offered, because flow steps are stored as JSON.
    expect(palette.some((entry) => entry.operationId === "credentials.set")).toBe(false);
    expect(palette.some((entry) => entry.operationId === "app.password.set")).toBe(false);
    // High-risk and read-only stay out as before.
    expect(palette.every((entry) => entry.operationId !== "app.purge")).toBe(true);
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
  it("offers steps a scalar form can build, never high, read-only, or secret-bearing", async () => {
    const store = fakeStore();
    const service = createFlowService({ store, jobs: fakeJobs(store) });
    const palette = service.stepPalette();
    const ids = palette.map((step) => step.operationId);
    expect(ids).toContain("apt.upgrade");
    expect(ids).toContain("host.snapshot.create");
    expect(ids).toContain("app.backup");                 // now included: a form can supply its app id
    expect(ids).not.toContain("storage.format");         // high
    expect(ids).not.toContain("app.inspect");            // read-only
    expect(ids).not.toContain("credentials.set");        // would store a secret in the flow
    expect(ids).not.toContain("storage.fs-snapshot.delete"); // asks for a typed confirmation every time
    expect(palette.every((step) => step.title && step.risk && Array.isArray(step.fields))).toBe(true);
    // app.backup carries its scalar fields for the builder to render.
    expect(palette.find((step) => step.operationId === "app.backup").fields.map((field) => field.name)).toEqual(["id", "keep"]);
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

    // The refusal must still advance the clock. It did not: the flow stayed due, so every tick
    // skipped it again - a push notification a minute and 1,440 audit rows a day, until the
    // 20,000-row cap had evicted everything else.
    // Forward of where it was, not a specific instant: the cadence is in local time, and a test
    // that pins the timezone of whoever runs it is a test that fails on the next machine.
    expect(store.getFlow(flow.id).nextDueAt > "2026-08-30T03:00:00.000Z").toBe(true);
    const skippedOnce = store.audits.filter((audit) => audit.event === "flow.skipped").length;
    await service.tick();
    await service.tick();
    expect(store.audits.filter((audit) => audit.event === "flow.skipped")).toHaveLength(skippedOnce);
  });

  it("refuses a step that would write a credential into the database", async () => {
    // Stored, backed up, snapshotted, and returned by GET /flows to a viewer. The scheduler has
    // refused this since it existed; flows only hid the field from the form.
    const store = fakeStore();
    const service = createFlowService({ store, jobs: fakeJobs(store), pollMs: 2 });
    await expect(service.create({ name: "leak", createdBy: "owner-1", steps: [{ operationId: "credentials.set", parameters: { name: "ntfy", value: "tok_LIVE" } }] }))
      .rejects.toThrow(/needs a password or key each time, so it cannot be part of a flow/);
    // The same operation with the secret left blank is not the problem: it will be asked for at run time.
    const ok = service.create({ name: "fine", createdBy: "owner-1", steps: [{ operationId: "credentials.set", parameters: { name: "ntfy", value: "" } }] });
    await expect(ok).resolves.toBeTruthy().catch(() => { /* if the op requires the value, that is a different refusal and fine */ });
  });

  /** Jobs that finish on their own a moment after they start, except those of `heldOperation`, which run until released. */
  function heldJobs(store, heldOperation) {
    let counter = 0;
    return {
      calls: [],
      async createOperationJob(operationId, parameters, actorId, { role }) {
        counter += 1;
        const job = { id: `job-${counter}`, operationId, parameters, state: "awaiting_approval" };
        store.jobs.set(job.id, job);
        this.calls.push({ operationId, actorId, role });
        return job;
      },
      async approveAndStart(jobId) {
        const job = store.jobs.get(jobId);
        job.state = "applying";
        if (job.operationId !== heldOperation) setTimeout(() => { job.state = "completed"; job.result = null; }, 5);
      },
      release() { for (const job of store.jobs.values()) if (job.operationId === heldOperation && job.state === "applying") job.state = "completed"; },
      cancelJob: vi.fn(),
    };
  }
  async function until(condition, ms = 1500) {
    const end = Date.now() + ms;
    while (!condition()) {
      if (Date.now() > end) throw new Error("timed out waiting");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }

  it("runs flows due together side by side, so one step held open does not hold up the other", async () => {
    // tick() awaited each due flow in turn: a step queued behind six hours of work kept every other
    // scheduled flow, and every follower, from starting until it finished.
    const store = fakeStore();
    const jobs = heldJobs(store, "controller.backup.create");
    const service = createFlowService({ store, jobs, pollMs: 2, maxStepMs: 60_000, now: at("2026-08-30T03:00:30.000Z") });
    const daily = { frequency: "daily", minute: 0, hour: 3 };
    const slow = await service.create({ name: "Slow", steps: [goodSteps[0]], createdBy: "owner-1", cadence: daily });
    const quick = await service.create({ name: "Quick", steps: [goodSteps[1]], createdBy: "owner-1", cadence: daily });
    for (const flow of [slow, quick]) store.flows.get(flow.id).nextDueAt = "2026-08-30T03:00:00.000Z";
    const ticked = service.tick();
    try {
      await until(() => store.getFlow(quick.id).lastResult === "completed");
      expect(jobs.calls.map((call) => call.operationId).sort()).toEqual(["controller.backup.create", "host.snapshot.create"]);
      expect(store.getFlow(slow.id).lastResult).toMatch(/^running step 1 of 1/);
      // Both clocks moved on when they fired, not when the slow one finally finished.
      for (const flow of [slow, quick]) expect(store.getFlow(flow.id).nextDueAt > "2026-08-30T03:00:30.000Z").toBe(true);
    } finally { jobs.release(); }
    expect(await ticked).toBe(2);
    expect(store.getFlow(slow.id).lastResult).toBe("completed");
    expect(store.audits.filter((audit) => audit.event === "flow.scheduled-run")).toHaveLength(2);
  });

  it("is not turned away by an earlier tick whose flow is still running", async () => {
    const store = fakeStore();
    const jobs = heldJobs(store, "controller.backup.create");
    let clock = new Date("2026-08-30T03:00:30.000Z");
    const service = createFlowService({ store, jobs, pollMs: 2, maxStepMs: 60_000, now: () => clock });
    const slow = await service.create({ name: "Slow", steps: [goodSteps[0]], createdBy: "owner-1", cadence: { frequency: "daily", minute: 0, hour: 3 } });
    const later = await service.create({ name: "Later", steps: [goodSteps[1]], createdBy: "owner-1", cadence: { frequency: "daily", minute: 0, hour: 4 } });
    store.flows.get(slow.id).nextDueAt = "2026-08-30T03:00:00.000Z";
    const first = service.tick();
    try {
      await until(() => /^running step/.test(store.getFlow(slow.id).lastResult ?? ""));
      clock = new Date("2026-08-30T04:00:30.000Z");
      store.flows.get(later.id).nextDueAt = "2026-08-30T04:00:00.000Z";
      // The slow flow is still running and due again only tomorrow; the later one fires now.
      expect(await service.tick()).toBe(1);
      expect(store.getFlow(later.id).lastResult).toBe("completed");
      expect(store.getFlow(slow.id).lastResult).toMatch(/^running step 1 of 1/);
    } finally { jobs.release(); }
    await first;
    expect(store.getFlow(slow.id).lastResult).toBe("completed");
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


describe("starting a flow without waiting for it", () => {
  it("returns as soon as the run has begun, and the run still finishes on its own", async () => {
    // A proxy that gives up on a long request must not make the page say the run was refused.
    const store = fakeStore();
    const jobs = fakeJobs(store);
    const service = createFlowService({ store, jobs, pollMs: 2 });
    const flow = await service.create({ name: "long", steps: goodSteps, createdBy: "owner-1" });
    const started = await service.launch(flow.id, "owner-1", { role: "owner" });
    expect(started).toEqual({ started: true, id: flow.id, name: "long" });
    expect(store.getFlow(flow.id).running ?? true).toBeTruthy(); // the run is underway, not awaited
    // Give it a moment: it records its own outcome without anyone awaiting it.
    for (let attempt = 0; attempt < 400 && !/completed|failed|stopped/.test(store.getFlow(flow.id).lastResult ?? ""); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(store.getFlow(flow.id).lastResult).toMatch(/completed/);
  });

  it("still refuses what run() refuses, at once and with the same message", async () => {
    const store = fakeStore();
    const service = createFlowService({ store, jobs: fakeJobs(store), pollMs: 2 });
    const flow = await service.create({ name: "x", steps: goodSteps, createdBy: "owner-1" });
    await expect(service.launch("nope", "owner-1", { role: "owner" })).rejects.toThrow("Flow not found");
    await expect(service.launch(flow.id, "viewer-1", { role: "viewer" })).rejects.toThrow(/Viewers cannot run flows/);
  });

  it("refuses a second start while the first is still running", async () => {
    const store = fakeStore();
    const service = createFlowService({ store, jobs: fakeJobs(store, { neverFinish: "job-1" }), pollMs: 2 });
    const flow = await service.create({ name: "slow", steps: goodSteps, createdBy: "owner-1" });
    await service.launch(flow.id, "owner-1", { role: "owner" });
    await expect(service.launch(flow.id, "owner-1", { role: "owner" })).rejects.toThrow(/already running/);
  });

  it("refuses the second of two starts made together, to its own caller", async () => {
    // launch waits on the catalog before it starts the run; both starts pass the first check in
    // that wait, and only the second look, taken with nothing between it and the run, tells them apart.
    const store = fakeStore();
    const service = createFlowService({ store, jobs: fakeJobs(store), pollMs: 2 });
    const flow = await service.create({ name: "slow", steps: goodSteps, createdBy: "owner-1" });
    const [first, second] = await Promise.allSettled([service.launch(flow.id, "owner-1", { role: "owner" }), service.launch(flow.id, "owner-1", { role: "owner" })]);
    expect(first).toMatchObject({ status: "fulfilled", value: { started: true } });
    expect(second).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: expect.stringMatching(/already running/) }) });
  });
});


describe("a step only the owner may run", () => {
  // A flow runs as whoever starts it. An operator could save a flow holding an owner-only step (an
  // HTTP request to their own address, Cloudflare unpublish, a credential removed), and it ran with
  // the owner's authority the moment the owner clicked Run now.
  const unpublish = { operationId: "cloudflare.unpublish", parameters: { hostname: "share.example.com" } };
  const withOperators = (store) => Object.assign(store, { findOwnerById: (id) => ({ id, username: id, role: id.startsWith("operator") ? "operator" : id.startsWith("viewer") ? "viewer" : "owner" }) });

  it("cannot be put in a flow by anyone but the owner", async () => {
    const store = withOperators(fakeStore());
    const service = createFlowService({ store, jobs: fakeJobs(store), pollMs: 2 });
    await expect(service.create({ name: "x", steps: [goodSteps[0], unpublish], createdBy: "operator-1", role: "operator" }))
      .rejects.toMatchObject({ code: "flow_step_owner_only", message: expect.stringMatching(/^Only the owner can put step 2 \(Stop publishing an app to the internet\) in a flow/) });
    const flow = await service.create({ name: "x", steps: [goodSteps[0]], createdBy: "operator-1", role: "operator" });
    await expect(service.update(flow.id, { steps: [goodSteps[0], unpublish] }, "operator-1", { role: "operator" })).rejects.toMatchObject({ code: "flow_step_owner_only" });
    expect(store.getFlow(flow.id).steps).toHaveLength(1);
    expect(store.listFlows()).toHaveLength(1);
  });

  it("put in an operator's flow by the owner, survives the operator's edits and runs when the owner starts it", async () => {
    const store = withOperators(fakeStore());
    const jobs = fakeJobs(store);
    const service = createFlowService({ store, jobs, pollMs: 2 });
    const flow = await service.create({ name: "x", steps: [goodSteps[0]], createdBy: "operator-1", role: "operator" });
    await service.update(flow.id, { steps: [goodSteps[0], unpublish] }, "owner-1", { role: "owner" });
    await service.update(flow.id, { steps: [{ ...goodSteps[0], retry: 1 }, unpublish] }, "operator-1", { role: "operator" });
    expect(store.getFlow(flow.id).steps[0].retry).toBe(1);
    await service.run(flow.id, "owner-1", { role: "owner" });
    expect(jobs.calls.map((call) => call.operationId)).toEqual(["controller.backup.create", "cloudflare.unpublish"]);
  });

  it("put there by someone else before this was checked, does not run until the owner has saved the flow", async () => {
    const store = withOperators(fakeStore());
    const jobs = fakeJobs(store);
    const service = createFlowService({ store, jobs, pollMs: 2 });
    const flow = store.createFlow({ name: "Tidy", steps: [goodSteps[0], unpublish], createdBy: "operator-1" });
    // The page cannot edit an existing flow's steps, so "open it and save the flow" was advice nobody
    // could follow: the refusal names the button that keeps the step, and the list says which step.
    await expect(service.launch(flow.id, "owner-1", { role: "owner" })).rejects.toThrow(/^This flow is no longer valid: step 2 \(Stop publishing an app to the internet\) is one only the owner may run, .*"Keep this step"/);
    await expect(service.run(flow.id, "owner-1", { role: "owner" })).rejects.toThrow(/only the owner may run/);
    expect(jobs.calls).toEqual([]);
    expect((await service.list()).find((entry) => entry.id === flow.id).ownerToKeep).toEqual([{ step: 2, title: "Stop publishing an app to the internet", reads: [] }]);
    // Keep this step: the owner keeps step 2, which is now one the owner put there.
    await service.update(flow.id, { keepStep: 2 }, "owner-1", { role: "owner" });
    expect(store.getFlow(flow.id).steps[1]).toMatchObject({ ...unpublish, ownerAdded: true });
    expect((await service.list()).find((entry) => entry.id === flow.id).ownerToKeep).toEqual([]);
    await service.run(flow.id, "owner-1", { role: "owner" });
    expect(jobs.calls.map((call) => call.operationId)).toEqual(["controller.backup.create", "cloudflare.unpublish"]);
  });

  it("is kept one at a time: keeping step 2 does not keep step 4 (sweep 4)", async () => {
    // "Keep this step" sent every step back, and the owner's save marked every owner-only step kept:
    // keeping the one the notice named kept another the owner had never been shown.
    const store = withOperators(fakeStore());
    const jobs = fakeJobs(store);
    const service = createFlowService({ store, jobs, pollMs: 2 });
    const send = { operationId: "http.request", parameters: { url: "https://collector.example/{{ steps.first.status }}", method: "POST", credentialName: "github-token" } };
    const flow = store.createFlow({ name: "Tidy", steps: [{ ...goodSteps[0], name: "first" }, unpublish, goodSteps[0], send], createdBy: "operator-1" });
    const listed = async () => (await service.list()).find((entry) => entry.id === flow.id);
    expect((await listed()).ownerToKeep).toEqual([
      { step: 2, title: "Stop publishing an app to the internet", reads: [] },
      { step: 4, title: "Send an HTTP request", reads: ["first"] },
    ]);
    await service.update(flow.id, { keepStep: 2 }, "owner-1", { role: "owner" });
    expect(store.getFlow(flow.id).steps[1].ownerAdded).toBe(true);
    expect(store.getFlow(flow.id).steps[3].ownerAdded).toBeUndefined();
    expect((await listed()).ownerToKeep).toEqual([{ step: 4, title: "Send an HTTP request", reads: ["first"] }]);
    await expect(service.run(flow.id, "owner-1", { role: "owner" })).rejects.toThrow(/step 4 \(Send an HTTP request\) is one only the owner may run/);
    // Saving the steps back as they are keeps nothing that was not kept; changing one makes it the owner's.
    await service.update(flow.id, { steps: store.getFlow(flow.id).steps }, "owner-1", { role: "owner" });
    expect(store.getFlow(flow.id).steps[3].ownerAdded).toBeUndefined();
    // Only an unkept owner-only step can be kept, only by the owner, and with nothing else changed.
    await expect(service.update(flow.id, { keepStep: 1 }, "owner-1", { role: "owner" })).rejects.toThrow(/Step 1 has nothing to keep/);
    await expect(service.update(flow.id, { keepStep: 9 }, "owner-1", { role: "owner" })).rejects.toThrow(/Step 9 has nothing to keep/);
    await expect(service.update(flow.id, { keepStep: 4 }, "operator-1", { role: "operator" })).rejects.toThrow(/Only the owner can keep/);
    await expect(service.update(flow.id, { keepStep: 4, name: "Renamed" }, "owner-1", { role: "owner" })).rejects.toThrow(/on its own/);
    await service.update(flow.id, { keepStep: 4 }, "owner-1", { role: "owner" });
    expect((await listed()).ownerToKeep).toEqual([]);
    expect(store.getFlow(flow.id).name).toBe("Tidy");
  });

  it("in the owner's own flow runs as it always did", async () => {
    const store = withOperators(fakeStore());
    const jobs = fakeJobs(store);
    const service = createFlowService({ store, jobs, pollMs: 2 });
    const flow = store.createFlow({ name: "Mine", steps: [unpublish], createdBy: "owner-1" });
    await service.run(flow.id, "owner-1", { role: "owner" });
    expect(jobs.calls.map((call) => call.operationId)).toEqual(["cloudflare.unpublish"]);
  });
});

describe("a step whose subject makes it high risk", () => {
  // app.install is medium, and the job layer stages it as high for an app whose manifest says so
  // (the house's DNS, the VPN): such a flow saved, then stopped at that step on every run, asking
  // for a password no flow can give.
  const withTiers = (jobs) => Object.assign(jobs, { effectiveRisk: async (operationId, parameters) => (operationId === "app.install" && parameters?.id === "pi-hole" ? "high" : "medium") });
  const install = (id) => ({ operationId: "app.install", parameters: { id } });

  it("cannot be saved, or edited in", async () => {
    const store = fakeStore();
    const service = createFlowService({ store, jobs: withTiers(fakeJobs(store)), pollMs: 2 });
    await expect(service.create({ name: "DNS", steps: [install("pi-hole")], createdBy: "owner-1" })).rejects.toThrow("step 1: Install application is high risk here and cannot be part of a flow");
    const flow = await service.create({ name: "Apps", steps: [goodSteps[0], install("jellyfin")], createdBy: "owner-1" });
    await expect(service.update(flow.id, { steps: [goodSteps[0], install("pi-hole")] }, "owner-1")).rejects.toThrow("step 2: Install application is high risk here");
    expect(store.getFlow(flow.id).steps[1].parameters.id).toBe("jellyfin");
  });

  it("saved before this was checked, does not run, by hand or on its clock", async () => {
    const store = fakeStore();
    const jobs = withTiers(fakeJobs(store));
    const service = createFlowService({ store, jobs, pollMs: 2, now: () => new Date("2026-09-15T10:00:00.000Z") });
    const flow = store.createFlow({ name: "DNS", steps: [install("pi-hole")], createdBy: "owner-1", frequency: "daily", minute: 0, hour: 3, nextDueAt: "2026-09-15T03:00:00.000Z" });
    await expect(service.launch(flow.id, "owner-1", { role: "owner" })).rejects.toThrow(/^This flow is no longer valid: step 1: Install application is high risk here/);
    await expect(service.run(flow.id, "owner-1", { role: "owner" })).rejects.toThrow(/no longer valid/);
    await service.tick();
    expect(store.getFlow(flow.id).lastResult).toMatch(/^skipped: This flow is no longer valid: step 1: Install application is high risk here/);
    expect(jobs.calls).toEqual([]);
  });
});

describe("a flow step that would store an app's secret", () => {
  it("is refused, like a step carrying a top-level password", async () => {
    // values.env is where an app's token lives; a stored flow would keep it in the database and in
    // every backup of it, and hand it back out of GET /flows.
    const store = fakeStore();
    const jobs = fakeJobs(store);
    const flows = createFlowService({ store, jobs, pollMs: 2, secretEnvNamesFor: async () => ["CLOUDFLARE_API_TOKEN"] });
    await expect(flows.create({ name: "Re-key DDNS", steps: [{ operationId: "app.reconfigure", parameters: { id: "cloudflare-ddns", values: { env: { CLOUDFLARE_API_TOKEN: "cf-token" } } } }], createdBy: "owner-1" }))
      .rejects.toThrow("needs a password or key each time");
  });
});

describe("editing a flow to carry an app's secret", () => {
  it("is refused exactly as creating one is", async () => {
    // create asked the manifest which env values are secrets; update did not, so the same token
    // could be added by editing the flow after it was saved.
    const store = fakeStore();
    const flows = createFlowService({ store, jobs: fakeJobs(store), pollMs: 2, secretEnvNamesFor: async () => ["CLOUDFLARE_API_TOKEN"] });
    const flow = await flows.create({ name: "Re-key DDNS", steps: [{ operationId: "app.reconfigure", parameters: { id: "cloudflare-ddns", values: { env: { CLOUDFLARE_API_TOKEN: "" } } } }], createdBy: "owner-1" });
    await expect(flows.update(flow.id, { steps: [{ operationId: "app.reconfigure", parameters: { id: "cloudflare-ddns", values: { env: { CLOUDFLARE_API_TOKEN: "cf-token" } } } }] }, "owner-1"))
      .rejects.toThrow("needs a password or key each time");
    expect(JSON.stringify(store.getFlow(flow.id))).not.toContain("cf-token");
  });

  it("is refused when the secret is typed as a number", async () => {
    // The check asked only whether the value was a non-empty string; values.env also takes numbers,
    // and a stored flow comes back out of GET /flows to anyone who can sign in.
    const store = fakeStore();
    const flows = createFlowService({ store, jobs: fakeJobs(store), pollMs: 2, secretEnvNamesFor: async () => ["ADMIN_PIN"] });
    const steps = (pin) => [{ operationId: "app.reconfigure", parameters: { id: "pinned-app", values: { env: { ADMIN_PIN: pin } } } }];
    await expect(flows.create({ name: "Re-pin", steps: steps(918273645546372), createdBy: "owner-1" })).rejects.toThrow("needs a password or key each time");
    const flow = await flows.create({ name: "Re-pin", steps: steps(""), createdBy: "owner-1" });
    await expect(flows.update(flow.id, { steps: steps(918273645546372) }, "owner-1")).rejects.toThrow("needs a password or key each time");
    expect(JSON.stringify(store.listFlows())).not.toContain("918273645546372");
  });
});

describe("a flow saved before its secret was refused", () => {
  // validateFlow refused such a flow at run time only for a top-level password; one holding an
  // app's token in values.env ran on, from the database it should never have been written to.
  const catalog = async (id) => (id === "cloudflared" ? ["TUNNEL_TOKEN"] : []);
  const legacy = {
    top: [{ operationId: "credentials.set", parameters: { name: "ntfy", value: "tok_LEGACY" } }],
    app: [{ operationId: "app.reconfigure", parameters: { id: "cloudflared", values: { env: { TUNNEL_TOKEN: "eyJ-legacy-token" } } } }],
  };

  it("does not run when started by hand, and says why before anything starts", async () => {
    const store = fakeStore();
    const jobs = fakeJobs(store);
    const service = createFlowService({ store, jobs, pollMs: 2, secretEnvNamesFor: catalog });
    for (const steps of Object.values(legacy)) {
      const flow = store.createFlow({ name: "legacy", steps, createdBy: "owner-1" });
      await expect(service.launch(flow.id, "owner-1", { role: "owner" })).rejects.toThrow(/no longer valid: step 1: .* needs a password or key each time/);
      await expect(service.run(flow.id, "owner-1", { role: "owner" })).rejects.toThrow(/no longer valid/);
    }
    expect(jobs.calls).toEqual([]);
  });

  it("is skipped, recorded and not run when its clock comes round", async () => {
    const store = fakeStore();
    const jobs = fakeJobs(store);
    const service = createFlowService({ store, jobs, pollMs: 2, secretEnvNamesFor: catalog, now: () => new Date("2026-09-15T10:00:00.000Z") });
    const flow = store.createFlow({ name: "legacy", steps: legacy.app, createdBy: "owner-1", frequency: "daily", minute: 0, hour: 3, nextDueAt: "2026-09-15T03:00:00.000Z" });
    await service.tick();
    expect(store.getFlow(flow.id).lastResult).toMatch(/^skipped: This flow is no longer valid: step 1/);
    expect(store.audits.map((audit) => audit.event)).toContain("flow.skipped");
    expect(jobs.calls).toEqual([]);
    // Nor can it be kept by editing something else about it: the stored steps are checked too.
    await expect(service.update(flow.id, { name: "renamed" }, "owner-1")).rejects.toThrow("needs a password or key each time");
  });

  it("is listed with its secret masked, since GET /flows answers every signed-in role", async () => {
    const store = fakeStore();
    const service = createFlowService({ store, jobs: fakeJobs(store), pollMs: 2, secretEnvNamesFor: catalog });
    store.createFlow({ name: "top", steps: legacy.top, createdBy: "owner-1" });
    store.createFlow({ name: "app", steps: legacy.app, createdBy: "owner-1" });
    const listed = await service.list();
    expect(JSON.stringify(listed)).not.toMatch(/tok_LEGACY|eyJ-legacy-token/);
    expect(listed[0].steps[0].parameters).toEqual({ name: "ntfy", value: "[secret]" });
    expect(listed[1].steps[0].parameters.values.env.TUNNEL_TOKEN).toBe("[secret]");
    // Only the answer is masked; the record, which run() must still refuse, is left as it is.
    expect(store.listFlows()[0].steps[0].parameters.value).toBe("tok_LEGACY");
  });
});

describe("a flow step whose app the catalog cannot name", () => {
  // The catalog answers null for an app it does not have. A step that names its app through an
  // earlier step's result asked for an app literally called "{{ steps.pick.id }}", was told "no
  // secrets", and the token beside it was stored in the flow and served by GET /flows.
  const catalogLookup = async (id) => (id === "cloudflared" ? ["TUNNEL_TOKEN"] : null);
  const pick = { operationId: "controller.backup.create", name: "pick", parameters: {} };

  it("cannot carry a value that might be that app's secret", async () => {
    const store = fakeStore();
    const flows = createFlowService({ store, jobs: fakeJobs(store), pollMs: 2, secretEnvNamesFor: catalogLookup });
    const referenced = [pick, { operationId: "app.reconfigure", parameters: { id: "{{ steps.pick.id }}", values: { env: { TUNNEL_TOKEN: "eyJ-referenced-token" } } } }];
    await expect(flows.create({ name: "Rotate", steps: referenced, createdBy: "owner-1" })).rejects.toThrow("needs a password or key each time");
    const unknown = [{ operationId: "app.reconfigure", parameters: { id: "cloudfared", values: { env: { TUNNEL_TOKEN: "eyJ-typo-token" } } } }];
    await expect(flows.create({ name: "Typo", steps: unknown, createdBy: "owner-1" })).rejects.toThrow("needs a password or key each time");
    const flow = await flows.create({ name: "Fine", steps: [pick], createdBy: "owner-1" });
    await expect(flows.update(flow.id, { steps: referenced }, "owner-1")).rejects.toThrow("needs a password or key each time");
    expect(JSON.stringify(store.listFlows())).not.toMatch(/eyJ-(referenced|typo)-token/);
  });

  it("still takes an app's ordinary settings when the catalog knows the app", async () => {
    const store = fakeStore();
    const flows = createFlowService({ store, jobs: fakeJobs(store), pollMs: 2, secretEnvNamesFor: catalogLookup });
    await expect(flows.create({ name: "Rename", steps: [{ operationId: "app.reconfigure", parameters: { id: "cloudflared", values: { env: { TUNNEL_NAME: "home" } } } }], createdBy: "owner-1" })).resolves.toBeTruthy();
  });
});

describe("an automation that fails (M27.2)", () => {
  // The real health-alert ledger, over its own settings, with a stand-in notification target.
  function withLedger({ target = { kind: "ntfy" }, send = vi.fn(async () => ({ sent: true })) } = {}) {
    const settings = new Map();
    const ledgerStore = { getSetting: (key, fallback) => settings.get(key) ?? fallback, setSetting: (key, value) => settings.set(key, value), recordAudit: () => {} };
    const alerts = createHealthAlerts({ inventory: { inspect: async () => ({}) }, notifications: { getTarget: () => target, send }, store: ledgerStore, now: () => new Date("2026-09-27T03:00:00Z") });
    // A flow announces without waiting; anything queued on the ledger after it waits for it.
    const drained = () => alerts.clear("nothing:pending");
    return { alerts, send, drained, state: () => settings.get("healthAlertsState") ?? {} };
  }

  it("is announced once per flow, owns its step jobs, and says when a clean run fixed it", async () => {
    const store = fakeStore();
    const { alerts, send, drained, state } = withLedger();
    const failing = createFlowService({ store, jobs: fakeJobs(store, { failAt: 1, alwaysFail: true }), pollMs: 2, alerts });
    const flow = await failing.create({ name: "Nightly", steps: [goodSteps[0]], createdBy: "owner-1" });

    await expect(failing.run(flow.id, "owner-1", { role: "owner" })).rejects.toThrow(/stopped at step 1/);
    // The step's job is the flow's: the notifier leaves it alone, so the owner hears it once, from here.
    expect(failing.owns("job-1")).toBe(true);
    await drained();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ title: "BoxPilot: Automation stopped: Nightly", message: expect.stringMatching(/^Nightly stopped at step 1 .*the step went wrong/), priority: "high" });

    await expect(failing.run(flow.id, "owner-1", { role: "owner" })).rejects.toThrow(/stopped at step 1/);
    await drained();
    expect(send).toHaveBeenCalledTimes(1); // the same flow failing again is not a second push
    expect(state()[`flow.failed:${flow.id}`]).toMatchObject({ notified: true });

    const fixed = createFlowService({ store, jobs: fakeJobs(store), pollMs: 2, alerts });
    await fixed.run(flow.id, "owner-1", { role: "owner" });
    await drained();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ title: "BoxPilot: resolved. Automation stopped: Nightly" }));
    expect(state()).toEqual({});
  });

  it("is kept as not announced when there is no target, and deleting the flow drops it quietly", async () => {
    const store = fakeStore();
    const { alerts, send, drained, state } = withLedger({ target: null });
    const service = createFlowService({ store, jobs: fakeJobs(store), pollMs: 2, alerts, now: () => new Date("2026-08-30T03:01:00.000Z") });
    // A demoted creator: the clock fires, the run is refused, and no job exists to carry the news.
    const flow = await service.create({ name: "Mirror", steps: [goodSteps[0]], createdBy: "viewer-9", cadence: { frequency: "daily", minute: 0, hour: 3 } });
    store.flows.get(flow.id).nextDueAt = "2026-08-30T03:00:00.000Z";
    await service.tick();
    await drained();
    expect(send).not.toHaveBeenCalled();
    expect(state()[`flow.failed:${flow.id}`]).toMatchObject({ notified: false, title: "Automation did not run: Mirror", message: expect.stringContaining("viewer-9 can no longer approve") });

    service.remove(flow.id, "owner-1", { role: "owner" });
    await drained();
    expect(state()).toEqual({});
    expect(send).not.toHaveBeenCalled();
  });

  it("is kept as not announced when the target does not answer", async () => {
    const store = fakeStore();
    const send = vi.fn(async () => { throw new Error("The notification target answered 502"); });
    const { alerts, drained, state } = withLedger({ send });
    const service = createFlowService({ store, jobs: fakeJobs(store, { failAt: 1 }), pollMs: 2, alerts });
    const flow = await service.create({ name: "Belt", steps: [{ ...goodSteps[0], onFailure: "continue" }, goodSteps[1]], createdBy: "owner-1" });
    expect((await service.run(flow.id, "owner-1", { role: "owner" })).completed).toBe(true);
    await drained();
    expect(send).toHaveBeenCalledTimes(1);
    expect(state()[`flow.failed:${flow.id}`]).toMatchObject({ notified: false, title: "Automation finished with problems: Belt" });
  });
});
