import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppIcon, CopyButton, Facts, MetricStrip, MetricTile, appHue } from ".";

/*
 * What several pages had each built for themselves, promoted to the kit in M33.14: an app's colour
 * square, a copy button for one value, the strip of figures across a page, and a line of facts.
 */

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("AppIcon", () => {
  it("draws the manifest's emoji, or the name's initials, on the app's own hue, hidden from assistive technology", () => {
    const { container } = render(<><AppIcon id="immich" name="Immich" icon="📷" size="lg" /><AppIcon id="home-assistant" name="Home Assistant" /></>);
    const [emoji, lettered] = [...container.querySelectorAll(".ui-app-icon")];
    expect(emoji.textContent).toBe("📷");
    expect(emoji.getAttribute("data-emoji")).toBe("true");
    expect(emoji.classList.contains("ui-app-icon--lg")).toBe(true);
    expect(emoji.getAttribute("data-hue")).toBe(appHue("immich"));
    expect(lettered.textContent).toBe("HA");
    expect(lettered.hasAttribute("data-emoji")).toBe(false);
    expect(lettered.classList.contains("ui-app-icon--md")).toBe(true);
    for (const square of [emoji, lettered]) expect(square.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("CopyButton", () => {
  it.each([undefined, { writeText: async () => { throw new Error("permission denied"); } }])("says so when the clipboard is missing or refuses, and can be tried again", async (clipboard) => {
    vi.stubGlobal("navigator", { clipboard });
    render(<CopyButton value="/srv/media" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect((await screen.findByRole("status")).textContent).toBe("Copy unavailable. Select the text and copy it by hand.");
    expect(screen.getByRole("button", { name: "Copy" })).toHaveProperty("disabled", false);
  });

  it("names what it copies, and says Copied only once the current value is on the clipboard", async () => {
    let finish: () => void = () => {};
    const writeText = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const view = render(<CopyButton value="first" label="Copy id" name="Grafana's client id" />);
    const button = () => screen.getByRole("button", { name: "Copy id Grafana's client id" });
    fireEvent.click(button());
    expect(button().getAttribute("aria-busy")).toBe("true");
    view.rerender(<CopyButton value="second" label="Copy id" name="Grafana's client id" />);
    finish();
    await waitFor(() => expect(button().textContent).toBe("Copy id"));
    fireEvent.click(button());
    finish();
    await waitFor(() => expect(button().textContent).toBe("Copied"));
    expect(writeText).toHaveBeenLastCalledWith("second");
  });
});

describe("MetricStrip and Facts", () => {
  it("groups a page's figures in one named region, as narrow as asked", () => {
    render(<MetricStrip label="Updates, reboot and automatic updates" minTile="14rem"><MetricTile label="Available updates" value="4" /><MetricTile label="Reboot" value="Not needed" /></MetricStrip>);
    const strip = screen.getByRole("region", { name: "Updates, reboot and automatic updates" });
    expect(strip.classList.contains("ui-metric-strip")).toBe(true);
    expect(strip.style.getPropertyValue("--ui-strip-min")).toBe("14rem");
    expect(strip.querySelectorAll(".ui-metric")).toHaveLength(2);
  });

  it("is a line of its own, or a span inside a row's words", () => {
    const { container } = render(<><Facts><b>12</b> entries · <b>3</b> new</Facts><Facts as="span" className="extra">for <code>homebox</code></Facts></>);
    const [line, inline] = [...container.querySelectorAll(".ui-facts")];
    expect(line.tagName).toBe("P");
    expect(line.textContent).toBe("12 entries · 3 new");
    expect(inline.tagName).toBe("SPAN");
    expect(inline.classList.contains("extra")).toBe(true);
  });
});
