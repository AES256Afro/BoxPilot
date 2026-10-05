/**
 * Settings routes: notification target and the approval-mode toggle. Both changes
 * require the owner password. Mounted at /api/v1 behind the session.
 */
import { Router } from "express";
import { approvalModes, defaultApprovalMode, elevationTtlMs, normalizeApprovalMode } from "../ops/risk.mjs";
import { normalizeDestination } from "../backup-destination.mjs";
import { healthConditions, isNotice, noticeKinds } from "../health-alerts.mjs";
import { vpnProviders, vpnProtocols } from "../vpn-profile.mjs";
import { watchEntryFor } from "./access.mjs";
import { createNotificationHistory } from "../notification-history.mjs";

export function createSettingsRouter({ state, notifications, notificationHistory = createNotificationHistory({ store: state }), weeklyReport = null, auth }) {
  const router = Router();
  // Belt and braces with the policy middleware: only the owner changes settings, whatever the path casing.
  router.use("/settings", (request, response, next) => (["GET", "HEAD", "OPTIONS"].includes(request.method) ? next() : auth.requireRole("owner")(request, response, next)));

  async function ownerWithPassword(request, response, message) {
    const owner = state.findOwnerById(request.boxpilotSession.owner.id);
    const verdict = await auth.checkPassword(request, owner, request.body?.password);
    if (verdict.blocked) { auth.rejectThrottled(response, verdict); return null; }
    if (!verdict.ok) {
      response.status(401).json({ error: message, code: "reauthentication_required" });
      return null;
    }
    return owner;
  }

  // Failed-job push notifications (M8.4): where alerts go.
  router.get("/settings/notifications", (request, response) => {
    const described = notifications.describe();
    // Where alerts go is the owner's to see (M29.4): an ntfy topic on a shared server, or a webhook
    // URL, works like a password - whoever knows it can read the alerts or send fake ones. Everyone
    // else learns whether a target is set, and of what kind, which is all the Overview needs.
    if ((request.boxpilotSession?.owner?.role ?? "owner") !== "owner") return response.json({ ...described, url: null, topic: null });
    response.json(described);
  });

  /** An entry's words as this caller may read them (M29.4); access.mjs holds the rule, which the assistant shares. */
  const scheduleOwner = (id) => state.getSchedule?.(id)?.createdBy ?? null;
  const titleFor = (request, key, entry, label) => watchEntryFor(request, key, entry, label, scheduleOwner).title;

  // What BoxPilot watches for on its own, and which conditions are live right now. The active set is
  // the health-alert watcher's own persisted state, grouped back to its condition families.
  router.get("/settings/watch", (request, response) => {
    const active = state.getSetting("healthAlertsState", {}) ?? {};
    const byFamily = {};
    const notices = [];
    for (const [key, entry] of Object.entries(active)) {
      if (!entry) continue;
      const family = key.split(":")[0];
      // News that reached no one - a release, a new sign-in, an interrupted job, the weekly report -
      // is not a condition to watch, but it is counted with the ones that could not be told.
      if (isNotice(key)) { notices.push({ key: family, label: noticeKinds[family], title: titleFor(request, key, entry, noticeKinds[family]), since: entry.since ?? null, announced: false }); continue; }
      // A condition that is live but was never announced - because no notification target is set -
      // is still live. Hiding it here as well meant a drive that dropped off USB was known to
      // BoxPilot and shown to nobody, on any page, until the owner happened to read a folder.
      (byFamily[family] ??= []).push({ title: titleFor(request, key, entry, healthConditions[family] ?? family), since: entry.since ?? null, announced: entry.notified !== false });
    }
    const conditions = Object.entries(healthConditions).map(([key, label]) => ({ key, label, active: Boolean(byFamily[key]?.length), details: byFamily[key] ?? [] }));
    const live = Object.values(byFamily).flat();
    // What BoxPilot knew and could not tell anyone (M27.2): the Overview's one-line count.
    response.json({ targetConfigured: notifications.describe().configured === true, activeCount: live.length, unannouncedCount: live.filter((detail) => !detail.announced).length + notices.length, conditions, notices });
  });

  /**
   * The notification centre (M36): what BoxPilot said lately - conditions raised (and whether they
   * have cleared), news, failed jobs pushed - with when, and whether the target took it. Read-only
   * apart from "mark seen", which is the caller's own. Every role reads it, with the words cut back
   * as the watch list cuts them (M29.4): another account's job, schedule or sign-in is its kind only.
   */
  const labelFor = (family) => healthConditions[family] ?? noticeKinds[family] ?? (family === "job.failed" ? "A job failed" : family === "approval.waiting" ? "A job waited for approval" : family);
  function historyEntryFor(request, entry, live) {
    const family = String(entry.key).split(":")[0];
    let visible;
    if (entry.kind === "job" || entry.kind === "approval") {
      // A failed job's push, or an approval's (M25.2): the owner's, and the job's own creator's.
      // Several approvals said at once name no one job, so they are the owner's alone.
      const jobId = String(entry.key).includes(":") ? String(entry.key).slice(String(entry.key).indexOf(":") + 1) : null;
      const job = jobId ? state.getJob?.(jobId) : null;
      const theirs = request.boxpilotSession?.owner?.role === "owner" || (job && job.createdBy === request.boxpilotSession?.owner?.id);
      visible = theirs ? { title: entry.title, key: entry.key, full: true } : { title: labelFor(family), key: family, full: false };
    } else {
      visible = watchEntryFor(request, entry.key, entry, labelFor(family), scheduleOwner);
    }
    // Cut by whether the caller may read it, not by whether the key got shorter: the weekly report's
    // key has no subject to cut, and its words were handed to every role (sweep 3).
    const masked = !visible.full;
    return {
      id: entry.id, kind: entry.kind, key: visible.key, family, title: visible.title, message: masked ? null : entry.message ?? null,
      at: entry.at, delivered: entry.delivered === true, reason: entry.reason ?? null, deliveredAt: entry.deliveredAt ?? null,
      resolvedAt: entry.resolvedAt ?? null, live: entry.kind === "alert" && !entry.resolvedAt && Object.hasOwn(live, entry.key),
    };
  }

  if (notificationHistory) {
    router.get("/notifications", (request, response) => {
      const self = request.boxpilotSession.owner.id;
      const live = state.getSetting("healthAlertsState", {}) ?? {};
      const entries = notificationHistory.list().map((entry) => historyEntryFor(request, entry, live));
      const seenAt = notificationHistory.seenAt(self);
      response.json({ entries, seenAt, unseen: entries.filter((entry) => !seenAt || entry.at > seenAt).length, targetConfigured: notifications.describe().configured === true });
    });

    // The only change here, and the caller's own: everything said until now stops counting as new.
    router.post("/notifications/seen", auth.requireCsrf, (request, response) => {
      response.json({ seenAt: notificationHistory.markSeen(request.boxpilotSession.owner.id) });
    });
  }

  // The weekly self-report (M30.4): whether it is on, when it goes, and how the last one went.
  if (weeklyReport) {
    router.get("/settings/weekly-report", (_request, response) => {
      response.json(weeklyReport.status());
    });

    // The words it would send now. Owner only: it names every account's jobs and failures, which
    // an operator or viewer cannot list for themselves.
    router.get("/settings/weekly-report/preview", auth.requireRole("owner"), async (_request, response) => {
      try {
        response.json(await weeklyReport.preview());
      } catch (error) {
        response.status(500).json({ error: `Could not put the report together: ${error.message}`, code: "report_failed" });
      }
    });

    router.put("/settings/weekly-report", auth.requireCsrf, (request, response) => {
      if (typeof request.body?.enabled !== "boolean") return response.status(400).json({ error: "enabled must be true or false", code: "invalid_setting" });
      return response.json(weeklyReport.setEnabled(request.body.enabled, { updatedBy: request.boxpilotSession.owner.id }));
    });

    router.post("/settings/weekly-report/send", auth.requireCsrf, async (request, response) => {
      try {
        response.json(await weeklyReport.sendNow({ actorId: request.boxpilotSession.owner.id }));
      } catch (error) {
        response.status(502).json({ error: error.message, code: "notification_test_failed" });
      }
    });
  }

  router.put("/settings/notifications", auth.requireCsrf, async (request, response) => {
    const owner = await ownerWithPassword(request, response, "Owner password required to change the notification target");
    if (!owner) return;
    try {
      notifications.setTarget(request.body?.target ?? null, { updatedBy: owner.id });
      response.json(notifications.describe());
    } catch (error) {
      response.status(400).json({ error: error.message, code: "invalid_setting" });
    }
  });

  router.post("/settings/notifications/test", auth.requireCsrf, async (_request, response) => {
    try {
      response.json(await notifications.send({ title: "BoxPilot test notification", message: "Notifications are working. Failed jobs, new releases, health alerts (disk space, SMART, UPS, failed services) and the weekly report arrive like this." }));
    } catch (error) {
      response.status(502).json({ error: error.message, code: "notification_test_failed" });
    }
  });

  router.get("/settings/approval-mode", (_request, response) => {
    response.json({ approvalMode: normalizeApprovalMode(state.getSetting("approvalMode", null) ?? process.env.BOXPILOT_APPROVAL_MODE ?? defaultApprovalMode), modes: approvalModes, elevationTtlMs });
  });

  router.put("/settings/approval-mode", auth.requireCsrf, async (request, response) => {
    const mode = request.body?.approvalMode;
    if (!approvalModes.includes(mode)) return response.status(400).json({ error: `approvalMode must be one of ${approvalModes.join(", ")}`, code: "invalid_setting" });
    const owner = await ownerWithPassword(request, response, "Owner password required to change the approval mode");
    if (!owner) return undefined;
    state.setSetting("approvalMode", mode, { updatedBy: owner.id });
    state.recordAudit("settings.approval-mode.changed", { actorId: owner.id, subjectId: owner.id, details: { approvalMode: mode } });
    return response.json({ approvalMode: mode, modes: approvalModes, elevationTtlMs });
  });

  // The shared VPN profile (M17.4): the non-secret description mirrored from vpn.profile.set, plus the
  // choices the form offers. The secrets stay in a root-owned file the web process never reads. Owner
  // only, matching vpn.profile.inspect: the description still names the VPN account (openvpnUser) and
  // the LAN ranges the kill switch exempts, which a viewer or operator has no call to read.
  router.get("/settings/vpn-profile", auth.requireRole("owner"), (_request, response) => {
    response.json({ profile: state.getSetting("vpnProfile", null), providers: vpnProviders, protocols: vpnProtocols });
  });

  // Cloud (rclone) destination: the non-secret description saved by backup.cloud.setup, plus the last mirror.
  router.get("/settings/cloud-destination", (_request, response) => {
    response.json({ destination: state.getSetting("cloudDestination", null), lastSync: state.getSetting("cloudDestinationLastSync", null) });
  });

  // Off-box SSH backup destination (M6.2). Not secret — the key stays root-only on the server.
  router.get("/settings/backup-destination", (_request, response) => {
    response.json({ destination: state.getSetting("backupDestination", null), lastSync: state.getSetting("backupDestinationLastSync", null) });
  });

  router.put("/settings/backup-destination", auth.requireCsrf, async (request, response) => {
    const owner = await ownerWithPassword(request, response, "Owner password required to change the backup destination");
    if (!owner) return undefined;
    if (request.body?.destination === null) {
      state.setSetting("backupDestination", null, { updatedBy: owner.id });
      return response.json({ destination: null, lastSync: null });
    }
    try {
      const destination = normalizeDestination(request.body?.destination ?? {});
      state.setSetting("backupDestination", destination, { updatedBy: owner.id });
      state.recordAudit("settings.backup-destination.changed", { actorId: owner.id, subjectId: owner.id, details: { host: destination.host, user: destination.user, path: destination.path, port: destination.port } });
      return response.json({ destination, lastSync: state.getSetting("backupDestinationLastSync", null) });
    } catch (error) {
      return response.status(400).json({ error: error.message, code: "invalid_setting" });
    }
  });

  return router;
}
