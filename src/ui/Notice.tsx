import type { ReactNode } from "react";
import { CloseIcon } from "./icons";
import { cx, type Status } from "./types";

export type NoticeTone = "info" | "success" | "warning" | "danger";

const statusOf: Record<NoticeTone, Status> = { info: "neutral", success: "good", warning: "warning", danger: "danger" };

export interface NoticeProps {
  /** info: a fact worth knowing; success: something finished; warning: needs a look; danger: something failed. */
  tone?: NoticeTone;
  /** What happened, first and in a few words: "The journal could not be read". */
  title?: ReactNode;
  /** One or two sentences more, when the title needs them. */
  children?: ReactNode;
  /** What to do about it: a Button, with its tier. */
  action?: ReactNode;
  /** Offers a dismiss button, for a notice about something already dealt with. */
  onDismiss?: () => void;
  /**
   * Announce it when it appears: as an alert for a warning or danger, politely otherwise. Use it
   * for what a click just caused (an error from a request), not for what the page found on load.
   */
  live?: boolean;
  className?: string;
}

/**
 * A line the page needs to say, with its status's mark and colour on the leading edge (M33.8):
 * a request that failed, a job that finished, a setting that needs a look. Short: the title says
 * it, the body adds a sentence, the action fixes it.
 */
export function Notice({ tone = "info", title, children, action, onDismiss, live = false, className }: NoticeProps) {
  const role = !live ? undefined : tone === "danger" || tone === "warning" ? "alert" : "status";
  return (
    <div className={cx("ui-notice", `ui-notice--${tone}`, "ui-marked", className)} data-status={statusOf[tone]} role={role}>
      <span className="ui-mark ui-notice__mark" aria-hidden="true" />
      <div className="ui-notice__body">
        {title && <strong className="ui-notice__title">{title}</strong>}
        {children && <div className="ui-notice__text">{children}</div>}
      </div>
      {action && <div className="ui-notice__action">{action}</div>}
      {onDismiss && (
        <button type="button" className="ui-notice__dismiss" aria-label="Dismiss" onClick={onDismiss}>
          <CloseIcon />
        </button>
      )}
    </div>
  );
}

export interface EmptyStateProps {
  /** What is not here, as a fact: "No units match", "No backups yet". */
  title: ReactNode;
  /** One sentence: why, or what would fill it. */
  children?: ReactNode;
  /** The way to fill it: a Button with its tier. */
  action?: ReactNode;
  /** A decorative icon (aria-hidden), above the title. */
  icon?: ReactNode;
  className?: string;
}

/**
 * What a panel or a table shows when it has nothing (M33.8): the fact, a sentence, and the one
 * action that would change it. Never a blank space, and never "healthy" about something unread:
 * use a Notice for a read that failed.
 */
export function EmptyState({ title, children, action, icon, className }: EmptyStateProps) {
  return (
    <div className={cx("ui-empty", className)}>
      {icon && <span className="ui-empty__icon" aria-hidden="true">{icon}</span>}
      <p className="ui-empty__title">{title}</p>
      {children && <p className="ui-empty__text">{children}</p>}
      {action && <div className="ui-empty__action">{action}</div>}
    </div>
  );
}
