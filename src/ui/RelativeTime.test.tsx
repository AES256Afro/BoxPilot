import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RelativeTime } from "./RelativeTime";

afterEach(cleanup);

const now = Date.parse("2026-11-10T12:00:00.000Z");

describe("RelativeTime", () => {
  it("says the moment in relative words, with the exact time in the element and its tooltip", () => {
    const { container } = render(<RelativeTime at="2026-11-10T11:57:00.000Z" now={now} />);
    const time = container.querySelector("time")!;
    expect(time.textContent).toBe("3 minutes ago");
    expect(time.getAttribute("datetime")).toBe("2026-11-10T11:57:00.000Z");
    expect(time.getAttribute("title")).toBe(new Date("2026-11-10T11:57:00.000Z").toLocaleString());
  });

  it("takes milliseconds, and a moment still to come", () => {
    const { container } = render(<RelativeTime at={now + 2 * 3_600_000} now={now} />);
    const time = container.querySelector("time")!;
    expect(time.textContent).toBe("in 2 hours");
    expect(time.getAttribute("datetime")).toBe("2026-11-10T14:00:00.000Z");
  });

  it("draws the fallback, and no time element, for a moment that is missing or unreadable", () => {
    const { container, rerender } = render(<RelativeTime at={null} now={now} fallback="never" />);
    expect(container.textContent).toBe("never");
    expect(container.querySelector("time")).toBeNull();
    rerender(<RelativeTime at="not a date" now={now} />);
    expect(container.textContent).toBe("");
  });
});
