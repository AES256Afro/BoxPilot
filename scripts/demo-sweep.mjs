/**
 * Load every page of the demo in every scenario and report what breaks.
 *
 * The demo is the surface everything gets reviewed on, and for a long time it held one world:
 * populated and healthy. That is the world least likely to break, and it was the only one anybody
 * ever saw — so what shipped broken were the other ones. A form nobody could submit, a Logs page
 * with no groups, a dialog whose list was absent: each rendered perfectly here, because here it was
 * never empty. The first run of this found six blank pages.
 *
 * Needs Chrome, so it is a command you run rather than part of `npm run check`.
 *
 *   npm run demo:sweep            all scenarios
 *   npm run demo:sweep -- fresh   just one
 *   npm run demo:sweep -- --deep  also click everything on every page that opens
 */
import { open, findChrome, chromeHint, sleep } from "./demo-driver.mjs";
import { scenarioNames } from "./boxpilot-demo.mjs";

/**
 * Buttons that would end the sweep rather than test anything: signing out, reloading, or asking the
 * browser for a file. Everything else is fair game — the demo stages jobs and never runs them.
 */
const leaveAlone = /sign out|reload boxpilot|download|support bundle/i;

/** Open everything on a page that opens, because that is where the crashes have actually been. */
let clicks = 0;
async function openEverything(driver, scenario, view) {
  const found = [];
  const labels = await driver.evaluate(`JSON.stringify([...document.querySelectorAll("main button:not([disabled])")].map((b) => (b.textContent || b.getAttribute("aria-label") || "").trim()).filter(Boolean))`);
  for (const label of [...new Set(JSON.parse(labels ?? "[]"))]) {
    if (leaveAlone.test(label)) continue;
    const clicked = await driver.evaluate(`(() => { const b = [...document.querySelectorAll("main button:not([disabled])")].find((x) => ((x.textContent || x.getAttribute("aria-label") || "").trim()) === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
    if (!clicked) continue;
    clicks += 1;
    await sleep(650);
    const problems = driver.problems();
    const caught = await driver.evaluate(`document.querySelector("[data-page-error]")?.getAttribute("data-page-error") ?? null`);
    if (caught) problems.push({ kind: "caught", text: `the ${caught} page fell back to the error boundary` });
    for (const problem of problems) found.push({ ...problem, text: `after clicking "${label}" — ${problem.text}` });
    // Put the page back the way it was: close any dialog, and return if the click navigated.
    await driver.evaluate(`(() => { const close = document.querySelector('[aria-label="Close dialog"], .modal [aria-label="Close"]'); if (close) close.click(); })()`);
    await driver.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await sleep(120);
    const stillHere = await driver.evaluate(`new URL(window.location.href).searchParams.get("view") === ${JSON.stringify(view)}`);
    if (!stillHere || (await driver.evaluate(`!!document.querySelector('[role="dialog"]')`))) { await driver.go(view, { scenario, settle: 1100 }); }
  }
  return found;
}

const views = ["overview", "updates", "catalog", "services", "storage", "backups", "network", "firewall", "users", "logs", "performance", "repairs", "system", "virtualization", "github", "setup"];

if (!findChrome()) { console.error(chromeHint); process.exit(2); }
const deep = process.argv.includes("--deep");
const asked = process.argv.slice(2).filter((value) => scenarioNames.includes(value));
const chosen = asked.length ? asked : scenarioNames;

const driver = await open();
const failures = [];
for (const scenario of chosen) {
  process.stdout.write(`\n${scenario}\n`);
  for (const view of views) {
    await driver.go(view, { scenario });
    const problems = driver.problems();
    const text = (await driver.evaluate(`(document.querySelector("main")?.innerText ?? "").trim()`)) ?? "";
    // The error boundary keeps a broken page legible, which is right for the owner and would be
    // wrong here: a caught crash is still a crash, so the sweep says so.
    const caught = await driver.evaluate(`document.querySelector("[data-page-error]")?.getAttribute("data-page-error") ?? null`);
    if (caught) problems.push({ kind: "caught", text: `the ${caught} page fell back to the error boundary` });
    if (!(await driver.evaluate(`document.querySelectorAll("nav a, nav button").length`))) problems.push({ kind: "nav", text: "navigation did not render, so there is no way out of this page" });
    // A page that renders almost nothing is not obviously fine; an empty world is where a blank
    // screen is most likely to pass for one.
    if (text.length < 40) problems.push({ kind: "blank", text: `main rendered ${text.length} characters` });

    // Only go opening things on a page that rendered; a broken page has nothing to click.
    if (deep && !caught && text.length >= 40) problems.push(...await openEverything(driver, scenario, view));
    const unique = [...new Map(problems.map((problem) => [problem.kind + problem.text, problem])).values()];
    process.stdout.write(`  ${unique.length ? "FAIL" : "ok  "}  ${view}\n`);
    for (const problem of unique) { process.stdout.write(`          ${problem.kind}: ${problem.text}\n`); failures.push({ scenario, view, ...problem }); }
  }
}
driver.close();
console.log(`\n${failures.length} problem(s) across ${chosen.length} scenario(s) × ${views.length} pages${deep ? `, after opening ${clicks} thing(s)` : ""}`);
if (deep && !clicks) { console.error("The deep sweep clicked nothing, so it proved nothing."); process.exit(2); }
process.exit(failures.length ? 1 : 0);
