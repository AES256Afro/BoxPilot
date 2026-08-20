/**
 * Failed-job push notifications (M8.4 v1). Subscribes to the store's job events and sends
 * one push per failed job to the configured target — ntfy, Gotify, or a plain webhook.
 * The catalog can deploy ntfy or Gotify on this host, so alerts need no cloud account.
 */

export const notificationKinds = Object.freeze(["ntfy", "gotify", "webhook"]);
const settingKey = "notifications";

export function validateTarget(target) {
  if (!target || typeof target !== "object") return "Target must be an object";
  if (!notificationKinds.includes(target.kind)) return `kind must be one of ${notificationKinds.join(", ")}`;
  if (typeof target.url !== "string" || !/^https?:\/\/[^\s]+$/.test(target.url) || target.url.length > 500) return "url must be an http(s) address";
  if (target.kind === "ntfy" && (typeof target.topic !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(target.topic))) return "topic must be letters, digits, underscore, or hyphen";
  if (target.kind === "gotify" && (typeof target.token !== "string" || target.token.length < 1 || target.token.length > 200)) return "token is required for Gotify";
  if (target.token !== undefined && target.token !== null && (typeof target.token !== "string" || target.token.length > 200)) return "token is invalid";
  return null;
}

/** Build the HTTP request for one message; exported for tests. */
export function buildRequest(target, { title, message, priority = "default" }) {
  if (target.kind === "ntfy") {
    const base = target.url.replace(/\/+$/, "");
    return {
      url: `${base}/${target.topic}`,
      options: {
        method: "POST",
        headers: { Title: title, Priority: priority === "high" ? "high" : "default", ...(target.token ? { Authorization: `Bearer ${target.token}` } : {}) },
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
        body: JSON.stringify({ title, message, priority: priority === "high" ? 8 : 4 }),
      },
    };
  }
  return {
    url: target.url,
    options: {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(target.token ? { Authorization: `Bearer ${target.token}` } : {}) },
      body: JSON.stringify({ source: "boxpilot", title, message, priority }),
    },
  };
}

export function createNotificationService({ store, fetcher = fetch, now = () => new Date() }) {
  const notified = new Set();

  function getTarget() {
    return store.getSetting(settingKey, null);
  }

  function setTarget(target, { updatedBy = null } = {}) {
    if (target === null) {
      store.setSetting(settingKey, null, { updatedBy });
      store.recordAudit("notifications.cleared", { actorId: updatedBy });
      return null;
    }
    const problem = validateTarget(target);
    if (problem) throw new Error(problem);
    const saved = { kind: target.kind, url: target.url, topic: target.topic ?? null, token: target.token ?? null };
    store.setSetting(settingKey, saved, { updatedBy });
    store.recordAudit("notifications.configured", { actorId: updatedBy, details: { kind: saved.kind, url: saved.url } });
    return saved;
  }

  /** Redacted view for the UI: never returns the token. */
  function describe() {
    const target = getTarget();
    if (!target) return { configured: false, kind: null, url: null, topic: null, hasToken: false };
    return { configured: true, kind: target.kind, url: target.url, topic: target.topic ?? null, hasToken: Boolean(target.token) };
  }

  async function send({ title, message, priority = "default" }) {
    const target = getTarget();
    if (!target) throw new Error("No notification target is configured");
    const { url, options } = buildRequest(target, { title, message, priority });
    const response = await fetcher(url, { ...options, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`The notification target answered ${response.status}`);
    return { sent: true, kind: target.kind };
  }

  /** Job-event listener: one push per failed job, never re-sent. Errors are audited, not thrown. */
  function onJob(job) {
    if (job.state !== "failed" || notified.has(job.id)) return;
    notified.add(job.id);
    if (notified.size > 500) notified.delete(notified.values().next().value);
    if (!getTarget()) return;
    void send({ title: `BoxPilot: ${job.title} failed`, message: (job.error ?? "The job failed; open Activity for the log.").slice(0, 500), priority: "high" })
      .then(() => store.recordAudit("notifications.sent", { subjectId: job.id, details: { title: job.title } }))
      .catch((error) => store.recordAudit("notifications.failed", { subjectId: job.id, details: { error: error.message, at: now().toISOString() } }));
  }

  function start() {
    return store.subscribeJobs(onJob);
  }

  return { getTarget, setTarget, describe, send, onJob, start };
}
