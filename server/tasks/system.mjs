import { fixedRun } from "../exec.mjs";

/**
 * Schedule a reboot a few seconds out so the runner can still write its result file and the
 * helper can report success before the machine goes down.
 */
export async function systemReboot({ delaySeconds = 5 } = {}, { run = fixedRun, log = null } = {}) {
  log?.(`Scheduling reboot in ${delaySeconds}s`, "stdout");
  const delay = Number.isInteger(delaySeconds) && delaySeconds >= 2 && delaySeconds <= 300 ? delaySeconds : 5;
  const result = await run("/usr/bin/systemd-run", ["--quiet", "--on-active", String(delay), "--unit", "boxpilot-reboot", "/usr/bin/systemctl", "reboot"], { timeout: 30_000 });
  if (!result.ok) throw new Error(`Could not schedule the reboot: ${result.stderr.split("\n").slice(-2).join(" ")}`);
  return { scheduled: true, inSeconds: delay };
}
