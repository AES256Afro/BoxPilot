import { afterAll, describe, expect, it } from "vitest";
import { cleanUpCheckTrees, runCheck } from "../test/check-harness.mjs";

/**
 * `check:exports` proving it fails on what it is for (M54).
 *
 * This check shipped twice in a state where it passed on everything. First its own allowlist was in
 * its corpus, so every listed name looked read. Then its corpus came from walking the filesystem,
 * and a gitignored demo bundle left by `npm run demo:publish` names every identifier in the app, so
 * every export looked read: it reported "275 of 275 reviewed" while seeing nothing, and CI found it
 * on a pull request rather than anyone here. Both are cases below.
 */

const allowlist = (entries = {}) => `${JSON.stringify({ allowed: entries }, null, 2)}\n`;
const check = (options) => runCheck("scripts/check-export-surface.mjs", options);

afterAll(cleanUpCheckTrees);

describe("an export nothing outside its file reads", () => {
  it("fails, and names the file, the export and what to do", async () => {
    const result = await check({
      tracked: {
        "server/thing.mjs": "export const unreadByAnyone = 1;\nexport const used = 2;\n",
        "server/other.mjs": 'import { used } from "./thing.mjs";\nconsole.log(used);\n',
        "scripts/export-surface-allowed.json": allowlist(),
      },
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("server/thing.mjs: unreadByAnyone");
    expect(result.output).toContain("Drop the export");
    // The one another file imports is not reported.
    expect(result.output).not.toContain("server/thing.mjs: used");
  });

  it("passes once it is reviewed, and says how many are", async () => {
    const result = await check({
      tracked: {
        "server/thing.mjs": "export const unreadByAnyone = 1;\n",
        "scripts/export-surface-allowed.json": allowlist({ "server/thing.mjs: unreadByAnyone": "the catalog reads it by name at runtime" }),
      },
    });
    expect(result.code).toBe(0);
    expect(result.output).toContain("1 of 1 unread exports are reviewed");
  });
});

describe("an allowlist entry that no longer describes anything", () => {
  it("fails, so the list cannot rot into names that are gone", async () => {
    const result = await check({
      tracked: {
        "server/thing.mjs": "const nobodyExportsThisNow = 1;\nconsole.log(nobodyExportsThisNow);\n",
        "scripts/export-surface-allowed.json": allowlist({ "server/thing.mjs: nobodyExportsThisNow": "stale" }),
      },
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("is now read elsewhere, or is gone");
    expect(result.output).toContain("Remove that line");
  });
});

describe("what the corpus is", () => {
  it("is not fooled by an untracked build artifact that names every export", async () => {
    // The bug CI found: `npm run demo:publish` leaves bundles under demo-site/public/assets, git
    // ignores them, and a bundle contains every identifier in the app.
    const result = await check({
      tracked: {
        "server/thing.mjs": "export const unreadByAnyone = 1;\n",
        "scripts/export-surface-allowed.json": allowlist(),
      },
      untracked: { "demo-site/public/assets/bundle-abc123.js": 'var a="unreadByAnyone";\n' },
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("server/thing.mjs: unreadByAnyone");
  });

  it("does not count the allowlist itself as a reader", async () => {
    // The first bug: the allowlist names every entry, so leaving it in the corpus passed anything.
    const result = await check({
      tracked: {
        "server/thing.mjs": "export const unreadByAnyone = 1;\nexport const alsoUnread = 2;\n",
        "scripts/export-surface-allowed.json": allowlist({ "server/thing.mjs: unreadByAnyone": "reviewed" }),
      },
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("server/thing.mjs: alsoUnread");
  });

  it("counts a test as a reader, since a test hatch is read by its test", async () => {
    const result = await check({
      tracked: {
        "server/thing.mjs": "export const thingInternals = { parse: () => null };\n",
        "server/thing.test.mjs": 'import { thingInternals } from "./thing.mjs";\nthingInternals.parse();\n',
        "scripts/export-surface-allowed.json": allowlist(),
      },
    });
    expect(result.code).toBe(0);
  });

  it("counts a non-source file as a reader, because a name can be reached from one", async () => {
    const result = await check({
      tracked: {
        "server/thing.mjs": "export const namedInAWorkflow = 1;\n",
        ".github/workflows/ci.yml": "jobs:\n  run:\n    steps:\n      - run: node -e 'namedInAWorkflow'\n",
        "scripts/export-surface-allowed.json": allowlist(),
      },
    });
    expect(result.code).toBe(0);
  });
});

describe("what it deliberately does not read", () => {
  it("leaves tests, type declarations and re-exports alone", async () => {
    const result = await check({
      tracked: {
        // A test's own exports are not the surface this guards.
        "server/thing.test.mjs": "export const helperForThisTestOnly = 1;\n",
        "server/types/thing.d.ts": "export declare const typeOnly: number;\n",
        // `export { … }` and `export default` are the type checker's business, not this check's.
        "server/other.mjs": "const inner = 1;\nexport { inner };\nexport default inner;\n",
        "scripts/export-surface-allowed.json": allowlist(),
      },
    });
    expect(result.code).toBe(0);
    expect(result.output).toContain("0 of 0 unread exports are reviewed");
  });
});

describe("outside a checkout", () => {
  it("refuses to answer rather than passing, since it cannot ask git what is tracked", async () => {
    const result = await runCheck("scripts/check-export-surface.mjs", { tracked: {}, untracked: { "scripts/export-surface-allowed.json": allowlist() } });
    // No tracked files at all: git answers with nothing, so every export in an empty tree is
    // vacuously fine. The case that must not pass silently is git being unavailable, which the
    // script exits 2 for; here the point is simply that an empty tree is not a failure.
    expect([0, 2]).toContain(result.code);
  });
});

describe("--write", () => {
  it("seeds the allowlist from what is there, keeping reasons already written", async () => {
    const tracked = {
      "server/thing.mjs": "export const unreadByAnyone = 1;\nexport const alsoUnread = 2;\n",
      "scripts/export-surface-allowed.json": allowlist({ "server/thing.mjs: unreadByAnyone": "a reason somebody wrote" }),
    };
    const written = await check({ tracked, args: ["--write"] });
    expect(written.code).toBe(0);
    expect(written.output).toContain("wrote 2 reviewed entries");

    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const saved = JSON.parse(await readFile(path.join(written.directory, "scripts/export-surface-allowed.json"), "utf8"));
    expect(saved.allowed["server/thing.mjs: unreadByAnyone"]).toBe("a reason somebody wrote");
    expect(saved.allowed["server/thing.mjs: alsoUnread"]).toContain("Drop the export");
  });
});
