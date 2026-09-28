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
  /**
   * Opens this figure's detail (Home and Ops: the page it comes from). The whole tile is then one
   * button, so `children` are not drawn: a button cannot hold other buttons.
   */
  onSelect?: () => void;
  /** Actions for this figure, under it. */
  children?: ReactNode;
  className?: string;
}

/** A figure with its label: the Ops metric strip, the widgets on Home, the Updates page's counts. */
export function MetricTile({ label, value, caption, status, bar, onSelect, children, className }: MetricTileProps) {
  const max = bar?.max ?? 100;
  const share = bar ? Math.min(100, Math.max(0, (bar.value / (max || 1)) * 100)) : 0;
  const body = (
    <>
      <span className="ui-metric__label">{label}</span>
      <strong className="ui-metric__value">{value}</strong>
      {caption !== undefined && caption !== null && <span className="ui-metric__caption">{caption}</span>}
      {bar && (
        <span className="ui-metric__bar" role={onSelect ? undefined : "meter"} aria-hidden={onSelect ? true : undefined} aria-valuemin={onSelect ? undefined : 0} aria-valuemax={onSelect ? undefined : max} aria-valuenow={onSelect ? undefined : bar.value} aria-label={onSelect ? undefined : bar.label ?? (typeof label === "string" ? label : undefined)}>
          <i style={{ width: `${share}%` }} />
        </span>
      )}
    </>
  );
  if (onSelect) {
    // The figure is the button's name ("Memory 11.0 GB of 32 GB"), so the bar, which only repeats
    // it, is left out of what is read.
    return <button type="button" className={cx("ui-metric", "ui-metric--link", className)} data-status={status} onClick={onSelect}>{body}</button>;
  }
  return (
    <article className={cx("ui-metric", className)} data-status={status}>
      {body}
      {children && <div className="ui-metric__actions">{children}</div>}
    </article>
  );
}
