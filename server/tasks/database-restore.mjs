/**
 * Start putting a database copy back (M36). The work itself stops the web service this job came
 * from, so it runs in a unit of its own (scripts/boxpilot-db-restore.mjs, server/db-restore.mjs) and
 * this returns once that unit has started, as an update does.
 */
import { lstat } from "node:fs/promises";
import path from "node:path";
import { fixedRun } from "../exec.mjs";
import { compareVersions } from "../release-updates.mjs";
import { productVersion } from "../version.mjs";
import { restoreCopyPattern } from "../db-restore.mjs";
import { runningUpgrade } from "./update.mjs";

const stampedCopy = /^boxpilot-rollback-(.+)-(\d{8}T\d{6}Z)\.sqlite3$/;

/** The version a copy was taken from, when its name says. */
export function copyVersion(name) {
  return stampedCopy.exec(String(name))?.[1] ?? null;
}

/**
 * @param {{ name?: string, database?: string }} [parameters]
 * @param {{ run?: typeof fixedRun, log?: ((line: string, stream?: string) => void) | null, installDir?: string, nodeBinary?: string, now?: () => Date, version?: string, files?: { lstat: (file: string) => Promise<any> }, upgradeRunning?: () => Promise<string | null> }} [context]
 */
export async function databaseCopyRestore({ name, database } = {}, {
  run = fixedRun,
  log = null,
  installDir = process.env.BOXPILOT_INSTALL_DIR ?? "/opt/boxpilot",
  nodeBinary = process.execPath,
  now = () => new Date(),
  version = productVersion,
  files = { lstat },
  upgradeRunning = () => runningUpgrade({ run }),
} = {}) {
  if (typeof name !== "string" || !restoreCopyPattern.test(name)) throw new Error("Name one of the database copies (boxpilot-rollback-*.sqlite3)");
  if (typeof database !== "string" || !path.isAbsolute(database) || !database.endsWith(".sqlite3")) throw new Error("The database path is not one BoxPilot uses");
  // A copy from a newer release than this one has a schema this code does not know.
  const taken = copyVersion(name);
  if (taken && /^\d+\.\d+\.\d+/.test(taken) && compareVersions(taken.replace(/-.*$/, ""), version) > 0) {
    throw new Error(`${name} was taken from BoxPilot ${taken}, newer than this ${version}, so this version cannot use it. Nothing was changed.`);
  }
  const info = await files.lstat(path.join(path.dirname(database), name)).catch(() => null);
  if (!info?.isFile()) throw new Error(`${name} is not beside the database any more. Nothing was changed.`);
  const running = await upgradeRunning();
  if (running) throw new Error(`A BoxPilot update is running (${running}); put the copy back once it is done. Nothing was changed.`);

  const stamp = now().toISOString().replaceAll(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const unit = `boxpilot-db-restore-${stamp}`;
  const args = ["--quiet", "--unit", unit, "--description", `BoxPilot: put back ${name}`, nodeBinary, path.join(installDir, "scripts", "boxpilot-db-restore.mjs"), name, database, version, stamp];
  log?.(`$ systemd-run ${args.join(" ")}`, "stdout");
  const started = await run("/usr/bin/systemd-run", args, { timeout: 30_000 });
  if (!started.ok) throw new Error(`Could not start the unit that puts the copy back: ${String(started.stderr ?? "").split("\n").slice(-2).join(" ")}`);
  log?.("BoxPilot stops for a moment, the copy goes in, and BoxPilot starts again. If it does not answer, the database it had is put back.", "stdout");
  return { started: true, unit, name, saved: `boxpilot-rollback-${version}-${stamp}.sqlite3` };
}
