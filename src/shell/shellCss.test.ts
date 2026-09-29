import { describe, expect, it } from "vitest";

/*
 * The shell's own stylesheets (M33.13) follow the page convention (docs/UI-PAGES.md,
 * src/pages/pageCss.test.ts): each sheet is imported by a component in src/ (the shell's own, or a
 * shared one such as the job log), takes every colour from a token, and scopes every selector to
 * its file's name (approve.css → .approve-), so the shell never restyles a page and no page
 * restyles the shell.
 */

const sheets = import.meta.glob<string>("./*.css", { query: "?raw", import: "default", eager: true });
const sources = import.meta.glob<string>(["../**/*.tsx", "!../**/*.test.tsx"], { query: "?raw", import: "default", eager: true });

/** The selectors of every rule, one level into @media, comments removed. */
function selectors(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const found: string[] = [];
  const walk = (source: string) => {
    let at = 0;
    while (at < source.length) {
      const open = source.indexOf("{", at);
      if (open < 0) break;
      let depth = 1;
      let close = open + 1;
      for (; close < source.length && depth; close += 1) {
        if (source[close] === "{") depth += 1;
        else if (source[close] === "}") depth -= 1;
      }
      const prelude = source.slice(at, open).trim();
      if (prelude.startsWith("@media") || prelude.startsWith("@supports")) walk(source.slice(open + 1, close - 1));
      else if (!prelude.startsWith("@")) found.push(...prelude.split(",").map((part) => part.trim()).filter(Boolean));
      at = close;
    }
  };
  walk(text);
  return found;
}

describe("the shell's stylesheets", () => {
  const entries = Object.entries(sheets);

  it("are there, and each is imported by a component", () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const [path] of entries) {
      const file = path.slice(2);
      const imported = Object.values(sources).some((source) => source.includes(`/shell/${file}"`) || source.includes(`"./${file}"`));
      expect(imported, `${path} is imported`).toBe(true);
    }
  });

  it("take every colour from a token", () => {
    for (const [path, css] of entries) {
      const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
      expect(text.match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|lab|lch|color)\(/gi) ?? [], path).toEqual([]);
      expect(text.match(/:\s*(?:white|black|red|green|blue|gray|grey|orange|yellow)\b/gi) ?? [], path).toEqual([]);
    }
  });

  it("scope every selector to the sheet's name", () => {
    for (const [path, css] of entries) {
      const prefix = `.${path.slice(2, -4)}-`;
      const stray = selectors(css).filter((selector) => !selector.startsWith(prefix));
      expect(stray, path).toEqual([]);
    }
  });
});
