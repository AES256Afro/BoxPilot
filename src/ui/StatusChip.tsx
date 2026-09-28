import type { ReactNode } from "react";
import { cx, type Status } from "./types";

export interface StatusChipProps {
  status: Status;
  /** Say what the status is about ("3 security updates", "Up to date"); the colour only repeats it. */
  children: ReactNode;
  title?: string;
  className?: string;
}

/**
 * A status in a pill. Each status has its own mark as well as its own colour: a dot for good and
 * neutral, a triangle for warning, a diamond for danger, and a hollow dashed ring for unknown.
 */
export function StatusChip({ status, children, title, className }: StatusChipProps) {
  return (
    <span className={cx("ui-chip", `ui-chip--${status}`, className)} data-status={status} title={title}>
      <span className="ui-mark" aria-hidden="true" />
      {children}
    </span>
  );
}
