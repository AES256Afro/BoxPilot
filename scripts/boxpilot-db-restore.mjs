#!/usr/bin/env node
/**
 * Put one of the update's database copies back (server/db-restore.mjs says how). Started by the
 * database.copy.restore root task in a unit of its own, because it stops the web service:
 *   node scripts/boxpilot-db-restore.mjs <copy name> <database path> <running version> <stamp>
 */
import { readFile } from "node:fs/promises";
import { webListenFromEnv } from "../server/env-file.mjs";
import { fixedRun } from "../server/exec.mjs";
import { restoreDatabaseCopy, restoreResultPath } from "../server/db-restore.mjs";
import { localHealthUrl } from "../server/tasks/update.mjs";

const [copyName, database, version, stamp] = process.argv.slice(2);
const url = localHealthUrl(webListenFromEnv(await readFile(process.env.BOXPILOT_ENV_FILE ?? "/etc/boxpilot/boxpilot.env", "utf8").catch(() => "")));

/** Whether BoxPilot answers its health check within two minutes. */
async function healthy() {
  const until = Date.now() + 120_000;
  while (Date.now() < until) {
    const answered = await fetch(url, { signal: AbortSignal.timeout(3_000) }).then((response) => response.ok, () => false);
    if (answered) return true;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return false;
}

try {
  await restoreDatabaseCopy({ database, copyName, version, stamp, healthy, resultFile: restoreResultPath, run: (binary, args) => fixedRun(binary, args, { timeout: 120_000 }) });
} catch (error) {
  console.log(`[boxpilot-db-restore] ERROR: ${error.message}`);
  process.exitCode = 1;
}
