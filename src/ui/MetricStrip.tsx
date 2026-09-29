import type { CSSProperties, ReactNode } from "react";
import { cx } from "./types";

export interface MetricStripProps {
  /** What the figures are, for assistive technology: "Processor, memory, disks and temperature". */
  label: string;
  /** MetricTiles, one per figure. */
  children: ReactNode;
  /**
   * The narrowest a tile may get before the strip wraps to another row: "9.5rem" for short figures,
   * "14rem" for tiles that carry a button. On a phone a tile takes the whole row when it must.
   */
  minTile?: string;
  className?: string;
}

/**
 * The row of figures across the top of a page (M33.14: Ops', Performance's, System's and Updates'
 * strips, promoted): MetricTiles side by side, as many as fit, wrapping on a narrow screen.
 */
export function MetricStrip({ label, children, minTile = "11rem", className }: MetricStripProps) {
  return (
    <section className={cx("ui-metric-strip", className)} aria-label={label} style={{ "--ui-strip-min": minTile } as CSSProperties}>
      {children}
    </section>
  );
}
