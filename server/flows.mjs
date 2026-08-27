/**
 * Flows (M13.2, ADR-002): an ordered list of registered operations, run one after another.
 *
 * There is deliberately nothing here that is not already in the registry. Each step becomes an
 * ordinary job, created and approved through the same doors the scheduler uses, so the audit
 * trail shows the steps a person could have clicked in order rather than a blur with one name.
 * A flow answers for its riskiest step, high-risk operations cannot be put in one at all, and a
 * step that fails stops the chain: what ran stays run, each job record says what happened, and
 * nothing attempts an automatic unwind — a half-done flow the owner can read beats a rollback
 * that guesses.
 */
import { registry as defaultRegistry } from "./ops/index.mjs";

const nameLimit = 80;
const stepLimit = 10;
const riskOrder = { low: 0, medium: 1, high: 2 };

/** The highest tier any step carries; what the flow answers for. */
export function flowRisk(steps, registry = defaultRegistry) {
  let highest = "low";
  for (const step of steps ?? []) {
    const operation = registry.get?.(step.operationId) ?? null;
    const risk = operation?.risk ?? "low";
    if (riskOrder[risk] > riskOrder[highest]) highest = risk;
  }
  return highest;
}

/** Why a flow definition is not acceptable, or null. Steps must be real, parameterised, and never high. */
export function validateFlow({ name, steps } = {}, registry = defaultRegistry) {
  if (typeof name !== "string" || !name.trim() || name.trim().length > nameLimit) return `name must be 1 to ${nameLimit} characters`;
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > stepLimit) return `steps must list 1 to ${stepLimit} operations`;
  for (const [index, step] of steps.entries()) {
    const label = `step ${index + 1}`;
    if (!step || typeof step.operationId !== "string") return `${label} must name an operation`;
    const operation = registry.get?.(step.operationId);
    if (!operation) return `${label}: ${step.operationId} is not a registered operation`;
    if (operation.risk === "high") return `${label}: ${operation.title} is high risk and cannot be part of a flow (ADR-002)`;
    const parameters = step.parameters ?? {};
    if (typeof parameters !== "object" || Array.isArray(parameters)) return `${label}: parameters must be an object`;
    const problem = registry.validate?.(step.operationId, parameters);
    if (problem) return `${label}: ${problem}`;
  }
  return null;
}

export function createFlowService({ store, jobs, registry = defaultRegistry, pollMs = 1000, maxStepMs = null }) {
  const running = new Set(); // flow ids mid-run; a flow must not lap itself

  function assertMayManage(flow, actorId, role) {
    if (!flow) throw new Error("Flow not found");
    if (flow.createdBy !== actorId && role !== "owner") throw new Error("Only the flow's creator or an owner can change it");
  }

  async function create({ name, steps, createdBy }) {
    const problem = validateFlow({ name, steps }, registry);
    if (problem) throw new Error(problem);
    return store.createFlow({ name: name.trim(), steps, createdBy });
  }

  function list() {
    return store.listFlows().map((flow) => ({ ...flow, risk: flowRisk(flow.steps, registry), running: running.has(flow.id) }));
  }

  async function update(id, { name, steps }, actorId, { role = "owner" } = {}) {
    const flow = store.getFlow(id);
    assertMayManage(flow, actorId, role);
    const problem = validateFlow({ name: name ?? flow.name, steps: steps ?? flow.steps }, registry);
    if (problem) throw new Error(problem);
    return store.updateFlow(id, { name: name?.trim(), steps }, { actorId });
  }

  function remove(id, actorId, { role = "owner" } = {}) {
    assertMayManage(store.getFlow(id), actorId, role);
    store.deleteFlow(id, { actorId });
  }

  /** Wait for one step's job to reach a terminal state, bounded by the operation's own budget. */
  async function awaitJob(jobId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = store.getJob(jobId);
      if (!job) throw new Error("The step's job record disappeared");
      if (["completed", "failed", "cancelled"].includes(job.state)) return job;
      if (Date.now() > deadline) throw new Error("The step did not finish inside its operation's own time budget");
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  /**
   * Run a flow now, under the authority of the person who asked. Sequential on purpose: a stopped
   * chain is diagnosable, and step three may depend on step two having actually happened.
   */
  async function run(id, actorId, { role = "owner" } = {}) {
    const flow = store.getFlow(id);
    if (!flow) throw new Error("Flow not found");
    if (["viewer", "disabled"].includes(role)) throw new Error("Viewers cannot run flows");
    if (running.has(id)) throw new Error(`${flow.name} is already running`);
    const problem = validateFlow(flow, registry);
    if (problem) throw new Error(`This flow is no longer valid: ${problem}`);
    if (store.getSetting?.("approvalMode", null) === "always-password") {
      throw new Error("Approval mode is set to always ask, so flows cannot run: each step would need its own password. Change the approval mode to run flows.");
    }

    running.add(id);
    const jobIds = [];
    try {
      for (const [index, step] of flow.steps.entries()) {
        const operation = registry.get(step.operationId);
        let job = null;
        try {
          job = await jobs.createOperationJob(step.operationId, step.parameters ?? {}, actorId, { role });
          jobIds.push(job.id);
          await jobs.approveAndStart(job.id, actorId, {});
        } catch (error) {
          if (job && typeof jobs.cancelJob === "function") {
            try { jobs.cancelJob(job.id, actorId, { role, reason: `Flow step could not start: ${error.message}`.slice(0, 200) }); } catch { /* already terminal */ }
          }
          store.markFlowRun(id, { result: `failed at step ${index + 1} (${operation?.title ?? step.operationId}): ${error.message}`.slice(0, 300), jobIds });
          store.recordAudit("flow.failed", { actorId, subjectId: id, details: { step: index + 1, operationId: step.operationId, reason: error.message.slice(0, 200) } });
          throw error;
        }
        const finished = await awaitJob(job.id, maxStepMs ?? ((operation?.timeoutMs ?? 180_000) + 60_000));
        if (finished.state !== "completed") {
          const summary = `stopped at step ${index + 1} (${operation?.title ?? step.operationId}): ${finished.error ?? finished.state}`.slice(0, 300);
          store.markFlowRun(id, { result: summary, jobIds });
          store.recordAudit("flow.failed", { actorId, subjectId: id, details: { step: index + 1, operationId: step.operationId, jobId: job.id } });
          throw new Error(`${flow.name} ${summary}. Earlier steps ran and stand; each one's job record says what it did.`);
        }
      }
      store.markFlowRun(id, { result: "completed", jobIds });
      store.recordAudit("flow.completed", { actorId, subjectId: id, details: { steps: flow.steps.length } });
      return { completed: true, steps: flow.steps.length, jobIds };
    } finally {
      running.delete(id);
    }
  }

  /**
   * Steps a flow can be built from without a parameter form: registered low and medium operations
   * every field of which is optional. The palette maintains itself as the registry grows.
   */
  function stepPalette() {
    return registry.list()
      .filter((operation) => operation.risk !== "high" && !operation.readOnly)
      .filter((operation) => Object.values(operation.parameters?.fields ?? {}).every((field) => field.optional))
      .map((operation) => ({ operationId: operation.id, title: operation.title, risk: operation.risk, description: operation.description ?? "" }));
  }

  return { create, list, update, remove, run, stepPalette };
}
