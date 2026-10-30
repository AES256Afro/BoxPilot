import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AnswerText } from "./Trace";
import { Prose, blocksOf } from "./Prose";

/*
 * An agent's words as prose (M44): the part of markdown a small model writes is drawn - bold,
 * italics, lists, line breaks - and nothing else is: HTML stays text, a link is its words, and
 * nothing in an answer runs or is a place to click.
 */

afterEach(cleanup);
const draw = (text: string) => render(<Prose text={text} />).container.firstElementChild as HTMLElement;

describe("Prose", () => {
  it("draws the digest the owner's Server Keeper wrote: bold, a list and its citations, no stars", () => {
    const digest = "**Daily digest complete.**\n\nAll is well:\n- No health alerts are live [T1].\n- Backups ran *last night* [T2, T3].\n\n1. Vaultwarden has no backup.\n2. Jellyfin's update waits [F1].";
    const prose = draw(digest);
    expect(prose.textContent).not.toContain("*");
    expect(prose.querySelector("p > strong")?.textContent).toBe("Daily digest complete.");
    expect([...prose.querySelectorAll("ul > li")].map((item) => item.textContent)).toEqual(["No health alerts are live T1.", "Backups ran last night T2 T3."]);
    expect(prose.querySelector("ul em")?.textContent).toBe("last night");
    const ordered = prose.querySelector("ol");
    expect(ordered?.getAttribute("start")).toBe("1");
    expect([...ordered!.querySelectorAll("li")].map((item) => item.textContent)).toEqual(["Vaultwarden has no backup.", "Jellyfin's update waits F1."]);
    expect([...prose.querySelectorAll("code.agents-answer__cite")].map((mark) => mark.textContent)).toEqual(["T1", "T2", "T3", "F1"]);
    expect(prose.querySelector("code[title^=\"Another agent's finding\"]")?.textContent).toBe("F1");
  });

  it("keeps HTML and script as text that never runs, and a link as its words alone", () => {
    const prose = draw("<script>window.__ran = true</script>\n<img src=x onerror=\"window.__ran = true\">\n**<b>bold?</b>** and [click me](javascript:alert(1)) or [the docs](https://example.org)");
    expect(prose.querySelector("script, img, b, a, iframe")).toBeNull();
    expect(prose.textContent).toContain("<script>window.__ran = true</script>");
    expect(prose.textContent).toContain("<img src=x onerror=\"window.__ran = true\">");
    expect(prose.querySelector("strong")?.textContent).toBe("<b>bold?</b>");
    expect(prose.textContent).toContain("click me or the docs");
    expect(prose.textContent).not.toContain("javascript:");
    expect((window as unknown as { __ran?: boolean }).__ran).toBeUndefined();
  });

  it("leaves what is not emphasis alone: snake_case, sums, a lone star, an unclosed one, code", () => {
    const prose = draw("server_facts and alerts_active; 2 * 3 = 6; *not closed and **neither\nRun `systemctl status smartd` [T9]");
    expect(prose.querySelector("em, strong")).toBeNull();
    expect(prose.textContent).toContain("server_facts and alerts_active; 2 * 3 = 6; *not closed and **neither");
    expect(prose.querySelector("code:not(.agents-answer__cite)")?.textContent).toBe("systemctl status smartd");
    // A line break inside a paragraph stays a line break.
    expect(prose.querySelectorAll("p br")).toHaveLength(1);
  });

  it("reads headings, numbered items that do not start at one, and an item's next line", () => {
    expect(blocksOf("## Where to focus\n3. Third\n   still the third\n4. Fourth\n---\nFine: all")).toEqual([
      { kind: "heading", text: "Where to focus" },
      { kind: "list", ordered: true, start: 3, items: ["Third\nstill the third", "Fourth"] },
      { kind: "paragraph", lines: ["Fine: all"] },
    ]);
    const prose = draw("## Where to focus\n3. Third");
    expect(prose.querySelector(".agents-prose__heading strong")?.textContent).toBe("Where to focus");
    expect(prose.querySelector("ol")?.getAttribute("start")).toBe("3");
  });

  it("is what a run's answer is drawn with, and a JSON answer keeps its fields", () => {
    const { container } = render(<AnswerText text={"**All well** [T1]"} />);
    expect(container.querySelector(".agents-answer.agents-prose strong")?.textContent).toBe("All well");
    cleanup();
    const fields = render(<AnswerText text={JSON.stringify({ issue: "**sdb** is failing [T2]" })} />).container;
    expect(fields.querySelector("dt")?.textContent).toBe("issue");
    expect(fields.querySelector("dd strong")?.textContent).toBe("sdb");
  });
});
