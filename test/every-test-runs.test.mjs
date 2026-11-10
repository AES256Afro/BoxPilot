import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./check-harness.mjs";
import config from "../vite.config.ts";

const execFile = promisify(execFileCallback);

/**
 * Every test file in the repository is matched by one of the configured include patterns (M54.5).
 *
 * The purest version of the fault this milestone is about: a test that never runs cannot fail. It
 * costs nothing, reports nothing, and shows up in no count — there is no red to notice, because
 * vitest is not looking at it. `eslint-rules/use-the-injected-clock.test.mjs` was written into a
 * directory no pattern covered, and the only reason it ran is that its author happened to check the
 * config. The next one would not be so lucky.
 *
 * The patterns come from the config rather than being restated here, so a project added to
 * `vite.config.ts` is read, not guessed; and the file list comes from git, for the same reason
 * `check:exports` asks git — a file nobody committed is nobody's test.
 */

/** `{a,b}/c` → ["a/c", "b/c"], applied until no braces are left. */
function expandBraces(pattern) {
  const match = /\{([^{}]*)\}/.exec(pattern);
  if (!match) return [pattern];
  return match[1].split(",").flatMap((option) => expandBraces(pattern.slice(0, match.index) + option + pattern.slice(match.index + match[0].length)));
}

/** A glob with `**` and `*` as a regular expression anchored to a whole path. */
function globToRegExp(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern.startsWith("**/", index)) { source += "(?:[^/]+/)*"; index += 2; continue; }
    if (pattern.startsWith("**", index)) { source += ".*"; index += 1; continue; }
    const character = pattern[index];
    if (character === "*") { source += "[^/]*"; continue; }
    source += character.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

const matchers = (config.test?.projects ?? [])
  .flatMap((project) => project.test?.include ?? [])
  .flatMap((pattern) => expandBraces(pattern))
  .map((pattern) => ({ pattern, regex: globToRegExp(pattern) }));

const { stdout } = await execFile("git", ["ls-files", "-z"], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
const testFiles = stdout.split("\0").filter(Boolean)
  .map((file) => file.split(path.sep).join("/"))
  .filter((file) => /\.test\.(mjs|ts|tsx)$/.test(file))
  .sort();

describe("the glob translation this test leans on", () => {
  it("expands braces and matches the patterns the config actually uses", () => {
    expect(expandBraces("{a,b}/x.mjs").sort()).toEqual(["a/x.mjs", "b/x.mjs"]);
    expect(expandBraces("{a,b}/*.test.{ts,mjs}").sort()).toEqual(["a/*.test.mjs", "a/*.test.ts", "b/*.test.mjs", "b/*.test.ts"]);
    const matches = (pattern, file) => globToRegExp(pattern).test(file);
    expect(matches("src/**/*.test.ts", "src/a.test.ts")).toBe(true);
    expect(matches("src/**/*.test.ts", "src/deep/down/a.test.ts")).toBe(true);
    expect(matches("src/**/*.test.ts", "server/a.test.ts")).toBe(false);
    expect(matches("src/**/*.test.ts", "src/a.test.tsx")).toBe(false);
    // A dot in the pattern is a dot, not any character.
    expect(matches("src/**/*.test.ts", "src/axtestxts")).toBe(false);
  });
});

describe("the include patterns", () => {
  it("are read from the config, not restated here", () => {
    expect(matchers.length).toBeGreaterThan(1);
    expect(matchers.map(({ pattern }) => pattern).join(" ")).toContain("server");
  });
});

describe("every test file in the repository", () => {
  it("is matched by one of them, so none of them silently never runs", () => {
    expect(testFiles.length).toBeGreaterThan(400);
    const unrun = testFiles.filter((file) => !matchers.some(({ regex }) => regex.test(file)));
    expect(unrun, "these test files match no include pattern in vite.config.ts, so vitest never collects them and they cannot fail. Add their directory to a project's `include`, or move them.").toEqual([]);
  });
});
