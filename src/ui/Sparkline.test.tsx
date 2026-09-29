import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MetricTile, Sparkline, sparkPoints } from ".";

afterEach(() => cleanup());

describe("a sparkline", () => {
  it("draws nothing until there are two reads to join", () => {
    expect(sparkPoints([])).toEqual([]);
    expect(sparkPoints([42])).toEqual([]);
    expect(sparkPoints([null, 42, null])).toEqual([]);
    const { container } = render(<Sparkline values={[42]} />);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("runs oldest to newest across the box, highest at the top", () => {
    const points = sparkPoints([10, 20, 30]);
    expect(points.map(([x]) => x)).toEqual([2, 32, 62]);
    expect(points[0][1]).toBe(22);
    expect(points[2][1]).toBe(2);
  });

  it("skips a read without the figure instead of inventing one", () => {
    const points = sparkPoints([10, null, 30]);
    expect(points).toHaveLength(2);
    expect(points.map(([x]) => x)).toEqual([2, 62]);
  });

  it("draws a small wobble as small, over the floor it is given", () => {
    const flat = sparkPoints([27.1, 27.4, 27.2], 10);
    const heights = flat.map(([, y]) => y);
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(2);
    expect(sparkPoints([27.1, 27.4])[0][1]).toBe(22);
  });

  it("is decoration: hidden from assistive technology, inside a figure that says it in words", () => {
    render(<MetricTile label="CPU" value="27.4%" status="good" onSelect={() => undefined} graphic={<Sparkline values={[20, 25, 27.4]} />} />);
    const graphic = document.querySelector(".ui-metric__graphic");
    expect(graphic?.getAttribute("aria-hidden")).toBe("true");
    expect(graphic?.querySelector("polyline")?.getAttribute("points")?.split(" ")).toHaveLength(3);
    expect(document.querySelector("button")?.textContent).toBe("CPU27.4%");
  });
});

describe("a figure's mark", () => {
  it("carries the status's own mark beside its label, hidden from assistive technology", () => {
    render(<><MetricTile label="Disk" value="93%" status="danger" /><MetricTile label="Plain" value="3" /></>);
    const [danger, plain] = Array.from(document.querySelectorAll(".ui-metric"));
    expect(danger.querySelector(".ui-metric__label .ui-mark")?.getAttribute("aria-hidden")).toBe("true");
    expect(danger.getAttribute("data-status")).toBe("danger");
    expect(plain.querySelector(".ui-mark")).toBeNull();
  });
});
