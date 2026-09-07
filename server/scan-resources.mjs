import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { parsePressure } from "./runtime-diagnostics.mjs";

/** One cheap preflight before a scheduled folder walk. Missing PSI remains unknown. */
export async function readScanPressure({ read = (file) => readFile(file, "utf8") } = {}) {
  const result = {};
  await Promise.all(["cpu", "memory", "io"].map(async (name) => {
    result[name] = parsePressure(await read(`/proc/pressure/${name}`).catch(() => null));
  }));
  return result;
}

/** Conservative scheduling policy, not a diagnosis of hardware health. */
export function scanDeferral(pressure) {
  for (const [resource, kind, threshold] of [["memory", "full", 1], ["io", "full", 10], ["cpu", "some", 80]]) {
    const average = pressure?.[resource]?.[kind]?.avg60;
    if (Number.isFinite(average) && average >= threshold) return `${resource.toUpperCase()} pressure (${average.toFixed(1)}% ${kind} stall over 60 seconds)`;
  }
  return null;
}

/** Keep the same filesystem-limited du, with lower scheduling priority on supported Linux hosts. */
export async function dataScanCommand(folder, { platform = process.platform, executable = (file) => access(file, constants.X_OK).then(() => true, () => false) } = {}) {
  if (platform !== "linux") return { binary: "du", args: ["-sbx", folder], priority: "default" };
  const [nice, ionice] = await Promise.all([executable("/usr/bin/nice"), executable("/usr/bin/ionice")]);
  const command = nice ? ["/usr/bin/nice", "-n", "10", "/usr/bin/du", "-sbx", folder] : ["/usr/bin/du", "-sbx", folder];
  // -t still runs the scan if this kernel/device cannot apply the requested IO class.
  if (ionice) return { binary: "/usr/bin/ionice", args: ["-c", "3", "-t", ...command], priority: nice ? "idle-io-requested-and-nice-10" : "idle-io-requested" };
  return { binary: command[0], args: command.slice(1), priority: nice ? "nice-10" : "default" };
}
