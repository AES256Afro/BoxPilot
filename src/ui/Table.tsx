import { useMemo, useState, type ReactNode } from "react";
import { ChevronIcon } from "./icons";
import { cx, type Status } from "./types";

export interface TableColumn<Row> {
  id: string;
  header: ReactNode;
  cell: (row: Row) => ReactNode;
  /** A figure: right-aligned, in tabular numerals (monospace at compact density). */
  numeric?: boolean;
  /** Said before the value when a row is stacked on a phone. Defaults to the header, when it is text. */
  label?: string;
  /** Left out at phone width, where it would push the row wider than the screen. */
  hideOnPhone?: boolean;
  /**
   * Makes the column sortable (M33.8): the header becomes a button, and rows are ordered by this
   * value. Text sorts as people read it (numbers inside names in order), empty values last.
   */
  sortValue?: (row: Row) => string | number | null | undefined;
  className?: string;
}

export type SortDirection = "ascending" | "descending";

export interface TableProps<Row> {
  /** What the table lists; its name for assistive technology, and shown when `showCaption` is set. */
  caption: ReactNode;
  showCaption?: boolean;
  columns: Array<TableColumn<Row>>;
  rows: Row[];
  rowKey: (row: Row) => string;
  /** A status for the whole row, drawn on its leading edge with the status's own mark. */
  rowStatus?: (row: Row) => Status | undefined;
  /** What an empty table says, in one row across every column: words, or an EmptyState. */
  empty?: ReactNode;
  /** At phone width each row becomes a block of labelled lines instead of scrolling sideways. */
  stackOnPhone?: boolean;
  /** The order rows start in, for a table with sortable columns. */
  defaultSort?: { column: string; direction: SortDirection };
  className?: string;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compare(a: string | number | null | undefined, b: string | number | null | undefined): number {
  const aEmpty = a === null || a === undefined || a === "";
  const bEmpty = b === null || b === undefined || b === "";
  if (aEmpty || bEmpty) return aEmpty === bEmpty ? 0 : aEmpty ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return collator.compare(String(a), String(b));
}

/**
 * Rows at the density's height (M33.3): Ops' containers, job queue and backup matrix, and any page
 * rebuilt on src/ui. The class is the `ui-table` pages already used; this adds a caption, figures
 * aligned as figures, a status per row drawn as the status's own mark (a shape as well as a colour;
 * give the row a column that says it in words too), an empty state, a phone layout that does not
 * scroll the page sideways, and (M33.8) columns sortable from their headers, with aria-sort.
 */
export function Table<Row>({ caption, showCaption = false, columns, rows, rowKey, rowStatus, empty, stackOnPhone = true, defaultSort, className }: TableProps<Row>) {
  const [sort, setSort] = useState<{ column: string; direction: SortDirection } | null>(defaultSort ?? null);
  const sorted = useMemo(() => {
    const column = sort ? columns.find((entry) => entry.id === sort.column && entry.sortValue) : undefined;
    if (!column?.sortValue || !sort) return rows;
    const value = column.sortValue;
    const sign = sort.direction === "ascending" ? 1 : -1;
    // Empty values stay last whichever way the rest runs.
    return rows.map((row, index) => ({ row, index, key: value(row) })).sort((a, b) => {
      const aEmpty = a.key === null || a.key === undefined || a.key === "";
      const bEmpty = b.key === null || b.key === undefined || b.key === "";
      if (aEmpty || bEmpty) return aEmpty === bEmpty ? a.index - b.index : aEmpty ? 1 : -1;
      return sign * compare(a.key, b.key) || a.index - b.index;
    }).map((entry) => entry.row);
  }, [columns, rows, sort]);
  const toggle = (id: string) => setSort((current) => (current?.column === id ? { column: id, direction: current.direction === "ascending" ? "descending" : "ascending" } : { column: id, direction: "ascending" }));
  return (
    <div className={cx("ui-table-wrap", className)}>
      <table className={cx("ui-table", stackOnPhone && "ui-table--stack")}>
        <caption className={showCaption ? "ui-table__caption" : "ui-visually-hidden"}>{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => {
              const active = sort?.column === column.id ? sort.direction : undefined;
              return (
                <th key={column.id} scope="col" aria-sort={column.sortValue ? active ?? "none" : undefined} className={cx(column.numeric && "ui-table__num", column.hideOnPhone && "ui-table__wide-only", column.className)}>
                  {column.sortValue ? (
                    <button type="button" className="ui-table__sort" data-direction={active} onClick={() => toggle(column.id)}>
                      {column.header}
                      <ChevronIcon className="ui-table__sort-icon" />
                    </button>
                  ) : column.header}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr><td className="ui-table__empty" colSpan={columns.length}>{empty ?? "Nothing to show."}</td></tr>
          ) : sorted.map((row) => {
            const status = rowStatus?.(row);
            return (
              <tr key={rowKey(row)} data-status={status}>
                {columns.map((column, index) => (
                  <td
                    key={column.id}
                    className={cx(column.numeric && "ui-table__num", column.hideOnPhone && "ui-table__wide-only", column.className)}
                    data-label={column.label ?? (typeof column.header === "string" ? column.header : undefined)}
                  >
                    {index === 0 && status && <span className="ui-mark ui-table__mark" aria-hidden="true" />}
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
