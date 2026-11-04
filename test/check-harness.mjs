/**
 * Run one of the repo's own checks against a tree built for the occasion, so a check can be tested
 * the way everything else is: by showing it fails on something known to be wrong.
 *
 * Two of the three checks added in M52 and M53 passed on everything before they worked. The export
 * check's allowlist was in its own corpus, so every entry looked read; then its corpus came from the
 * filesystem, so a gitignored demo bundle in a working copy made every export look read, and it
 * reported "275 of 275 reviewed" while seeing nothing — CI found that one, on a pull request. The
 * clock rule's first two versions reported 151 parameter defaults. A guard that is wrong in this
 * direction is worse than no guard: its output looks like evidence.
 *
 * So a check gets the same treatment as the code it guards (M54). `runCheck` gives it a temporary
 * git repository with exactly the files a case needs — `tracked` are staged, so `git ls-files` sees
 * them; `untracked` are written and not staged, which is how a build artifact or a scratch file
 * reaches a working copy — and returns what the check printed and the code it exited with.
 */
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

/** This checkout, so a check script can be run by absolute path against another tree. */
export const repoRoot = path.resolve(import.meta.dirname, "..");

const temporary = [];

/** Remove every tree `runCheck` made. Call from `afterAll`. */
export async function cleanUpCheckTrees() {
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true });
}

async function write(directory, files) {
  for (const [file, contents] of Object.entries(files)) {
    const full = path.join(directory, file);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, contents);
  }
}

/**
 * Run `script` (a path inside this checkout) with its working directory set to a fresh git
 * repository holding `tracked` and `untracked`.
 *
 * @param {string} script e.g. "scripts/check-export-surface.mjs"
 * @param {{ tracked?: Record<string, string>, untracked?: Record<string, string>, args?: string[] }} [options]
 * @returns {Promise<{ code: number, stdout: string, stderr: string, output: string, directory: string }>}
 */
export async function runCheck(script, { tracked = {}, untracked = {}, args = [] } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-check-"));
  temporary.push(directory);
  // -q and a fixed branch name so the output is the check's alone, and no global git config is read:
  // a developer's commit.gpgsign or init.templateDir must not change what a test sees.
  const git = (...parameters) => execFile("git", parameters, { cwd: directory, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
  await git("init", "-q", "-b", "main");
  await write(directory, tracked);
  if (Object.keys(tracked).length) await git("add", "-A");
  await write(directory, untracked);

  try {
    const { stdout, stderr } = await execFile(process.execPath, [path.join(repoRoot, script), ...args], { cwd: directory, maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, stdout, stderr, output: `${stdout}${stderr}`, directory };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "", output: `${error.stdout ?? ""}${error.stderr ?? ""}`, directory };
  }
}
