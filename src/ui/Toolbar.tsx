import type { ComponentProps, ReactNode } from "react";
import { CloseIcon, SearchIcon } from "./icons";
import { cx } from "./types";

export interface SearchFieldProps extends Omit<ComponentProps<"input">, "type" | "value" | "onChange"> {
  value: string;
  onValueChange: (value: string) => void;
  /** Its name for assistive technology: "Filter units". Also the placeholder when none is given. */
  label: string;
}

/**
 * A search box (M33.8): a lens, the words, and a clear button once something is typed. Escape
 * clears it too. It filters what the page already holds; say so in the label ("Filter units").
 */
export function SearchField({ value, onValueChange, label, placeholder, className, onKeyDown, ...rest }: SearchFieldProps) {
  return (
    <span className={cx("ui-search", className)}>
      <SearchIcon className="ui-search__icon" />
      <input
        {...rest}
        type="search"
        aria-label={label}
        placeholder={placeholder ?? `${label}…`}
        value={value}
        className="ui-control ui-input ui-search__input"
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.key === "Escape" && value) { event.preventDefault(); event.stopPropagation(); onValueChange(""); }
        }}
      />
      {value && (
        <button type="button" className="ui-search__clear" aria-label={`Clear ${label.toLowerCase()}`} onClick={() => onValueChange("")}>
          <CloseIcon />
        </button>
      )}
    </span>
  );
}

export interface ToolbarProps {
  /** What the controls act on, for assistive technology: "Units". Read as "Units, group". */
  label: string;
  /** A search box first, growing to fill the row. */
  search?: SearchFieldProps;
  /** Filters after it: a Segmented, a Select or two. */
  filters?: ReactNode;
  /** Actions at the end of the row, each a Button with its tier. */
  actions?: ReactNode;
  /** Anything else, between the filters and the actions. */
  children?: ReactNode;
  className?: string;
}

/**
 * The row over a table or a list (M33.8): a search, the filters, and the actions, wrapping onto
 * more lines on a phone rather than scrolling sideways. A group, not an ARIA toolbar: each control
 * keeps its own tab stop.
 */
export function Toolbar({ label, search, filters, actions, children, className }: ToolbarProps) {
  return (
    <div role="group" aria-label={label} className={cx("ui-toolbar", className)}>
      {search && <SearchField {...search} className={cx("ui-toolbar__search", search.className)} />}
      {filters && <div className="ui-toolbar__filters">{filters}</div>}
      {children}
      {actions && <div className="ui-toolbar__actions">{actions}</div>}
    </div>
  );
}
