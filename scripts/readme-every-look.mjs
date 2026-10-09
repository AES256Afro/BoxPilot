#!/usr/bin/env node
/**
 * The README's "in every look" galleries: each page the README pictures, photographed in every look
 * (src/looks/looks.ts), and a collapsed gallery of them under the page's own picture, so anyone can
 * see what a page looks like in the look they would pick.
 *
 *   npm run build && npm run demo &
 *   npm run demo:every-look              # photograph every page in every look, then the README
 *   npm run demo:every-look -- --readme  # only rewrite the README's galleries from the files there
 *
 * The pictures are docs/screenshots/every-look/<look>-<page>.jpg: the demo at 1440 x 960 drawn at
 * 0.6 (864 x 576, the size of the Looks section's own), JPEG quality 72, each look in its own mode
 * (a light-only look in light, every other in dark, as the README's pictures are). A gallery sits
 * between <!-- every-look:<page> --> and <!-- /every-look --> in the README; Home's is the Looks
 * section, so it is not repeated here.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "docs", "screenshots", "every-look");
const relative = "docs/screenshots/every-look";

/** The pages with a picture in the README, by the view they are and the name the README gives them. */
const pages = [
  ["today", "Today"], ["agents", "Agents"], ["ops", "Ops"], ["performance", "Metrics"], ["catalog", "Apps"],
  ["automations", "Automations"], ["firewall", "Firewall"], ["storage", "Storage"], ["backups", "Backups"],
  ["network", "Network"], ["updates", "Updates"], ["system", "System"], ["repairs", "Repair"],
];

/** Every look, read out of src/looks/looks.ts in its order, so a new look is photographed too. */
function looks() {
  const source = readFileSync(path.join(root, "src", "looks", "looks.ts"), "utf8");
  const found = [...source.matchAll(/\{ id: "([a-z]+)", name: "([^"]+)", caption: "[^"]*", modes: "(both|light|dark)"/g)]
    .map(([, id, name, modes]) => ({ id, name, scheme: modes === "light" ? "light" : "dark" }));
  if (found.length < 10) throw new Error("Reading the looks from src/looks/looks.ts found too few");
  return found;
}

function photograph(all) {
  for (const look of all) {
    console.log(`\n${look.name}`);
    const run = spawnSync(process.execPath, [path.join(root, "scripts", "demo-screenshots.mjs")], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, LOOK: look.id, SCHEMES: look.scheme, SCALE: "0.6", FORMAT: "jpg", QUALITY: "72", OUT_DIR: outDir, PAGES: pages.map(([view]) => view).join(",") },
    });
    if (run.status !== 0) throw new Error(`photographing ${look.name} stopped (exit ${run.status})`);
  }
}

/** A page's gallery: every look that has its picture, three to a row, each named. */
function gallery(view, label, all) {
  const shot = (look) => `${look.id}-${view}.jpg`;
  const present = all.filter((look) => existsSync(path.join(outDir, shot(look))));
  if (!present.length) return null;
  const cell = (look) => `<td width="33%" valign="top"><img src="${relative}/${shot(look)}" alt="${label} in ${look.name}"><br>${look.name}</td>`;
  const rows = [];
  for (let index = 0; index < present.length; index += 3) rows.push(`<tr>${present.slice(index, index + 3).map(cell).join("")}</tr>`);
  return [`<details><summary>${label} in every look</summary>`, "", "<table>", ...rows, "</table>", "</details>"].join("\n");
}

function rewriteReadme(all) {
  const file = path.join(root, "README.md");
  const raw = readFileSync(file, "utf8");
  const crlf = raw.includes("\r\n");
  let text = raw.replace(/\r\n/g, "\n");
  const missing = [];
  for (const [view, label] of pages) {
    const block = new RegExp(`(<!-- every-look:${view} -->)[\\s\\S]*?(<!-- /every-look -->)`);
    if (!block.test(text)) { missing.push(view); continue; }
    const made = gallery(view, label, all);
    text = text.replace(block, (_match, start, end) => (made ? `${start}\n${made}\n${end}` : `${start}\n${end}`));
  }
  writeFileSync(file, crlf ? text.replace(/\n/g, "\r\n") : text);
  if (missing.length) console.log(`README.md has no gallery marker for: ${missing.join(", ")}`);
  console.log("README.md galleries rewritten");
}

const all = looks();
if (!process.argv.includes("--readme")) photograph(all);
const absent = all.flatMap((look) => pages.filter(([view]) => !existsSync(path.join(outDir, `${look.id}-${view}.jpg`))).map(([view]) => `${look.id}-${view}`));
if (absent.length) console.log(`not photographed: ${absent.join(", ")}`);
rewriteReadme(all);
