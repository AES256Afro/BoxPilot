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

  it("stands up as Ops' rail: the same areas under the BoxPilot mark, led by Ops as the current one", () => {
    const onSelect = vi.fn();
    render(<ShellDock view="ops" onSelect={onSelect} variant="rail" />);
    const rail = screen.getByRole("navigation", { name: "Admin areas" });
    expect(rail.classList.contains("shell-dock--rail")).toBe(true);
    expect(rail.querySelector(".shell-rail__logo")?.getAttribute("aria-hidden")).toBe("true");
    const items = within(rail).getAllByRole("button").filter((button) => button.classList.contains("ui-dock__item"));
    expect(items[0].getAttribute("aria-current")).toBe("page");
    expect(within(items[0]).getByText("Ops", { selector: ".ui-visually-hidden" })).toBeTruthy();
    // Every area of the dock is on the rail, each still named in full for assistive technology.
    for (const area of dockAreas) expect(rail.querySelector(`[data-area="${area.id}"]`)).not.toBeNull();
    fireEvent.click(within(rail).getByRole("button", { name: "Firewall" }));
    expect(onSelect).toHaveBeenCalledWith("firewall");
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
