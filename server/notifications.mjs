import { lookup as dnsLookup } from "node:dns/promises";
import { fetchGuarded, isLinkLocalAddress } from "./outbound-guard.mjs";
import { heldKey, heldLimit, holds, isQuiet, normalizeQuietHours, quietHoursKey, summaryOf } from "./quiet-hours.mjs";
/**
 * Failed-job push notifications (M8.4 v1). Subscribes to the store's job events and sends
 * one push per failed job to the configured target — ntfy, Gotify, or a plain webhook.
 * The catalog can deploy ntfy or Gotify on this host, so alerts need no cloud account.
 */

export const notificationKinds = Object.freeze(["ntfy", "gotify", "webhook"]);
const settingKey = "notifications";

/**
 * Whether fetch() can send to this address. It refuses one it cannot parse, or one with a user name
 * or password in it, and its error then quotes the whole URL - a Gotify token in the query, a
 * webhook's password - which would go on to the audit log and the page.
 */
function usableUrl(url) {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
}

/**
 * A failed job whose failure is already being dealt with, by the steps written on it: one a
 * BoxPilot restart cut off (state.recoverInterruptedJobs), which whoever owns it tells through the
 * health-alert ledger, and one somebody has since tried again with more time (M30.3). Each later
 * gets a step - whether it ran again (M30.2), the retry that was staged - and after a restart this
 * process does not remember having pushed it, so without this each such step pushed it again.
 */
const failureAlreadyHandled = (job) => (job?.steps ?? []).some((step) => (step.name === "recovery" && step.state === "required") || (step.name === "retry" && step.state === "staged"));

export function validateTarget(target) {
  if (!target || typeof target !== "object") return "Target must be an object";
  if (!notificationKinds.includes(target.kind)) return `kind must be one of ${notificationKinds.join(", ")}`;
  if (typeof target.url !== "string" || !/^https?:\/\/[^\s]+$/.test(target.url) || target.url.length > 500) return "url must be an http(s) address";
  if (!usableUrl(target.url)) return "url must be a valid http(s) address without a user name or password (use the token field)";
  if (isLinkLocalAddress(new URL(target.url).hostname)) return "url must not be a link-local address";
  if (target.kind === "ntfy" && (typeof target.topic !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(target.topic))) return "topic must be letters, digits, underscore, or hyphen";
  if (target.kind === "gotify" && (typeof target.token !== "string" || target.token.length < 1 || target.token.length > 200)) return "token is required for Gotify";
  if (target.token !== undefined && target.token !== null && (typeof target.token !== "string" || target.token.length > 200)) return "token is invalid";
  return null;
}

/**
 * Where tapping a push goes (M25.2: an approval in BoxPilot): only an https address with nothing
 * in it but a path and a query, or nothing at all.
 */
function clickUrl(click) {
  if (typeof click !== "string" || !URL.canParse(click)) return null;
  const url = new URL(click);
  return url.protocol === "https:" && !url.username && !url.password && !url.hash ? url.href : null;
}

/** Build the HTTP request for one message; exported for tests. */
export function buildRequest(target, { title, message, priority = "default", click = null }) {
  const opens = clickUrl(click);
  if (target.kind === "ntfy") {
    const base = target.url.replace(/\/+$/, "");
    return {
      url: `${base}/${target.topic}`,
      options: {
        method: "POST",
        headers: { Title: title, Priority: priority === "high" ? "high" : "default", ...(opens ? { Click: opens } : {}), ...(target.token ? { Authorization: `Bearer ${target.token}` } : {}) },
        body: message,
      },
    };
  }
  if (target.kind === "gotify") {
    const base = target.url.replace(/\/+$/, "");
    return {
      url: `${base}/message?token=${encodeURIComponent(target.token)}`,
      options: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, message, priority: priority === "high" ? 8 : 4, ...(opens ? { extras: { "client::notification": { click: { url: opens } } } } : {}) }),
      },
    };
  }
  return {
    url: target.url,
    options: {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(target.token ? { Authorization: `Bearer ${target.token}` } : {}) },
      body: JSON.stringify({ source: "boxpilot", title, message, priority, ...(opens ? { url: opens } : {}) }),
    },
  };
}

export function createNotificationService({ store, fetcher = fetch, lookup = dnsLookup, now = () => new Date(), claimed = (_job) => false, history = null, timeZone = undefined }) {
  const notified = new Set();

  function getTarget() {
    return store.getSetting(settingKey, null);
  }

  function setTarget(requested, { updatedBy = null } = {}) {
    if (requested === null) {
      store.setSetting(settingKey, null, { updatedBy });
      store.recordAudit("notifications.cleared", { actorId: updatedBy });
      return null;
    }
    // Settings never shows the saved token, so changing the address cannot send it back: a change
    // that sends none keeps it, as long as it is still for the same service.
    const stored = getTarget();
    const target = requested && typeof requested === "object" && requested.token === undefined && stored?.token && stored.kind === requested.kind
      ? { ...requested, token: stored.token }
      : requested;
    const problem = validateTarget(target);
    if (problem) throw new Error(problem);
    const saved = { kind: target.kind, url: target.url, topic: target.topic ?? null, token: target.token ?? null };
    store.setSetting(settingKey, saved, { updatedBy });
    // The kind only. For a webhook the URL *is* the credential, and the audit log is kept for
    // twenty thousand rows and copied into every controller backup.
    store.recordAudit("notifications.configured", { actorId: updatedBy, details: { kind: saved.kind, hasToken: Boolean(saved.token) } });
    return saved;
  }

  /**
   * Save the target "Send alerts to the ntfy on this server" proved (notifications.ntfy.connect,
   * M35): the helper found the local ntfy, made the topic and sent the test, and ntfy accepted it,
   * so this only records where it went. It never replaces a target somebody set in Settings, which
   * asks for the owner's password there; the job is refused at staging for the same reason, and
   * this catches one set while it ran.
   */
  function adoptLocalNtfy(result, { updatedBy = null } = {}) {
    if (getTarget()) throw new Error("A notification target was set while this ran, so it was left as it is");
    if (result?.kind !== "ntfy" || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(String(result?.url ?? ""))) throw new Error("The ntfy check did not say where ntfy answers");
    return setTarget({ kind: "ntfy", url: result.url, topic: result.topic }, { updatedBy });
  }

  /** Redacted view for the UI: never returns the token. */
  function describe() {
    const target = getTarget();
    if (!target) return { configured: false, kind: null, url: null, topic: null, hasToken: false };
    return { configured: true, kind: target.kind, url: target.url, topic: target.topic ?? null, hasToken: Boolean(target.token) };
  }

  /**
   * Send a push, or hold it for the summary at the end of quiet hours. `immediate` is for a push the
   * owner asked for just now (the test button), which nobody wants held. `key` and `kind` name the
   * notification centre's entry, so the summary marks it delivered once it goes out.
   */
  async function send({ title, message, priority = "default", click = null }, { immediate = false, key = null, kind = null } = {}) {
    const target = getTarget();
    if (!target) throw new Error("No notification target is configured");
    if (!immediate && holds(store.getSetting(quietHoursKey, null), priority, now(), timeZone)) {
      const held = store.getSetting(heldKey, []);
      const kept = [...(Array.isArray(held) ? held : []), { title: String(title ?? "").slice(0, 200), message: String(message ?? "").slice(0, 300), priority, at: now().toISOString(), ...(key && kind ? { key, kind } : {}) }].slice(-heldLimit);
      store.setSetting(heldKey, kept);
      return { sent: false, held: true, kind: target.kind };
    }
    return deliver(target, { title, message, priority, click });
  }

  async function deliver(target, { title, message, priority, click }) {
    const { url, options } = buildRequest(target, { title, message, priority, click });
    // A target saved before validateTarget refused such an address: say so without quoting it.
    if (!usableUrl(url)) throw new Error("The notification target's address is not one BoxPilot can send to; set the target again in Settings");
    // A token rides in a header or the query, so a redirect is never followed with one (M50); without
    // one each hop is checked against the link-local range, which the saved address was not.
    const response = await fetchGuarded(url, { ...options, signal: AbortSignal.timeout(15_000) }, { fetcher, lookup, followRedirects: !target.token });
    if (!response.ok) throw new Error(`The notification target answered ${response.status}`);
    return { sent: true, kind: target.kind };
  }

  /** Job-event listener: one push per failed job, never re-sent. Errors are audited, not thrown. */
  function onJob(job) {
    if (job.state !== "failed" || notified.has(job.id) || failureAlreadyHandled(job)) return;
    notified.add(job.id);
    if (notified.size > 500) notified.delete(notified.values().next().value);
    // A scheduled run, an automation's step, or a job whose result was not saved is announced as
    // its own condition, once, through the health alerts - and kept as not announced when this
    // cannot reach anyone. Pushing the job too is what made a nightly failure a nightly push.
    let owned = false;
    try { owned = Boolean(claimed(job)); } catch { owned = false; } // unsure means push it: a duplicate beats silence
    if (owned) return;
    // What is left was run by hand, and the person who ran it watched it fail in the dialog that
    // started it; Activity and the Overview keep it after. So a push that reaches no one here is
    // audited, not kept in the ledger. The unattended case - a job a restart cut off, whose page
    // lost its connection before the end - is kept there instead (health-alerts tellInterrupted).
    if (!getTarget()) return;
    const message = (job.error ?? "The job failed; open Activity for the log.").slice(0, 500);
    // The notification centre's record of it (M36): what was pushed, and whether it arrived.
    const said = (delivered) => history?.record({ key: `job.failed:${job.id}`, kind: "job", title: `${job.title} failed`, message, priority: "high", delivered, reason: delivered ? null : "failed" });
    void send({ title: `BoxPilot: ${job.title} failed`, message, priority: "high" }, { key: `job.failed:${job.id}`, kind: "job" })
      .then((result) => {
        if (result?.held) { history?.record({ key: `job.failed:${job.id}`, kind: "job", title: `${job.title} failed`, message, priority: "high", delivered: false, reason: "held" }); return; }
        store.recordAudit("notifications.sent", { subjectId: job.id, details: { title: job.title } }); said(true);
      })
      .catch((error) => { store.recordAudit("notifications.failed", { subjectId: job.id, details: { error: error.message, at: now().toISOString() } }); said(false); });
  }

  /**
   * Once quiet hours are over, send what waited as one push. Kept until that push is accepted, so a
   * target that is down at 7 a.m. gets the summary on a later minute instead of losing it; only the
   * first failure in a row is audited, so a target down all day is one row, not one a minute.
   */
  let flushFailing = false;
  async function flushHeld() {
    const held = store.getSetting(heldKey, []);
    if (!Array.isArray(held) || !held.length || isQuiet(store.getSetting(quietHoursKey, null), now(), timeZone)) return { sent: false, count: 0 };
    const target = getTarget();
    if (!target) return { sent: false, count: held.length };
    try {
      await deliver(target, { ...summaryOf(held), click: null });
    } catch (error) {
      if (!flushFailing) store.recordAudit("notifications.failed", { details: { error: error.message, held: held.length, at: now().toISOString() } });
      flushFailing = true;
      return { sent: false, count: held.length };
    }
    flushFailing = false;
    // Held while the summary was on its way: kept for the next one.
    const sent = new Set(held.map((item) => JSON.stringify(item)));
    const after = store.getSetting(heldKey, []);
    store.setSetting(heldKey, (Array.isArray(after) ? after : []).filter((item) => !sent.has(JSON.stringify(item))));
    for (const item of held) if (item?.key && item?.kind) history?.record({ key: item.key, kind: item.kind, title: String(item.title ?? "").replace(/^BoxPilot: /, ""), message: item.message, priority: item.priority, delivered: true });
    store.recordAudit("notifications.sent", { details: { title: "quiet hours summary", count: held.length } });
    return { sent: true, count: held.length };
  }

  /** Quiet hours as saved, and how many pushes are waiting for the summary. */
  function quietHours() {
    const held = store.getSetting(heldKey, []);
    return { ...normalizeQuietHours(store.getSetting(quietHoursKey, null)), held: Array.isArray(held) ? held.length : 0, quietNow: isQuiet(store.getSetting(quietHoursKey, null), now(), timeZone) };
  }

  function start({ flushEveryMs = 60_000 } = {}) {
    const unsubscribe = store.subscribeJobs(onJob);
    const timer = setInterval(() => { void flushHeld().catch(() => {}); }, flushEveryMs);
    timer.unref?.();
    return () => { clearInterval(timer); unsubscribe?.(); };
  }

  return { getTarget, setTarget, adoptLocalNtfy, describe, send, flushHeld, quietHours, onJob, start };
}
