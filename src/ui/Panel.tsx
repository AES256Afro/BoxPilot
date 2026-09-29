import { useId, type ReactNode } from "react";
import { cx, type Status } from "./types";
import "./Panel.css";

export interface PanelProps {
  /** Said in small capitals: "Critical", "Prerequisites". */
  title: ReactNode;
  /** A count beside the title, marked with its status: { status: "danger", label: "2" }. */
  count?: { status: Status; label: ReactNode };
  /** One short fact on the right of the head, in mono: "5 of 7 ready", "checked 09:03". */
  meta?: ReactNode;
  /** Buttons for the whole panel, at the right end of its head. */
  actions?: ReactNode;
  /** The region's name when the title alone would not do ("Critical, 2"). */
  label?: string;
  className?: string;
  children?: ReactNode;
}

/**
 * A Command Center console panel (M33.7): a hairline box whose head holds the title in small
 * capitals, its count and one fact, and whose body draws its own rows to the edges. The panel Ops
 * draws, for any page built in that style.
 */
export function Panel({ title, count, meta, actions, label, className, children }: PanelProps) {
  const headingId = useId();
  return (
    <section className={cx("cc-panel", "ui-panel", className)} aria-labelledby={label ? undefined : headingId} aria-label={label}>
      <header className="cc-panel__head ui-panel__head">
        <h2>
          <span id={headingId}>{title}</span>
          {count && <span className="cc-count ui-marked" data-status={count.status}><span className="ui-mark" aria-hidden="true" />{count.label}</span>}
        </h2>
        {meta && <p className="cc-panel__meta">{meta}</p>}
        {actions && <div className="ui-panel__actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}
