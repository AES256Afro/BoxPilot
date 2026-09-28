import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reloadThemeChoice } from "../useTheme";
import { Button, Dock, MetricTile, RiskTag, Section, StatusChip, ThemeSwitch, Tile, riskOf } from ".";

afterEach(() => cleanup());

describe("Button", () => {
  it("keeps the action as its name and reads the tier as its description", () => {
    render(<><Button risk="low">Refresh lists</Button><Button risk="medium">Install all updates</Button><Button risk="high">Reboot now</Button><Button>Cancel</Button></>);
    const low = screen.getByRole("button", { name: "Refresh lists" });
    const medium = screen.getByRole("button", { name: "Install all updates" });
    const high = screen.getByRole("button", { name: "Reboot now" });
    expect(low.getAttribute("data-risk")).toBe("low");
    expect(medium.getAttribute("data-risk")).toBe("medium");
    expect(document.getElementById(medium.getAttribute("aria-describedby") ?? "")?.textContent).toBe("Medium risk: shows a preview and asks you to confirm.");
    expect(document.getElementById(high.getAttribute("aria-describedby") ?? "")?.textContent).toBe("High risk: asks for your password before it runs.");
    expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("aria-describedby")).toBe(false);
  });

  it("draws a lock and says Password on a high-risk button, and nothing extra on a low one", () => {
    render(<><Button risk="high">Reboot now</Button><Button risk="low">Refresh lists</Button></>);
    const high = screen.getByRole("button", { name: "Reboot now" });
    expect(high.querySelector("svg.ui-button__lock")).not.toBeNull();
    expect(high.querySelector(".ui-button__tier")?.textContent).toBe("Password");
    expect(high.querySelector(".ui-button__tier")?.getAttribute("aria-hidden")).toBe("true");
    const low = screen.getByRole("button", { name: "Refresh lists" });
    expect(low.querySelector("svg, .ui-button__tier")).toBeNull();
  });

  it("keeps an existing description alongside the tier", () => {
    render(<><p id="why">Frees 3 GB</p><Button risk="medium" aria-describedby="why">Prune images</Button></>);
    const ids = screen.getByRole("button", { name: "Prune images" }).getAttribute("aria-describedby")?.split(" ") ?? [];
    expect(ids[0]).toBe("why");
    expect(ids).toHaveLength(2);
  });

  it("is disabled and busy while work is under way, and still clickable otherwise", () => {
    const onClick = vi.fn();
    render(<><Button busy onClick={onClick}>Working</Button><Button onClick={onClick}>Go</Button></>);
    const busy = screen.getByRole("button", { name: "Working" }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Go" }) as HTMLButtonElement).type).toBe("button");
  });
});

describe("tiers and statuses", () => {
  it("names each tier in words", () => {
    render(<><RiskTag risk="low" /><RiskTag risk="high" /></>);
    expect(screen.getByText("Low").closest(".ui-risk")?.textContent).toBe("Low risk");
    expect(screen.getByText("High").closest(".ui-risk")?.querySelector("svg")).not.toBeNull();
  });

  it("treats an operation it does not know as high", () => {
    expect(riskOf("apt.refresh")).toBe("low");
    expect(riskOf("system.reboot")).toBe("high");
    expect(riskOf("something.new")).toBe("high");
  });

  it("puts the words in the chip and the status on it", () => {
    render(<StatusChip status="unknown">Not read</StatusChip>);
    const chip = screen.getByText("Not read");
    expect(chip.getAttribute("data-status")).toBe("unknown");
    expect(chip.className).toContain("ui-chip--unknown");
  });
});

describe("Section", () => {
  it("puts the status before the title in the heading", () => {
    render(<Section title="Upgradable packages" status={{ status: "warning", label: "3 security updates" }} summary="Select some." actions={<Button>Refresh</Button>}><p>rows</p></Section>);
    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading.textContent).toBe("3 security updatesUpgradable packages");
    expect(screen.getByRole("region", { name: /Upgradable packages/ })).toBeTruthy();
    expect(screen.getByText("Select some.")).toBeTruthy();
  });
});

describe("MetricTile and Tile", () => {
  it("shows a figure with its bar as a meter", () => {
    render(<MetricTile label="Memory" value="21.4 GB" caption="of 64 GB" status="neutral" bar={{ value: 21.4, max: 64 }} />);
    const meter = screen.getByRole("meter", { name: "Memory" });
    expect(meter.getAttribute("aria-valuenow")).toBe("21.4");
    expect(meter.getAttribute("aria-valuemax")).toBe("64");
    expect(screen.getByText("of 64 GB")).toBeTruthy();
  });

  it("reads an app tile's health with its name", () => {
    const onSelect = vi.fn();
    render(<><Tile name="Home Assistant" status="warning" detail="Not off-box" onSelect={onSelect} /><Tile name="Jellyfin" status="good" /></>);
    const tile = screen.getByRole("button", { name: "Home Assistant, Needs a look" });
    expect(document.getElementById(tile.getAttribute("aria-describedby") ?? "")?.textContent).toBe("Not off-box");
    expect(tile.textContent).toContain("HA");
    fireEvent.click(tile);
    expect(onSelect).toHaveBeenCalled();
    expect(screen.getByText("Jellyfin").closest(".ui-tile")?.getAttribute("data-status")).toBe("good");
  });
});

describe("Dock", () => {
  it("marks the current area and reads its count", () => {
    const onSelect = vi.fn();
    render(<Dock onSelect={onSelect} items={[{ id: "updates", label: "Updates", icon: "UP", badge: 14, current: true }, { id: "storage", label: "Storage", icon: "SG" }]} />);
    const nav = screen.getByRole("navigation", { name: "Admin areas" });
    const updates = within(nav).getByRole("button", { name: "Updates, 14 waiting" });
    expect(updates.getAttribute("aria-current")).toBe("page");
    fireEvent.click(within(nav).getByRole("button", { name: "Storage" }));
    expect(onSelect).toHaveBeenCalledWith("storage");
  });
});

describe("ThemeSwitch", () => {
  beforeEach(() => {
    window.localStorage.clear();
    reloadThemeChoice();
  });

  it("starts on System, remembers a choice and sets data-theme", () => {
    render(<ThemeSwitch compact />);
    expect(screen.getByRole("radio", { name: "System" }).getAttribute("aria-checked")).toBe("true");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(screen.getByRole("radio", { name: "Light" }).getAttribute("aria-checked")).toBe("true");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(window.localStorage.getItem("boxpilot-theme")).toBe("light");
  });

  it("moves with the arrow keys, as a radio group does", () => {
    render(<ThemeSwitch />);
    const system = screen.getByRole("radio", { name: "System" });
    system.focus();
    fireEvent.keyDown(system, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Light" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    fireEvent.keyDown(document.activeElement as Element, { key: "End" });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowRight" });
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(window.localStorage.getItem("boxpilot-theme")).toBeNull();
  });

  it("keeps two switches in step", () => {
    render(<><ThemeSwitch compact /><ThemeSwitch /></>);
    fireEvent.click(screen.getAllByRole("radio", { name: "Dark" })[0]);
    for (const radio of screen.getAllByRole("radio", { name: "Dark" })) expect(radio.getAttribute("aria-checked")).toBe("true");
  });
});
