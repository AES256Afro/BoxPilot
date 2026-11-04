import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./check-harness.mjs";

/**
 * Every check this repo runs on itself has a test showing it fails on something known to be wrong
 * (M54).
 *
 * Two of the three checks added in M52 and M53 shipped in a state where they passed on everything.
 * The export check's allowlist was inside its own corpus, so each entry looked read; rewritten to
 * walk the filesystem, it was then fooled by a gitignored demo bundle that names every identifier in
 * the app, and reported "275 of 275 reviewed" while seeing nothing at all — found by CI on a pull
 * request, not here. The clock rule's first two versions reported 151 parameter defaults.
 *
 * A guard that fails this way does not merely stop working: its green output reads as evidence, so
 * it is worse than having no guard. A positive run proves nothing about it. The negative case does,
 * and this test is what keeps the next one from shipping without it.
 *
 * `npm run check` is the list. A new `check:*` that runs a script of ours fails here until that
 * script has `<name>.test.mjs` beside it, and so does a new ESLint rule.
 */

/** Checks whose correctness is not ours to prove, and why. Anything else needs a self-test. */
const reviewed = {
  "check:types": "tsc; the TypeScript project proves its own type checker",
  "lint": "eslint's own rules; the local rules in eslint-rules/ are tested individually below",
  "check:retention": "a churn probe that asserts directly rather than reporting findings, and is not part of `npm run check`",
};

const exists = async (file) => access(path.join(repoRoot, file)).then(() => true, () => false);

const scripts = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")).scripts ?? {};

/** The checks `npm run check` runs, in its own order. */
const checksInTheGate = [...(scripts.check ?? "").matchAll(/npm run ([\w:]+)/g)].map(([, name]) => name);

describe("the checks `npm run check` runs", () => {
  it("are all either tested here or reviewed as somebody else's to prove", () => {
    expect(checksInTheGate.length).toBeGreaterThan(5);
    for (const name of checksInTheGate) {
      expect(scripts, `npm run check runs "${name}", which package.json does not define`).toHaveProperty(name);
    }
  });

  it.each(Object.keys(scripts).filter((name) => name === "lint" || (name.startsWith("check") && name !== "check")))(
    "%s has a self-test, or a written reason it needs none",
    async (name) => {
      const command = scripts[name];
      const own = /node (?:--[\w=-]+ )*(scripts\/[\w.-]+\.mjs)/.exec(command);
      if (!own) {
        // Not one of our scripts: it must be in the reviewed list with a reason.
        expect(reviewed, `"${name}" runs "${command}", which is not a script of ours; add it to the reviewed list in this file with why it needs no self-test`).toHaveProperty(name);
        return;
      }
      if (reviewed[name]) return;
      const selfTest = own[1].replace(/\.mjs$/, ".test.mjs");
      expect(await exists(selfTest), `"${name}" runs ${own[1]} and has no ${selfTest}. A check that passes on everything is worse than no check: give it a test that plants something wrong and shows it fails. test/check-harness.mjs runs a check against a tree built for the occasion.`).toBe(true);
    },
  );
});

describe("the local ESLint rules", () => {
  it("each have a test, including the shapes they must stay quiet on", async () => {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(path.join(repoRoot, "eslint-rules"));
    const rules = entries.filter((file) => file.endsWith(".mjs") && !file.endsWith(".test.mjs"));
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      const selfTest = `eslint-rules/${rule.replace(/\.mjs$/, ".test.mjs")}`;
      expect(await exists(selfTest), `eslint-rules/${rule} has no ${selfTest}. A rule needs its valid cases as much as its invalid ones: use-the-injected-clock reported 151 false positives before it reported anything real.`).toBe(true);
    }
  });

  it("are linted themselves", async () => {
    // A rule with a syntax error or an unused variable is a rule nobody notices is broken.
    expect(scripts.lint, "`npm run lint` does not cover eslint-rules/, so the rules are not linted").toContain("eslint-rules");
  });
});

describe("the self-tests prove failure, not just success", () => {
  it.each([
    "scripts/check-export-surface.test.mjs",
    "scripts/check-sweep-coverage.test.mjs",
    "scripts/check-sources.test.mjs",
    "eslint-rules/use-the-injected-clock.test.mjs",
  ])("%s asserts a non-zero exit or an invalid case", async (file) => {
    const text = await readFile(path.join(repoRoot, file), "utf8");
    // Either a check run that must fail, or a RuleTester invalid list.
    const provesFailure = /code\)\.toBe\(1\)|code\)\.toBe\(2\)|invalid: \[/.test(text);
    expect(provesFailure, `${file} never asserts a failure, so it does not show the check works`).toBe(true);
  });
});
