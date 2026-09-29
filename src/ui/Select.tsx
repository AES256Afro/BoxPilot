import type { ChangeEvent, ComponentProps } from "react";
import { useFieldControl } from "./Field";
import { ChevronIcon } from "./icons";
import { cx } from "./types";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<ComponentProps<"select">, "children"> {
  /** The choices, in order. */
  options: SelectOption[];
  /** A first choice with no value ("Any time", "Pick a container…"), for when none is chosen. */
  placeholder?: string;
  /** The chosen value, beside (not instead of) onChange. */
  onValueChange?: (value: string) => void;
  /** Monospace, for choices that are names typed exactly (units, containers, interfaces). */
  mono?: boolean;
}

/**
 * A choice from a list (M33.8). It is the browser's own select, so the keyboard, the screen
 * reader and a phone's picker all work as people expect; only its face is the console's: the
 * field's box, the chevron drawn by the kit. Inside a Field it takes the field's label.
 */
export function Select({ options, placeholder, onValueChange, onChange, mono = false, className, ...rest }: SelectProps) {
  const field = useFieldControl(rest);
  return (
    <span className={cx("ui-select", className)}>
      <select
        {...rest}
        {...field}
        className={cx("ui-control", "ui-select__control", mono && "ui-input--mono")}
        onChange={(event: ChangeEvent<HTMLSelectElement>) => { onChange?.(event); onValueChange?.(event.target.value); }}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
      </select>
      <ChevronIcon className="ui-select__chevron" />
    </span>
  );
}
