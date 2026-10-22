/**
 * Putting a database copy back (M36): the three steps an update's rollback used to print for the
 * owner to type, as one run that checks each of them.
 *
 * The copies are the ones an update takes before it swaps the code in (scripts/boxpilot-upgrade.sh),
 * `boxpilot-rollback-<version>-<stamp>.sqlite3` beside the database. Putting one back:
 *   1. copies it into a folder only root can open, checks that copy opens and passes SQLite's
 *      integrity check before anything stops, and signs everyone out of it (a sign-in revoked since
 *      the copy was taken would otherwise work again);
 *   2. stops BoxPilot, then saves the database as it is now as a copy of its own, so this can be
 *      undone the same way;
 *   3. writes the copy over the database (the live file's owner and mode kept, through a file
 *      beside it renamed into place), and removes the -wal and -shm the old database left;
 *   4. starts BoxPilot and waits for its health check; if that fails, or the copy could not be
 *      written, puts the saved database back and starts BoxPilot on it again.
 * Runs as root in its own unit (server/tasks/database-restore.mjs starts it), because it stops the
 * web service the job came from. Every line it logs starts with [boxpilot-db-restore].
 */
import { constants } from "node:fs";
import { lstat, mkdtemp, open, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { replaceFileWithoutFollowing } from "./durable-file.mjs";

export const restoreCopyPattern = /^boxpilot-rollback-[A-Za-z0-9._+-]{1,80}\.sqlite3$/;

// How the last restore ended, for the System page: the job that started it finished before the
// restore stopped BoxPilot, and the database put back has no record of it. In the helper's own
// state folder (root), out of the web user's reach.
export const restoreResultPath = process.env.BOXPILOT_DB_RESTORE_RESULT ?? "/var/lib/boxpilot-managed/db-restore-last.json";
const outcomes = ["restored", "rolled-back", "failed"];

/** The last restore's outcome, or null when there has been none or the file cannot be read. */
export async function readRestoreResult(file = restoreResultPath) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (!outcomes.includes(value?.outcome) || typeof value.at !== "string" || !restoreCopyPattern.test(String(value.copy))) return null;
    return { at: value.at, copy: value.copy, outcome: value.outcome, message: String(value.message ?? "").slice(0, 500), saved: restoreCopyPattern.test(String(value.saved)) ? value.saved : null };
  } catch {
    return null;
  }
}

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

// The database's folder belongs to BoxPilot's own user, so anything in it may be a link that user
// planted. Root opens nothing there by name except through these: never through a link, and a new
// file only where nothing is.
const readNoLink = constants.O_RDONLY | constants.O_NOFOLLOW;
const createNew = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

/** Copy everything from one open file to another. */
async function copyHandle(from, to) {
  const buffer = Buffer.alloc(1 << 20);
  for (let position = 0; ;) {
    const { bytesRead } = await from.read(buffer, 0, buffer.length, position);
    if (!bytesRead) return;
    await to.write(buffer, 0, bytesRead);
    position += bytesRead;
  }
}

/** Copy a plain file (never a link) into a fresh file at `target`, with `mode`, synced. */
async function copyInto(source, target, mode, owner = null) {
  const from = await open(source, readNoLink);
  try {
    if (!(await from.stat()).isFile()) throw new Error(`${source} is not a plain file`);
    const to = await open(target, createNew, mode);
    try {
      await copyHandle(from, to);
      if (owner) await to.chown(owner.uid, owner.gid);
      await to.chmod(mode);
      await to.sync();
    } finally { await to.close(); }
  } finally { await from.close(); }
}

/**
 * Write `source` (a file in the private folder) over `target` with `target`'s owner and mode: copied
 * to a file beside it, synced, then renamed into place, so a crash leaves the old database or the new
 * one and never half of one.
 */
async function replaceWith(source, target, owner) {
  const staged = `${target}.restoring`;
  await rm(staged, { force: true });
  try {
    await copyInto(source, staged, owner.mode & 0o7777, owner);
  } catch (error) {
    await rm(staged, { force: true }).catch(() => {});
    throw error;
  }
  await rename(staged, target);
  for (const suffix of ["-wal", "-shm", "-journal"]) await rm(`${target}${suffix}`, { force: true });
}

/** Copy the live database (with whatever its -wal holds) to `target`, and check the result. */
function saveCurrent(database, target) {
  const source = new DatabaseSync(database, { readOnly: true });
  try { source.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`); } finally { source.close(); }
  const verdict = integrityOf(target);
  if (verdict !== "ok") throw new Error(`the copy of the current database failed its integrity check (${verdict})`);
}

/** Sign everyone out of the copy: a session revoked since it was taken would otherwise work again. */
function signEveryoneOut(file) {
  const database = new DatabaseSync(file);
  try {
    if (database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get()) database.exec("DELETE FROM sessions");
  } finally { database.close(); }
}

/**
 * Put the copy back, and write how it ended to `resultFile` when one is given.
 * @param {{ database: string, copyName: string, version: string, stamp: string, run: (binary: string, args: string[]) => Promise<{ ok: boolean, stderr?: string }>, healthy: () => Promise<boolean>, log?: (line: string) => void, workRoot?: string, resultFile?: string | null, now?: () => Date }} options
 */
export async function restoreDatabaseCopy({ resultFile = null, now = () => new Date(), ...options }) {
  const record = async (fields) => {
    if (!resultFile) return;
    const text = `${JSON.stringify({ at: now().toISOString(), copy: options.copyName, ...fields })}\n`;
    await replaceFileWithoutFollowing(resultFile, text, { mode: 0o600 }).catch((error) => options.log?.(`[boxpilot-db-restore] could not record the outcome: ${error.message}`));
  };
  try {
    const result = await putBack(options);
    await record({ outcome: "restored", saved: result.saved, message: "BoxPilot answers on the copy; everyone was signed out" });
    return result;
  } catch (error) {
    await record({ outcome: error.rolledBack ? "rolled-back" : "failed", message: error.message });
    throw error;
  }
}

/** @param {{ database: string, copyName: string, version: string, stamp: string, run: (binary: string, args: string[]) => Promise<{ ok: boolean, stderr?: string }>, healthy: () => Promise<boolean>, log?: (line: string) => void, workRoot?: string }} options */
async function putBack({ database, copyName, version, stamp, run, healthy, log = (line) => console.log(line), workRoot = os.tmpdir() }) {
  const say = (line) => log(`[boxpilot-db-restore] ${line}`);
  const directory = path.dirname(database);
  if (!restoreCopyPattern.test(copyName)) throw new Error(`${copyName} is not a database copy`);
  const copy = path.join(directory, copyName);
  const live = await lstat(database).catch(() => null);
  if (!live?.isFile()) throw new Error(`${database} is not a plain file. Nothing was changed.`);
  const owner = { uid: live.uid, gid: live.gid, mode: live.mode };

  // Everything checked or put back is first copied into a folder only root can open, so what was
  // checked is what goes in, and the rollback uses the saved database rather than a name beside it.
  const work = await mkdtemp(path.join(workRoot, "boxpilot-db-restore-"));
  try {
    const chosen = path.join(work, "chosen.sqlite3");
    const before = path.join(work, "before.sqlite3");
    try {
      await copyInto(copy, chosen, 0o600);
    } catch (error) {
      throw new Error(`${copy} is not there, or is not a plain file (${error.code ?? error.message}). Nothing was changed.`);
    }
    const verdict = integrityOf(chosen);
    if (verdict !== "ok") throw new Error(`${copyName} failed SQLite's integrity check (${verdict}). Nothing was changed.`);
    signEveryoneOut(chosen);

    say(`stopping BoxPilot to put back ${copyName}`);
    const stopped = await run("/usr/bin/systemctl", ["stop", "boxpilot.service"]);
    if (!stopped.ok) throw new Error(`BoxPilot would not stop (${stopped.stderr?.trim() || "systemctl failed"}). Nothing was changed.`);

    const savedName = `boxpilot-rollback-${version}-${stamp}.sqlite3`;
    try {
      saveCurrent(database, before);
      await copyInto(before, path.join(directory, savedName), 0o600);
      say(`database copy: ${path.join(directory, savedName)} (the database as it was before this)`);
    } catch (error) {
      await run("/usr/bin/systemctl", ["start", "boxpilot.service"]);
      throw new Error(`the current database could not be saved first, so it was left as it was: ${error.message}`);
    }

    try {
      await replaceWith(chosen, database, owner);
    } catch (error) {
      // Out of space, most likely. Whatever stage it stopped at, the database before is put back.
      say(`ERROR: could not write ${copyName} in place (${error.message}); putting back the database it had`);
      await replaceWith(before, database, owner).catch((again) => say(`ERROR: could not put it back either (${again.message})`));
      await run("/usr/bin/systemctl", ["start", "boxpilot.service"]);
      throw new Error(`${copyName} could not be written in place (${error.message}); the database it had was put back and BoxPilot started again`);
    }
    say(`${copyName} is the database now; starting BoxPilot`);
    await run("/usr/bin/systemctl", ["start", "boxpilot.service"]);
    if (await healthy()) {
      say(`RESTORED: BoxPilot answers on ${copyName}; everyone was signed out; the database before this is ${savedName}`);
      return { restored: copyName, saved: savedName, rolledBack: false };
    }

    say(`ERROR: BoxPilot did not answer on ${copyName}; putting back the database it had`);
    await run("/usr/bin/systemctl", ["stop", "boxpilot.service"]);
    try {
      await replaceWith(before, database, owner);
    } finally {
      await run("/usr/bin/systemctl", ["start", "boxpilot.service"]);
    }
    const back = await healthy();
    throw Object.assign(new Error(`BoxPilot did not answer on ${copyName}, so the database it had was put back${back ? " and BoxPilot answers again" : "; BoxPilot does not answer on it either, see the service log"}`), { rolledBack: true });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
