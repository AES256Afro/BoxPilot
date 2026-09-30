import { useCallback, useEffect, useState } from "react";
import { openActivity, openNotificationsEvent } from "../activityEvents";
import { viewLabel, type ViewName } from "../data";
import { relativeTime } from "../home/format";
import { readJson } from "../http";
import { Button, EmptyState, Facts, Notice, Sheet, StatusChip, Tag, type Status } from "../ui";
import { BellIcon } from "./areaIcons";
import { PushPanel } from "./PushPanel";
import "./look.css";
import "./bar.css";
import "./notifications.css";

/*
 * The notification centre (M36): the bell in the top bar and what BoxPilot told the owner lately -
 * conditions raised and whether they have cleared, news, failed jobs pushed - with when, whether the
 * notification target took it, and a way to the page it is about. Read-only apart from "Mark all
 * seen", which moves this account's own marker. The server keeps the record
 * (server/notification-history.mjs) and cuts another account's entries back to their kind. Drawn
 * with the kit's Sheet, in the console's look wherever it opens (M33.13).
 */

export interface NotificationEntry {
  id: string;
  kind: "alert" | "notice" | "job" | "approval";
  key: string;
  family: string;
  title: string;
  message: string | null;
  at: string;
  delivered: boolean;
  reason: "no-target" | "failed" | null;
  deliveredAt: string | null;
  resolvedAt: string | null;
  live: boolean;
}

export interface NotificationList { entries: NotificationEntry[]; seenAt: string | null; unseen: number; targetConfigured: boolean }

/** Where an entry leads: a job opens in Activity, everything else on the page that has its detail. */
export function destinationOf(entry: NotificationEntry): { kind: "activity"; jobId: string | null; label: string } | { kind: "view"; view: ViewName; label: string; tab?: string } {
  const [, subject] = entry.key.split(/:(.*)/s);
  if (entry.family === "job.failed" || entry.family === "approval.lapsed") return { kind: "activity", jobId: subject && entry.key !== entry.family ? subject : null, label: "Open in Activity" };
  // An approval pushed to a phone (M25.2): the job, where it can be reviewed; several at once, Today.
  if (entry.family === "approval.waiting") return subject && entry.key !== entry.family ? { kind: "activity", jobId: subject, label: "Open in Activity" } : { kind: "view", view: "today", label: "Open Today" };
  if (entry.family === "job.interrupted" || entry.family === "record.failed" || entry.family === "joblog.unreadable") return { kind: "activity", jobId: null, label: "Open Activity" };
  if (entry.family.startsWith("storage.") || entry.family.startsWith("smart.")) return { kind: "view", view: "storage", label: "Open Storage" };
  if (entry.family.startsWith("docker.")) return { kind: "view", view: "catalog", label: "Open the App catalog" };
  if (entry.family === "system.services") return { kind: "view", view: "services", label: "Open Services" };
  if (entry.family === "system.reboot") return { kind: "view", view: "updates", label: "Open Updates" };
  if (entry.family === "power.ups") return { kind: "view", view: "system", label: "Open System" };
  if (entry.family === "schedule.overdue") return { kind: "view", view: "backups", label: "Open Backups" };
  // As Home's list sends them (src/home/needs.ts watchView), without loading Home to know it.
  const view: ViewName = entry.family === "schedule.failed" || entry.family === "release.available" ? "system"
    : entry.family === "flow.failed" ? "automations"
      : entry.family === "drive.reconnected" ? "storage"
        : entry.family === "signin.new" || entry.family === "report.weekly" ? "settings" : "repairs";
  // Settings opens at the tab the entry is about (M33.13).
  const tab = entry.family === "report.weekly" ? "notifications" : entry.family === "signin.new" ? "account" : undefined;
  return { kind: "view", view, label: `Open ${viewLabel(view)}`, ...(tab ? { tab } : {}) };
}

/** Whether it arrived, in words, with the status that goes with them. */
export function deliveryOf(entry: NotificationEntry): { status: Status; words: string } {
  if (entry.delivered) return { status: "good", words: "Sent" };
  if (entry.reason === "no-target") return { status: "neutral", words: "Not sent: no target set" };
  return { status: "warning", words: "Sending failed" };
}

const pollMs = 60_000;

export function NotificationCentre({ csrfToken, role = "owner", onNavigate }: { csrfToken: string; role?: string; onNavigate: (view: ViewName, options?: { tab?: string }) => void }) {
  const [list, setList] = useState<NotificationList | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const body = await readJson<NotificationList>(await fetch("/api/v1/notifications"));
      if (!Array.isArray(body?.entries)) throw new Error("BoxPilot sent a list the page could not read");
      setList(body);
      setProblem(null);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The notifications could not be read");
    }
  }, []);

  // A read when the page opens, one a minute while it is visible, and one each time the bell opens.
  useEffect(() => {
    if (typeof fetch !== "function") return undefined;
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") void load(); }, pollMs);
    return () => window.clearInterval(timer);
  }, [load]);
  useEffect(() => { if (open) void load(); }, [open, load]);
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(openNotificationsEvent, onOpen);
    return () => window.removeEventListener(openNotificationsEvent, onOpen);
  }, []);
  const markSeen = async () => {
    try {
      const body = await readJson<{ seenAt: string }>(await fetch("/api/v1/notifications/seen", { method: "POST", headers: { "X-BoxPilot-CSRF": csrfToken } }));
      setList((current) => (current ? { ...current, seenAt: body.seenAt, unseen: 0 } : current));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Could not mark them seen");
    }
  };

  const go = (entry: NotificationEntry) => {
    const destination = destinationOf(entry);
    setOpen(false);
    if (destination.kind === "activity") openActivity(destination.jobId ?? undefined);
    else if (destination.tab) onNavigate(destination.view, { tab: destination.tab });
    else onNavigate(destination.view);
  };

  const unseen = list?.unseen ?? 0;
  const now = Date.now();
  const isNew = (entry: NotificationEntry) => !list?.seenAt || entry.at > list.seenAt;

  return (
    <>
      <button className="bar-button bar-bell" data-live={unseen > 0 || undefined} type="button" aria-expanded={open} aria-haspopup="dialog" aria-label={unseen ? `Notifications, ${unseen} new` : "Notifications"} onClick={() => setOpen((value) => !value)}>
        <BellIcon aria-hidden="true" />
        {unseen > 0 && <span className="bar-badge" aria-hidden="true">{unseen > 99 ? "99+" : unseen}</span>}
      </button>
      {open && (
        <Sheet title="Notifications" kicker={unseen ? `${unseen} new` : "The last thirty days"} side="right" className="look-console notifications-sheet" onClose={() => setOpen(false)}>
          {/* Approvals pushed to a phone (M25.2): on for this device, the devices, the owner's choices. */}
          {role !== "viewer" && <PushPanel csrfToken={csrfToken} role={role} />}
          {(list || unseen > 0) && (
            <div className="notifications-head">
              {list && <Facts><b>{list.entries.length}</b> {list.entries.length === 1 ? "entry" : "entries"} · <b>{unseen}</b> new · target <b>{list.targetConfigured ? "set" : "not set"}</b></Facts>}
              {unseen > 0 && <Button variant="ghost" onClick={() => void markSeen()}>Mark all seen</Button>}
            </div>
          )}
          {problem && <Notice tone="danger" live title="The notifications could not be read">{problem}</Notice>}
          {list && !list.targetConfigured && (
            <Notice tone="warning" action={<Button onClick={() => { setOpen(false); onNavigate("settings", { tab: "notifications" }); }}>Set one in Settings</Button>}>
              No notification target is set, so none of this reached your phone.
            </Notice>
          )}
          {!list && !problem && <p className="notifications-quiet">Reading…</p>}
          {list && list.entries.length === 0 && <EmptyState title="Nothing in the last thirty days">Disk space, drive health, failed backups and new releases show up here.</EmptyState>}
          {list && list.entries.length > 0 && (
            <ul className="notifications-list" aria-label="What BoxPilot told you">
              {list.entries.map((entry) => {
                const delivery = deliveryOf(entry);
                const destination = destinationOf(entry);
                const fresh = isNew(entry);
                return (
                  <li key={entry.id} className="notifications-entry" data-new={fresh || undefined}>
                    <div className="notifications-entry__head">
                      <strong>{entry.title}</strong>
                      {fresh && <Tag tone="accent">New</Tag>}
                    </div>
                    {entry.message && <p className="notifications-entry__message">{entry.message}</p>}
                    <div className="notifications-entry__meta">
                      <time dateTime={entry.at} title={new Date(entry.at).toLocaleString()}>{relativeTime(entry.at, now)}</time>
                      <StatusChip status={delivery.status}>{delivery.words}</StatusChip>
                      {entry.kind === "alert" && (entry.resolvedAt
                        ? <StatusChip status="good">Cleared {relativeTime(entry.resolvedAt, now)}</StatusChip>
                        : entry.live ? <StatusChip status="warning">Still going</StatusChip> : null)}
                      <Button variant="ghost" className="notifications-entry__go" onClick={() => go(entry)}>{destination.label}</Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Sheet>
      )}
    </>
  );
}

export default NotificationCentre;
