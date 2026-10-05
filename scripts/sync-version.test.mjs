// @vitest-environment node
/**
 * scripts/sync-version.mjs, run the way `npm version` runs it, against a scratch copy of the two
 * files it keeps in step. A README whose install line changed shape (`--ref=v1.2.3`, a quoted ref)
 * used to be skipped without a word, so a release could ship telling people to install the last one.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { productVersion } from "../server/version.mjs";

const program = path.resolve("scripts/sync-version.mjs");
const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function sync({ readme, compose = `services:\n  boxpilot:\n    image: boxpilot:${productVersion}\n` }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-sync-version-"));
  directories.push(directory);
  await writeFile(path.join(directory, "README.md"), readme);
  await writeFile(path.join(directory, "docker-compose.yml"), compose);
  const result = spawnSync(process.execPath, [program], { cwd: directory, encoding: "utf8" });
  return { ...result, readme: await readFile(path.join(directory, "README.md"), "utf8") };
}

describe("sync-version", () => {
  it("refuses when the README's install line no longer holds a version it can sync", async () => {
    for (const line of ["sh -s -- --ref=v1.2.3 --access lan", 'sh -s -- --ref "v1.2.3"', "sh -s -- --access lan"]) {
      const result = await sync({ readme: `# BoxPilot\n\n    curl -fsSL https://example.invalid/install.sh | sudo ${line}\n` });
      expect(result.status, line).not.toBe(0);
      expect(result.stderr, line).toContain("README.md no longer contains a version to sync");
    }
  });

  it("syncs a stale version, and passes when every copy already reads this one", async () => {
    const stale = await sync({ readme: "    curl -fsSL https://example.invalid/install.sh | sudo sh -s -- --ref v0.0.1\n" });
    expect(stale.status, stale.stderr).toBe(0);
    expect(stale.readme).toContain(`--ref v${productVersion}`);
    const current = await sync({ readme: `    curl -fsSL https://example.invalid/install.sh | sudo sh -s -- --ref v${productVersion}\n` });
    expect(current.status, current.stderr).toBe(0);
    expect(current.stdout).toContain(`every version reference already reads ${productVersion}`);
  });
});
