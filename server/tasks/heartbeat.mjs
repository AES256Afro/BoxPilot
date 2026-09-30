/**
 * The heartbeat's switch and its test (M39.3). Tasks rather than helper work: the timer's interval
 * is a drop-in under /etc/systemd/system, which the helper's sandbox cannot write, and a test ping
 * needs the network, which the helper does not have. The ping itself always runs in
 * boxpilot-heartbeat.service, the very unit the timer starts, so a test proves the real path: the
 * unit's sandbox, its credential read and its request.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fixedRun } from "../exec.mjs";
import { defaultStatusFile, dropInDirectory, dropInName, heartbeatService, heartbeatTimer, intervalChoices, readStatus, renderDropIn } from "../heartbeat.mjs";

const systemctlBinary = () => process.env.BOXPILOT_SYSTEMCTL_BINARY ?? "/usr/bin/systemctl";
const defaultFiles = { mkdir, writeFile };

/**
 * Start the heartbeat unit once and read what it recorded. A status older than the start means the
 * unit did not run at all (a condition failed, or it is not installed), which is said as such
 * rather than passing an old ping off as this one.
 */
export async function heartbeatPing(_parameters = {}, { run = fixedRun, log = () => {}, statusFile = defaultStatusFile, now = () => new Date(), read = readStatus } = {}) {
  const started = now().getTime();
  const result = await run(systemctlBinary(), ["start", heartbeatService], { timeout: 60_000 });
  if (!result.ok) throw new Error(`The heartbeat unit did not run: ${String(result.stderr || `exit ${result.code ?? "?"}`).split("\n").slice(-2).join(" ")}`);
  const status = await read({ file: statusFile });
  if (!status || Date.parse(status.at) < started - 1000) throw new Error(`${heartbeatService} did not record a ping. Is BoxPilot's heartbeat unit installed? Upgrading BoxPilot installs it.`);
  log(status.ok ? `The dead man's switch took the ping (HTTP ${status.status}, ${status.ms} ms).` : `The ping did not get through: ${status.error}.`, status.ok ? "stdout" : "stderr");
  return status;
}

/**
 * Turn the timer on at an interval, or off. On writes the interval, enables and restarts the timer
 * (so the new interval counts from now) and sends the first ping at once, so the switch hears from
 * this server before its first period runs out. Off stops and disables the timer; the interval
 * drop-in stays for next time.
 */
export async function heartbeatConfigure({ enabled, intervalMinutes = null } = {}, { run = fixedRun, log = () => {}, files = defaultFiles, statusFile = defaultStatusFile, now = () => new Date(), read = readStatus } = {}) {
  if (typeof enabled !== "boolean") throw new Error("enabled must be true or false");
  const systemctl = systemctlBinary();
  const must = async (args, what) => {
    const result = await run(systemctl, args, { timeout: 60_000 });
    if (!result.ok) throw new Error(`${what}: ${String(result.stderr || `exit ${result.code ?? "?"}`).split("\n").slice(-2).join(" ")}`);
    return result;
  };
  if (!enabled) {
    await must(["disable", "--now", heartbeatTimer], "Could not turn the heartbeat timer off");
    log("The heartbeat timer is off. Your dead man's switch will alert you when its period runs out; pause or delete the check there.", "stdout");
    return { enabled: false, intervalMinutes: null, last: await read({ file: statusFile }) };
  }
  if (!intervalChoices.includes(intervalMinutes)) throw new Error(`The interval must be one of ${intervalChoices.join(", ")} minutes`);
  await files.mkdir(dropInDirectory, { recursive: true, mode: 0o755 });
  await files.writeFile(path.join(dropInDirectory, dropInName), renderDropIn(intervalMinutes), { mode: 0o644 });
  await must(["daemon-reload"], "Could not reload systemd");
  await must(["enable", heartbeatTimer], "Could not enable the heartbeat timer");
  await must(["restart", heartbeatTimer], "Could not start the heartbeat timer");
  log(`The heartbeat timer runs every ${intervalMinutes} minutes. Sending the first ping now.`, "stdout");
  const last = await heartbeatPing({}, { run, log, statusFile, now, read });
  return { enabled: true, intervalMinutes, last };
}
