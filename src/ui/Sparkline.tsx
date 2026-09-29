import { cx } from "./types";

export interface SparklineProps {
  /** Oldest first. A null is a read without this figure: the line skips it rather than inventing one. */
  values: ReadonlyArray<number | null>;
  /**
   * The smallest range the line is drawn over, in the figure's own unit, so a processor moving
   * between 27.1% and 27.4% draws as the near-flat line it is instead of filling the box.
   */
  floor?: number;
  className?: string;
}

const width = 64;
const height = 24;
const inset = 2;

/**
 * The points of a sparkline in a 64 by 24 box, oldest at the left and spread across it: scaled to
 * the values' own range, widened to `floor` when that is narrower. Empty below two values, since
 * one read is a dot, not a trend. Pure, so the tests can hold it.
 */
export function sparkPoints(values: ReadonlyArray<number | null>, floor = 0): Array<[number, number]> {
  const known = values.map((value, index) => [index, value] as const).filter((entry): entry is readonly [number, number] => entry[1] !== null && Number.isFinite(entry[1]));
  if (known.length < 2) return [];
  const numbers = known.map(([, value]) => value);
  let low = Math.min(...numbers);
  let high = Math.max(...numbers);
  if (high - low < floor) {
    const middle = (high + low) / 2;
    low = middle - floor / 2;
    high = middle + floor / 2;
  }
  const span = high - low || 1;
  const first = known[0][0];
  const last = known[known.length - 1][0];
  const step = (width - inset * 2) / (last - first || 1);
  return known.map(([index, value]) => [
    Math.round((inset + (index - first) * step) * 100) / 100,
    Math.round((height - inset - ((value - low) / span) * (height - inset * 2)) * 100) / 100,
  ]);
}

/**
 * A figure's last few minutes as a line (Ops, M33.7): decoration beside the figure itself, so it
 * is hidden from assistive technology. Draws nothing until there are two values to join.
 */
export function Sparkline({ values, floor, className }: SparklineProps) {
  const points = sparkPoints(values, floor);
  if (points.length < 2) return null;
  const line = points.map(([x, y]) => `${x},${y}`).join(" ");
  const area = `M${points[0][0]},${height} L${points.map(([x, y]) => `${x},${y}`).join(" L")} L${points[points.length - 1][0]},${height} Z`;
  return (
    <svg className={cx("ui-spark", className)} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <path className="ui-spark__area" d={area} />
      <polyline className="ui-spark__line" points={line} />
    </svg>
  );
}
