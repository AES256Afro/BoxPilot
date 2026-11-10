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

/*
 * What a phone needs of the shell and the kit: nothing tapped is under 44 px, and what opens over
 * the page is sized by the part of the screen that can be seen (dvh), not by the part behind a
 * keyboard or a browser's bars.
 */
describe("on a touch screen", () => {
  const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
  const shared = strip(Object.values(import.meta.glob<string>("../styles.css", { query: "?raw", import: "default", eager: true }))[0] ?? "");
  const blend = strip(Object.values(import.meta.glob<string>("../looks/blend/skin.css", { query: "?raw", import: "default", eager: true }))[0] ?? "");
  /** The rules inside every `@media (pointer: coarse)` block of a sheet, as [selectors, body]. */
  const coarse = (css: string): Array<[string, string]> => [...css.matchAll(/@media \(pointer: coarse\)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)]
    .flatMap((block) => [...block[1].matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((rule): [string, string] => [rule[1], rule[2]]));
  const grows = (rules: Array<[string, string]>, selector: string, properties: string[]) => rules.some(([selectors, body]) =>
    selectors.split(",").some((part) => part.trim().endsWith(selector)) && properties.every((property) => new RegExp(`(?:^|[;\\s])${property}:\\s*44px`).test(body)));

  it("grows the small controls to 44 px", () => {
    const kit = coarse(shared);
    expect(grows(kit, ".ui-notice__dismiss", ["width", "height"]), "a notice's Dismiss").toBe(true);
    expect(grows(kit, ".ui-search__clear", ["width", "height"]), "a search box's Clear").toBe(true);
    expect(grows(kit, ".command-option", ["min-height"]), "a row in the command bar").toBe(true);
    expect(grows(kit, ".command-close", ["min-width", "min-height"]), "the command bar's Esc").toBe(true);
    expect(grows(coarse(strip(sheets["./account.css"])), ".account-menu__item", ["min-height"]), "a row in the account menu").toBe(true);
    // Blend draws the info toggle at 26 to 28 px with selectors that outrank the shared 44 px rule.
    const look = coarse(blend);
    expect(grows(look, '[data-look="blend"] .ui-info-toggle', ["width", "height"]), "Blend's info toggle").toBe(true);
    expect(grows(look, ".ui-page-header__actions .ui-info-toggle", ["width", "height"]), "Blend's info toggle in a page's header").toBe(true);
  });

  it("sizes what opens over the page by the screen that can be seen, with vh first for a browser without dvh", () => {
    const after = (css: string, first: string, second: string) => css.includes(first) && css.indexOf(second, css.indexOf(first)) > css.indexOf(first);
    expect(after(shared, "max-height: min(580px, calc(100vh - 32px))", "max-height: min(580px, calc(100dvh - 32px))"), "the command bar").toBe(true);
    expect(after(shared, "max-height: 92vh", "max-height: min(92dvh, 100%)"), "a sheet").toBe(true);
    expect(after(strip(sheets["./approve.css"]), "max-height: 94vh", "max-height: min(92dvh, 100%)"), "the approval dialog").toBe(true);
  });

  it("holds the session notice under the bar, and stacks it with the offline banner in one box", () => {
    const offline = strip(sheets["./offline.css"]);
    expect(offline).toMatch(/\.offline-session\s*\{[^}]*position:\s*sticky/);
    expect(offline).toMatch(/\.offline-stack\s*\{[^}]*position:\s*sticky[^}]*display:\s*grid/);
    expect(offline).toMatch(/\.offline-stack:empty\s*\{[^}]*display:\s*none/);
    expect(offline).toMatch(/\.offline-stack > \.offline-session\s*\{[^}]*position:\s*static/);
  });
});
