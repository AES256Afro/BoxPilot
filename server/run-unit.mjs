/**
 * Helper-side client for the generic root runner (deploy/boxpilot-run@.service).
 * Writes a one-shot approval spec, starts the template unit, and returns the task result.
 * The helper itself runs with PrivateNetwork=true, so anything needing the network goes this way.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fixedRun } from "./exec.mjs";
import { taskIds } from "./tasks/index.mjs";

export function createRunUnitClient({
  run = fixedRun,
  runDirectory = process.env.BOXPILOT_RUN_DIRECTORY ?? "/run/boxpilot/run",
  systemctlBinary = process.env.BOXPILOT_SYSTEMCTL_BINARY ?? "/usr/bin/systemctl",
  unitTemplate = "boxpilot-run@",
  now = () => new Date(),
} = {}) {
  const knownTasks = new Set(taskIds());

  async function runTask(task, parameters = {}, { timeoutMs = 15 * 60 * 1000, logPath = null } = {}) {
    if (!knownTasks.has(task)) throw new Error(`Root task ${task} is not in the task table`);
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) throw new Error("Root task parameters must be an object");
    const id = randomUUID();
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    const specPath = path.join(runDirectory, `${id}.json`);
    const resultPath = path.join(runDirectory, `${id}.result.json`);
    await writeFile(specPath, JSON.stringify({ task, parameters, approvedAt: now().toISOString(), timeoutMs, ...(logPath ? { logPath } : {}) }), { mode: 0o600, flag: "wx" });
    let start;
    try {
      start = await run(systemctlBinary, ["start", `${unitTemplate}${id}.service`], { timeout: timeoutMs + 60_000 });
    } finally {
      await unlink(specPath).catch(() => {});
    }
    let payload = null;
    try {
      payload = JSON.parse(await readFile(resultPath, "utf8"));
    } catch {
      payload = null;
    } finally {
      await unlink(resultPath).catch(() => {});
    }
    if (!payload) throw new Error(`Root task ${task} produced no result${start?.ok ? "" : ` (unit failed: ${start?.stderr || "see journalctl -u " + unitTemplate + id})`}`);
    if (!payload.ok) throw new Error(payload.error || `Root task ${task} failed`);
    return payload.result;
  }

  /**
   * Remove spec and result files left by a task whose caller had already given up (the unit can keep
   * running for hours after a timeout, then write its result). /run is tmpfs, so these would otherwise
   * hold memory until the next reboot.
   */
  async function sweepStale({ olderThanMs = 25 * 60 * 60 * 1000, now = () => Date.now() } = {}) {
    const entries = await readdir(runDirectory).catch(() => []);
    let removed = 0;
    for (const entry of entries) {
      if (!/^[0-9a-f-]{36}(\.result)?\.json$/.test(entry)) continue;
      const file = path.join(runDirectory, entry);
      const info = await stat(file).catch(() => null);
      if (!info || now() - info.mtimeMs < olderThanMs) continue;
      await unlink(file).catch(() => {});
      removed += 1;
    }
    return { removed };
  }

  return { sweepStale, runTask, knownTasks };
}
