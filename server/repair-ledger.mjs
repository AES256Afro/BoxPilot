/**
 * What Repair remembers between scans (M35): the findings the owner chose to put aside, and which
 * job was started to fix which finding.
 *
 * A dismissal is the owner saying "I know, and not now", with the reason in their words. It holds
 * only while the finding says what it said then (its fingerprint: severity, title and evidence), so
 * one that gets worse or changes comes back by itself, marked as back. A critical finding is never
 * hidden: a dismissal of one is kept, but the finding stays in the list, and is refused at the door.
 *
 * An attempt links a job to the finding it was started from. It is what lets a failed fix be shown
 * on its finding ("Last try failed: ... Try again") rather than as a separate failure on Home, and
 * lets that failure drop away by itself once the finding it was fixing is gone.
 *
 * Pure: the route reads and writes the two settings, this decides what they mean.
 */
import { fingerprintOf } from "./remediations.mjs";

export const dismissalsKey = "repairDismissals";
export const attemptsKey = "repairAttempts";
/** How many attempts are remembered; jobs themselves are pruned long before this matters. */
export const attemptLimit = 200;
/** How many dismissals are remembered; a finding id is at most one entry. */
export const dismissalLimit = 200;

export const findingIdPattern = /^[A-Za-z0-9][A-Za-z0-9 :._-]{0,160}$/;
export const jobIdPattern = /^[A-Za-z0-9-]{1,64}$/;

/** A dismissal to store, or the reason it is refused. `key` is a finding id, or job:<id> for a failed job. */
export function dismissalFrom(body, { by = null, now = () => new Date() } = {}) {
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 1 || reason.length > 200) return { error: "Say why in 1 to 200 characters, so whoever reads this later knows" };
  if (typeof body?.jobId === "string") {
    if (!jobIdPattern.test(body.jobId)) return { error: "That is not a job id" };
    return { key: `job:${body.jobId}`, entry: { kind: "job", reason, at: now().toISOString(), by } };
  }
  if (typeof body?.id !== "string" || !findingIdPattern.test(body.id)) return { error: "That is not a finding id" };
  if (body.severity === "critical") return { error: "A critical finding stays until it is fixed, so it cannot be dismissed" };
  if (typeof body.fingerprint !== "string" || !/^[0-9a-f]{16}$/.test(body.fingerprint)) return { error: "Dismiss the finding as it is shown now: its fingerprint is missing" };
  return { key: body.id, entry: { kind: "finding", fingerprint: body.fingerprint, reason, at: now().toISOString(), by } };
}

/** The ledger with one dismissal added, oldest dropped past the limit. */
export function withDismissal(dismissals, key, entry) {
  const next = { ...(dismissals ?? {}), [key]: entry };
  const keys = Object.keys(next);
  if (keys.length <= dismissalLimit) return next;
  const oldest = keys.sort((a, b) => String(next[a].at).localeCompare(String(next[b].at))).slice(0, keys.length - dismissalLimit);
  for (const drop of oldest) delete next[drop];
  return next;
}

/** The ledger with one attempt added, oldest dropped past the limit. */
export function withAttempt(attempts, jobId, findingId, { now = () => new Date() } = {}) {
  const next = { ...(attempts ?? {}), [jobId]: { findingId, at: now().toISOString() } };
  const keys = Object.keys(next);
  if (keys.length <= attemptLimit) return next;
  const oldest = keys.sort((a, b) => String(next[a].at).localeCompare(String(next[b].at))).slice(0, keys.length - attemptLimit);
  for (const drop of oldest) delete next[drop];
  return next;
}

const sameValue = (left, right) => JSON.stringify(left) === JSON.stringify(right);
/** Whether `job` ran `fix`: the same operation, with every parameter the fix names the same (prepare hooks may add more). */
export function ranFix(job, fix) {
  if (!job || !fix || fix.kind === "schedule" || job.type !== `op:${fix.operationId}`) return false;
  const given = job.parameters ?? {};
  return Object.entries(fix.parameters ?? {}).every(([key, value]) => sameValue(given[key], value));
}

const at = (job) => job?.updatedAt ?? job?.createdAt ?? null;
const newestFirst = (a, b) => String(at(b)).localeCompare(String(at(a)));

/**
 * The findings as the owner should see them: each with its fingerprint, the last job that tried to
 * fix it, and whether it came back after a dismissal; the ones set aside, separately; and which
 * failed jobs the page must not show as failures of their own.
 *
 * `jobs` are the jobs the caller may see (newest first or not), `attempts` and `dismissals` the two
 * settings.
 */
export function applyLedger(findings = [], { dismissals = {}, attempts = {}, jobs = [] } = {}) {
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const recent = [...jobs].sort(newestFirst);
  const active = [];
  const dismissed = [];
  const attached = new Set();
  for (const entry of findings) {
    const fingerprint = fingerprintOf(entry);
    const fixes = entry.fixes ?? (entry.fix ? [entry.fix] : []);
    // The newest job started from this finding, or failing that, one that ran one of its fixes.
    const linked = Object.entries(attempts ?? {}).filter(([, attempt]) => attempt?.findingId === entry.id).map(([jobId]) => byId.get(jobId)).filter(Boolean).sort(newestFirst)[0] ?? null;
    const matched = recent.find((job) => fixes.some((fix) => ranFix(job, fix))) ?? null;
    const last = [linked, matched].filter(Boolean).sort(newestFirst)[0] ?? null;
    const lastAttempt = last ? {
      jobId: last.id, state: last.state, error: last.error ?? null, at: at(last), title: last.title,
      operationId: last.type.replace(/^op:/, ""), label: fixes.find((fix) => ranFix(last, fix))?.label ?? null,
    } : null;
    if (last && last.state === "failed") attached.add(last.id);
    const dismissal = dismissals?.[entry.id];
    const annotated = { ...entry, fingerprint, lastAttempt };
    if (dismissal?.kind === "finding" && dismissal.fingerprint === fingerprint && entry.severity !== "critical") {
      dismissed.push({ ...annotated, dismissal: { reason: dismissal.reason, at: dismissal.at, by: dismissal.by ?? null } });
      continue;
    }
    // Dismissed as it was, and not the same any more: back, and said to be back.
    active.push(dismissal?.kind === "finding" ? { ...annotated, returned: { reason: dismissal.reason, at: dismissal.at, why: entry.severity === "critical" ? "critical" : "changed" } } : annotated);
  }
  const present = new Set(findings.map((entry) => entry.id));
  // A failed job started from a finding that is gone now: what it was fixing is fixed, one way or another.
  const resolved = Object.entries(attempts ?? {}).filter(([jobId, attempt]) => byId.get(jobId)?.state === "failed" && !present.has(attempt?.findingId)).map(([jobId]) => jobId);
  const dismissedJobs = Object.entries(dismissals ?? {}).filter(([key, entry]) => entry?.kind === "job" && key.startsWith("job:")).map(([key]) => key.slice(4)).filter((jobId) => byId.has(jobId));
  return { findings: active, dismissed, jobs: { attached: [...attached], resolved, dismissed: dismissedJobs } };
}
