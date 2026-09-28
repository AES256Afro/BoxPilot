/**
 * Tells the owner when a newer BoxPilot release exists — once per release, through the same
 * notification target failed jobs use. Runs in the web process (it only talks to GitHub);
 * applying the update stays a password-approved job on the System page.
 *
 * The notice goes through the health-alert ledger (M27.2): with no target, or a target that does
 * not answer, it is kept as one "not announced" entry the Overview counts and a later round sends,
 * instead of being checked again and dropped every six hours. A newer release replaces it, and
 * applying the update clears it.
 */
const noticeKey = "release.available";

export function createUpdateNotifier({ releaseUpdates, notifications, alerts, store, intervalMs = 6 * 60 * 60 * 1000, initialDelayMs = 2 * 60 * 1000, now = () => new Date(), setInterval: schedule = globalThis.setInterval, setTimeout: delay = globalThis.setTimeout, clearInterval: unschedule = globalThis.clearInterval, clearTimeout: cancel = globalThis.clearTimeout } = {}) {
  async function check() {
    const release = await releaseUpdates.inspect({ refresh: true });
    if (!release.updateAvailable || !release.latest) {
      // Up to date (a failed check proves nothing): a notice nobody received is no longer news.
      if (!release.error) await alerts.clear(noticeKey, { quietly: true });
      return { notified: false, reason: release.error ? "check-failed" : "up-to-date", latest: release.latest?.tag ?? null };
    }
    const alreadyNotified = store.getSetting("updateNotifiedTag", null);
    if (alreadyNotified === release.latest.tag) return { notified: false, reason: "already-notified", latest: release.latest.tag };
    const { notified } = await alerts.tell({
      key: noticeKey,
      title: `Version ${release.latest.tag.replace(/^v/, "")} is available`,
      message: `You are running ${release.current.version}. Open System → BoxPilot updates to review and apply it (password approval; automatic rollback on a failed health check).`,
      priority: "default",
    });
    // Sent or kept, the ledger has it now: remembering the tag keeps this check from adding it twice.
    store.setSetting("updateNotifiedTag", release.latest.tag, { updatedBy: null });
    store.recordAudit(notified ? "update.available.notified" : "update.available.kept", { actorId: null, subjectId: release.latest.tag, details: { from: release.current.version, at: now().toISOString(), target: Boolean(notifications?.getTarget?.()) } });
    return { notified, reason: notified ? "sent" : "not-announced", latest: release.latest.tag };
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
