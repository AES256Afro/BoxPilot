// Run inside the VM of tests/ubuntu/power-loss-vm.sh: how the previous boot ended, read from the
// journal the way the helper's system.boots.inspect reads it, and the sentence Home would say.
//
//   node power-loss.mjs <server-dir>
import { readFile } from "node:fs/promises";
import os from "node:os";

const serverDir = process.argv[2] ?? "/opt/bp/server";
const { inspectBoots, outageTitle } = await import(`${serverDir}/power-loss.mjs`);
const { fixedRun } = await import(`${serverDir}/exec.mjs`);
const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim().replaceAll("-", "");
const read = await inspectBoots({ run: fixedRun, uptimeSeconds: os.uptime(), bootId });
const judged = read.judgement ?? {};
console.log(JSON.stringify({
  ...read,
  bootId,
  title: judged.state === "unclean" ? outageTitle({ ...judged, dnsApps: [] }, { hostname: os.hostname(), timeZone: "UTC" }) : null,
}));
