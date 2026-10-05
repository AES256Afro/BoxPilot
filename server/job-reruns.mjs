/**
 * Interrupted jobs run again where that is safe (M30.2).
 *
 * A BoxPilot restart - a self-update, a crash - cuts off whatever was running, and startup marks
 * those jobs failed (state.recoverInterruptedJobs). Most of them changed the server and may have
 * finished on their own, so they stay failed and the owner is told to check. A job whose operation
 * is safe to repeat - a read, or a registry entry that says `rerunAfterInterrupt` - is instead
 * staged again, once, as the person who started it, through the ordinary approval path, and the
 * two records name each other.
 *
 * Not run again, whatever the registry says:
 * - a job that was itself a rerun: one rerun per job, so a restart loop cannot become a job loop;
 * - a job staged with secrets: they lived in memory and did not survive the restart;
 * - a scheduled run or an automation's step: the schedule runs again at its next time and says so,
 *   and a step run on its own would not finish the automation;
 * - anything while approvals are set to always ask for the owner password;
 * - a job whose creator can no longer approve jobs.
 *
 * A job BoxPilot restarted before it began (it was still waiting behind earlier work in the helper,
 * state.recoverInterruptedJobs) changed nothing, so its operation need not be safe to repeat: it runs
 * now as it would have, unless approving it again needs a person - the owner's password, a typed
 * confirmation - or it can restart BoxPilot itself, by its operation or as a Services restart of
 * BoxPilot's own unit.
 */
import { registry as defaultRegistry } from "./ops/index.mjs";
import { placeholderPaths, rerunsAfterInterrupt } from "./ops/registry.mjs";
import { defaultApprovalMode, normalizeApprovalMode } from "./ops/risk.mjs";
import { restartsBoxPilot } from "./ops/services.mjs";

/** Why an interrupted job is not run again, as the end of a sentence; null when it is. Pure. */
export function rerunRefusal(job, { registry = defaultRegistry, approvalMode = defaultApprovalMode, startedBy = null, creator = null, neverStarted = false } = {}) {
  const operation = typeof job?.type === "string" && job.type.startsWith("op:") ? registry.get(job.type.slice(3)) : null;
  if (!operation) return "it is not a registered operation";
  if (neverStarted) {
    if ((job.risk ?? operation.risk) === "high") return "it is high risk, and approving it again takes the owner's password";
    if (operation.confirm) return "it asks for a typed confirmation, which is given each time";
    // A Services restart of BoxPilot's own unit is the same restart by another door (jobs.mjs).
    if (operation.restartsService || restartsBoxPilot(operation.id, job.parameters ?? {})) return "it can restart BoxPilot, so a person starts it again";
  } else if (!rerunsAfterInterrupt(operation)) return "it changes the server and may have finished on its own, so check what it did first";
  if (job.recovery?.rerunOf) return "it was already the second run";
  if (job.recovery?.approvalExpiresAt || placeholderPaths(job.parameters ?? {}).length) return "the passwords it was given do not survive a restart";
  if (startedBy === "schedule") return "its schedule runs it again at the next time";
  if (startedBy === "automation") return "it was a step of an automation, which reports what happened";
  if (normalizeApprovalMode(approvalMode) === "always-password") return "approvals are set to always ask for the owner password";
  if (!creator || ["viewer", "disabled"].includes(creator.role)) return "the person who started it can no longer approve jobs";
  return null;
}

/**
 * Decide, at startup, which interrupted jobs run again; `start()` stages and starts them. Deciding
 * is synchronous so the caller can announce the rest at once; starting waits until the notifier
 * and the scheduler are listening, so a rerun that fails straight away is still reported.
 *
 * `interrupted` is what recoverInterruptedJobs returned; `scheduled` the ids the scheduler claimed.
 * `announce(job)` is today's "was interrupted" notice, used for a rerun that could not start.
 */
export function planInterruptedReruns(interrupted, { store, jobs, registry = defaultRegistry, scheduled = new Set(), announce = () => {} }) {
  // An automation's run keeps the ids of its step jobs, finished or not.
  let flowJobIds = new Set();
  try { flowJobIds = new Set((store.listFlows?.() ?? []).flatMap((flow) => flow.lastJobIds ?? []).filter(Boolean)); } catch { /* unsure means not run again */ flowJobIds = null; }
  const approvalMode = store.getSetting?.("approvalMode", null) ?? process.env.BOXPILOT_APPROVAL_MODE ?? defaultApprovalMode;
  const planned = [];
  const neverStarted = new Set(interrupted.filter((entry) => entry.neverStarted).map((entry) => entry.id));
  for (const { id } of interrupted) {
    const job = store.getJob(id);
    if (!job) continue;
    const startedBy = scheduled.has(id) ? "schedule" : flowJobIds === null || flowJobIds.has(id) ? "automation" : null;
    const refusal = rerunRefusal(job, { registry, approvalMode, startedBy, creator: store.findOwnerById?.(job.createdBy) ?? null, neverStarted: neverStarted.has(id) });
    if (refusal) {
      // Only the jobs that would otherwise have run again get a reason; the rest keep today's record.
      if (neverStarted.has(id) || rerunsAfterInterrupt(registry.get(job.type.slice(3)))) store.addJobStep(id, "rerun", "skipped", `Not run again: ${refusal}`.slice(0, 500));
      continue;
    }
    planned.push(job);
  }
  const ids = new Set(planned.map((job) => job.id));

  async function start() {
    const reruns = [];
    for (const job of planned) {
      let rerun = null;
      try {
        const role = store.findOwnerById?.(job.createdBy)?.role ?? "owner";
        // Same operation, same parameters, same budget (a job given more time keeps it).
        rerun = await jobs.createOperationJob(job.type.slice(3), job.parameters ?? {}, job.createdBy, { role, rerunOf: job.id, budgetMs: job.recovery?.budgetMs ?? null, ...(neverStarted.has(job.id) ? { rerunNeverStarted: true } : {}) });
        store.addJobStep(job.id, "rerun", "started", `Running again as job ${rerun.id}`);
        await jobs.approveAndStart(rerun.id, job.createdBy, {});
        store.recordAudit("job.rerun", { actorId: job.createdBy, subjectId: rerun.id, details: { type: job.type, rerunOf: job.id } });
        reruns.push(rerun);
      } catch (error) {
        // Staged but not started: withdraw it rather than leave it waiting for an approval nobody will give.
        if (rerun) { try { jobs.cancelJob(rerun.id, job.createdBy, { role: "owner", reason: `Could not run again after the restart: ${error.message}`.slice(0, 200) }); } catch { /* already moved on */ } }
        store.addJobStep(job.id, "rerun", "failed", `Could not run it again: ${error.message}`.slice(0, 500));
        try { announce(neverStarted.has(job.id) ? { ...job, neverStarted: true } : job); } catch { /* the job record says it */ }
      }
    }
    return reruns;
  }

  return { has: (id) => ids.has(id), planned, start };
}
