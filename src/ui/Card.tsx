import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./types";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** No inner padding, for a table or a list that draws its own rows to the edge. */
  flush?: boolean;
  children: ReactNode;
}

/**
 * A raised surface. Use it sparingly: for a table, a form, or a group that must read as one
 * object. Headings and status belong to the Section around it, not to the card.
 */
export function Card({ flush = false, className, children, ...rest }: CardProps) {
  return <div {...rest} className={cx("ui-card", flush && "ui-card--flush", className)}>{children}</div>;
}
