import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registry } from "./index.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

/**
 * Every operation in the registry is named by at least one test (M56.2).
 *
 * The registry is the whole of what BoxPilot can do to a host, and the fourth audit sweep measured
 * that ten of its 265 entries had never been named in any test at all — four of them operations
 * that change the host. Not a norm, since 96% were: an oversight, which is exactly the kind of
 * thing that needs a number watching it rather than a sweep rediscovering it.
 *
 * Being named is a floor, not coverage: a test can mention an id and prove little. But an operation
 * no test mentions is certainly untested, and the floor is cheap to hold.
 *
 * The test files come from the filesystem, not from `git ls-files` — the opposite of
 * `check:exports`, deliberately. That check asks "does anything mention this name", where an
 * uncommitted build artifact lies and git's list is the only honest one. This one asks "does a test
 * cover this operation", and a test file on disk does run, staged or not; taking git's list would
 * fail while someone was writing exactly the test it is asking for. The filter is on `*.test.*`
 * names, which no build artifact carries, so there is nothing here for an artifact to distort.
 */

const skipped = new Set(["node_modules", "dist", ".git", ".claude"]);

async function testFilesUnder(directory) {
  const found = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) { if (!skipped.has(entry.name)) found.push(...await testFilesUnder(full)); }
    else if (/\.test\.(mjs|ts|tsx)$/.test(entry.name)) found.push(full);
  }
  return found;
}

const testFiles = (await Promise.all(["server", "src", "scripts", "packages", "test", "tests"].map((root) => testFilesUnder(path.join(repoRoot, root))))).flat();

const corpus = await Promise.all(testFiles.map((file) => readFile(file, "utf8").catch(() => "")));

describe("the operation registry", () => {
  it("is asked of every operation, not of an empty list", () => {
    // As with the escalation inventory (M54.4): "every operation is named" is satisfied by no
    // operations at all, so the size is asserted before the invariant. 265 at the time of writing.
    expect(registry.list().length).toBeGreaterThan(200);
    expect(testFiles.length).toBeGreaterThan(400);
  });

  it("has every operation named by a test somewhere", () => {
    const unnamed = registry.list()
      .map((operation) => operation.id)
      .filter((id) => !corpus.some((text) => text.includes(`"${id}"`) || text.includes(`'${id}'`) || text.includes(`op:${id}`)));
    expect(unnamed, "these operations are in the registry and no test names them. An operation nothing tests is one nobody has checked the tier, the role, the parameters or the wiring of; the four found in the 2026-11 sweep were a wrong-looking role, a dropped progress handler and two untested inline reads away from mattering.").toEqual([]);
  });
});
