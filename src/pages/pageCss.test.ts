import { describe, expect, it } from "vitest";

/*
 * The page CSS convention (M33.8, docs/UI-PAGES.md): a rebuilt page's own styles live in
 * src/pages/<area>/<area>.css, imported by the page, colours from tokens only, and every selector
 * scoped to the area's prefix, so wave 2's pages never collide with each other or with
 * src/styles.css, which holds the tokens and the shared components.
 */

const sheets = import.meta.glob<string>("./*/*.css", { query: "?raw", import: "default", eager: true });
const pages = import.meta.glob<string>("./*/*.tsx", { query: "?raw", import: "default", eager: true });

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
      if (prelude.startsWith("@media") || prelude.startsWith("@supports") || prelude.startsWith("@container")) walk(source.slice(open + 1, close - 1));
      else if (!prelude.startsWith("@")) found.push(...prelude.split(",").map((part) => part.trim()).filter(Boolean));
      at = close;
    }
  };
  walk(text);
  return found;
}

describe("the page CSS convention", () => {
  const entries = Object.entries(sheets);

  it("has at least the reference pages", () => {
    expect(entries.map(([path]) => path)).toEqual(expect.arrayContaining(["./services/services.css", "./logs/logs.css"]));
  });

  it("names each page's sheet after its area, and the page imports it", () => {
    for (const [path] of entries) {
      const [, area, file] = /^\.\/([a-z0-9-]+)\/([a-z0-9-]+)\.css$/.exec(path) ?? [];
      expect(file, path).toBe(area);
      const imported = Object.entries(pages).some(([page, source]) => page.startsWith(`./${area}/`) && source.includes(`"./${area}.css"`));
      expect(imported, `${path} is imported by a page in src/pages/${area}/`).toBe(true);
    }
  });

  it("takes every colour from a token", () => {
    for (const [path, css] of entries) {
      const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
      expect(text.match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|lab|lch|color)\(/gi) ?? [], path).toEqual([]);
      expect(text.match(/:\s*(?:white|black|red|green|blue|gray|grey|orange|yellow)\b/gi) ?? [], path).toEqual([]);
    }
  });

  it("scopes every selector to the area, so no page restyles another", () => {
    for (const [path, css] of entries) {
      const area = path.split("/")[1];
      const stray = selectors(css).filter((selector) => !selector.startsWith(`.${area}-`));
      expect(stray, path).toEqual([]);
    }
  });
});
