/**
 * Tells the owner when a newer BoxPilot release exists — once per release, through the same
 * notification target failed jobs use. Runs in the web process (it only talks to GitHub);
 * applying the update stays a password-approved job on the System page.
 */
export function createUpdateNotifier({ releaseUpdates, notifications, store, intervalMs = 6 * 60 * 60 * 1000, initialDelayMs = 2 * 60 * 1000, now = () => new Date(), setInterval: schedule = globalThis.setInterval, setTimeout: delay = globalThis.setTimeout, clearInterval: unschedule = globalThis.clearInterval, clearTimeout: cancel = globalThis.clearTimeout } = {}) {
  async function check() {
    const release = await releaseUpdates.inspect({ refresh: true });
    if (!release.updateAvailable || !release.latest) return { notified: false, reason: release.error ? "check-failed" : "up-to-date", latest: release.latest?.tag ?? null };
    const alreadyNotified = store.getSetting("updateNotifiedTag", null);
    if (alreadyNotified === release.latest.tag) return { notified: false, reason: "already-notified", latest: release.latest.tag };
    if (!notifications.getTarget()) return { notified: false, reason: "no-target", latest: release.latest.tag };
    await notifications.send({ title: `BoxPilot ${release.latest.tag} is available`, message: `You are running ${release.current.version}. Open System → BoxPilot updates to review and apply it (password approval; automatic rollback on a failed health check).`, priority: "default" });
    store.setSetting("updateNotifiedTag", release.latest.tag, { updatedBy: null });
    store.recordAudit("update.available.notified", { actorId: null, subjectId: release.latest.tag, details: { from: release.current.version, at: now().toISOString() } });
    return { notified: true, reason: "sent", latest: release.latest.tag };
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
