/**
 * Keep the LAN certificate from expiring on its own (M18.2).
 *
 * The leaf that HTTPS-on-the-LAN issues is short-lived (browsers reject long ones), so a set-and-
 * forget install would eventually break. This background check reissues it well before it expires,
 * reusing the same certificate authority so every device that trusted it stays trusting. It runs the
 * same provisioning the owner ran, with the names already on the certificate, so nothing changes
 * except the expiry. It is careful about the restart that provisioning schedules: if a job is
 * running, it waits for the next round rather than cutting that job off.
 */
import { readTlsStatus } from "./tls-status.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Renew once the certificate is within `withinMs` of expiring. */
export function shouldRenew(notAfter, { now, withinMs }) {
  const expiry = Date.parse(notAfter);
  if (!Number.isFinite(expiry)) return false;
  return expiry - now <= withinMs;
}

export function createTlsRenewal({
  helper,
  store,
  readStatus = () => readTlsStatus(),
  now = () => Date.now(),
  intervalMs = 12 * 60 * 60 * 1000,
  initialDelayMs = 5 * 60 * 1000,
  renewWithinMs = 30 * DAY_MS,
  requestTimeoutMs = 2 * 60 * 1000,
  setInterval: schedule = globalThis.setInterval,
  setTimeout: delay = globalThis.setTimeout,
  clearInterval: unschedule = globalThis.clearInterval,
  clearTimeout: cancel = globalThis.clearTimeout,
} = {}) {
  async function check() {
    const status = await readStatus().catch(() => ({ provisioned: false }));
    if (!status?.provisioned || typeof status.notAfter !== "string") return { renewed: false, reason: "not-provisioned" };
    if (!shouldRenew(status.notAfter, { now: now(), withinMs: renewWithinMs })) return { renewed: false, reason: "not-due", notAfter: status.notAfter };
    // The provision restarts BoxPilot; never do that out from under a running job.
    const active = typeof store.listActiveJobs === "function" ? store.listActiveJobs() : [];
    if (active.length) return { renewed: false, reason: "job-running" };
    try {
      await helper.request("system.web.tls.provision", { names: status.names, ipAddresses: status.ipAddresses ?? [] }, { timeoutMs: requestTimeoutMs });
      store.recordAudit?.("tls.renewed", { actorId: null, subjectId: null, details: { names: status.names, expiring: status.notAfter } });
      return { renewed: true, names: status.names };
    } catch (error) {
      store.recordAudit?.("tls.renew.failed", { actorId: null, subjectId: null, details: { error: error.message } });
      return { renewed: false, reason: "failed", error: error.message };
    }
  }

  function start() {
    const safeCheck = () => check().catch(() => {});
    const first = delay(safeCheck, initialDelayMs);
    first.unref?.();
    const timer = schedule(safeCheck, intervalMs);
    timer.unref?.();
    return () => { cancel(first); unschedule(timer); };
  }

  return { check, start };
}
