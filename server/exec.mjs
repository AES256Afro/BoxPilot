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
/**
 * Terminal control sequences, removed so a log reads as text.
 *
 * Commands that draw progress do not merely overwrite with a carriage return: `ollama pull` and
 * `docker pull` move the cursor, clear lines and hide the caret with escape sequences, all of which
 * survived into the job log as `[K` and `[A[A[1G` wrapped around the words. Stripping them here
 * covers every command rather than the one that prompted it.
 */
export function stripTerminalCodes(text) {
  return String(text ?? "")
    .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, "")  // OSC ... BEL / ST
    .replace(/\u001B[[\]()#;?]*[0-9;?]*[ -/]*[@-~]/g, "")            // CSI and friends
    .replace(/\r/g, "");
}

export function streamRun(binary, args = [], { timeout = 30_000, env = {}, cwd, onLine, tailBytes = 256 * 1024, redrawIntervalMs = 1000, clock = () => Date.now() } = {}) {
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
    const lastRedrawAt = { stdout: 0, stderr: 0 };
    let settled = false;
    const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* ignore */ } setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 5000).unref?.(); }, timeout);
    const deliver = (stream, line) => {
      const clean = stripTerminalCodes(line).trimEnd();
      // A blank line is still output: it goes into the tail the caller reads, even though there is
      // nothing worth handing to a log writer.
      tails[stream] = (tails[stream] + clean + "\n").slice(-tailBytes);
      if (clean) { try { onLine(clean, stream); } catch { /* logging must never break the command */ } }
    };
    const consume = (stream, chunk) => {
      const text = partial[stream] + chunk.toString("utf8");
      const rows = text.split("\n");
      partial[stream] = rows.pop() ?? "";
      // A completed line is always delivered.
      for (const row of rows) deliver(stream, row.split("\r").filter(Boolean).at(-1) ?? "");
      // What is left is a line still being written. A \r in it means it is being *redrawn* — a
      // progress bar, which can repaint hundreds of times a second. Each repaint used to become
      // its own job-log entry and could exhaust the log's size cap before the lines that matter
      // were written, so redraws are sampled: the newest state, at most once a second.
      const redraws = partial[stream].split("\r");
      if (redraws.length > 1) {
        partial[stream] = redraws.at(-1) ?? "";
        const at = clock();
        if (at - lastRedrawAt[stream] >= redrawIntervalMs) {
          lastRedrawAt[stream] = at;
          deliver(stream, redraws.slice(0, -1).filter(Boolean).at(-1) ?? "");
        }
      }
      // A child that emits neither newline nor carriage return is still bounded.
      if (partial[stream].length > tailBytes) partial[stream] = partial[stream].slice(-tailBytes);
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
