import type { ReactNode } from "react";
import { cx } from "./types";

export interface FactsProps {
  /** The facts, joined with " · ": figures in <b>, names and ids in <code>. */
  children: ReactNode;
  /** A line of its own (the default), or a span inside a row's words. */
  as?: "p" | "span";
  className?: string;
}

/**
 * A line of facts in mono, as a page header's `meta` draws them: "12 entries · 3 new · target set"
 * (M33.14: Activity's, the notifications', the approval dialog's and Settings' lines, promoted).
 * Muted, with each figure in <b> brought forward.
 */
export function Facts({ children, as: Tag = "p", className }: FactsProps) {
  return <Tag className={cx("ui-facts", className)}>{children}</Tag>;
}
