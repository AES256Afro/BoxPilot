import { afterAll, describe, expect, it } from "vitest";
import { onWindows } from "../test/platform.mjs";
import { cleanUpCheckTrees, runCheck } from "../test/check-harness.mjs";

/**
 * `check:syntax` and `check:shell` proving they fail on what they are for (M54).
 *
 * These two were written before the convention and had no test of their own. They are the safest of
 * the repo's checks — a check that parses every file errs towards checking too much, never too
 * little — but "it only fails in the safe direction" is a claim worth holding to a test, and the
 * mode argument and the file walk are both places a check can go quiet.
 */
const check = (mode, options) => runCheck("scripts/check-sources.mjs", { ...options, args: [mode] });

afterAll(cleanUpCheckTrees);

describe("the syntax check", () => {
  it("fails on a server file that does not parse, and names it", async () => {
    const result = await check("syntax", {
      tracked: {
        "server/good.mjs": "export const fine = 1;\n",
        "server/broken.mjs": "export const oops = ;\n",
      },
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("server/broken.mjs");
    expect(result.output).toContain("1 of 2 files passed");
  });

  it("passes when every file parses, and counts them", async () => {
    const result = await check("syntax", {
      tracked: { "server/a.mjs": "export const a = 1;\n", "scripts/b.mjs": "export const b = 2;\n", "packages/c/d.mjs": "export const d = 3;\n" },
    });
    expect(result.code).toBe(0);
    expect(result.output).toContain("3 of 3 files passed");
  });

  it("looks in server, scripts and packages, and not elsewhere", async () => {
    // A file that does not parse, outside the three roots: not this check's business.
    const result = await check("syntax", { tracked: { "server/a.mjs": "export const a = 1;\n", "src/broken.mjs": "const x = ;\n" } });
    expect(result.code).toBe(0);
    expect(result.output).toContain("1 of 1 files passed");
  });
});

// `sh -n` needs a POSIX shell; a macOS checkout has one, Windows does not.
describe.skipIf(onWindows)("the shell check", () => {
  it("fails on a script that does not parse, and names it", async () => {
    const result = await check("shell", {
      tracked: { "scripts/fine.sh": "#!/bin/sh\necho hello\n", "deploy/broken.sh": "#!/bin/sh\nif [ 1 = 1 ]; then\necho unterminated\n" },
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("deploy/broken.sh");
  });

  it("passes on scripts that parse", async () => {
    const result = await check("shell", { tracked: { "scripts/fine.sh": "#!/bin/sh\nset -e\necho hello\n" } });
    expect(result.code).toBe(0);
    expect(result.output).toContain("1 of 1 files passed");
  });

  it("does not look below the top of scripts and deploy, as its walk says", async () => {
    const result = await check("shell", { tracked: { "scripts/nested/broken.sh": "#!/bin/sh\nif [ 1 = 1 ]; then\n" } });
    expect(result.code).toBe(0);
    expect(result.output).toContain("0 of 0 files passed");
  });
});

describe("an unknown mode", () => {
  it("refuses with usage rather than passing silently", async () => {
    const result = await check("whatever", { tracked: { "server/a.mjs": "export const a = 1;\n" } });
    expect(result.code).toBe(2);
    expect(result.output).toContain("Usage:");
  });

  it("refuses with no mode at all", async () => {
    const result = await runCheck("scripts/check-sources.mjs", { tracked: { "server/a.mjs": "export const a = 1;\n" } });
    expect(result.code).toBe(2);
  });
});
