/**
 * Helper-side client for the generic root runner (deploy/boxpilot-run@.service).
 * Writes a one-shot approval spec, starts the template unit, and returns the task result.
 * The helper itself runs with PrivateNetwork=true, so anything needing the network goes this way.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fixedRun } from "./exec.mjs";
import { taskIds } from "./tasks/index.mjs";
import { formatDuration, timedOut } from "./timeouts.mjs";

/**
 * How long past a root task's own limit the helper waits for its unit. The runner writes its result
 * the moment the limit runs out, a few seconds after the unit starts; this covers that start. It was
 * a minute, and most operations' budgets are their task's limit plus a minute, so the web side's
 * deadline and the helper's answer came due together and the deadline won: the job recorded the
 * whole operation running out, not the task left running. An operation that runs a root task keeps
 * this, and half a minute more, inside its budget (ops/root-task-budgets.test.mjs).
 */
export const rootTaskWaitMarginMs = 30_000;

/**
 * The longest a root task left running past its own limit keeps its operation's lanes: the unit's
 * own TimeoutStartSec, after which systemd stops it. Past this the lanes are let go, with a line in
 * the helper's journal, rather than hold every change behind it for good.
 */
export const rootTaskLingerCapMs = 12 * 60 * 60_000;

/**
 * Who holds lanes for the work running now (helper-lanes.mjs `holdUntil`), so a root task that
 * runs out of its own time while its unit is still active keeps them until the unit stops. The
 * runner writes "timed out" and lets the task carry on (KillMode=process): an fsck.exfat -y went on
 * writing to the unmounted drive while an app start bound the empty folder and a reconnect mounted
 * the drive mid-repair, because the operation had answered and its lanes were free.
 */
const lanesHeld = new AsyncLocalStorage();
export const whileHoldingRootTasks = (holdUntil, work) => lanesHeld.run(holdUntil, work);

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
/** `systemctl is-active` says one of these while a unit has not finished: a oneshot runs "activating". */
const runningStates = new Set(["active", "activating", "deactivating", "reloading", "refreshing"]);

export function createRunUnitClient({
  run = fixedRun,
  runDirectory = process.env.BOXPILOT_RUN_DIRECTORY ?? "/run/boxpilot/run",
  systemctlBinary = process.env.BOXPILOT_SYSTEMCTL_BINARY ?? "/usr/bin/systemctl",
  unitTemplate = "boxpilot-run@",
  now = () => new Date(),
  sleep = pause,
  clock = () => Date.now(),
  lingerPollMs = 15_000,
  lingerCapMs = rootTaskLingerCapMs,
  log = (line) => console.log(line),
} = {}) {
  const knownTasks = new Set(taskIds());

  async function runTask(task, parameters = {}, { timeoutMs = 15 * 60 * 1000, logPath = null } = {}) {
    if (!knownTasks.has(task)) throw new Error(`Root task ${task} is not in the task table`);
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) throw new Error("Root task parameters must be an object");
    const id = randomUUID();
    const startedAt = clock();
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    const specPath = path.join(runDirectory, `${id}.json`);
    const resultPath = path.join(runDirectory, `${id}.result.json`);
    await writeFile(specPath, JSON.stringify({ task, parameters, approvedAt: now().toISOString(), timeoutMs, ...(logPath ? { logPath } : {}) }), { mode: 0o600, flag: "wx" });
    let start;
    try {
      start = await run(systemctlBinary, ["start", `${unitTemplate}${id}.service`], { timeout: timeoutMs + rootTaskWaitMarginMs });
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
    // The runner says when the task ran out of its own budget (M30.3); that is a timeout, with the
    // task's budget, rather than one more failure sentence. The runner writes that and lets the task
    // carry on (the unit's KillMode=process), so it may still be running: a flow must not start it
    // again beside itself, and nor must "Try again with more time".
    if (payload?.ok === false && payload.timedOut === true) {
      await holdWhileRunning(task, `${unitTemplate}${id}.service`, startedAt);
      throw timedOut(`Root task ${task} did not finish within ${formatDuration(timeoutMs)}`, { budgetMs: timeoutMs, step: `Root task ${task}`, stillRunning: true });
    }
    if (!payload) throw new Error(`Root task ${task} produced no result${start?.ok ? "" : ` (unit failed: ${start?.stderr || "see journalctl -u " + unitTemplate + id})`}`);
    if (!payload.ok) throw new Error(payload.error || `Root task ${task} failed`);
    return payload.result;
  }

  /** Whether systemd says the unit is still at work; an answer it cannot give counts as yes. */
  async function stillActive(unit) {
    const answer = await run(systemctlBinary, ["is-active", unit], { timeout: 15_000 }).catch(() => null);
    const state = String(answer?.stdout ?? "").trim();
    return state ? runningStates.has(state) : true;
  }

  /**
   * A task that ran out of its own time and whose unit is still active: the lanes its operation holds
   * stay held until the unit stops, or until the unit's own limit has passed. Only inside the helper's
   * lanes; anywhere else nothing waits on it.
   */
  async function holdWhileRunning(task, unit, startedAt) {
    const holdUntil = lanesHeld.getStore();
    if (typeof holdUntil !== "function" || !(await stillActive(unit))) return;
    holdUntil((async () => {
      while (clock() - startedAt < lingerCapMs) {
        await sleep(Math.min(lingerPollMs, Math.max(1_000, lingerCapMs - (clock() - startedAt))));
        if (!(await stillActive(unit))) { log(`Root task ${task} (${unit}) has stopped; what it held is free again`); return; }
      }
      log(`Root task ${task} (${unit}) is still running after ${formatDuration(lingerCapMs)}; what it held is free again`);
    })());
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
