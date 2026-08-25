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
 */
import { open, findChrome, chromeHint } from "./demo-driver.mjs";
import { scenarioNames } from "./boxpilot-demo.mjs";

const views = ["overview", "updates", "catalog", "services", "storage", "backups", "network", "firewall", "users", "logs", "performance", "repairs", "system", "virtualization", "github", "setup"];

if (!findChrome()) { console.error(chromeHint); process.exit(2); }
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

    const unique = [...new Map(problems.map((problem) => [problem.kind + problem.text, problem])).values()];
    process.stdout.write(`  ${unique.length ? "FAIL" : "ok  "}  ${view}\n`);
    for (const problem of unique) { process.stdout.write(`          ${problem.kind}: ${problem.text}\n`); failures.push({ scenario, view, ...problem }); }
  }
}
driver.close();
console.log(`\n${failures.length} problem(s) across ${chosen.length} scenario(s) × ${views.length} pages`);
process.exit(failures.length ? 1 : 0);
