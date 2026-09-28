import type { ReactNode } from "react";
import { cx, type Status } from "./types";

export interface MetricTileProps {
  /** What is measured: "Memory", "Available updates". */
  label: ReactNode;
  /** The number or state, the largest thing on the tile. */
  value: ReactNode;
  /** One line under the value: "3 security", "cache 18.2 GB". */
  caption?: ReactNode;
  /** Colours the tile's edge and its bar. Leave it out for a plain figure. */
  status?: Status;
  /** A bar under the value, for a share of something. `value` runs from 0 to `max` (100 by default). */
  bar?: { value: number; max?: number; label?: string };
  /** Actions for this figure, under it. */
  children?: ReactNode;
  className?: string;
}

/** A figure with its label: the Ops metric strip, the widgets on Home, the Updates page's counts. */
export function MetricTile({ label, value, caption, status, bar, children, className }: MetricTileProps) {
  const max = bar?.max ?? 100;
  const share = bar ? Math.min(100, Math.max(0, (bar.value / (max || 1)) * 100)) : 0;
  return (
    <article className={cx("ui-metric", className)} data-status={status}>
      <span className="ui-metric__label">{label}</span>
      <strong className="ui-metric__value">{value}</strong>
      {caption !== undefined && caption !== null && <span className="ui-metric__caption">{caption}</span>}
      {bar && (
        <span className="ui-metric__bar" role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={bar.value} aria-label={bar.label ?? (typeof label === "string" ? label : undefined)}>
          <i style={{ width: `${share}%` }} />
        </span>
      )}
      {children && <div className="ui-metric__actions">{children}</div>}
    </article>
  );
}
