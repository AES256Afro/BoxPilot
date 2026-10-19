/**
 * Putting a database copy back (M36): the three steps an update's rollback used to print for the
 * owner to type, as one run that checks each of them.
 *
 * The copies are the ones an update takes before it swaps the code in (scripts/boxpilot-upgrade.sh),
 * `boxpilot-rollback-<version>-<stamp>.sqlite3` beside the database. Putting one back:
 *   1. checks the copy opens and passes SQLite's integrity check, before anything stops;
 *   2. stops BoxPilot, then saves the database as it is now as a copy of its own, so this can be
 *      undone the same way;
 *   3. writes the copy over the database (the live file's owner and mode kept, through a file
 *      beside it renamed into place), and removes the -wal and -shm the old database left;
 *   4. starts BoxPilot and waits for its health check; if that fails, puts the saved database back
 *      and starts BoxPilot on it again.
 * Runs as root in its own unit (server/tasks/database-restore.mjs starts it), because it stops the
 * web service the job came from. Every line it logs starts with [boxpilot-db-restore].
 */
import { chmod, chown, copyFile, lstat, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const restoreCopyPattern = /^boxpilot-rollback-[A-Za-z0-9._+-]{1,80}\.sqlite3$/;

/** "ok" or why SQLite will not vouch for the file. */
export function integrityOf(file) {
  let database = null;
  try {
    database = new DatabaseSync(file, { readOnly: true });
    const rows = database.prepare("PRAGMA integrity_check").all().map((row) => String(Object.values(row)[0]));
    return rows.length === 1 && rows[0] === "ok" ? "ok" : rows.slice(0, 3).join("; ");
  } catch (error) {
    return error.message;
  } finally {
    database?.close();
  }
}

const defaultFs = { chmod, chown, copyFile, lstat, open, rename, rm };

/**
 * Write `source` over `target` with `target`'s owner and mode: copied to a file beside it, synced,
 * then renamed into place, so a crash leaves the old database or the new one and never half of one.
 */
async function replaceWith(source, target, owner, { fs = defaultFs } = {}) {
  const staged = `${target}.restoring`;
  await fs.rm(staged, { force: true });
  await fs.copyFile(source, staged);
  await fs.chown(staged, owner.uid, owner.gid);
  await fs.chmod(staged, owner.mode & 0o7777);
  const handle = await fs.open(staged, "r+");
  try { await handle.sync(); } finally { await handle.close(); }
  await fs.rename(staged, target);
  for (const suffix of ["-wal", "-shm", "-journal"]) await fs.rm(`${target}${suffix}`, { force: true });
}

/** Copy the live database (with whatever its -wal holds) to `target`, readable by root alone, and check the result. */
function saveCurrent(database, target) {
  const source = new DatabaseSync(database, { readOnly: true });
  try { source.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`); } finally { source.close(); }
  const verdict = integrityOf(target);
  if (verdict !== "ok") throw new Error(`the copy of the current database failed its integrity check (${verdict})`);
}

/**
 * @param {{ database: string, copyName: string, version: string, stamp: string, run: (binary: string, args: string[]) => Promise<{ ok: boolean, stderr?: string }>, healthy: () => Promise<boolean>, log?: (line: string) => void, fs?: any }} options
 */
export async function restoreDatabaseCopy({ database, copyName, version, stamp, run, healthy, log = (line) => console.log(line), fs = defaultFs }) {
  const say = (line) => log(`[boxpilot-db-restore] ${line}`);
  const directory = path.dirname(database);
  if (!restoreCopyPattern.test(copyName)) throw new Error(`${copyName} is not a database copy`);
  const copy = path.join(directory, copyName);
  const copyInfo = await fs.lstat(copy).catch(() => null);
  if (!copyInfo?.isFile()) throw new Error(`${copy} is not there, or is not a plain file. Nothing was changed.`);
  const live = await fs.lstat(database).catch(() => null);
  if (!live?.isFile()) throw new Error(`${database} is not a plain file. Nothing was changed.`);
  const verdict = integrityOf(copy);
  if (verdict !== "ok") throw new Error(`${copyName} failed SQLite's integrity check (${verdict}). Nothing was changed.`);
  const owner = { uid: live.uid, gid: live.gid, mode: live.mode };

  say(`stopping BoxPilot to put back ${copyName}`);
  const stopped = await run("/usr/bin/systemctl", ["stop", "boxpilot.service"]);
  if (!stopped.ok) throw new Error(`BoxPilot would not stop (${stopped.stderr?.trim() || "systemctl failed"}). Nothing was changed.`);

  const saved = path.join(directory, `boxpilot-rollback-${version}-${stamp}.sqlite3`);
  try {
    saveCurrent(database, saved);
    await fs.chmod(saved, 0o600);
    say(`database copy: ${saved} (the database as it was before this)`);
  } catch (error) {
    await run("/usr/bin/systemctl", ["start", "boxpilot.service"]);
    throw new Error(`the current database could not be saved first, so it was left as it was: ${error.message}`);
  }

  await replaceWith(copy, database, owner, { fs });
  say(`${copyName} is the database now; starting BoxPilot`);
  await run("/usr/bin/systemctl", ["start", "boxpilot.service"]);
  if (await healthy()) {
    say(`BoxPilot answers on ${copyName}; the database before this is ${path.basename(saved)}`);
    return { restored: copyName, saved: path.basename(saved), rolledBack: false };
  }

  say(`ERROR: BoxPilot did not answer on ${copyName}; putting back the database it had`);
  await run("/usr/bin/systemctl", ["stop", "boxpilot.service"]);
  await replaceWith(saved, database, owner, { fs });
  await run("/usr/bin/systemctl", ["start", "boxpilot.service"]);
  const back = await healthy();
  throw Object.assign(new Error(`BoxPilot did not answer on ${copyName}, so the database it had was put back${back ? " and BoxPilot answers again" : "; BoxPilot does not answer on it either, see the service log"}`), { rolledBack: true });
}
