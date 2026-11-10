#!/usr/bin/env node
/**
 * Keep the sweep coverage ledger honest (M52.8).
 *
 *   node scripts/check-sweep-coverage.mjs
 *
 * `docs/reviews/sweep-coverage.json` says when each page and each shell surface was last reviewed
 * for usability, for visuals and for quality of life, and how many findings that pass raised. It is
 * what retires those three categories from the audit loop: "three consecutive sweeps with nothing"
 * is a real stopping rule for code, bug and security, where a codebase can genuinely be clean, but
 * usability and visuals never run out — three empty sweeps there says the sweeper stopped looking.
 * Coverage says it properly: every surface reviewed in this loop, and the last pass over all of
 * them finding nothing.
 *
 * A ledger of dates rots the moment a page is added, so the pages are checked against `navItems` in
 * `src/data.ts` — the same list the screenshot and sweep scripts read. A page in the dock and not in
 * the ledger fails here, as does a ledger row for a page that no longer exists.
 *
 * Time passing is NOT a failure: a stale review is reported, never a red check, because a check that
 * goes red on its own while nobody has touched the code teaches people to ignore it. Staleness is
 * for the sweeper to read.
 */
import { readFile } from "node:fs/promises";

const ledgerPath = "docs/reviews/sweep-coverage.json";
/** Real pages that are not in the dock: the first-run wizard and the sign-in page. */
const pagesOutsideTheDock = ["setup", "signin"];

const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
const source = await readFile("src/data.ts", "utf8");

const navIds = [...source.matchAll(/\{ id: "([a-z]+)", label: "/g)].map(([, id]) => id);
if (navIds.length === 0) {
  console.error(`FAILED could not read navItems out of src/data.ts, so ${ledgerPath} cannot be checked against it`);
  process.exit(1);
}

const expected = [...new Set([...navIds, ...pagesOutsideTheDock])].sort();
const listed = Object.keys(ledger.pages ?? {}).sort();
const categories = ledger.categories ?? [];

const failures = [];
for (const page of expected) if (!listed.includes(page)) failures.push(`${page} is a page but has no row in ${ledgerPath}. Add it, unreviewed, so the gap is visible.`);
for (const page of listed) if (!expected.includes(page)) failures.push(`${ledgerPath} has a row for "${page}", which is no longer a page. Remove it.`);
for (const [surface, rows] of [...Object.entries(ledger.pages ?? {}), ...Object.entries(ledger.shell ?? {})]) {
  for (const category of categories) if (!rows?.[category]) failures.push(`${ledgerPath}: "${surface}" has no ${category} row.`);
}
if (!Object.keys(ledger.shell ?? {}).length) failures.push(`${ledgerPath} lists no shell surfaces; the command bar, the drawer and the approval dialog are swept too.`);

for (const failure of failures) console.error(`FAILED ${failure}`);

/** Reported, not failed: what the next sweep of each category has left to cover. */
const surfaces = [...Object.entries(ledger.pages ?? {}), ...Object.entries(ledger.shell ?? {})];
const staleBefore = Date.now() - (ledger.staleAfterWeeks ?? 8) * 7 * 86_400_000;
for (const category of categories) {
  const reviewed = surfaces.filter(([, rows]) => {
    const at = Date.parse(rows?.[category]?.lastReviewed ?? "");
    return Number.isFinite(at) && at >= staleBefore;
  });
  const clean = reviewed.length === surfaces.length && surfaces.every(([, rows]) => rows[category].found === 0);
  console.log(`sweeps: ${category} — ${reviewed.length} of ${surfaces.length} surfaces reviewed and fresh${clean ? "; every one found nothing, so this category can retire" : ""}`);
}

process.exitCode = failures.length ? 1 : 0;
