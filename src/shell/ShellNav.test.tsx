import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShellDock, dockAreas } from "./ShellNav";

afterEach(() => cleanup());

describe("the dock", () => {
  it("names every area under its icon, and says which stay on a narrow screen", () => {
    render(<ShellDock view="backups" onSelect={vi.fn()} />);
    const dock = screen.getByRole("navigation", { name: "Admin areas" });
    const labels = Array.from(dock.querySelectorAll(".ui-dock__label")).map((label) => label.textContent);
    expect(labels).toEqual(expect.arrayContaining(["Updates", "Storage", "VMs", "Repair", "Apps", "Automate", "Metrics", "Classic", "Settings", "More"]));
    expect(within(dock).getByRole("button", { name: "Backups" }).getAttribute("aria-current")).toBe("page");
    // A phone keeps four areas and More; every area is still reachable through More.
    expect(dockAreas.filter((area) => area.priority === 1).map((area) => area.id)).toEqual(["updates", "storage", "backups", "repairs"]);
    expect(dock.querySelector('[data-priority="overflow"]')?.textContent).toContain("More");
  });

  it("opens every area from More, named in full, and goes to the one chosen", () => {
    const onSelect = vi.fn();
    render(<ShellDock view="home" onSelect={onSelect} />);
    fireEvent.click(within(screen.getByRole("navigation", { name: "Admin areas" })).getByRole("button", { name: "All areas" }));
    const sheet = screen.getByRole("dialog", { name: "All areas" });
    expect(within(sheet).getAllByRole("button").filter((button) => button.classList.contains("ui-dock__item"))).toHaveLength(dockAreas.length);
    fireEvent.click(within(sheet).getByRole("button", { name: "Virtual Machines" }));
    expect(onSelect).toHaveBeenCalledWith("virtualization");
    expect(screen.queryByRole("dialog", { name: "All areas" })).toBeNull();
  });

  it("closes the sheet on Escape without going anywhere", () => {
    const onSelect = vi.fn();
    render(<ShellDock view="home" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: "All areas" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "All areas" })).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
