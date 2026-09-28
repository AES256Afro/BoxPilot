import { useId, type ReactNode } from "react";
import { StatusChip } from "./StatusChip";
import { cx, type Status } from "./types";

export interface SectionProps {
  title: ReactNode;
  /** The finding, said before anything else: { status: "warning", label: "14 waiting" }. */
  status?: { status: Status; label: ReactNode };
  /** One sentence after the status, when the title and status need it. Not a paragraph. */
  summary?: ReactNode;
  /** Buttons for the whole section, on the right of the heading. */
  actions?: ReactNode;
  /** Heading level; 2 on a page, 3 inside another section. */
  level?: 2 | 3;
  children?: ReactNode;
  className?: string;
}

/**
 * A part of a page whose heading puts the status first: the chip comes before the title, in the
 * heading itself, so it is the first thing seen and the first thing read out.
 */
export function Section({ title, status, summary, actions, level = 2, children, className }: SectionProps) {
  const headingId = useId();
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <section className={cx("ui-section", className)} aria-labelledby={headingId}>
      <div className="ui-section__head">
        <div className="ui-section__heading">
          <Heading id={headingId} className="ui-section__title">
            {status && <StatusChip status={status.status}>{status.label}</StatusChip>}
            <span>{title}</span>
          </Heading>
          {summary && <p className="ui-section__summary">{summary}</p>}
        </div>
        {actions && <div className="ui-section__actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
