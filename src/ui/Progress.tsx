import type { ReactNode } from "react";
import { cx, type Status } from "./types";

export interface ProgressProps {
  /** How far along, from 0 to `max`. Leave it out when nobody can say: the bar then moves on its own. */
  value?: number;
  max?: number;
  /** What is progressing, for assistive technology and shown above the bar: "Backing up Immich". */
  label: string;
  /** Hide the label and show only the bar (the name stays for assistive technology). */
  hideLabel?: boolean;
  /** Shown on the right of the label: "62%", "3 of 7", "2m 14s". */
  detail?: ReactNode;
  /** Colours the fill: a failure turns it red, a finished one green. */
  status?: Status;
  className?: string;
}

/**
 * A progress bar (M33.8), a native progressbar for assistive technology: with a value it says how
 * far along; without one it is indeterminate, drawn as a moving segment (still, for anyone who
 * asked for less motion). Cyan while it measures, as the Command Center draws what is measured.
 */
export function Progress({ value, max = 100, label, hideLabel = false, detail, status, className }: ProgressProps) {
  const known = typeof value === "number" && Number.isFinite(value);
  const share = known ? Math.min(100, Math.max(0, (value / (max || 1)) * 100)) : 0;
  return (
    <div className={cx("ui-progress", !known && "ui-progress--indeterminate", className)} data-status={status}>
      {!hideLabel && (
        <div className="ui-progress__head">
          <span className="ui-progress__label">{label}</span>
          {detail !== undefined && detail !== null && <span className="ui-progress__detail">{detail}</span>}
        </div>
      )}
      <div
        className="ui-progress__track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={known ? 0 : undefined}
        aria-valuemax={known ? max : undefined}
        aria-valuenow={known ? value : undefined}
        aria-valuetext={known && typeof detail === "string" ? detail : undefined}
      >
        <i className="ui-progress__fill" style={known ? { width: `${share}%` } : undefined} />
      </div>
    </div>
  );
}
