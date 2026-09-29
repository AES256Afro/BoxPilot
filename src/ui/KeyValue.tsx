import type { ReactNode } from "react";
import { cx, type Status } from "./types";

export interface KeyValueItem {
  /** A stable key for the row. */
  id: string;
  /** What the fact is: "Kernel", "In / out", "Last backup". */
  label: ReactNode;
  /** The fact itself. */
  value: ReactNode;
  /** In monospace: a version, a path, an address, a count. */
  mono?: boolean;
  /** A status drawn with its mark before the value; say it in the value's words too. */
  status?: Status;
  /** A line under the value: its unit, where it came from, when it was read. */
  hint?: ReactNode;
}

export interface KeyValueProps {
  items: KeyValueItem[];
  /**
   * rows: label beside value, one fact per row (a sheet's facts). columns: several facts across,
   * label over value (a panel's summary). strip: the Command Center's strip of key facts along the
   * top of a page ("UFW active | IN / OUT deny / allow | ..."), wrapping on a narrow screen.
   */
  layout?: "rows" | "columns" | "strip";
  className?: string;
}

/**
 * Facts as a description list (M33.8): each a label and a value, read as pairs. Facts come first
 * on every console page, so this is usually the first thing under the header.
 */
export function KeyValue({ items, layout = "rows", className }: KeyValueProps) {
  return (
    <dl className={cx("ui-kv", `ui-kv--${layout}`, className)}>
      {items.map((item) => (
        <div key={item.id} className="ui-kv__item ui-marked" data-status={item.status}>
          <dt className="ui-kv__label">{item.label}</dt>
          <dd className={cx("ui-kv__value", item.mono && "ui-kv__value--mono")}>
            {item.status && <span className="ui-mark ui-kv__mark" aria-hidden="true" />}
            {item.value}
            {item.hint !== undefined && item.hint !== null && <span className="ui-kv__hint">{item.hint}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}
