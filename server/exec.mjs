import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const fixedEnvironment = Object.freeze({ PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", DEBIAN_FRONTEND: "noninteractive" });

/**
 * Run a binary with a fixed environment and argument array (never a shell).
 * Resolves to `{ ok, code, stdout, stderr }`; never throws for a non-zero exit.
 * Pass `onLine(line, stream)` to receive output as it is produced (then the process is spawned
 * with streaming pipes; stdout/stderr in the result are capped to the last `tailBytes`).
 */
export async function fixedRun(binary, args = [], { timeout = 30_000, maxBuffer = 1024 * 1024, env = {}, cwd, onLine = null, tailBytes = 256 * 1024, input = undefined } = {}) {
  if (typeof onLine === "function") return streamRun(binary, args, { timeout, env, cwd, onLine, tailBytes });
  try {
    const pending = execFile(binary, args, { timeout, cwd, maxBuffer, encoding: "utf8", env: { ...fixedEnvironment, ...env } });
    // Optional stdin payload (e.g. a password for `openssl passwd -stdin`) — never an argument.
    if (typeof input === "string" && pending.child?.stdin) pending.child.stdin.end(input);
    const result = await pending;
    return { ok: true, code: 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    return {
      ok: false,
      code: typeof error.code === "number" ? error.code : null,
      stdout: typeof error.stdout === "string" ? error.stdout.trim() : "",
      // A command that never started (ENOENT, EACCES) has an empty stderr; without the message
      // the job log would say nothing at all about why it failed.
      stderr: (typeof error.stderr === "string" && error.stderr.trim()) || error.message || "",
    };
  }
}

/** Spawn with line-by-line callbacks. Same result shape as fixedRun. */
export function streamRun(binary, args = [], { timeout = 30_000, env = {}, cwd, onLine, tailBytes = 256 * 1024 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binary, args, { cwd, env: { ...fixedEnvironment, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ ok: false, code: null, stdout: "", stderr: error.message });
      return;
    }
    const tails = { stdout: "", stderr: "" };
    const partial = { stdout: "", stderr: "" };
    let settled = false;
    const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* ignore */ } setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 5000).unref?.(); }, timeout);
    const consume = (stream, chunk) => {
      const text = partial[stream] + chunk.toString("utf8");
      const lines = text.split("\n");
      partial[stream] = lines.pop() ?? "";
      for (const line of lines) {
        const clean = line.replace(/\r/g, "").trimEnd();
        tails[stream] = (tails[stream] + clean + "\n").slice(-tailBytes);
        if (clean) { try { onLine(clean, stream); } catch { /* logging must never break the command */ } }
      }
    };
    child.stdout.on("data", (chunk) => consume("stdout", chunk));
    child.stderr.on("data", (chunk) => consume("stderr", chunk));
    const finish = (code, error) => {
      if (settled) return; settled = true; clearTimeout(timer);
      for (const stream of ["stdout", "stderr"]) if (partial[stream]) { consume(stream, "\n"); }
      resolve({ ok: code === 0 && !error, code: typeof code === "number" ? code : null, stdout: tails.stdout.trim(), stderr: (error ? `${error.message}\n` : "") + tails.stderr.trim() });
    };
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code, null));
  });
}
