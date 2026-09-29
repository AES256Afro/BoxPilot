/**
 * Who may call what, and what a composite route may hand back to them (M29.4).
 *
 * A direct operation is checked by the registry: its `minimumRole`, and ADR-003's rule for reads
 * that see past the caller's own permissions. A composite route - the Overview, the catalog, Repair,
 * the evidence lists, the support bundle - assembles its answer from several sources and never asks
 * an operation's question. Two rules keep it from answering more than the caller could ask for:
 *
 * - Another account's work is the owner's to see. Everyone else sees their own jobs, and the
 *   records their jobs left behind carry no other account's id.
 * - An operator-gated read (ADR-003) is not run for a viewer on a composite route's behalf, or
 *   its gated fields are removed before the answer goes out.
 */

const reads = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The /api/v1 role policy, ahead of every router: viewers look (and run read-only operations, which
 * the operations router checks one by one, and ask the assistant, which only reads and answers from
 * what the asker may read); operators change the box but not its settings or people; disabled
 * accounts get nothing. Express routes case-insensitively and with or without a trailing slash, so
 * the policy compares the path lower-cased and without one: `/Operations/x/run/` is the route
 * `/operations/x/run`, and must be judged as that route.
 */
export function apiRolePolicy() {
  return function rolePolicy(request, response, next) {
    const role = request.boxpilotSession?.owner?.role ?? "owner";
    const reading = reads.has(request.method);
    const pathname = request.path.toLowerCase().replace(/(.)\/+$/, "$1");
    const readOnlyRun = /^\/operations\/[^/]+\/run$/.test(pathname);
    const asking = request.method === "POST" && pathname === "/assistant/ask";
    // Marking the notification centre seen (M36) is the caller's own, like signing out.
    const selfService = pathname === "/auth/logout" || pathname === "/auth/elevate" || pathname === "/auth/password" || pathname === "/notifications/seen";
    if (role === "disabled") return response.status(403).json({ error: "This account is disabled", code: "forbidden" });
    if (role === "viewer" && !reading && !readOnlyRun && !asking && !selfService) return response.status(403).json({ error: "Viewers can look but not change anything", code: "forbidden" });
    if (role === "operator" && !reading && (pathname.startsWith("/settings") || pathname.startsWith("/people"))) return response.status(403).json({ error: "Only the owner can change settings or people", code: "forbidden" });
    return next();
  };
}

/** The signed-in account's id, or null. */
export const callerId = (request) => request.boxpilotSession?.owner?.id ?? null;

/** Only the owner sees every account's jobs, and so every account's traces. No session sees nothing. */
export const seesEveryAccount = (request) => request.boxpilotSession?.owner?.role === "owner";

/** Whether an operator-gated read (ADR-003) may run on this caller's behalf. */
export const readsThroughHelper = (request) => ["owner", "operator"].includes(request.boxpilotSession?.owner?.role);

/**
 * A health-alert ledger entry as this caller may read it (M29.4): its words and its key. Every role
 * sees that a condition is live; the words of one about another account's work - a job a restart
 * cut off, a result not saved, a schedule of theirs, their sign-in from a new address - go only to
 * the owner and to that account. Everyone else reads what kind of thing it is, and its key is cut
 * back to that kind, because the rest of the key names the schedule, the account or the subject.
 * `scheduleOwner(id)` answers who created a schedule.
 */
export function watchEntryFor(request, key, entry, label, scheduleOwner = () => null) {
  const title = entry?.title ?? key;
  const [family, subject] = String(key).split(":");
  if (seesEveryAccount(request)) return { title, key };
  const self = callerId(request);
  const theirs = family === "schedule.failed" || family === "schedule.overdue" ? Boolean(self && scheduleOwner(subject) === self)
    : family === "signin.new" ? Boolean(self && subject === self)
    // Named by operation and subject rather than by job, so whose it was cannot be told apart.
    : family === "job.interrupted" || family === "record.failed" || family === "approval.lapsed" ? false
    : true;
  return theirs ? { title, key } : { title: label, key: family };
}

/** The fields that name who did something: a job's creator, a drill's runner, a profile's applier. */
const actorFields = new Set(["createdBy", "appliedBy", "by", "actorId", "updatedBy"]);

/**
 * `value` as this caller may see it: every actor field that names another account is null. The
 * owner gets it unchanged. Walks nested objects and arrays, so a history inside a verdict, or a run
 * list inside a retention preview, is covered by the same call as the record around it.
 */
export function withOwnActors(request, value) {
  if (seesEveryAccount(request)) return value;
  const self = callerId(request);
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    return Object.fromEntries(Object.entries(node).map(([key, entry]) => [key, actorFields.has(key) && typeof entry === "string" && entry !== self ? null : walk(entry)]));
  };
  return walk(value);
}
