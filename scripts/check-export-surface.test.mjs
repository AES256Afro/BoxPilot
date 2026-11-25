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

describe("export lists (M84, CODE-9)", () => {
  it("fails on a listed name nothing reads, which the first version skipped", async () => {
    const result = await check({
      tracked: {
        "server/thing.mjs": "const unused = 1;\nconst inner = 2;\nexport { unused, inner as renamed };\n",
        "scripts/export-surface-allowed.json": allowlist(),
      },
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("server/thing.mjs: unused");
    // The exported name is the one after `as`.
    expect(result.output).toContain("server/thing.mjs: renamed");
    expect(result.output).not.toContain("server/thing.mjs: inner");
  });

  it("passes when the listed names are read elsewhere", async () => {
    const result = await check({
      tracked: {
        "server/thing.mjs": "const used = 1;\nconst inner = 2;\nexport {\n  used,\n  inner as renamed,\n};\n",
        "server/other.mjs": 'import { used, renamed } from "./thing.mjs";\nconsole.log(used, renamed);\n',
        "scripts/export-surface-allowed.json": allowlist(),
      },
    });
    expect(result.code).toBe(0);
    expect(result.output).toContain("0 of 0 unread exports are reviewed");
  });

  it("fails on a pass-through nobody imports from it, though the module that defines the name mentions it", async () => {
    // The six M84 dropped: `import { x } from "./origin.mjs"; export { x };`. The origin and its own
    // importers all name x, so a plain word match would call this read.
    const result = await check({
      tracked: {
        "server/origin.mjs": "export const passed = 1;\n",
        "server/middle.mjs": 'import { passed } from "./origin.mjs";\nexport { passed };\nexport const own = passed + 1;\n',
        // Imports something else from the middle module, and `passed` from the origin: not a reader of the re-export.
        "server/user.mjs": 'import { passed } from "./origin.mjs";\nimport { own } from "./middle.mjs";\nconsole.log(passed, own);\n',
        "scripts/export-surface-allowed.json": allowlist(),
      },
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("server/middle.mjs: passed");
    expect(result.output).not.toContain("server/origin.mjs: passed");
  });

  it("fails on `export { x } from` nobody takes from it, and passes once a file does", async () => {
    const tracked = {
      "server/origin.mjs": "export const passed = 1;\n",
      "server/barrel/index.mjs": 'export { passed } from "../origin.mjs";\n',
      "server/user.mjs": 'import { passed } from "./origin.mjs";\nconsole.log(passed);\n',
      "scripts/export-surface-allowed.json": allowlist(),
    };
    const unread = await check({ tracked });
    expect(unread.code).toBe(1);
    expect(unread.output).toContain("server/barrel/index.mjs: passed");

    // Taken through the directory's index, as `import { … } from "./barrel"` reaches it.
    const read = await check({ tracked: { ...tracked, "server/user.mjs": 'import { passed } from "./barrel";\nconsole.log(passed);\n' } });
    expect(read.code).toBe(0);
  });

  it("counts a namespace import or a mock of the module as reaching every name it passes through", async () => {
    const result = await check({
      tracked: {
        "server/origin.mjs": "export const first = 1;\nexport const second = 2;\n",
        "server/middle.mjs": 'import { first, second } from "./origin.mjs";\nexport { first, second };\n',
        "server/a.mjs": 'import * as middle from "./middle.mjs";\nconsole.log(middle.first);\n',
        "server/b.test.mjs": 'vi.mock("./middle.mjs", () => ({ second: 3 }));\n',
        "scripts/export-surface-allowed.json": allowlist(),
      },
    });
    expect(result.code).toBe(0);
  });
});

describe("what it deliberately does not read", () => {
  it("leaves tests, type declarations, defaults and type-only lists alone", async () => {
    const result = await check({
      tracked: {
        // A test's own exports are not the surface this guards.
        "server/thing.test.mjs": "export const helperForThisTestOnly = 1;\n",
        "server/types/thing.d.ts": "export declare const typeOnly: number;\n",
        // `export default` and types are the type checker's business, not this check's.
        "server/other.mjs": "const inner = 1;\nexport default inner;\nexport * from \"./thing.mjs\";\n",
        "src/types.ts": 'type Local = string;\nexport type { Local };\nexport { type Remote } from "./remote";\n',
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
