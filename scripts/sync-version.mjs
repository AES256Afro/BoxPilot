/**
 * Keep the files that repeat the product version in step with package.json.
 *
 * `package.json` is the single source (CLAUDE.md), but a couple of files have to spell the version
 * out because nothing interpolates them. This runs from the npm `version` lifecycle, so bumping
 * with `npm version` cannot leave a stale copy behind — a mistake that has shipped a red build.
 */
import { readFile, writeFile } from "node:fs/promises";
import { productVersion } from "../server/version.mjs";
import { loadCatalog } from "../server/catalog/index.mjs";

const files = [
  { path: "docker-compose.yml", pattern: /^(\s*image: boxpilot:)\S+$/m },
  { path: "README.md", pattern: /(--ref v)\d+\.\d+\.\d+/ },
];

let changed = 0;
for (const { path, pattern } of files) {
  const before = await readFile(path, "utf8");
  const after = before.replace(pattern, (match, prefix) => `${prefix}${productVersion}`);
  if (after === before) continue;
  if (!pattern.test(before)) throw new Error(`${path} no longer contains a version to sync`);
  await writeFile(path, after);
  changed += 1;
  process.stdout.write(`synced ${path} to ${productVersion}\n`);
}
// The catalog size is spelled out in the README ("169 apps and game servers"). The UI count is
// derived at build time (__BOXPILOT_CATALOG_SIZE__) precisely because the copy
// once sat at "128 apps" through 161; the README had no such fix and had drifted
// to 163 with 165 installed. Adding an app is the moment the number changes, and
// a release is the moment anyone reads it, so it is synced here with the rest.
const { manifests } = await loadCatalog();
const readme = await readFile("README.md", "utf8");
const counted = readme.replaceAll(
  /\b\d+ apps and game servers\b/g,
  `${manifests.length} apps and game servers`
);
if (counted !== readme) {
  await writeFile("README.md", counted);
  changed += 1;
  process.stdout.write(`synced README.md catalog size to ${manifests.length}\n`);
}

// The README also lists every app by category, between two markers, rebuilt here from the
// manifests for the same reason as the count: a list kept by hand is out of date by the next app.
const listed = await readFile("README.md", "utf8");
const withList = listed.replace(/(<!-- apps:start -->)[\s\S]*?(<!-- apps:end -->)/, (_match, start, end) => `${start}\n${appTable(manifests)}\n${end}`);
if (withList !== listed) {
  await writeFile("README.md", withList);
  changed += 1;
  process.stdout.write("synced README.md app list\n");
}

/** Every app by category, the biggest category first, names in the order people read them. */
function appTable(all) {
  const labels = { DNS: "Ad blocking and DNS", Developer: "Developer tools" };
  const byCategory = new Map();
  for (const manifest of all) byCategory.set(manifest.category, [...(byCategory.get(manifest.category) ?? []), manifest.name]);
  const rows = [...byCategory].sort(([a, left], [b, right]) => right.length - left.length || a.localeCompare(b))
    .map(([category, names]) => `| ${labels[category] ?? category} (${names.length}) | ${names.sort((a, b) => a.localeCompare(b, "en", { numeric: true })).join(", ")} |`);
  return ["| Category | Apps |", "| --- | --- |", ...rows].join("\n");
}

if (!changed) process.stdout.write(`every version reference already reads ${productVersion}\n`);
