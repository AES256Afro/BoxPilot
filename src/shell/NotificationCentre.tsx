import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { openActivity, openNotificationsEvent } from "../activityEvents";
import { viewLabel, type ViewName } from "../data";
import { relativeTime } from "../home/format";
import { readJson } from "../http";
import { Button, StatusChip, type Status } from "../ui";
import { useDialogFocus } from "../useDialogFocus";
import { BellIcon } from "./areaIcons";

/*
 * The notification centre (M36): the bell in the top bar and what BoxPilot told the owner lately -
 * conditions raised and whether they have cleared, news, failed jobs pushed - with when, whether the
 * notification target took it, and a way to the page it is about. Read-only apart from "Mark all
 * seen", which moves this account's own marker. The server keeps the record
 * (server/notification-history.mjs) and cuts another account's entries back to their kind.
 */

export interface NotificationEntry {
  id: string;
  kind: "alert" | "notice" | "job";
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
export function destinationOf(entry: NotificationEntry): { kind: "activity"; jobId: string | null; label: string } | { kind: "view"; view: ViewName; label: string } {
  const [, subject] = entry.key.split(/:(.*)/s);
  if (entry.family === "job.failed" || entry.family === "approval.lapsed") return { kind: "activity", jobId: subject && entry.key !== entry.family ? subject : null, label: "Open in Activity" };
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
  return { kind: "view", view, label: `Open ${viewLabel(view)}` };
}

/** Whether it arrived, in words, with the status that goes with them. */
export function deliveryOf(entry: NotificationEntry): { status: Status; words: string } {
  if (entry.delivered) return { status: "good", words: "Sent" };
  if (entry.reason === "no-target") return { status: "neutral", words: "Not sent: no target set" };
  return { status: "warning", words: "Sending failed" };
}

const pollMs = 60_000;

export function NotificationCentre({ csrfToken, onNavigate }: { csrfToken: string; onNavigate: (view: ViewName) => void }) {
  const [list, setList] = useState<NotificationList | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);
  useDialogFocus(panelRef, open);

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
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

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
    else onNavigate(destination.view);
  };

  const unseen = list?.unseen ?? 0;
  const now = Date.now();
  const isNew = (entry: NotificationEntry) => !list?.seenAt || entry.at > list.seenAt;

  return (
    <>
      <button className="text-button notice-bell" type="button" aria-expanded={open} aria-haspopup="dialog" aria-label={unseen ? `Notifications, ${unseen} new` : "Notifications"} onClick={() => setOpen((value) => !value)}>
        <BellIcon className="notice-bell__icon" aria-hidden="true" />
        {unseen > 0 && <span className="activity-badge" aria-hidden="true">{unseen > 99 ? "99+" : unseen}</span>}
      </button>
      {open && createPortal(
        <div className="activity-backdrop" role="presentation" onMouseDown={() => setOpen(false)}>
          <aside ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Notifications" className="activity-drawer notice-centre" onMouseDown={(event) => event.stopPropagation()}>
            <header className="activity-header">
              <div>
                <span className="eyebrow">What BoxPilot told you</span>
                <h2>{unseen ? `${unseen} new` : "Notifications"}</h2>
              </div>
              <div className="notice-centre__head-actions">
                {unseen > 0 && <Button variant="ghost" onClick={() => void markSeen()}>Mark all seen</Button>}
                <button className="icon-button" type="button" aria-label="Close notifications" onClick={() => setOpen(false)}>X</button>
              </div>
            </header>
            <div className="activity-list">
              {problem && <p className="auth-error" role="alert">{problem}</p>}
              {list && !list.targetConfigured && (
                <p className="notice-centre__target">No notification target is set, so none of this reached your phone. <button className="text-button" type="button" onClick={() => { setOpen(false); onNavigate("settings"); }}>Set one in Settings</button></p>
              )}
              {!list && !problem && <p className="activity-empty">Reading…</p>}
              {list && list.entries.length === 0 && <p className="activity-empty">Nothing in the last thirty days. Disk space, drive health, failed backups and new releases show up here.</p>}
              {list && list.entries.length > 0 && (
                <ul className="notice-centre__list">
                  {list.entries.map((entry) => {
                    const delivery = deliveryOf(entry);
                    const destination = destinationOf(entry);
                    return (
                      <li key={entry.id} className="notice-entry" data-new={isNew(entry) || undefined}>
                        <div className="notice-entry__head">
                          <strong>{entry.title}</strong>
                          {isNew(entry) && <span className="notice-entry__new">New</span>}
                        </div>
                        {entry.message && <p className="notice-entry__message">{entry.message}</p>}
                        <div className="notice-entry__meta">
                          <time dateTime={entry.at} title={new Date(entry.at).toLocaleString()}>{relativeTime(entry.at, now)}</time>
                          <StatusChip status={delivery.status}>{delivery.words}</StatusChip>
                          {entry.kind === "alert" && (entry.resolvedAt
                            ? <StatusChip status="good">Cleared {relativeTime(entry.resolvedAt, now)}</StatusChip>
                            : entry.live ? <StatusChip status="warning">Still going</StatusChip> : null)}
                          <button className="text-button notice-entry__go" type="button" onClick={() => go(entry)}>{destination.label}</button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </aside>
        </div>,
        document.body,
      )}
    </>
  );
}

export default NotificationCentre;
