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
import { registry as defaultRegistry, validateParameters } from "./ops/index.mjs";
import { computeNextRun, validateCadence } from "./scheduler.mjs";
import { holdsPlaceholder, isSinglePlaceholder, referencesIn, resolveValues, stepNamePattern } from "./flow-values.mjs";

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
  const namesSoFar = new Set();
  for (const [index, step] of steps.entries()) {
    const label = `step ${index + 1}`;
    if (!step || typeof step.operationId !== "string") return `${label} must name an operation`;
    const operation = registry.get?.(step.operationId);
    if (!operation) return `${label}: ${step.operationId} is not a registered operation`;
    if (operation.risk === "high") return `${label}: ${operation.title} is high risk and cannot be part of a flow (ADR-002)`;
    const parameters = step.parameters ?? {};
    if (typeof parameters !== "object" || Array.isArray(parameters)) return `${label}: parameters must be an object`;
    if (step.name !== undefined && step.name !== null) {
      if (typeof step.name !== "string" || !stepNamePattern.test(step.name)) return `${label}: a step name is lowercase letters, digits and dashes, 24 characters at most`;
      if (namesSoFar.has(step.name)) return `${label}: another step is already named ${step.name}`;
    }
    if (step.onFailure !== undefined && !["stop", "continue"].includes(step.onFailure)) return `${label}: onFailure is either stop or continue`;
    if (step.when !== undefined) {
      if (!step.when || typeof step.when !== "object" || Array.isArray(step.when) || typeof step.when.value !== "string") return `${label}: a condition names the value it reads, as when.value`;
      const reads = referencesIn({ value: step.when.value });
      if (!isSinglePlaceholder(step.when.value)) return `${label}: when.value is exactly one {{ steps.name.field }} reference`;
      if (!namesSoFar.has(reads[0].step)) return `${label} reads steps.${reads[0].step}, which is not the name of an earlier step`;
      if (step.when.equals !== undefined && (typeof step.when.equals === "object" || typeof step.when.equals === "function")) return `${label}: when.equals compares against a plain value`;
    }
    // A reference can only look backwards: the step it reads must be named and already run.
    for (const reference of referencesIn(parameters)) {
      if (!namesSoFar.has(reference.step)) return `${label} reads steps.${reference.step}, which is not the name of an earlier step`;
    }
    if (typeof step.name === "string") namesSoFar.add(step.name);
    // A value read from an earlier step does not exist yet, so its field sits out save-time
    // validation: the field is treated as optional and its value withheld, everything else checked
    // as usual. The resolved parameters go through the registry again when the job is staged.
    const placeholderFields = Object.keys(parameters).filter((key) => holdsPlaceholder(parameters[key]));
    if (placeholderFields.length === 0) {
      const problem = registry.validate?.(step.operationId, parameters);
      if (problem) return `${label}: ${problem}`;
    } else {
      const spec = operation.parameters ?? { fields: {} };
      for (const key of placeholderFields) {
        if (spec.exact !== false && !Object.hasOwn(spec.fields ?? {}, key)) return `${label}: ${operation.title} does not accept parameter "${key}"`;
      }
      const relaxed = { ...spec, fields: Object.fromEntries(Object.entries(spec.fields ?? {}).map(([key, field]) => [key, placeholderFields.includes(key) ? { ...field, optional: true } : field])) };
      const checkable = Object.fromEntries(Object.entries(parameters).filter(([key]) => !placeholderFields.includes(key)));
      const problem = validateParameters(relaxed, checkable, operation.title);
      if (problem) return `${label}: ${problem}`;
    }
  }
  return null;
}

export function createFlowService({ store, jobs, registry = defaultRegistry, pollMs = 1000, maxStepMs = null, now = () => new Date(), notify = null }) {
  const running = new Set(); // flow ids mid-run; a flow must not lap itself

  function assertMayManage(flow, actorId, role) {
    if (!flow) throw new Error("Flow not found");
    if (flow.createdBy !== actorId && role !== "owner") throw new Error("Only the flow's creator or an owner can change it");
  }

  /** A cadence is optional; present, it must be a schedule the scheduler itself would accept. */
  function cadenceFields(cadence) {
    if (!cadence || !cadence.frequency) return { frequency: null, minute: null, hour: null, weekday: null, nextDueAt: null };
    const problem = validateCadence(cadence);
    if (problem) throw new Error(problem);
    return {
      frequency: cadence.frequency, minute: cadence.minute, hour: cadence.hour ?? null, weekday: cadence.weekday ?? null,
      nextDueAt: computeNextRun(cadence, now()).toISOString(),
    };
  }

  /** Only what a step means persists: its operation, its parameters, and (if given) its name. */
  // Keeps exactly the fields validateFlow understands, so junk keys never persist. Every new
  // step field must be carried here or it silently vanishes at save time; the schema normalizer
  // dropping containerFollowsHost shipped a broken release the same way.
  function normalizeSteps(steps) {
    return steps.map((step) => ({
      operationId: step.operationId, parameters: step.parameters ?? {},
      ...(typeof step.name === "string" ? { name: step.name } : {}),
      ...(step.onFailure !== undefined ? { onFailure: step.onFailure } : {}),
      ...(step.when !== undefined ? { when: { value: step.when.value, ...(step.when.equals !== undefined ? { equals: step.when.equals } : {}) } } : {}),
    }));
  }

  async function create({ name, steps, createdBy, cadence = null }) {
    const problem = validateFlow({ name, steps }, registry);
    if (problem) throw new Error(problem);
    return store.createFlow({ name: name.trim(), steps: normalizeSteps(steps), createdBy, ...cadenceFields(cadence) });
  }

  function list() {
    return store.listFlows().map((flow) => ({ ...flow, risk: flowRisk(flow.steps, registry), running: running.has(flow.id) }));
  }

  async function update(id, { name, steps, cadence, enabled }, actorId, { role = "owner" } = {}) {
    const flow = store.getFlow(id);
    assertMayManage(flow, actorId, role);
    const problem = validateFlow({ name: name ?? flow.name, steps: steps ?? flow.steps }, registry);
    if (problem) throw new Error(problem);
    const changes = { name: name?.trim(), steps: steps ? normalizeSteps(steps) : undefined, enabled };
    if (cadence !== undefined) Object.assign(changes, cadenceFields(cadence));
    // Re-enabling a scheduled flow computes the next due time afresh, so a flow paused for a
    // month does not fire the moment it is switched back on to make up for missed Sundays.
    if (enabled === true && flow.frequency && cadence === undefined) {
      changes.nextDueAt = computeNextRun(flow, now()).toISOString();
    }
    return store.updateFlow(id, changes, { actorId });
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
    // One entry per step, in step order: a job id, or null for a step whose condition was not
    // met. The page maps run entries back to steps by position, so skipped steps hold their place.
    const jobIds = [];
    const problems = [];
    let skippedByCondition = 0;
    const namedResults = {};
    try {
      for (const [index, step] of flow.steps.entries()) {
        const operation = registry.get(step.operationId);
        const title = operation?.title ?? step.operationId;
        // A condition reads an earlier step's recorded result; false means the step is skipped
        // and holds its place, not failed. A reference that cannot resolve is a real failure:
        // hiding a typo behind "condition not met" would make every misspelling silent.
        if (step.when) {
          let read;
          try {
            read = resolveValues({ value: step.when.value }, namedResults).value;
          } catch (error) {
            const summary = `failed at step ${index + 1} (${title}): its condition ${error.message}`.slice(0, 300);
            store.markFlowRun(id, { result: summary, jobIds });
            store.recordAudit("flow.failed", { actorId, subjectId: id, details: { step: index + 1, operationId: step.operationId, reason: error.message.slice(0, 200) } });
            notify?.(`${flow.name} ${summary}`);
            throw new Error(`${flow.name} ${summary}`);
          }
          const met = step.when.equals !== undefined ? read === step.when.equals : Boolean(read);
          if (!met) { jobIds.push(null); skippedByCondition += 1; continue; }
        }
        let job = null;
        try {
          // References to earlier steps become the values those steps recorded, here at the last
          // moment before staging, so the job is created and validated with real parameters.
          const parameters = resolveValues(step.parameters ?? {}, namedResults);
          job = await jobs.createOperationJob(step.operationId, parameters, actorId, { role });
          jobIds.push(job.id);
          // Progress lands as it happens, not at the end: the page can show which step is running
          // and its live output, and a crash mid-run leaves an honest record of where it stopped.
          store.markFlowRun(id, { result: `running step ${index + 1} of ${flow.steps.length} (${title})`, jobIds });
          await jobs.approveAndStart(job.id, actorId, {});
        } catch (error) {
          if (job && typeof jobs.cancelJob === "function") {
            try { jobs.cancelJob(job.id, actorId, { role, reason: `Flow step could not start: ${error.message}`.slice(0, 200) }); } catch { /* already terminal */ }
          }
          if (job === null) jobIds.push(null);
          store.recordAudit("flow.failed", { actorId, subjectId: id, details: { step: index + 1, operationId: step.operationId, reason: error.message.slice(0, 200) } });
          if (step.onFailure === "continue") { problems.push(`step ${index + 1} (${title}) could not start: ${error.message}`.slice(0, 200)); continue; }
          const summary = `failed at step ${index + 1} (${title}): ${error.message}`.slice(0, 300);
          store.markFlowRun(id, { result: summary, jobIds });
          // No job ran, so no failed-job push carries the news; this is the flow's own to send.
          notify?.(`${flow.name} ${summary}`);
          throw new Error(`${flow.name} ${summary}`);
        }
        let finished;
        try {
          finished = await awaitJob(job.id, maxStepMs ?? ((operation?.timeoutMs ?? 180_000) + 60_000));
        } catch (error) {
          // Losing sight of a step is not the same as the step failing: the job may well still be
          // running, so the next step must not start whatever this step's failure policy says.
          const summary = `lost sight of step ${index + 1} (${title}): ${error.message}`.slice(0, 300);
          store.markFlowRun(id, { result: summary, jobIds });
          store.recordAudit("flow.failed", { actorId, subjectId: id, details: { step: index + 1, operationId: step.operationId, jobId: job.id, reason: error.message.slice(0, 200) } });
          notify?.(`${flow.name} ${summary}`);
          throw new Error(`${flow.name} ${summary}`);
        }
        if (finished.state !== "completed") {
          store.recordAudit("flow.failed", { actorId, subjectId: id, details: { step: index + 1, operationId: step.operationId, jobId: job.id } });
          if (step.onFailure === "continue") { problems.push(`step ${index + 1} (${title}) ${finished.state === "failed" ? "failed" : finished.state}`.slice(0, 200)); continue; }
          const summary = `stopped at step ${index + 1} (${title}): ${finished.error ?? finished.state}`.slice(0, 300);
          store.markFlowRun(id, { result: summary, jobIds });
          throw new Error(`${flow.name} ${summary}. Earlier steps ran and stand; each one's job record says what it did.`);
        }
        if (typeof step.name === "string") namedResults[step.name] = finished.result ?? {};
      }
      const result = problems.length
        ? `completed with problems: ${problems.join("; ")}`.slice(0, 300)
        : skippedByCondition > 0 ? `completed (${skippedByCondition} step${skippedByCondition === 1 ? "" : "s"} skipped by condition)` : "completed";
      store.markFlowRun(id, { result, jobIds });
      store.recordAudit("flow.completed", { actorId, subjectId: id, details: { steps: flow.steps.length, problems: problems.length } });
      return { completed: true, steps: flow.steps.length, jobIds, problems };
    } finally {
      running.delete(id);
    }
  }

  /**
   * Run flows whose clock has come due, each under its creator's stored authority. The clock is
   * the one trigger ADR-002 admits without a new consent story, because it is the contract the
   * scheduler already carries: the creator consented by writing the cadence, the consent is
   * visible on the page, and disabling the flow revokes it. Everything else about unattended
   * running is inherited too, including refusing to run under always-ask approval mode.
   */
  let ticking = false;
  async function tick() {
    if (ticking) return 0;
    ticking = true;
    try {
      const due = store.listDueFlows(now().toISOString());
      for (const flow of due) {
        // Advance the clock before running, so a slow flow cannot fire twice.
        const nextDueAt = computeNextRun(flow, now()).toISOString();
        if (running.has(flow.id)) { store.updateFlow(flow.id, { nextDueAt }, { actorId: flow.createdBy }); continue; }
        const creator = store.findOwnerById?.(flow.createdBy) ?? null;
        try {
          if (creator && ["viewer", "disabled"].includes(creator.role)) throw new Error(`${creator.username} can no longer approve jobs`);
          store.updateFlow(flow.id, { nextDueAt }, { actorId: flow.createdBy });
          await run(flow.id, flow.createdBy, { role: creator?.role ?? "owner" });
          store.recordAudit("flow.scheduled-run", { actorId: flow.createdBy, subjectId: flow.id, details: { nextDueAt } });
        } catch (error) {
          // run() already recorded the failure on the flow; a refusal before it started needs recording here.
          if (!/stopped at step|failed at step|lost sight of step/.test(error.message)) {
            store.markFlowRun(flow.id, { result: `skipped: ${error.message}`.slice(0, 300), jobIds: [] });
            store.recordAudit("flow.skipped", { actorId: flow.createdBy, subjectId: flow.id, details: { reason: error.message.slice(0, 200) } });
            // A refusal produces no job, so nothing else would tell the owner their schedule did not run.
            notify?.(`${flow.name} was due but did not run: ${error.message}`.slice(0, 300));
          }
        }
      }
      return due.length;
    } finally {
      ticking = false;
    }
  }

  function start(intervalMs = 60_000) {
    const timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
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

  return { create, list, update, remove, run, tick, start, stepPalette };
}
