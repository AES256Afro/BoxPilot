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
// The catalog size is spelled out in the README's feature table. The UI count is
// derived at build time (__BOXPILOT_CATALOG_SIZE__) precisely because the copy
// once sat at "128 apps" through 161; the README had no such fix and had drifted
// to 163 with 165 installed. Adding an app is the moment the number changes, and
// a release is the moment anyone reads it, so it is synced here with the rest.
const { manifests } = await loadCatalog();
const readme = await readFile("README.md", "utf8");
const counted = readme.replace(
  /\b\d+ self-hosted apps and game servers\b/,
  `${manifests.length} self-hosted apps and game servers`
);
if (counted !== readme) {
  await writeFile("README.md", counted);
  changed += 1;
  process.stdout.write(`synced README.md catalog size to ${manifests.length}\n`);
}

if (!changed) process.stdout.write(`every version reference already reads ${productVersion}\n`);
