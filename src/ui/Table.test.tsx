import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Table, type TableColumn } from ".";

afterEach(() => cleanup());

interface Row { name: string; cpu: number; state: string }
const rows: Row[] = [{ name: "jellyfin", cpu: 3.2, state: "up" }, { name: "immich", cpu: 11.8, state: "stopped" }];
const columns: Array<TableColumn<Row>> = [
  { id: "name", header: "Name", cell: (row) => row.name },
  { id: "cpu", header: "CPU", numeric: true, cell: (row) => `${row.cpu}%` },
  { id: "state", header: <abbr title="State">St</abbr>, label: "State", hideOnPhone: true, cell: (row) => row.state },
];

describe("Table", () => {
  it("is named by its caption, with a header for each column", () => {
    render(<Table caption="Containers" columns={columns} rows={rows} rowKey={(row) => row.name} />);
    const table = screen.getByRole("table", { name: "Containers" });
    const headers = within(table).getAllByRole("columnheader");
    expect(headers.map((header) => header.textContent)).toEqual(["Name", "CPU", "St"]);
    expect(headers.every((header) => header.getAttribute("scope") === "col")).toBe(true);
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    // The caption names the table without taking room, unless it is asked to show.
    expect(table.querySelector("caption")?.className).toBe("ui-visually-hidden");
  });

  it("aligns figures, names each cell for the phone layout, and marks what a phone leaves out", () => {
    render(<Table caption="Containers" columns={columns} rows={rows} rowKey={(row) => row.name} />);
    const [name, cpu, state] = within(screen.getAllByRole("row")[1]).getAllByRole("cell");
    expect(name.getAttribute("data-label")).toBe("Name");
    expect(cpu.className).toContain("ui-table__num");
    expect(cpu.textContent).toBe("3.2%");
    expect(state.getAttribute("data-label")).toBe("State"); // the header is not text, so the label is used
    expect(state.className).toContain("ui-table__wide-only");
    expect(screen.getByRole("columnheader", { name: "CPU" }).className).toContain("ui-table__num");
  });

  it("draws a row's status as its mark in the first cell, and leaves other rows plain", () => {
    render(<Table caption="Containers" columns={columns} rows={rows} rowKey={(row) => row.name} rowStatus={(row) => (row.state === "stopped" ? "danger" : undefined)} />);
    const [, jellyfin, immich] = screen.getAllByRole("row");
    expect(immich.getAttribute("data-status")).toBe("danger");
    const mark = within(immich).getAllByRole("cell")[0].querySelector(".ui-table__mark");
    expect(mark?.getAttribute("aria-hidden")).toBe("true");
    expect(jellyfin.hasAttribute("data-status")).toBe(false);
    expect(jellyfin.querySelector(".ui-table__mark")).toBeNull();
  });

  it("says so in one row across every column when there is nothing", () => {
    render(<Table caption="Jobs" columns={columns} rows={[]} rowKey={(row) => row.name} empty="No jobs yet." />);
    const cell = screen.getByRole("cell", { name: "No jobs yet." });
    expect(cell.getAttribute("colspan")).toBe("3");
  });

  it("stacks on a phone unless told to scroll, and can show its caption", () => {
    const { rerender } = render(<Table caption="Jobs" showCaption columns={columns} rows={rows} rowKey={(row) => row.name} />);
    expect(screen.getByRole("table").className).toContain("ui-table--stack");
    expect(screen.getByText("Jobs").className).toBe("ui-table__caption");
    rerender(<Table caption="Jobs" stackOnPhone={false} columns={columns} rows={rows} rowKey={(row) => row.name} />);
    expect(screen.getByRole("table").className).not.toContain("ui-table--stack");
  });
});
