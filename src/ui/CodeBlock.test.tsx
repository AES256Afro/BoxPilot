import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CodeBlock } from "./CodeBlock";

afterEach(cleanup);

/** jsdom lays nothing out: give the block a 200 px window onto `height` px of text, and a scroll position it keeps. */
function layout(element: HTMLElement, height: { value: number }) {
  let top = 0;
  Object.defineProperty(element, "clientHeight", { configurable: true, get: () => 200 });
  Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => height.value });
  Object.defineProperty(element, "scrollTop", { configurable: true, get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, height.value - 200)); } });
}

describe("a followed CodeBlock (M89)", () => {
  it("keeps the newest line in view while the view is at the bottom", () => {
    const height = { value: 1000 };
    const { rerender } = render(<CodeBlock label="Output" follow>{"one"}</CodeBlock>);
    const pre = screen.getByLabelText("Output");
    layout(pre, height);
    height.value = 1200;
    rerender(<CodeBlock label="Output" follow>{"one\ntwo"}</CodeBlock>);
    expect(pre.scrollTop).toBe(1000);
    expect(screen.queryByRole("button", { name: "Jump to newest" })).toBeNull();
    // Within a few pixels of the bottom still counts as following.
    pre.scrollTop = 990;
    fireEvent.scroll(pre);
    height.value = 1400;
    rerender(<CodeBlock label="Output" follow>{"one\ntwo\nthree"}</CodeBlock>);
    expect(pre.scrollTop).toBe(1200);
  });

  it("stays where the owner scrolled up to, and offers a way back to the newest line", () => {
    const height = { value: 1000 };
    const { rerender } = render(<CodeBlock label="Output" follow>{"one"}</CodeBlock>);
    const pre = screen.getByLabelText("Output");
    layout(pre, height);
    rerender(<CodeBlock label="Output" follow>{"one\ntwo"}</CodeBlock>);
    expect(pre.scrollTop).toBe(800);
    pre.scrollTop = 300;
    fireEvent.scroll(pre);
    height.value = 1600;
    rerender(<CodeBlock label="Output" follow>{"one\ntwo\nthree"}</CodeBlock>);
    expect(pre.scrollTop).toBe(300);
    const jump = screen.getByRole("button", { name: "Jump to newest" });
    fireEvent.click(jump);
    expect(pre.scrollTop).toBe(1400);
    expect(document.activeElement).toBe(pre);
    expect(screen.queryByRole("button", { name: "Jump to newest" })).toBeNull();
    // Following again: the next chunk is brought into view.
    height.value = 1800;
    rerender(<CodeBlock label="Output" follow>{"one\ntwo\nthree\nfour"}</CodeBlock>);
    expect(pre.scrollTop).toBe(1600);
  });

  it("scrolling back down by hand picks the newest line up again", () => {
    const height = { value: 1000 };
    const { rerender } = render(<CodeBlock label="Output" follow>{"one"}</CodeBlock>);
    const pre = screen.getByLabelText("Output");
    layout(pre, height);
    pre.scrollTop = 100;
    fireEvent.scroll(pre);
    expect(screen.getByRole("button", { name: "Jump to newest" })).toBeTruthy();
    pre.scrollTop = 800;
    fireEvent.scroll(pre);
    expect(screen.queryByRole("button", { name: "Jump to newest" })).toBeNull();
    height.value = 1300;
    rerender(<CodeBlock label="Output" follow>{"one\ntwo"}</CodeBlock>);
    expect(pre.scrollTop).toBe(1100);
  });

  it("offers no jump for a block that does not follow", () => {
    const height = { value: 1000 };
    render(<CodeBlock label="Output">{"one"}</CodeBlock>);
    const pre = screen.getByLabelText("Output");
    layout(pre, height);
    pre.scrollTop = 0;
    fireEvent.scroll(pre);
    expect(screen.queryByRole("button", { name: "Jump to newest" })).toBeNull();
  });
});
