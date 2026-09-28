import type { ReactNode } from "react";
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
  className?: string;
}

export interface TableProps<Row> {
  /** What the table lists; its name for assistive technology, and shown when `showCaption` is set. */
  caption: ReactNode;
  showCaption?: boolean;
  columns: Array<TableColumn<Row>>;
  rows: Row[];
  rowKey: (row: Row) => string;
  /** A status for the whole row, drawn on its leading edge with the status's own mark. */
  rowStatus?: (row: Row) => Status | undefined;
  /** What an empty table says, in one row across every column. */
  empty?: ReactNode;
  /** At phone width each row becomes a block of labelled lines instead of scrolling sideways. */
  stackOnPhone?: boolean;
  className?: string;
}

/**
 * Rows at the density's height (M33.3): Ops' containers, job queue and backup matrix, and any page
 * rebuilt on src/ui. The class is the `ui-table` pages already used; this adds a caption, figures
 * aligned as figures, a status per row drawn as the status's own mark (a shape as well as a colour;
 * give the row a column that says it in words too), an empty state, and a phone layout that does
 * not scroll the page sideways.
 */
export function Table<Row>({ caption, showCaption = false, columns, rows, rowKey, rowStatus, empty, stackOnPhone = true, className }: TableProps<Row>) {
  return (
    <div className={cx("ui-table-wrap", className)}>
      <table className={cx("ui-table", stackOnPhone && "ui-table--stack")}>
        <caption className={showCaption ? "ui-table__caption" : "ui-visually-hidden"}>{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.id} scope="col" className={cx(column.numeric && "ui-table__num", column.hideOnPhone && "ui-table__wide-only", column.className)}>{column.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td className="ui-table__empty" colSpan={columns.length}>{empty ?? "Nothing to show."}</td></tr>
          ) : rows.map((row) => {
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
