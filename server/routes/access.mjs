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
 * A path without its trailing slashes, "/" itself kept. It was `replace(/(.)\/+$/, "$1")`, which read
 * a run of slashes again from each one of them when the path went on after it: a 16 KB path of
 * slashes took 70 ms of the event loop per request (sweep 5).
 */
function withoutTrailingSlashes(path) {
  let end = path.length;
  while (end > 1 && path[end - 1] === "/") end -= 1;
  return path.slice(0, end);
}

/**
 * The /api/v1 role policy, ahead of every router: viewers look (and run read-only operations, which
 * the operations router checks one by one, and ask the assistant, which only reads and answers from
 * what the asker may read); operators change the box but not its settings or people - Repair's
 * dismissals and fix attempts (M35) are theirs as fixing is - and disabled accounts get nothing.
 * Express routes case-insensitively and with or without a trailing slash, so
 * the policy compares the path lower-cased and without one: `/Operations/x/run/` is the route
 * `/operations/x/run`, and must be judged as that route.
 */
export function apiRolePolicy() {
  return function rolePolicy(request, response, next) {
    const role = request.boxpilotSession?.owner?.role ?? "owner";
    const reading = reads.has(request.method);
    const pathname = withoutTrailingSlashes(request.path.toLowerCase());
    const readOnlyRun = /^\/operations\/[^/]+\/run$/.test(pathname);
    // Asking the assistant, or an agent someone may borrow (M37): both only read, as the asker.
    const asking = request.method === "POST" && (pathname === "/assistant/ask" || /^\/agents\/[^/]+\/ask$/.test(pathname));
    // A person's own with an agent (M37): saying whether an answer was right, and making it forget
    // the conversation with them. The service allows each only on the caller's own run or thread.
    const ownWithAgent = (request.method === "POST" && /^\/agents\/runs\/[^/]+\/feedback$/.test(pathname)) || (request.method === "DELETE" && /^\/agents\/[^/]+\/memory\/thread$/.test(pathname));
    // Marking the notification centre seen (M36) is the caller's own, like signing out.
    const selfService = pathname === "/auth/logout" || pathname === "/auth/elevate" || pathname === "/auth/password" || pathname === "/notifications/seen";
    if (role === "disabled") return response.status(403).json({ error: "This account is disabled", code: "forbidden" });
    if (role === "viewer" && !reading && !readOnlyRun && !asking && !ownWithAgent && !selfService) return response.status(403).json({ error: "Viewers can look but not change anything", code: "forbidden" });
    if (role === "operator" && !reading && (pathname.startsWith("/settings") || pathname.startsWith("/people"))) return response.status(403).json({ error: "Only the owner can change settings or people", code: "forbidden" });
    return next();
  };
}

/**
 * The agents runner's identity (M37): not a person and not a session, but one scoped key that opens
 * the runner's own routes (/api/v1/agent-runner/...) and nothing else. Every other route asks for a
 * session, which this key is not, so it is refused there as an anonymous caller would be. On its
 * own routes it can only ask for work, report steps, ask for a read-only tool by name on a run it
 * holds the lease of, and finish; it can stage, approve and run nothing.
 *
 * Only from this machine: the runner talks over loopback, and a request that came through a proxy
 * (Tailscale Serve, which also connects from loopback, sets forwarding headers) is refused even
 * with the right key. `verify(token)` compares digests; `limit` is a rate limit for the runner.
 */
const loopbackPeer = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;
const proxyHeaders = ["x-forwarded-for", "x-forwarded-host", "forwarded", "tailscale-user-login", "x-real-ip"];

export function agentRunnerAuth({ verify, limit = null }) {
  return function runnerAuth(request, response, next) {
    const local = loopbackPeer.test(String(request.socket?.remoteAddress ?? "")) && !proxyHeaders.some((name) => request.get(name) !== undefined);
    const match = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(request.get("authorization") ?? "");
    if (!local || !match || !verify(match[1])) return response.status(401).json({ error: "The agents runner's key is missing or wrong", code: "runner_unauthorized" });
    if (limit && !limit.take("runner")) return response.status(429).json({ error: "The agents runner is calling too often", code: "runner_rate_limited" });
    const runnerId = request.body?.runnerId;
    if (typeof runnerId !== "string" || !/^[0-9a-f-]{36}$/i.test(runnerId)) return response.status(400).json({ error: "runnerId must be the runner's id", code: "invalid_runner" });
    request.agentRunner = { runnerId };
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
 * The kinds of alert and news about the server itself, whose words every role reads in full: a disk,
 * a drive, the UPS, services, containers, BoxPilot's own job logs, a new release. Any other kind is
 * about somebody's work or is the owner's (sweep 3): the weekly report names every account's failed
 * jobs, which only the owner may preview. A kind added later is the owner's until it is put here.
 */
const everyonesFamilies = new Set([
  "storage.root.full", "storage.mount.full", "storage.smart", "storage.mount.detached", "storage.mount.readonly", "storage.forecast",
  "smart.errors", "smart.wear", "power.ups", "system.services", "system.reboot", "docker.unhealthy", "docker.restarting",
  "joblog.unreadable", "release.available", "drive.reconnected", "boxpilot.restart",
]);

/**
 * A health-alert ledger entry as this caller may read it (M29.4): its words and its key. Every role
 * sees that a condition is live; the words of one about another account's work - a schedule of
 * theirs, an automation's run, their sign-in from a new address - go only to the owner and to that
 * account. Everyone else reads what kind of thing it is, and its key is cut back to that kind,
 * because the rest of the key names the schedule, the account or the subject.
 * `scheduleOwner(id)` answers who created a schedule. An automation's failure carries its step's job
 * error, which GET /flows keeps to the owner and to the account whose run it was (flowForCaller): the
 * entry names who ran the run its words describe (`actorId`, recorded as it was raised), and one
 * recorded before that was kept is the owner's. `full` says whether the caller may read the rest of
 * the entry (its message): a key with no subject, like the weekly report's, is not shortened when cut.
 */
export function watchEntryFor(request, key, entry, label, scheduleOwner = () => null) {
  const title = entry?.title ?? key;
  const [family, subject] = String(key).split(":");
  if (seesEveryAccount(request)) return { title, key, full: true };
  const self = callerId(request);
  const theirs = everyonesFamilies.has(family) ? true
    : family === "schedule.failed" || family === "schedule.overdue" ? Boolean(self && scheduleOwner(subject) === self)
    : family === "flow.failed" ? Boolean(self && typeof entry?.actorId === "string" && entry.actorId === self)
    : family === "signin.new" ? Boolean(self && subject === self)
    // Everything else: a job a restart cut off or a result not saved (named by operation and subject
    // rather than by job, so whose it was cannot be told apart), a job that lapsed waiting for
    // approval, an agent's notice (written from what its maker's run read), the weekly report.
    : false;
  return theirs ? { title, key, full: true } : { title: label, key: family, full: false };
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
