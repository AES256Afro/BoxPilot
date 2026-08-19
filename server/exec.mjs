import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const fixedEnvironment = Object.freeze({ PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", DEBIAN_FRONTEND: "noninteractive" });

/**
 * Run a binary with a fixed environment and argument array (never a shell).
 * Resolves to `{ ok, code, stdout, stderr }`; never throws for a non-zero exit.
 */
export async function fixedRun(binary, args = [], { timeout = 30_000, maxBuffer = 1024 * 1024, env = {} } = {}) {
  try {
    const result = await execFile(binary, args, { timeout, maxBuffer, encoding: "utf8", env: { ...fixedEnvironment, ...env } });
    return { ok: true, code: 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    return {
      ok: false,
      code: typeof error.code === "number" ? error.code : null,
      stdout: typeof error.stdout === "string" ? error.stdout.trim() : "",
      stderr: typeof error.stderr === "string" ? error.stderr.trim() : (error.message ?? ""),
    };
  }
}
