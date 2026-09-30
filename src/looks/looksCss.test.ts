import { describe, expect, it } from "vitest";
import { LOOK_IDS } from "./looks";

/*
 * The looks' stylesheets (M41) stay inside their look: a skin (src/looks/<id>/skin.css) only ever
 * applies under :root[data-look="<id>"], and a look's Home styles (any other sheet in its folder)
 * only its own classes, .<id>-…, so no look restyles another and none leaks into the default.
 * The shared sheet (looks.css) keys everything to an attribute on the root element.
 */

const sheets = import.meta.glob<string>("./**/*.css", { query: "?raw", import: "default", eager: true });
const sources = import.meta.glob<string>("./**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true });

/** The selectors of every rule, into @media, @supports and @container, comments removed. */
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
      if (/^@(media|supports|container)/.test(prelude)) walk(source.slice(open + 1, close - 1));
      else if (!prelude.startsWith("@")) found.push(...splitSelectors(prelude));
      at = close;
    }
  };
  walk(text);
  return found;
}

/** Split a selector list on its top-level commas, leaving :is(a, b) whole. */
function splitSelectors(prelude: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < prelude.length; index += 1) {
    const char = prelude[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) { parts.push(prelude.slice(start, index)); start = index + 1; }
  }
  parts.push(prelude.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

describe("the looks' stylesheets", () => {
  it("has a skin and a Home for every look, and loads every skin", () => {
    const loader = sources["./skins.ts"];
    for (const id of LOOK_IDS) {
      expect(Object.keys(sheets), id).toContain(`./${id}/skin.css`);
      if (id !== "launcher") expect(Object.keys(sources), id).toContain(`./${id}/Home.tsx`);
      expect(loader, id).toContain(`"./${id}/skin.css"`);
    }
  });

  it("scope a skin to its look and a look's other sheets to its own classes", () => {
    for (const [path, css] of Object.entries(sheets)) {
      const [, id, file] = /^\.\/([a-z]+)\/([a-z-]+)\.css$/.exec(path) ?? [];
      if (!id) continue;
      const prefix = file === "skin" ? `:root[data-look="${id}"]` : `.${id}-`;
      const stray = selectors(css).filter((selector) => !selector.startsWith(prefix));
      expect(stray, path).toEqual([]);
    }
  });

  it("key the shared sheet to the root element, and declare only faces in the fonts sheet", () => {
    const stray = selectors(sheets["./looks.css"]).filter((selector) => !selector.startsWith(":root"));
    expect(stray).toEqual([]);
    expect(selectors(sheets["./fonts.css"])).toEqual([]);
  });
});
