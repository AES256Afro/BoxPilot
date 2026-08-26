/**
 * Freeze the demo into something that can be served without Node.
 *
 * `boxpilot-demo.mjs` is an Express app: it reads the catalog off disk, computes a few responses,
 * and answers three different worlds depending on the page that asked. None of that survives being
 * put on a CDN, and none of it needs to — every answer is fixed. So this asks the real demo for
 * every route, in every world, and writes the answers down.
 *
 * Asking the running app rather than reconstructing its fixtures is deliberate: a second copy of
 * what a route is believed to return is the thing that drifts, and this repository has been bitten
 * by exactly that more than once.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { app, scenarioNames, inspections, switcher } from "./boxpilot-demo.mjs";

const here = import.meta.dirname;
const outDir = path.join(here, "..", "demo-site");

/** Every GET route the demo declares, read from its own source so the list cannot fall behind. */
async function declaredRoutes() {
  const source = await readFile(path.join(here, "boxpilot-demo.mjs"), "utf8");
  return [...source.matchAll(/api\.get\("([^"]+)"/g)]
    .map((match) => match[1])
    .filter((route) => !route.includes(":") && !route.includes("*"));
}

const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const { port } = server.address();
const ask = (route, scenario) => fetch(`http://127.0.0.1:${port}/api/v1${route}`, {
  headers: { referer: `http://127.0.0.1:${port}/?scenario=${scenario}` },
}).then((response) => (response.ok ? response.json() : null));

const routes = await declaredRoutes();
const bundle = { scenarios: {}, generatedAt: new Date().toISOString() };
for (const scenario of scenarioNames) {
  const rest = {};
  for (const route of routes) {
    const body = await ask(route, scenario);
    if (body !== null) rest[route] = body;
  }
  const operations = {};
  for (const id of Object.keys(inspections)) {
    const body = await ask(`/operations/${id}/inspect`, scenario);
    if (body?.result !== undefined) operations[id] = body.result;
  }
  // The world switcher is rendered by the demo server; taking it from there rather than
  // rewriting it keeps the hosted copy from drifting away from the one used for review.
  bundle.scenarios[scenario] = { rest, operations, switcher: switcher(scenario) };
  process.stdout.write(`${scenario}: ${Object.keys(rest).length} routes, ${Object.keys(operations).length} operations\n`);
}
await new Promise((resolve) => server.close(resolve));

await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, "demo-data.json"), JSON.stringify(bundle));
const bytes = JSON.stringify(bundle).length;
console.log(`wrote demo-site/demo-data.json (${(bytes / 1024).toFixed(0)} KiB)`);
