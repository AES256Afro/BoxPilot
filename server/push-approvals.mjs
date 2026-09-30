/**
 * Push approvals (M25.2): when a job has been waiting for a person's approval for a couple of
 * minutes, the people who could approve it get a push on their phone - "Update an app (Jellyfin):
 * approve?" - that opens BoxPilot at that approval.
 *
 * A push never approves anything. It carries a title, one sentence that is the same for every job
 * of a tier, and a link that names the job's id and nothing else; tapping it opens the ordinary
 * approval dialog, which reads the job again as the signed-in account and asks what that tier always
 * asks (a confirmation, or the password and the typed text). No parameter, no path, no error text,
 * no secret is ever in one: the device shows it on a lock screen, and the push service carries it.
 *
 * Channels: Web Push to the devices each approver turned it on for (the installed app on an iPhone
 * or iPad, iOS 16.4 and later, or any browser), and the notification target (ntfy) when no device
 * of the owner's took it, or always, or never, as the owner chooses. Who gets one: the owner, for
 * every job; an operator, for the jobs they staged that they are allowed to approve.
 *
 * Kept quiet: one push per job, ever; several waiting at once are one push ("3 approvals
 * waiting"); two identical jobs (same operation, same subject) are one; nothing during the owner's
 * quiet hours (what is still waiting afterwards is said once, together); at most one push every
 * two minutes and ten an hour; nothing for a job staged more than a day ago; and nothing at all for
 * a job whose person approves it within the first two minutes - the everyday case of approving in
 * the dialog that staged it.
 */
import { randomUUID } from "node:crypto";
import { checkSubscription, pushRequest } from "./web-push.mjs";

export const pushSettingsKey = "pushApprovals";
export const pushSubscriptionsKey = "pushSubscriptions";
const stateKey = "pushApprovalsState";

export const riskTiers = Object.freeze(["low", "medium", "high"]);
export const ntfyModes = Object.freeze(["fallback", "always", "never"]);

/** On by default for what asks the most of the owner; low-risk jobs rarely wait. */
export const defaultPushSettings = Object.freeze({
  tiers: Object.freeze({ low: false, medium: true, high: true }),
  quietHours: Object.freeze({ enabled: false, start: "22:00", end: "07:00" }),
  ntfy: "fallback",
});

export const pushLimits = Object.freeze({
  graceMs: 2 * 60_000,
  maxAgeMs: 24 * 60 * 60_000,
  minGapMs: 2 * 60_000,
  perHour: 10,
  subscriptionsPerAccount: 10,
  titleChars: 120,
  sweepMs: 30_000,
});

const clock = /^([01]\d|2[0-3]):[0-5]\d$/;
const tierWords = { low: "Low risk", medium: "Medium risk", high: "High risk" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The owner's choices, checked; anything missing takes the default. Throws saying what is wrong. */
export function normalizePushSettings(input = {}) {
  const tiers = { ...defaultPushSettings.tiers };
  for (const tier of riskTiers) {
    const value = input?.tiers?.[tier];
    if (value === undefined) continue;
    if (typeof value !== "boolean") throw new Error(`tiers.${tier} must be true or false`);
    tiers[tier] = value;
  }
  const quiet = { ...defaultPushSettings.quietHours, ...(input?.quietHours ?? {}) };
  if (typeof quiet.enabled !== "boolean") throw new Error("quietHours.enabled must be true or false");
  if (!clock.test(quiet.start) || !clock.test(quiet.end)) throw new Error("Quiet hours are two times of day, like 22:00 and 07:00");
  const ntfy = input?.ntfy ?? defaultPushSettings.ntfy;
  if (!ntfyModes.includes(ntfy)) throw new Error(`ntfy must be one of ${ntfyModes.join(", ")}`);
  return { tiers, quietHours: { enabled: quiet.enabled, start: quiet.start, end: quiet.end }, ntfy };
}

/** Whether `date` (this server's local time) falls in the quiet hours; they may run past midnight. */
export function inQuietHours(quietHours, date) {
  if (!quietHours?.enabled || quietHours.start === quietHours.end) return false;
  const minutes = (text) => Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5));
  const now = date.getHours() * 60 + date.getMinutes();
  const start = minutes(quietHours.start);
  const end = minutes(quietHours.end);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/** An https origin with nothing after it, as a browser's Origin header says it; null otherwise. */
export function cleanOrigin(value) {
  if (typeof value !== "string" || !URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) return null;
  return url.origin;
}

const cut = (text, limit) => (text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`);

/**
 * What one push says. Built from the operation's registered title, the tier, and - for an app's
 * operation - the app's name from the catalog; the job's id goes only into the link and the tag.
 * Nothing the job was given is read here. `jobs` of more than one says how many, and links to Today.
 */
export function approvalMessage(jobs, { origin = null, subjectOf = () => null } = {}) {
  const one = jobs.length === 1 ? jobs[0] : null;
  const link = (query) => (origin ? `${origin}/?${query}` : null);
  if (one) {
    const subject = subjectOf(one);
    const title = cut(`${one.title}${subject ? ` (${subject})` : ""}: approve?`, pushLimits.titleChars);
    const tier = riskTiers.includes(one.risk) ? one.risk : "high";
    return {
      title,
      body: `${tierWords[tier]}. Tap to review it in BoxPilot; nothing runs until you approve it there.`,
      url: uuid.test(one.id) ? link(`approve=${one.id}`) : link("view=today"),
      tag: `approval-${String(one.id).replace(/[^0-9a-f]/gi, "").slice(0, 23)}`,
      key: `approval.waiting:${one.id}`,
    };
  }
  return {
    title: `${jobs.length} approvals waiting`,
    body: "Tap to review them in BoxPilot; nothing runs until you approve each one there.",
    url: link("view=today"),
    tag: "approvals",
    key: "approval.waiting",
  };
}

/**
 * The Web Push payload: Declarative Web Push (Safari 18.4 and later shows it with no worker at all)
 * in a shape the service worker also reads (src/pwa/swRules.js), for every other browser.
 */
export function webPushPayload(message) {
  return {
    web_push: 8030,
    notification: {
      title: message.title,
      body: message.body,
      ...(message.url ? { navigate: message.url } : {}),
      tag: message.tag,
      silent: false,
    },
  };
}

/** Where the subscription's endpoint lives, for the list of devices (never the endpoint itself). */
const serviceOf = (endpoint) => {
  const host = new URL(endpoint).hostname;
  return /apple\.com$/.test(host) ? "Apple" : /googleapis\.com$/.test(host) ? "Google" : /mozilla\.com$/.test(host) ? "Mozilla" : /windows\.com$/.test(host) ? "Microsoft" : host;
};

export function createPushApprovals({
  store,
  notifications = null,
  history = null,
  loadVapid,
  fetcher = fetch,
  subjectOf = () => null,
  mayApprove = defaultMayApprove,
  now = () => new Date(),
  limits = pushLimits,
  timers = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, setTimeout: globalThis.setTimeout },
} = {}) {
  let vapid = null;
  const keys = () => (vapid ??= loadVapid());

  const settings = () => {
    try { return normalizePushSettings(store.getSetting(pushSettingsKey, null) ?? {}); } catch { return normalizePushSettings({}); }
  };
  const openAt = () => cleanOrigin(store.getSetting(pushSettingsKey, null)?.openAt ?? null);
  const subscriptions = () => {
    const value = store.getSetting(pushSubscriptionsKey, []);
    return Array.isArray(value) ? value.filter((entry) => entry && typeof entry.endpoint === "string" && typeof entry.accountId === "string") : [];
  };
  const saveSubscriptions = (entries) => store.setSetting(pushSubscriptionsKey, entries, { updatedBy: null });
  const readState = () => {
    const value = store.getSetting(stateKey, null) ?? {};
    return { pushed: value.pushed && typeof value.pushed === "object" ? value.pushed : {}, sent: Array.isArray(value.sent) ? value.sent : [] };
  };

  function describeSettings() {
    return { ...settings(), openAt: openAt(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null };
  }

  function saveSettings(input, { actorId, origin = null } = {}) {
    const next = normalizePushSettings(input);
    const where = cleanOrigin(origin) ?? openAt();
    store.setSetting(pushSettingsKey, { ...next, openAt: where }, { updatedBy: actorId ?? null });
    store.recordAudit?.("push.settings.changed", { actorId: actorId ?? null, details: { tiers: next.tiers, quietHours: next.quietHours, ntfy: next.ntfy } });
    return describeSettings();
  }

  /** This account's devices, as the page lists them: which push service, when added and last used. */
  function devicesOf(accountId) {
    return subscriptions().filter((entry) => entry.accountId === accountId).map((entry) => ({
      id: entry.id, label: entry.label, service: serviceOf(entry.endpoint), createdAt: entry.createdAt, lastSentAt: entry.lastSentAt ?? null, lastError: entry.lastError ?? null,
    }));
  }

  function subscribe(account, { subscription, origin, label }) {
    if (!["owner", "operator"].includes(account?.role)) throw Object.assign(new Error("Only someone who can approve jobs can get approval pushes"), { status: 403 });
    const checked = checkSubscription(subscription);
    const where = cleanOrigin(origin);
    if (!where) throw new Error("Pushes can only be turned on from BoxPilot's HTTPS address");
    const name = typeof label === "string" && label.trim() ? label.trim().replace(/[^\p{L}\p{N} ().,'-]/gu, "").slice(0, 40) || "This device" : "This device";
    const at = now().toISOString();
    const others = subscriptions().filter((entry) => entry.endpoint !== checked.endpoint);
    const mine = others.filter((entry) => entry.accountId === account.id);
    if (mine.length >= limits.subscriptionsPerAccount) throw new Error(`An account can have pushes on at most ${limits.subscriptionsPerAccount} devices; remove one first`);
    const entry = { id: randomUUID(), accountId: account.id, endpoint: checked.endpoint, keys: checked.keys, origin: where, label: name, vapidKey: keys().publicKey, createdAt: at, lastSentAt: null, lastError: null };
    saveSubscriptions([...others, entry]);
    // The owner's address is where ntfy's pushes link to as well.
    if (account.role === "owner") store.setSetting(pushSettingsKey, { ...settings(), openAt: where }, { updatedBy: account.id });
    store.recordAudit?.("push.device.added", { actorId: account.id, subjectId: entry.id, details: { service: serviceOf(entry.endpoint), label: name } });
    return devicesOf(account.id).find((device) => device.id === entry.id);
  }

  function unsubscribe(account, id) {
    const entries = subscriptions();
    const entry = entries.find((candidate) => candidate.id === id && candidate.accountId === account?.id);
    if (!entry) throw Object.assign(new Error("There is no such device"), { status: 404 });
    saveSubscriptions(entries.filter((candidate) => candidate.id !== id));
    store.recordAudit?.("push.device.removed", { actorId: account.id, subjectId: id, details: { service: serviceOf(entry.endpoint) } });
    return { removed: true };
  }

  /** Send one message to one device. A subscription the push service no longer knows is dropped. */
  async function sendTo(entry, message, { topic = null } = {}) {
    let status = 0;
    let reason = "";
    try {
      const vapidKeys = keys();
      // A device subscribed under a key since replaced (a restore) cannot be reached with this one.
      if (entry.vapidKey && entry.vapidKey !== vapidKeys.publicKey) { status = 410; reason = "subscribed with an older key"; }
      else {
        const { url, options } = pushRequest({ subscription: entry, payload: webPushPayload({ ...message, url: message.url ?? null }), vapid: vapidKeys, subject: entry.origin ?? openAt() ?? "mailto:boxpilot@example.com", topic, now: now().getTime() });
        const response = await fetcher(url, { ...options, redirect: "error", signal: AbortSignal.timeout(15_000) });
        status = response.status;
        if (!response.ok) reason = (await response.text().catch(() => "")).slice(0, 120);
      }
    } catch (error) {
      reason = error?.message ?? "could not reach the push service";
    }
    const ok = status >= 200 && status < 300;
    const gone = status === 404 || status === 410 || (status === 403 && /VapidPkHashMismatch/i.test(reason));
    const entries = subscriptions();
    const next = gone ? entries.filter((candidate) => candidate.id !== entry.id)
      : entries.map((candidate) => (candidate.id === entry.id ? { ...candidate, ...(ok ? { lastSentAt: now().toISOString(), lastError: null } : { lastError: `${status || "no answer"}${reason ? `: ${reason}` : ""}`.slice(0, 160) }) } : candidate));
    saveSubscriptions(next);
    return { ok, gone, status };
  }

  /** Every device of these accounts; true if any took it. */
  async function sendToAccounts(accountIds, messageFor) {
    const targets = subscriptions().filter((entry) => accountIds.includes(entry.accountId));
    const outcomes = await Promise.all(targets.map(async (entry) => {
      const message = messageFor(entry);
      return { accountId: entry.accountId, ...(await sendTo(entry, message, { topic: message.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || null })) };
    }));
    return outcomes;
  }

  /** The notification target (ntfy, Gotify, a webhook), with the link as its click action. */
  async function sendToTarget(message) {
    if (!notifications?.getTarget?.()) return { ok: false, reason: "no-target" };
    try {
      await notifications.send({ title: `BoxPilot: ${message.title}`, message: message.body, priority: "default", click: message.url ?? null });
      return { ok: true };
    } catch {
      return { ok: false, reason: "failed" };
    }
  }

  /**
   * Look at what is waiting and push what should be pushed. Called every half minute and a little
   * after a job is staged; also what the tests drive, with their own clock.
   */
  let sweeping = null;
  function sweep() {
    sweeping ??= (async () => { try { return await sweepOnce(); } finally { sweeping = null; } })();
    return sweeping;
  }

  async function sweepOnce() {
    const at = now();
    const time = at.getTime();
    const chosen = settings();
    const state = readState();
    const waiting = (store.listAwaitingApproval?.() ?? []).filter((job) => job?.state === "awaiting_approval");
    const waitingIds = new Set(waiting.map((job) => job.id));
    // Forget what no longer waits, and sends older than the hour the limit counts.
    for (const id of Object.keys(state.pushed)) if (!waitingIds.has(id)) delete state.pushed[id];
    state.sent = state.sent.filter((iso) => time - Date.parse(iso) < 3_600_000);

    const ageOf = (job) => time - Date.parse(job.createdAt ?? "");
    const expired = (job) => Boolean(job.recovery?.approvalExpiresAt && Date.parse(job.recovery.approvalExpiresAt) <= time);
    const tierOf = (job) => (riskTiers.includes(job.risk) ? job.risk : "high");
    // Identical jobs (operation and subject) are one push: a later copy of one already pushed is quiet.
    const sameAs = (job) => `${job.type}:${subjectOf(job) ?? ""}`;
    const pushedKinds = new Set(waiting.filter((job) => state.pushed[job.id]).map(sameAs));
    const due = [];
    for (const job of waiting.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""))) {
      if (state.pushed[job.id]) continue;
      const age = ageOf(job);
      if (!Number.isFinite(age) || age < limits.graceMs) continue;
      if (age > limits.maxAgeMs || expired(job) || !chosen.tiers[tierOf(job)]) { state.pushed[job.id] = "skipped"; continue; }
      if (pushedKinds.has(sameAs(job))) { state.pushed[job.id] = "same"; continue; }
      pushedKinds.add(sameAs(job));
      due.push(job);
    }
    const outcome = { due: due.map((job) => job.id), sent: [], held: null };
    if (!due.length) { store.setSetting(stateKey, state, { updatedBy: null }); return outcome; }
    if (inQuietHours(chosen.quietHours, at)) { outcome.held = "quiet-hours"; store.setSetting(stateKey, state, { updatedBy: null }); return outcome; }
    const last = state.sent.length ? Date.parse(state.sent.at(-1)) : Number.NEGATIVE_INFINITY;
    if (state.sent.length >= limits.perHour || time - last < limits.minGapMs) { outcome.held = "rate-limit"; store.setSetting(stateKey, state, { updatedBy: null }); return outcome; }

    // Who may approve each job, and so who hears about it.
    const accounts = new Map();
    for (const job of due) {
      for (const accountId of mayApprove(store, job)) (accounts.get(accountId) ?? accounts.set(accountId, []).get(accountId)).push(job);
    }
    const deliveries = await sendToAccounts([...accounts.keys()], (entry) => approvalMessage(accounts.get(entry.accountId), { origin: entry.origin, subjectOf }));
    const owners = new Set((store.listOwners?.() ?? []).filter((owner) => owner.role === "owner").map((owner) => owner.id));
    const ownerReached = deliveries.some((delivery) => delivery.ok && owners.has(delivery.accountId));
    const all = approvalMessage(due, { origin: openAt(), subjectOf });
    let target = { ok: false, reason: "not-used" };
    if (chosen.ntfy === "always" || (chosen.ntfy === "fallback" && !ownerReached)) target = await sendToTarget(all);
    const delivered = deliveries.some((delivery) => delivery.ok) || target.ok;

    for (const job of due) state.pushed[job.id] = at.toISOString();
    state.sent.push(at.toISOString());
    store.setSetting(stateKey, state, { updatedBy: null });
    outcome.sent = deliveries.map((delivery) => ({ accountId: delivery.accountId, ok: delivery.ok, status: delivery.status }));
    outcome.target = target.ok ? "sent" : target.reason;
    // The notification centre's record: what was said, and whether it arrived anywhere.
    history?.record({ key: all.key, kind: "approval", title: all.title, message: all.body, priority: "default", delivered, reason: delivered ? null : (deliveries.length || target.reason === "failed" ? "failed" : "no-target") });
    store.recordAudit?.("push.approval.sent", { actorId: null, details: { jobs: due.map((job) => job.id), devices: deliveries.filter((delivery) => delivery.ok).length, target: outcome.target } });
    return outcome;
  }

  /** A test push to the caller's own devices: says which took it. */
  async function test(account) {
    const origin = subscriptions().find((entry) => entry.accountId === account.id)?.origin ?? openAt();
    const message = { title: "BoxPilot test push", body: "Approval pushes reach this device.", url: origin ? `${origin}/?view=today` : null, tag: "test" };
    const outcomes = await sendToAccounts([account.id], () => message);
    if (!outcomes.length) throw Object.assign(new Error("No device of yours has pushes turned on"), { status: 409 });
    return { devices: outcomes.length, delivered: outcomes.filter((outcome) => outcome.ok).length };
  }

  function start({ subscribeJobs = (listener) => store.subscribeJobs(listener) } = {}) {
    const run = () => { void sweep().catch(() => {}); };
    const interval = timers.setInterval(run, limits.sweepMs);
    interval?.unref?.();
    const unsubscribe = subscribeJobs((job) => {
      if (job?.state !== "awaiting_approval") return;
      const soon = timers.setTimeout(run, limits.graceMs + 1_000);
      soon?.unref?.();
    });
    return () => { timers.clearInterval(interval); unsubscribe?.(); };
  }

  return { describeSettings, saveSettings, devicesOf, subscribe, unsubscribe, sweep, test, start, publicKey: () => keys().publicKey };
}

/**
 * Who may approve a job, by the same rules jobs.mjs applies when the approval arrives: the owner
 * always; the account that staged it, when it is an operator, the job is not high risk and its
 * operation is not the owner's alone (`minimumRole`, which index.mjs reads from the registry).
 */
export function defaultMayApprove(store, job, { minimumRole = null } = {}) {
  const people = store.listOwners?.() ?? [];
  const approvers = people.filter((person) => person.role === "owner").map((person) => person.id);
  const creator = people.find((person) => person.id === job.createdBy);
  if (creator?.role === "operator" && job.risk !== "high" && minimumRole !== "owner") approvers.push(creator.id);
  return [...new Set(approvers)];
}
