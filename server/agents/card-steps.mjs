/**
 * The cards agents leave, in the web process: listed, decided, and each step tied to the job it was
 * staged as, so the card is decided once every step's job is approved wherever that was. Part of
 * the agents service (service.mjs), which hands it what it uses.
 */

/**
 * @param {{
 *   store: any, state: any, audit: (type: string, entry: object) => void,
 *   refuse: (status: number, message: string, code?: string) => never,
 *   personOf: (caller: any) => { id: string, role: string },
 *   canSeeProposal: (caller: any, proposal: any) => boolean,
 *   presentProposal: (caller: any, proposal: any) => any, rememberProposal: (proposal: any) => any,
 * }} deps
 */
export function createCardSteps({ store, state, audit, refuse, personOf, canSeeProposal, presentProposal, rememberProposal }) {
  function listProposals(caller) {
    const person = personOf(caller);
    if (person.role === "viewer") return [];
    return store.listProposals().filter((proposal) => canSeeProposal(person, proposal)).map((proposal) => presentProposal(person, proposal)).filter((proposal) => proposal.state === "open");
  }

  /**
   * @param {any} caller
   * @param {string} proposalId
   * @param {{ decision?: string, jobIds?: unknown[] }} [body]
   */
  function decideProposal(caller, proposalId, { decision, jobIds = [] } = {}) {
    const person = personOf(caller);
    if (!["owner", "operator"].includes(person.role)) refuse(403, "Viewers cannot act on cards", "forbidden");
    const proposal = store.getProposal(proposalId);
    if (!proposal || !canSeeProposal(person, proposal)) refuse(404, "There is no such card", "proposal_not_found");
    if (!["dismissed", "staged"].includes(decision)) refuse(400, "A card is dismissed, or its steps staged", "invalid_decision");
    const shaped = Array.isArray(jobIds) ? jobIds.filter((id) => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)).slice(0, 8) : [];
    // Only jobs this person staged, or any for the owner (M50): an id was taken on its shape alone.
    const ids = typeof state.getJob === "function" && person.role !== "owner" ? shaped.filter((id) => state.getJob(id)?.createdBy === person.id) : shaped;
    const decided = store.decideProposal(proposal.id, { state: decision, decidedBy: person.id, jobIds: ids });
    if (!decided) refuse(409, "That card was already decided", "proposal_decided");
    audit("agents.proposal.decided", { actorId: person.id, subjectId: proposal.id, details: { decision, jobs: ids.length } });
    rememberProposal(decided);
    return presentProposal(person, decided);
  }

  // ---- a card's steps and the jobs staged for them (2026-10 sweep 3) ----
  // Which job each step was staged as is kept here, so every page that draws the card knows it, and
  // the card is decided once every step's job is approved, wherever that was: the card's own dialog,
  // a push, Activity or Today. Only the dialog that staged a step used to know either.

  /** A step by its job: ready to stage (no job, or one cancelled, gone or never started), waiting, approved, or failed once started. */
  function stepStatus(job) {
    if (!job || job.state === "cancelled") return "ready";
    if (job.state === "awaiting_approval") return "waiting";
    if (job.state === "failed") return job.timeout?.phase === "queued" ? "ready" : "failed";
    return "approved";
  }
  const stepJob = (step) => (typeof step?.jobId === "string" ? state.getJob?.(step.jobId) ?? null : null);
  /** A step as a person is shown it: how its job stands, and the job's id to the owner and whoever staged it. */
  function presentStep(caller, step) {
    const job = stepJob(step);
    return { ...step, jobId: job && (caller.role === "owner" || job.createdBy === caller.id) ? job.id : null, jobState: job?.state ?? null, status: stepStatus(job) };
  }

  /** An open card whose every step's job was approved is decided, staged, by whoever approved the last. */
  function settleProposal(proposal) {
    if (proposal?.state !== "open" || !proposal.steps?.length || !proposal.steps.every((step) => step.jobId)) return proposal;
    const jobs = proposal.steps.map(stepJob);
    if (!jobs.every((job) => ["approved", "failed"].includes(stepStatus(job)))) return proposal;
    const last = jobs.flatMap((job) => job.approvals ?? []).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).at(-1);
    const decidedBy = last?.ownerId ?? jobs.at(-1).createdBy ?? null;
    const decided = store.decideProposal(proposal.id, { state: "staged", decidedBy, jobIds: jobs.map((job) => job.id) });
    if (!decided) return store.getProposal(proposal.id) ?? proposal;
    audit("agents.proposal.decided", { actorId: decidedBy, subjectId: proposal.id, details: { decision: "staged", jobs: jobs.length, automatic: true } });
    rememberProposal(decided);
    return decided;
  }

  /** A value written the same whatever order its keys came in. */
  const canonical = (value) => JSON.stringify(value, (_key, inner) => (inner && typeof inner === "object" && !Array.isArray(inner) ? Object.fromEntries(Object.keys(inner).sort().map((name) => [name, inner[name]])) : inner));

  /**
   * "This step was staged as this job": the caller's own job, for the step's operation with the
   * step's settings (a prepare hook may have pinned more beside them), on a card still open. A step
   * whose job waits or was approved is not taken again: that is how an operation ran twice.
   */
  /**
   * @param {any} caller
   * @param {string} proposalId
   * @param {number | string} index
   * @param {{ jobId?: string }} [body]
   */
  function stageProposalStep(caller, proposalId, index, { jobId } = {}) {
    const person = personOf(caller);
    if (!["owner", "operator"].includes(person.role)) refuse(403, "Viewers cannot act on cards", "forbidden");
    const proposal = store.getProposal(proposalId);
    if (!proposal || !canSeeProposal(person, proposal)) refuse(404, "There is no such card", "proposal_not_found");
    const at = Number(index);
    const step = Number.isInteger(at) && at >= 0 ? proposal.steps[at] : undefined;
    if (!step) refuse(404, "That card has no such step", "step_not_found");
    if (typeof jobId !== "string" || !/^[0-9a-f-]{36}$/i.test(jobId)) refuse(400, "Say which job the step was staged as", "invalid_job");
    const job = state.getJob?.(jobId) ?? null;
    // Someone else's job and no job get the same answer: neither is this person's to name.
    if (!job || job.createdBy !== person.id) refuse(404, "There is no such job", "job_not_found");
    const same = job.type === `op:${step.operationId}` && Object.entries(step.parameters ?? {}).every(([name, value]) => canonical(value) === canonical(job.parameters?.[name]));
    if (!same) refuse(409, "That job is not this step: it runs another operation, or with other settings", "job_mismatch");
    // The same job again (named once staged, and again once approved) changes nothing.
    if (step.jobId === job.id) return presentProposal(person, proposal);
    if (proposal.state !== "open") refuse(409, "That card was already decided", "proposal_decided");
    if (["waiting", "approved"].includes(stepStatus(stepJob(step)))) refuse(409, "This step is already staged: review the job waiting for it instead", "step_staged");
    if (job.state === "cancelled") refuse(409, "That job was cancelled. Stage the step again", "job_cancelled");
    if (store.listOpenProposalsForJob(job.id).length) refuse(409, "That job was staged for another step", "job_taken");
    const recorded = store.setProposalStepJob(proposal.id, at, job.id);
    if (!recorded) refuse(409, "That card was already decided", "proposal_decided");
    audit("agents.proposal.step-staged", { actorId: person.id, subjectId: proposal.id, details: { step: at, operationId: step.operationId } });
    return presentProposal(person, recorded);
  }

  /** One card, read again when a dialog for one of its steps closes. */
  function getProposal(caller, proposalId) {
    const person = personOf(caller);
    const proposal = person.role === "viewer" ? null : store.getProposal(proposalId);
    if (!proposal || !canSeeProposal(person, proposal)) refuse(404, "There is no such card", "proposal_not_found");
    return presentProposal(person, proposal);
  }

  return { listProposals, decideProposal, presentStep, settleProposal, stageProposalStep, getProposal };
}
