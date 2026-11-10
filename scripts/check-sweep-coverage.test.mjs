import { afterAll, describe, expect, it } from "vitest";
import { cleanUpCheckTrees, runCheck } from "../test/check-harness.mjs";

/**
 * `check:sweeps` proving it fails on what it is for (M54).
 *
 * This check is what retires a usability, visual or quality-of-life sweep: coverage of every page
 * and shell surface, rather than a count of sweeps that found nothing, because those categories
 * never run out of findings. The ledger of dates is only worth as much as the guarantee that it
 * still describes the real pages, so the cases that matter are a page with no row and a row with no
 * page. The two that must NOT fail matter just as much: time passing, and a surface with findings.
 */

const categories = ["usability", "visual", "qol"];
const blank = () => Object.fromEntries(categories.map((category) => [category, { lastReviewed: null, sweep: null, found: null }]));
const reviewed = (lastReviewed, found) => Object.fromEntries(categories.map((category) => [category, { lastReviewed, sweep: 1, found }]));

const navItems = (ids) => `export const navItems: Array<{ id: ViewName; label: string; short: string }> = [\n${ids.map((id) => `  { id: "${id}", label: "${id}", short: "XX" },`).join("\n")}\n];\n`;

const ledger = ({ pages, shell = { "command bar": blank() }, staleAfterWeeks = 8 } = {}) => `${JSON.stringify({
  rule: "see docs/reviews/2026-11-04-audit-loop.md",
  loopStartedOn: "2026-11-04",
  staleAfterWeeks,
  categories,
  pages,
  shell,
}, null, 2)}\n`;

/** The pages the check requires: whatever navItems lists, plus the two that are not in the dock. */
const tree = ({ nav = ["home", "today"], pages, shell, staleAfterWeeks } = {}) => ({
  "src/data.ts": navItems(nav),
  "docs/reviews/sweep-coverage.json": ledger({ pages: pages ?? Object.fromEntries([...nav, "setup", "signin"].map((id) => [id, blank()])), shell, staleAfterWeeks }),
});

const check = (options) => runCheck("scripts/check-sweep-coverage.mjs", options);

afterAll(cleanUpCheckTrees);

describe("a ledger that still describes the real pages", () => {
  it("passes, and says how much of each category is covered", async () => {
    const result = await check({ tracked: tree() });
    expect(result.code).toBe(0);
    expect(result.output).toContain("usability — 0 of 5 surfaces reviewed and fresh");
  });
});

describe("a page the ledger does not mention", () => {
  it("fails, so a page added to the dock cannot go unswept quietly", async () => {
    const result = await check({
      tracked: tree({ nav: ["home", "today", "brandnew"], pages: Object.fromEntries(["home", "today", "setup", "signin"].map((id) => [id, blank()])) }),
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("brandnew is a page but has no row");
    expect(result.output).toContain("Add it, unreviewed, so the gap is visible");
  });

  it("fails for the pages that are not in the dock either", async () => {
    const result = await check({
      tracked: tree({ pages: Object.fromEntries(["home", "today", "setup"].map((id) => [id, blank()])) }),
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("signin is a page but has no row");
  });
});

describe("a ledger row for a page that is gone", () => {
  it("fails, so the ledger cannot claim coverage of something that no longer exists", async () => {
    const result = await check({
      tracked: tree({ pages: Object.fromEntries(["home", "today", "setup", "signin", "classic"].map((id) => [id, blank()])) }),
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain('has a row for "classic", which is no longer a page');
  });
});

describe("a row missing one of the categories", () => {
  it("fails, because a surface half in the ledger reads as covered", async () => {
    const pages = Object.fromEntries(["home", "today", "setup", "signin"].map((id) => [id, blank()]));
    delete pages.home.visual;
    const result = await check({ tracked: tree({ pages }) });
    expect(result.code).toBe(1);
    expect(result.output).toContain('"home" has no visual row');
  });

  it("fails for a shell surface too", async () => {
    const shell = { "command bar": blank() };
    delete shell["command bar"].qol;
    const result = await check({ tracked: tree({ shell }) });
    expect(result.code).toBe(1);
    expect(result.output).toContain('"command bar" has no qol row');
  });
});

describe("a ledger with no shell surfaces", () => {
  it("fails: the command bar, the drawer and the approval dialog are swept too", async () => {
    const result = await check({ tracked: tree({ shell: {} }) });
    expect(result.code).toBe(1);
    expect(result.output).toContain("lists no shell surfaces");
  });
});

describe("a src/data.ts it cannot read navItems out of", () => {
  it("fails rather than checking the ledger against nothing", async () => {
    const result = await check({
      tracked: { "src/data.ts": "export const somethingElse = [];\n", "docs/reviews/sweep-coverage.json": ledger({ pages: { home: blank() } }) },
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("could not read navItems");
  });
});

describe("what it must never fail on", () => {
  it("does not fail because time has passed: a stale review is reported, not red", async () => {
    // Reviewed two years ago, well past staleAfterWeeks. A check that turns red while nobody has
    // touched the code is a check people learn to ignore.
    const pages = Object.fromEntries(["home", "today", "setup", "signin"].map((id) => [id, reviewed("2024-01-01", 0)]));
    const result = await check({ tracked: tree({ pages, shell: { "command bar": reviewed("2024-01-01", 0) } }) });
    expect(result.code).toBe(0);
    expect(result.output).toContain("0 of 5 surfaces reviewed and fresh");
  });

  it("does not fail because a sweep found things; that is the sweep working", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const pages = Object.fromEntries(["home", "today", "setup", "signin"].map((id) => [id, reviewed(today, 7)]));
    const result = await check({ tracked: tree({ pages, shell: { "command bar": reviewed(today, 7) } }) });
    expect(result.code).toBe(0);
    expect(result.output).not.toContain("can retire");
  });

  it("says a category can retire only when every surface is fresh and found nothing", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const pages = Object.fromEntries(["home", "today", "setup", "signin"].map((id) => [id, reviewed(today, 0)]));
    const clean = await check({ tracked: tree({ pages, shell: { "command bar": reviewed(today, 0) } }) });
    expect(clean.code).toBe(0);
    expect(clean.output).toContain("5 of 5 surfaces reviewed and fresh; every one found nothing, so this category can retire");

    // One surface still carrying a finding is enough to keep the category in the loop.
    const almost = { ...pages, home: reviewed(today, 1) };
    const result = await check({ tracked: tree({ pages: almost, shell: { "command bar": reviewed(today, 0) } }) });
    expect(result.output).not.toContain("can retire");
  });
});
