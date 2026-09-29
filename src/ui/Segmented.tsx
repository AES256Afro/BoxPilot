import type { ReactNode } from "react";
import { handleRadioKeys } from "./radio";
import { cx } from "./types";

export interface SegmentedOption<V extends string> {
  value: V;
  label: ReactNode;
  /** A figure after the label, in mono: how many rows this choice shows. */
  count?: number | string;
  disabled?: boolean;
}

export interface SegmentedProps<V extends string> {
  /** What the choice is about, for assistive technology: "Which units". */
  label: string;
  options: Array<SegmentedOption<V>>;
  /** The chosen value; null when none is (a search overrides the choice, for instance). */
  value: V | null;
  onChange: (value: V) => void;
  className?: string;
}

/**
 * One of a few, side by side (M33.8): a filter's scope, a view's range. A radio group, so the
 * arrow keys, Home and End move the choice as the ARIA radio pattern has it, and only the chosen
 * option is a tab stop. Changes only this page: a choice that changes the server is a Select in a
 * form, confirmed by its Button.
 */
export function Segmented<V extends string>({ label, options, value, onChange, className }: SegmentedProps<V>) {
  const focusable = options.some((option) => option.value === value) ? value : options.find((option) => !option.disabled)?.value;
  return (
    <div role="radiogroup" aria-label={label} className={cx("ui-segmented", className)} onKeyDown={(event) => handleRadioKeys(event, (next) => onChange(next as V))}>
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={option.value === focusable ? 0 : -1}
            data-value={option.value}
            disabled={option.disabled}
            className="ui-segmented__option"
            onClick={() => onChange(option.value)}
          >
            <span>{option.label}</span>
            {/* The space keeps "Failed 2" two words when the name is read; the gap draws it. */}
            {option.count !== undefined && option.count !== "" && <>{" "}<span className="ui-segmented__count">{option.count}</span></>}
          </button>
        );
      })}
    </div>
  );
}
