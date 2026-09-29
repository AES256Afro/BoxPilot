import { useId, type ReactNode } from "react";
import { cx, type Status } from "./types";

export interface PanelProps {
  /** Named in small monospace capitals, as the Command Center draws it: "Units", "Critical". */
  title: ReactNode;
  /**
   * A count beside the title. A number or words are drawn plain in amber; { status, label } carries
   * the status's own mark as well as its colour ("Alerts ▲ 2"). The heading reads "Alerts, 2".
   */
  count?: number | string | { status: Status; label: ReactNode };
  /** Facts on the right of the head, in mono: "3 running · 1 waiting". Put figures in <b>. */
  meta?: ReactNode;
  /** Buttons for the whole panel, at the right end of its head. Each with its `risk`. */
  actions?: ReactNode;
  /** A line under the body: totals, when it was read, a way to the rest. */
  footer?: ReactNode;
  /**
   * The region's name, when the title alone would not do ("Critical, 2", "Activity on this
   * server"). Without it the region is named by its title.
   */
  label?: string;
  /**
   * Padding around the body, for words, a form or facts. Without it the body draws its own rows
   * to the edges, as a table or a list of rows does (the Command Center's default).
   */
  padded?: boolean;
  /** Heading level: 2 on a page (the default), 3 inside another panel or a sheet. */
  level?: 2 | 3;
  id?: string;
  className?: string;
  children?: ReactNode;
}

/**
 * The console's panel (M33.7 for Ops and Repair, the kit's since M33.8): hairline edges, a small
 * uppercase heading with its count, facts and actions on the right, the body, and an optional
 * footer. It is a region named by its title (or `label`), so a screen reader can move between
 * panels as between the parts of the page; the heading itself also reads the count.
 */
export function Panel({ title, count, meta, actions, footer, label, padded = false, level = 2, id, className, children }: PanelProps) {
  const titleId = useId();
  const Heading = level === 2 ? "h2" : "h3";
  const counted = count !== undefined && count !== null && count !== "";
  const marked = counted && typeof count === "object";
  return (
    <section id={id} className={cx("ui-panel", padded && "ui-panel--padded", className)} aria-labelledby={label ? undefined : titleId} aria-label={label}>
      <header className="ui-panel__head">
        <Heading className="ui-panel__title">
          <span id={titleId}>{title}</span>
          {counted && (marked
            ? <span className="ui-panel__count ui-marked" data-status={count.status}><span className="ui-mark" aria-hidden="true" /><span className="ui-visually-hidden">,</span>{typeof count.label === "string" ? ` ${count.label}` : <> {count.label}</>}</span>
            : <span className="ui-panel__count"><span className="ui-visually-hidden">,</span>{` ${String(count)}`}</span>)}
        </Heading>
        {meta && <p className="ui-panel__meta">{meta}</p>}
        {actions && <div className="ui-panel__actions">{actions}</div>}
      </header>
      <div className="ui-panel__body">{children}</div>
      {footer && <footer className="ui-panel__foot">{footer}</footer>}
    </section>
  );
}
