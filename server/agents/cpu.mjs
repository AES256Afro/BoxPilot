/**
 * The agents runner's processors, set per run (M40, ADR-009): the one place root changes them.
 *
 * The shipped unit holds the background quota (deploy/boxpilot-agents.service, CPUQuota=400%).
 * While a person waits on an answer, the web service asks the helper to raise the running unit's
 * quota with `systemctl set-property --runtime` - a drop-in under /run that goes with the next boot
 * - and to lower it again when the run is over. Only these two values are ever set, each held here
 * to the machine's own ceiling (eight, or all its processors but two), whatever the caller asked.
 *
 * A raise always arms a timer with it (`systemd-run --on-active`, a transient unit, collected once
 * it has run) that puts the background quota back by itself after the run's longest time: if the
 * web service stops or loses track mid-run, the burst still ends. A raise that cannot arm its timer
 * is taken back at once and refused. Lowering stops the timer.
 *
 * Idle priority, idle I/O, the memory cap and the rest of the unit are not touched.
 */
import os from "node:os";
import { coreCeiling, coreLimits, runnerUnit } from "./caps.mjs";

export const cpuResetUnit = "boxpilot-agents-cpu-reset";
const systemctlBinary = "/usr/bin/systemctl";
const systemdRunBinary = "/usr/bin/systemd-run";

export class CpuError extends Error {}

/** The drop-in's words: CPUQuota for so many processors. */
export const quotaFor = (processors) => `CPUQuota=${processors * 100}%`;

/**
 * Set the runner's processors to `processors`; `background` is what the reset timer puts back.
 * `bounds` is { min, max } (the machine's, unless a test gives its own).
 */
export async function setRunnerProcessors({ processors, background, resetAfterSeconds = 1_200 }, { run, bounds = { min: coreLimits.min, max: coreCeiling(os.cpus().length) }, systemctl = systemctlBinary, systemdRun = systemdRunBinary } = {}) {
  const whole = (value, what, min, max) => {
    if (!Number.isInteger(value) || value < min || value > max) throw new CpuError(`${what} must be ${min} to ${max} on this machine`);
    return value;
  };
  whole(background, "The background processors", bounds.min, bounds.max);
  whole(processors, "The processors", background, bounds.max);
  whole(resetAfterSeconds, "The reset time", 60, 7_200);

  const set = async (count) => {
    const result = await run(systemctl, ["set-property", "--runtime", runnerUnit, quotaFor(count)], { timeout: 15_000 });
    if (!result.ok) throw new CpuError(`systemctl could not set ${runnerUnit}'s processors: ${String(result.stderr ?? "").trim().split("\n").slice(-1)[0] || "no reason given"}`);
  };
  // The timer of an earlier raise goes first: a new raise re-arms it for its own run, a lowering needs none.
  await run(systemctl, ["stop", `${cpuResetUnit}.timer`], { timeout: 15_000 }).catch(() => null);
  await set(processors);
  let resetAt = null;
  if (processors > background) {
    const armed = await run(systemdRun, [
      "--quiet", "--collect", `--unit=${cpuResetUnit}`, `--on-active=${resetAfterSeconds}`, "--timer-property=AccuracySec=1s",
      `--description=BoxPilot: the agents runner back to ${background} processors`,
      "--", systemctl, "set-property", "--runtime", runnerUnit, quotaFor(background),
    ], { timeout: 15_000 });
    if (!armed.ok) {
      // Never raised without the way back: take it back now, and say why.
      await set(background).catch(() => null);
      throw new CpuError(`The timer that takes the extra processors back could not be set (${String(armed.stderr ?? "").trim().split("\n").slice(-1)[0] || "systemd-run failed"}), so the runner stays at ${background}`);
    }
    resetAt = new Date(Date.now() + resetAfterSeconds * 1000).toISOString();
  }
  const shown = await run(systemctl, ["show", runnerUnit, "--property=CPUQuotaPerSecUSec"], { timeout: 15_000 });
  const perSecond = /CPUQuotaPerSecUSec=(\S+)/.exec(String(shown.stdout ?? ""))?.[1] ?? null;
  return { processors, background, quotaPercent: processors * 100, perSecond, resetAt };
}
