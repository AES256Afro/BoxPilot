#!/usr/local/bin/node
/**
 * What the UPS monitor's shutdown command runs before it powers the server off (M39.1).
 *
 * /etc/nut/boxpilot-shutdown (server/tasks/ups.mjs) calls this as root when the battery is low. It
 * stops the apps and unmounts the drives in the order BoxPilot's own reboot uses (Docker stopped as
 * a shutdown stops it, containers live-restore kept running given their own stop signal, a sync,
 * each drive unmounted and checked), bounded by --budget-seconds, and adds one line to the
 * power-event log saying how that went. The shell script powers off afterwards whatever happens
 * here; this never keeps the server from switching off. What it did goes to stdout, which is
 * nut-monitor's journal.
 */
import { pathToFileURL } from "node:url";
import { prepareDrivesForReboot } from "../server/tasks/drive-shutdown.mjs";
import { appendPowerEvent } from "../server/power-events.mjs";

export function budgetSecondsFrom(argv) {
  const index = argv.indexOf("--budget-seconds");
  const value = index >= 0 ? Number.parseInt(argv[index + 1], 10) : Number.NaN;
  return Number.isInteger(value) && value >= 10 && value <= 600 ? value : 60;
}

/** The preparation and its one line in the log: how many apps stopped, how many drives let go. */
export async function prepareForPowerOff({ budgetSeconds = 60, prepare = prepareDrivesForReboot, append = appendPowerEvent, log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  try {
    const summary = await prepare({}, { log: (line) => log(line), budgetMs: budgetSeconds * 1000, allContainers: true, occasion: "shutdown" });
    const containers = summary.containers.stopped.length + summary.containers.killed.length;
    const mounted = summary.drives.filter((drive) => drive.mounted);
    const unmounted = mounted.filter((drive) => drive.state === "unmounted").length;
    await append("apps-stopped", { containers, drives: unmounted, busy: mounted.length - unmounted });
    return { ok: true, containers, drives: unmounted, busy: mounted.length - unmounted };
  } catch (error) {
    log(`Could not stop the apps and unmount the drives: ${error.message}; powering off regardless`);
    await append("apps-not-stopped");
    return { ok: false, error: error.message };
  }
}

// Exits 0 once its line is in the log, however the preparation went: the shell script notes
// "apps-not-stopped" itself only when this could not run at all (a crash, or its time ran out).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await prepareForPowerOff({ budgetSeconds: budgetSecondsFrom(process.argv) });
}
