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
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { registry as defaultRegistry, validateParameters } from "./ops/index.mjs";
import { computeNextRun, validateCadence } from "./scheduler.mjs";
import { holdsPlaceholder, isSinglePlaceholder, referencesIn, resolveValues, stepNamePattern } from "./flow-values.mjs";

const nameLimit = 80;
const stepLimit = 10;
// One flow may run after another; a chain may be at most this many links, and the same number
// governs saving and running, so nothing that saves can silently not run.
const chainLimit = 8;
// Failures run() has already recorded on the flow, so a caller must not overwrite them with
// "skipped". Every stop-path throw in run() carries one of these prefixes; keep them in step.
const recordedRunFailure = /stopped at step|failed at step|lost sight of step/;
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
    if (step.retry !== undefined && (!Number.isInteger(step.retry) || step.retry < 0 || step.retry > 3)) return `${label}: retry is 0 to 3 extra attempts`;
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

export function createFlowService({ store, jobs, registry = defaultRegistry, pollMs = 1000, maxStepMs = null, retryDelayMs = 30_000, now = () => new Date(), notify = null }) {
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
      ...(step.retry !== undefined ? { retry: step.retry } : {}),
      ...(step.when !== undefined ? { when: { value: step.when.value, ...(step.when.equals !== undefined ? { equals: step.when.equals } : {}) } } : {}),
    }));
  }

  /**
   * A flow may run after another completes (ADR-002 addendum, v1.45.0). The link must point at a
   * real flow, never itself, and never close a loop: A after B after A would run forever on the
   * strength of one click.
   */
  function checkTrigger(triggerFlowId, ownId = null) {
    if (triggerFlowId === null || triggerFlowId === undefined) return null;
    let current = triggerFlowId;
    for (let depth = 0; depth < chainLimit; depth += 1) {
      if (current === ownId) return "that would make the flow trigger itself in a loop";
      const flow = store.getFlow(current);
      // Only the flow pointed at directly must exist; a gap further up the chain (a flow
      // deleted before follower cleanup existed) ends the walk rather than blaming this link.
      if (!flow) return depth === 0 ? "the flow it should run after does not exist" : null;
      if (!flow.triggerFlowId) return null;
      current = flow.triggerFlowId;
    }
    return `flows may chain at most ${chainLimit} deep`;
  }

  // The stored hash is never the browser's business; strip it from anything a route returns.
  const withoutHash = ({ webhookHash: _webhookHash, ...flow }) => flow;

  async function create({ name, steps, createdBy, cadence = null, triggerFlowId = null }) {
    const problem = validateFlow({ name, steps }, registry);
    if (problem) throw new Error(problem);
    const triggerProblem = checkTrigger(triggerFlowId);
    if (triggerProblem) throw new Error(triggerProblem);
    return withoutHash(store.createFlow({ name: name.trim(), steps: normalizeSteps(steps), createdBy, triggerFlowId, ...cadenceFields(cadence) }));
  }

  function list() {
    // The hash never travels to a browser: it is not invertible, but it is also not the page's business.
    return store.listFlows().map((flow) => ({ ...withoutHash(flow), risk: flowRisk(flow.steps, registry), running: running.has(flow.id) }));
  }

  async function update(id, { name, steps, cadence, enabled, triggerFlowId }, actorId, { role = "owner" } = {}) {
    const flow = store.getFlow(id);
    assertMayManage(flow, actorId, role);
    const problem = validateFlow({ name: name ?? flow.name, steps: steps ?? flow.steps }, registry);
    if (problem) throw new Error(problem);
    if (triggerFlowId !== undefined) {
      const triggerProblem = checkTrigger(triggerFlowId, id);
      if (triggerProblem) throw new Error(triggerProblem);
    }
    const changes = { name: name?.trim(), steps: steps ? normalizeSteps(steps) : undefined, enabled, triggerFlowId };
    if (cadence !== undefined) Object.assign(changes, cadenceFields(cadence));
    // Re-enabling a scheduled flow computes the next due time afresh, so a flow paused for a
    // month does not fire the moment it is switched back on to make up for missed Sundays.
    if (enabled === true && flow.frequency && cadence === undefined) {
      changes.nextDueAt = computeNextRun(flow, now()).toISOString();
    }
    return withoutHash(store.updateFlow(id, changes, { actorId }));
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
  async function run(id, actorId, { role = "owner", chainDepth = 0 } = {}) {
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
    let completedRun = false;
    // One entry per step, in step order: a job id, or null for a step whose condition was not
    // met. The page maps run entries back to steps by position, so skipped steps hold their place.
    const jobIds = [];
    const problems = [];
    const notes = [];
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
          // A named step that never finished (skipped by its own condition, or failed under a
          // keep-going policy) is not a typo: the condition cannot be true, so this step
          // skips too. Only a missing FIELD on a step that did finish fails loudly.
          const reads = referencesIn({ value: step.when.value });
          if (reads.length === 1 && !Object.hasOwn(namedResults, reads[0].step)) { jobIds.push(null); skippedByCondition += 1; continue; }
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
        // A step may carry up to three extra attempts for transient failures (an apt lock, a
        // busy mirror). Each attempt is its own recorded job; the run's slot keeps the attempt
        // that counted. Only a job that ran and failed is retried: staging refusals are
        // deterministic, a cancellation was somebody's decision, and a lost-sight step may
        // still be running.
        const attemptsAllowed = 1 + (step.retry ?? 0);
        let finished = null;
        for (let attempt = 1; attempt <= attemptsAllowed; attempt += 1) {
          let job = null;
          try {
            // References to earlier steps become the values those steps recorded, here at the last
            // moment before staging, so the job is created and validated with real parameters.
            const parameters = resolveValues(step.parameters ?? {}, namedResults);
            job = await jobs.createOperationJob(step.operationId, parameters, actorId, { role });
            if (attempt === 1) jobIds.push(job.id); else jobIds[index] = job.id;
            // Progress lands as it happens, not at the end: the page can show which step is running
            // and its live output, and a crash mid-run leaves an honest record of where it stopped.
            store.markFlowRun(id, { result: `running step ${index + 1} of ${flow.steps.length} (${title})${attempt > 1 ? `, attempt ${attempt} of ${attemptsAllowed}` : ""}`, jobIds });
            await jobs.approveAndStart(job.id, actorId, {});
          } catch (error) {
            if (job && typeof jobs.cancelJob === "function") {
              try { jobs.cancelJob(job.id, actorId, { role, reason: `Flow step could not start: ${error.message}`.slice(0, 200) }); } catch { /* already terminal */ }
            }
            if (job === null && attempt === 1) jobIds.push(null);
            store.recordAudit("flow.failed", { actorId, subjectId: id, details: { step: index + 1, operationId: step.operationId, reason: error.message.slice(0, 200) } });
            if (step.onFailure === "continue") { problems.push(`step ${index + 1} (${title}) could not start: ${error.message}`.slice(0, 200)); break; }
            const summary = `failed at step ${index + 1} (${title}): ${error.message}`.slice(0, 300);
            store.markFlowRun(id, { result: summary, jobIds });
            // No job ran, so no failed-job push carries the news; this is the flow's own to send.
            notify?.(`${flow.name} ${summary}`);
            throw new Error(`${flow.name} ${summary}`);
          }
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
          if (finished.state === "completed") {
            if (attempt > 1) notes.push(`step ${index + 1} (${title}) succeeded on attempt ${attempt} of ${attemptsAllowed}`);
            break;
          }
          store.recordAudit("flow.failed", { actorId, subjectId: id, details: { step: index + 1, operationId: step.operationId, jobId: job.id, attempt } });
          if (finished.state === "failed" && attempt < attemptsAllowed) {
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
            continue;
          }
          if (step.onFailure === "continue") { problems.push(`step ${index + 1} (${title}) ${finished.state === "failed" ? "failed" : finished.state}${attemptsAllowed > 1 ? ` after ${attempt} attempts` : ""}`.slice(0, 200)); break; }
          const summary = `stopped at step ${index + 1} (${title})${attemptsAllowed > 1 ? ` after ${attempt} attempts` : ""}: ${finished.error ?? finished.state}`.slice(0, 300);
          store.markFlowRun(id, { result: summary, jobIds });
          throw new Error(`${flow.name} ${summary}. Earlier steps ran and stand; each one's job record says what it did.`);
        }
        if (finished?.state !== "completed") continue;
        if (typeof step.name === "string") namedResults[step.name] = finished.result ?? {};
      }
      // A retry that saved a step and a condition that skipped one are footnotes on success,
      // never problems: the red style is for runs that actually went wrong.
      const asides = [...notes, ...(skippedByCondition > 0 ? [`${skippedByCondition} step${skippedByCondition === 1 ? "" : "s"} skipped by condition`] : [])];
      const result = problems.length
        ? `completed with problems: ${problems.join("; ")}`.slice(0, 300)
        : asides.length ? `completed (${asides.join("; ")})`.slice(0, 300) : "completed";
      store.markFlowRun(id, { result, jobIds });
      store.recordAudit("flow.completed", { actorId, subjectId: id, details: { steps: flow.steps.length, problems: problems.length } });
      completedRun = true;
      return { completed: true, steps: flow.steps.length, jobIds, problems };
    } finally {
      running.delete(id);
      // Followers start only after this flow has let go of itself: its record is final, and
      // it no longer reads as running while the chain behind it works through its own steps.
      if (completedRun) await runFollowers(id, { depth: chainDepth });
    }
  }

  /**
   * The webhook (ADR-002 addendum, v1.50.0): a token minted by the flow's creator, delegated
   * authority for exactly one action. Only the hash is stored, the caller chooses only WHEN
   * (nothing from the request reaches any step), and firing goes through the same door as a
   * scheduled run, refusals and all.
   */
  function mintWebhook(id, actorId, { role = "owner" } = {}) {
    const flow = store.getFlow(id);
    assertMayManage(flow, actorId, role);
    const token = randomBytes(32).toString("base64url");
    store.setFlowWebhook(id, createHash("sha256").update(token).digest("hex"), { actorId });
    return { token };
  }

  function clearWebhook(id, actorId, { role = "owner" } = {}) {
    const flow = store.getFlow(id);
    assertMayManage(flow, actorId, role);
    store.setFlowWebhook(id, null, { actorId });
    return { removed: true };
  }

  // A caller may fire one flow at most this often; beyond it the answer is 429 without a run.
  const webhookFires = new Map();
  const webhookLimit = { count: 6, perMs: 60_000 };

  /**
   * Fire a flow from its webhook. Returns "accepted" | "not-found" | "rate-limited"; the run
   * itself happens after the response, under the creator's stored authority, and a refusal is
   * recorded on the flow and notified exactly like a scheduled run's.
   */
  function fireWebhook(id, token, { source = null } = {}) {
    const flow = store.getFlow(id);
    // A wrong token and a missing flow answer identically, so the URL cannot be probed apart.
    // A disabled flow answers as if it had no webhook: pausing is the revocation gesture the UI
    // offers, and it must revoke this trigger as it revokes the clock and flow-after-flow ones.
    if (!flow || !flow.webhookHash || flow.enabled === false || typeof token !== "string" || !token.length) return "not-found";
    const presented = createHash("sha256").update(token).digest();
    const stored = Buffer.from(flow.webhookHash, "hex");
    if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) return "not-found";
    const recent = (webhookFires.get(id) ?? []).filter((at) => now().getTime() - at < webhookLimit.perMs);
    if (recent.length >= webhookLimit.count) { webhookFires.set(id, recent); return "rate-limited"; }
    webhookFires.set(id, [...recent, now().getTime()]);
    store.recordAudit("flow.webhook-fired", { actorId: flow.createdBy, subjectId: id, details: { source: source ? String(source).slice(0, 60) : null } });
    // Unhandled here would reject an un-awaited promise; a remote caller must never be able to
    // crash the web process, so the run is fired and its own failures are swallowed after being
    // recorded inside runUnderCreator.
    void runUnderCreator(flow, "was fired by its webhook but did not run").catch(() => {});
    return "accepted";
  }

  /** One flow run under its creator's stored authority, with refusals recorded and notified. */
  async function runUnderCreator(flow, refusalPhrase) {
    if (running.has(flow.id)) return;
    const creator = store.findOwnerById?.(flow.createdBy) ?? null;
    try {
      // No creator means no authority to borrow: refuse rather than run at owner privilege, or a
      // deleted operator's flow fired by webhook would escalate to owner.
      if (!creator) throw new Error("the flow's creator no longer exists");
      if (["viewer", "disabled"].includes(creator.role)) throw new Error(`${creator.username} can no longer approve jobs`);
      await run(flow.id, flow.createdBy, { role: creator.role });
    } catch (error) {
      if (!recordedRunFailure.test(error.message)) {
        store.markFlowRun(flow.id, { result: `skipped: ${error.message}`.slice(0, 300), jobIds: [] });
        store.recordAudit("flow.skipped", { actorId: flow.createdBy, subjectId: flow.id, details: { reason: error.message.slice(0, 200) } });
        notify?.(`${flow.name} ${refusalPhrase}: ${error.message}`.slice(0, 300));
      }
    }
  }

  /**
   * Start the flows wired to run after this one completed, each under its own creator's stored
   * authority with the same refusals as a scheduled run. A follower failing is its own story,
   * recorded on the follower; it never rewrites the finished flow's result. Depth is bounded so
   * a chain someone managed to loop past validation cannot run forever.
   */
  async function runFollowers(flowId, { depth = 0 } = {}) {
    if (depth >= chainLimit) return;
    for (const follower of store.listFlowsTriggeredBy?.(flowId) ?? []) {
      await runUnderCreatorAtDepth(follower, depth + 1);
    }
  }

  /** runUnderCreator, threading the chain depth so follower cascades stay bounded. */
  async function runUnderCreatorAtDepth(flow, chainDepth) {
    if (running.has(flow.id)) return;
    const creator = store.findOwnerById?.(flow.createdBy) ?? null;
    try {
      if (!creator) throw new Error("the flow's creator no longer exists");
      if (["viewer", "disabled"].includes(creator.role)) throw new Error(`${creator.username} can no longer approve jobs`);
      await run(flow.id, flow.createdBy, { role: creator.role, chainDepth });
    } catch (error) {
      if (!recordedRunFailure.test(error.message)) {
        store.markFlowRun(flow.id, { result: `skipped: ${error.message}`.slice(0, 300), jobIds: [] });
        store.recordAudit("flow.skipped", { actorId: flow.createdBy, subjectId: flow.id, details: { reason: error.message.slice(0, 200) } });
        notify?.(`${flow.name} was due to run after another flow but did not: ${error.message}`.slice(0, 300));
      }
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
          if (!creator) throw new Error("the flow's creator no longer exists");
          if (["viewer", "disabled"].includes(creator.role)) throw new Error(`${creator.username} can no longer approve jobs`);
          store.updateFlow(flow.id, { nextDueAt }, { actorId: flow.createdBy });
          await run(flow.id, flow.createdBy, { role: creator.role });
          store.recordAudit("flow.scheduled-run", { actorId: flow.createdBy, subjectId: flow.id, details: { nextDueAt } });
        } catch (error) {
          // run() already recorded the failure on the flow; a refusal before it started needs recording here.
          if (!recordedRunFailure.test(error.message)) {
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

  /**
   * A run lives in this process, so a BoxPilot restart mid-run (a self-update, the upgrade's own
   * deferred service restart, a crash) leaves the record claiming "running step N" forever while
   * the flow looks idle. Startup rewrites those records to what is actually known. The step's own
   * job was already marked by the interrupted-jobs recovery, and may well have finished on its
   * own; the record says to check it rather than guessing.
   */
  function recover() {
    let recovered = 0;
    for (const flow of store.listFlows()) {
      if (!flow.lastResult || !flow.lastResult.startsWith("running step")) continue;
      const summary = `interrupted by a BoxPilot restart while ${flow.lastResult}; the step's job record says how far it got, and later steps did not run`.slice(0, 300);
      store.markFlowRun(flow.id, { result: summary, jobIds: flow.lastJobIds ?? [] });
      store.recordAudit("flow.interrupted", { actorId: flow.createdBy, subjectId: flow.id, details: { was: flow.lastResult.slice(0, 200) } });
      notify?.(`${flow.name} was ${summary}`);
      recovered += 1;
    }
    return recovered;
  }

  function start(intervalMs = 60_000) {
    recover();
    const timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /**
   * Steps a flow can be built from without a parameter form: registered low and medium operations
   * every field of which is optional. The palette maintains itself as the registry grows.
   */
  function stepPalette() {
    const isScalar = (field) => ["string", "number", "boolean", undefined].includes(field.type);
    return registry.list()
      .filter((operation) => operation.risk !== "high" && !operation.readOnly)
      // Buildable by a plain form, and never able to store a secret in the flow's JSON. A field
      // that is not a scalar (an array of packages, an object of app values) is fine only when it
      // is optional: the form omits it, which is valid. A required non-scalar field, or any secret
      // field, takes the whole operation out — the app-specific form is the place for those.
      .filter((operation) => Object.values(operation.parameters?.fields ?? {}).every((field) => !field.secret && (isScalar(field) || field.optional)))
      .map((operation) => ({
        operationId: operation.id, title: operation.title, risk: operation.risk, description: operation.description ?? "",
        // Only the scalar fields are offered; an optional non-scalar one is simply left unset.
        fields: Object.entries(operation.parameters?.fields ?? {}).filter(([, field]) => isScalar(field)).map(([name, field]) => ({
          name, type: field.type ?? "string", optional: Boolean(field.optional),
          enum: Array.isArray(field.enum) ? field.enum : null, default: field.default ?? null,
        })),
      }));
  }

  return { create, list, update, remove, run, tick, start, recover, stepPalette, mintWebhook, clearWebhook, fireWebhook };
}
