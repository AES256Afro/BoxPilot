import { describe, expect, it, vi } from "vitest";
import { createFlowService, flowRisk, validateFlow } from "./flows.mjs";

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
    createFlow({ name, steps, createdBy }) {
      const flow = { id: `flow-${flows.size + 1}`, name, steps, createdBy, createdAt: "2026-08-26T00:00:00Z", updatedAt: "2026-08-26T00:00:00Z", lastRunAt: null, lastResult: null, lastJobIds: [] };
      flows.set(flow.id, flow);
      return flow;
    },
    getFlow: (id) => flows.get(id) ?? null,
    listFlows: () => [...flows.values()],
    updateFlow(id, { name, steps }) {
      const flow = flows.get(id);
      Object.assign(flow, { name: name ?? flow.name, steps: steps ?? flow.steps });
      return flow;
    },
    markFlowRun(id, { result, jobIds }) { Object.assign(flows.get(id), { lastResult: result, lastJobIds: jobIds, lastRunAt: "now" }); },
    deleteFlow(id) { if (!flows.delete(id)) throw new Error("Flow not found"); },
    getJob: (id) => jobs.get(id) ?? null,
    getSetting: () => null,
    recordAudit: (event, detail) => audits.push({ event, ...detail }),
  };
}

function fakeJobs(store, { failAt = null, neverFinish = null } = {}) {
  let counter = 0;
  return {
    calls: [],
    async createOperationJob(operationId, parameters, actorId, { role }) {
      counter += 1;
      const job = { id: `job-${counter}`, operationId, parameters, actorId, role, state: "awaiting_approval" };
      store.jobs.set(job.id, job);
      this.calls.push({ operationId, actorId, role });
      return job;
    },
    async approveAndStart(jobId) {
      const job = store.jobs.get(jobId);
      job.state = "applying";
      // steps finish on their own unless told otherwise; the runner polls for the outcome
      if (neverFinish !== this.calls.length) {
        setTimeout(() => { job.state = failAt === this.calls.length ? "failed" : "completed"; if (job.state === "failed") job.error = "the step went wrong"; }, 5);
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
    // and once the stuck run has been declared dead, the flow is runnable again
    expect(store.getFlow(flow.id).lastResult).toBe(null); // a timeout mid-await records nothing false
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
