/**
 * Keep the files that repeat the product version in step with package.json.
 *
 * `package.json` is the single source (CLAUDE.md), but a couple of files have to spell the version
 * out because nothing interpolates them. This runs from the npm `version` lifecycle, so bumping
 * with `npm version` cannot leave a stale copy behind — a mistake that has shipped a red build.
 */
import { readFile, writeFile } from "node:fs/promises";
import { productVersion } from "../server/version.mjs";

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
if (!changed) process.stdout.write(`every version reference already reads ${productVersion}\n`);
