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
 * the operations router checks one by one); operators change the box but not its settings or people;
 * disabled accounts get nothing. Express routes case-insensitively and with or without a trailing
 * slash, so the policy compares the path lower-cased and without one: `/Operations/x/run/` is the
 * route `/operations/x/run`, and must be judged as that route.
 */
export function apiRolePolicy() {
  return function rolePolicy(request, response, next) {
    const role = request.boxpilotSession?.owner?.role ?? "owner";
    const reading = reads.has(request.method);
    const pathname = request.path.toLowerCase().replace(/(.)\/+$/, "$1");
    const readOnlyRun = /^\/operations\/[^/]+\/run$/.test(pathname);
    const selfService = pathname === "/auth/logout" || pathname === "/auth/elevate" || pathname === "/auth/password";
    if (role === "disabled") return response.status(403).json({ error: "This account is disabled", code: "forbidden" });
    if (role === "viewer" && !reading && !readOnlyRun && !selfService) return response.status(403).json({ error: "Viewers can look but not change anything", code: "forbidden" });
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
