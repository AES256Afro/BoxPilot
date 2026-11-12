import { describe, expect, it } from "vitest";

/*
 * Two of the owner's rules for this page, held to its stylesheet: square corners (no circles, no
 * pills), and 44px of height under a finger for everything that is pressed, without changing how
 * any of it looks under a mouse. A stylesheet has no computed sizes in jsdom, so the rules
 * themselves are read.
 */

const sheets = import.meta.glob<string>("./agents.css", { query: "?raw", import: "default", eager: true });
const css = (sheets["./agents.css"] ?? "").replace(/\/\*[\s\S]*?\*\//g, "");

/** The block of `@media (pointer: coarse)`, and the sheet without it. */
function split(source: string): { coarse: string; rest: string } {
  const start = source.indexOf("@media (pointer: coarse)");
  if (start < 0) return { coarse: "", rest: source };
  const open = source.indexOf("{", start);
  let depth = 1;
  let close = open + 1;
  for (; close < source.length && depth; close += 1) {
    if (source[close] === "{") depth += 1;
    else if (source[close] === "}") depth -= 1;
  }
  return { coarse: source.slice(open + 1, close - 1), rest: source.slice(0, start) + source.slice(close) };
}

/** Each selector's declarations, the later rule added to the earlier. */
function rules(source: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const [, prelude, body] of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const selector of prelude.split(",").map((part) => part.trim()).filter(Boolean)) found.set(selector, `${found.get(selector) ?? ""} ${body.trim()}`.trim());
  }
  return found;
}

/** A corner the kit draws: none, a hair on a focus ring, or the kit's own small radii. */
const square = (radius: string) => /^(0|[0-4]px|var\(--radius-(sm|md)\))$/.test(radius.trim());

describe("the Agents stylesheet", () => {
  it("is read", () => {
    expect(css).toContain(".agents-page");
    expect(split(css).coarse).not.toBe("");
  });

  it("draws no circles or pills: every corner is square or the kit's small radius", () => {
    const radii = [...css.matchAll(/border-radius:\s*([^;}]+)/g)].map((match) => match[1].trim());
    expect(radii.length).toBeGreaterThan(0);
    expect(radii.filter((radius) => !square(radius))).toEqual([]);
    // The two that were here, and the kit's own pill, are what this refuses.
    for (const round of ["50%", "999px", "var(--radius-pill)", "var(--radius-lg)", "12px", "1em"]) expect(square(round), round).toBe(false);
    const all = rules(css);
    expect(all.get(".agents-form__step")).not.toContain("border-radius");
    expect(all.get(".agents-chip-link:focus-visible")).not.toContain("border-radius");
  });

  it("gives everything pressed 44px of height under a finger", () => {
    const coarse = rules(split(css).coarse);
    for (const button of [".agents-actions .ui-button", ".agents-step__toggle.ui-button", ".agents-question__remove.ui-button"]) expect(coarse.get(button), button).toContain("min-height: 44px");
    // Text that is a button: its line (14px at the least) and 15px above and below, the row's height kept by the margin.
    for (const link of [".agents-link", ".agents-chip-link"]) {
      expect(coarse.get(link), link).toContain("padding-block: 15px");
      expect(coarse.get(link), link).toContain("margin-block: -15px");
    }
    // A citation keeps its tint the size of its words; its target is drawn behind it.
    expect(coarse.get(".agents-answer__cite--link::after")).toContain("min-height: 44px");
    expect(coarse.get(".agents-answer__cite--link::after")).toContain("position: absolute");
    expect(coarse.get(".agents-answer__cite--link")).toContain("position: relative");
    expect(coarse.get(".agents-answer__cite--link") ?? "").not.toMatch(/padding|background/);
  });

  it("leaves them as they were under a mouse", () => {
    const fine = rules(split(css).rest);
    expect(fine.get(".agents-actions .ui-button")).toContain("min-height: 26px");
    expect(fine.get(".agents-step__toggle.ui-button")).toContain("min-height: 24px");
    expect(fine.get(".agents-question__remove.ui-button")).toContain("min-height: 30px");
    expect(fine.get(".agents-link")).toContain("padding: 0;");
    expect(fine.get(".agents-chip-link")).toContain("padding: 0;");
    for (const selector of fine.keys()) expect(selector, selector).not.toContain("::after");
    expect(split(css).rest).not.toMatch(/44px|padding-block: 15px/);
  });
});
