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
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { replaceFileWithoutFollowing } from "./durable-file.mjs";
import { compareVersions } from "./release-updates.mjs";
import { applySchema } from "./state/schema.mjs";
import { productVersion } from "./version.mjs";

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
  // A failure before the rename leaves `target` as it was; one after it does not (M73: the caller
  // words its outcome from which it was).
  const untouched = (error) => Object.assign(error, { untouched: true });
  await rm(staged, { force: true }).catch((error) => { throw untouched(error); });
  try {
    await copyInto(source, staged, owner.mode & 0o7777, owner);
  } catch (error) {
    await rm(staged, { force: true }).catch(() => {});
    throw untouched(error);
  }
  await rename(staged, target).catch((error) => { throw untouched(error); });
  for (const suffix of ["-wal", "-shm", "-journal"]) await rm(`${target}${suffix}`, { force: true });
}

/** The sha256 of a file, read through an open handle. */
async function sha256Of(handle) {
  const digest = createHash("sha256");
  const buffer = Buffer.alloc(1 << 20);
  for (let position = 0; ;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (!bytesRead) return digest.digest("hex");
    digest.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
}

/**
 * Each table in a database file (not SQLite's own) with its columns, or null when it cannot be read.
 * BoxPilot never sets PRAGMA user_version (a fresh database has 0), so what a database holds is what
 * says which release it came from.
 * @returns {Map<string, Set<string>> | null}
 */
function schemaOf(file) {
  let database = null;
  try {
    database = new DatabaseSync(file, { readOnly: true });
    const tables = new Map();
    const rows = /** @type {any[]} */ (database.prepare("SELECT m.name AS tableName, p.name AS columnName FROM sqlite_schema AS m JOIN pragma_table_info(m.name) AS p WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'").all());
    for (const row of rows) {
      if (!tables.has(row.tableName)) tables.set(row.tableName, new Set());
      tables.get(row.tableName).add(row.columnName);
    }
    return tables;
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

/** The tables and columns `copy` has that `live` does not, as "table x" / "column x.y". */
function beyond(copy, live) {
  const extra = [];
  for (const [table, columns] of copy) {
    const known = live.get(table);
    if (!known) { extra.push(`table ${table}`); continue; }
    for (const column of columns) if (!known.has(column)) extra.push(`column ${table}.${column}`);
  }
  return extra;
}

/**
 * Why a database copy is from a newer BoxPilot than this one, or null. Asked two ways (M91 review):
 * the release its record says took it (`takenBy`, controller backups record it since M91), and what
 * it holds: a table or column the live database lacks came from a release that added it. The live
 * database has every table this release makes (its start makes them), and a copy from an older
 * release can still hold a table this one has since dropped, so a copy that seems to hold more is
 * first brought to this release's schema, as BoxPilot's own start would bring it, in a scratch copy.
 */
function newerThanThis({ chosen, database, takenBy, version, work }) {
  if (typeof takenBy === "string" && /^\d+\.\d+\.\d+/.test(takenBy) && compareVersions(takenBy, version) > 0) {
    return `The backup was taken by BoxPilot ${takenBy}, newer than this ${version}, so this version cannot use it. Update BoxPilot first. Nothing was changed.`;
  }
  const live = schemaOf(database);
  const theirs = schemaOf(chosen);
  if (!live || !theirs || !beyond(theirs, live).length) return null;
  const migrated = path.join(work, "migrated.sqlite3");
  let extra;
  try {
    const source = new DatabaseSync(chosen, { readOnly: true });
    try { source.exec(`VACUUM INTO '${migrated.replaceAll("'", "''")}'`); } finally { source.close(); }
    const upgraded = new DatabaseSync(migrated);
    try { applySchema(upgraded); } finally { upgraded.close(); }
    extra = beyond(schemaOf(migrated) ?? new Map([["(unreadable)", new Set()]]), live);
  } catch (error) {
    return `This BoxPilot could not bring the backup to its own database schema (${error.message}), so it was most likely taken by a newer release. Nothing was changed.`;
  }
  if (!extra.length) return null;
  return `The backup holds ${extra.slice(0, 5).join(", ")}${extra.length > 5 ? ` and ${extra.length - 5} more` : ""}, which this BoxPilot ${version} does not have, so it was taken by a newer release. Update BoxPilot first. Nothing was changed.`;
}

/**
 * Put a verified database backup beside the database as a copy restoreDatabaseCopy can put back
 * (M91): a controller backup, or the copy a snapshot restore staged for review. Until then only the
 * copies updates take could be restored from the browser, and a rebuilt server's own database copy
 * only at the console. The backup is copied (never through a link) into a folder only root can open,
 * checked against the checksum it was written with, SQLite's integrity check, and whether it came
 * from a newer release than this one (newerThanThis: the release its record names, `takenBy`, and the
 * tables and columns it holds against the live database's), and only then written as
 * `boxpilot-rollback-<label>-<stamp>.sqlite3` beside the database, created where nothing is. Returns
 * its name; the caller starts the restore with it, and removes it if that cannot start.
 * @param {{ database: string, source: string, checksumSha256: string, label: "backup" | "snapshot", takenBy?: string | null, version?: string, now?: () => Date, workRoot?: string }} options
 */
export async function stageDatabaseBackup({ database, source, checksumSha256, label, takenBy = null, version = productVersion, now = () => new Date(), workRoot = os.tmpdir() }) {
  if (!["backup", "snapshot"].includes(label)) throw new Error("A database backup is a controller backup or a snapshot's copy");
  if (typeof checksumSha256 !== "string" || !/^[a-f0-9]{64}$/.test(checksumSha256)) throw new Error("The backup has no recorded checksum to check it against. Nothing was changed.");
  const stamp = now().toISOString().replaceAll(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const name = `boxpilot-rollback-${label}-${stamp}.sqlite3`;
  if (!restoreCopyPattern.test(name)) throw new Error("The copy's name could not be made");
  const live = await lstat(database).catch(() => null);
  if (!live?.isFile()) throw new Error(`${database} is not a plain file. Nothing was changed.`);
  const work = await mkdtemp(path.join(workRoot, "boxpilot-db-stage-"));
  try {
    const chosen = path.join(work, "chosen.sqlite3");
    try {
      await copyInto(source, chosen, 0o600);
    } catch (error) {
      throw new Error(`The backup is not there, or is not a plain file (${error.code ?? error.message}). Nothing was changed.`);
    }
    const handle = await open(chosen, readNoLink);
    let actual;
    try { actual = await sha256Of(handle); } finally { await handle.close(); }
    if (actual !== checksumSha256) throw new Error("The backup does not match the checksum recorded when it was taken, so it may be damaged. Nothing was changed.");
    const verdict = integrityOf(chosen);
    if (verdict !== "ok") throw new Error(`The backup failed SQLite's integrity check (${verdict}). Nothing was changed.`);
    const newer = newerThanThis({ chosen, database, takenBy, version, work });
    if (newer) throw new Error(newer);
    const target = path.join(path.dirname(database), name);
    try {
      await copyInto(chosen, target, 0o600);
    } catch (error) {
      // Removed only when this made it: a name already taken (a link someone left there) is not ours.
      if (error?.code !== "EEXIST") await rm(target, { force: true }).catch(() => {});
      throw new Error(`The backup could not be put beside the database (${error.code ?? error.message}). Nothing was changed.`);
    }
    return { name, path: target };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** @param {{ ok: boolean, stderr?: string }} started */
const startedAgain = (started) => (started.ok ? "BoxPilot started again" : `BoxPilot would not start again (${started.stderr?.trim() || "systemctl failed"}); see the service log`);

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
    // The model gateway is part of the web service (it stops with it, so its view of the sockets
    // is made again), and a stop then a start does not bring it back: it is started again below
    // wherever BoxPilot is, if it was running.
    const gatewayWasRunning = (await run("/usr/bin/systemctl", ["is-active", "--quiet", "boxpilot-model-gateway.service"])).ok;
    const startBoxPilot = async () => {
      const started = await run("/usr/bin/systemctl", ["start", "boxpilot.service"]);
      if (gatewayWasRunning) await run("/usr/bin/systemctl", ["start", "boxpilot-model-gateway.service"]);
      return started;
    };
    const stopped = await run("/usr/bin/systemctl", ["stop", "boxpilot.service"]);
    if (!stopped.ok) throw new Error(`BoxPilot would not stop (${stopped.stderr?.trim() || "systemctl failed"}). Nothing was changed.`);

    const savedName = `boxpilot-rollback-${version}-${stamp}.sqlite3`;
    try {
      saveCurrent(database, before);
      await copyInto(before, path.join(directory, savedName), 0o600);
      say(`database copy: ${path.join(directory, savedName)} (the database as it was before this)`);
    } catch (error) {
      const started = await startBoxPilot();
      throw new Error(`the current database could not be saved first, so it was left as it was: ${error.message}. ${startedAgain(started)}`);
    }

    // Each outcome below is worded from what happened (M73): the message said the database it had
    // was put back, and BoxPilot started, when that put-back had thrown or the start had failed.
    try {
      await replaceWith(chosen, database, owner);
    } catch (error) {
      // Out of space, most likely. Stopped before the rename, the database was never touched;
      // after it, the database before is put back.
      let outcome;
      let rolledBack = false;
      if (error.untouched) {
        say(`ERROR: could not write ${copyName} in place (${error.message}); the database was left as it was`);
        outcome = "the database was left as it was";
      } else {
        say(`ERROR: could not write ${copyName} in place (${error.message}); putting back the database it had`);
        try {
          await replaceWith(before, database, owner);
          rolledBack = true;
          outcome = "the database it had was put back";
        } catch (again) {
          say(`ERROR: could not put it back either (${again.message})`);
          outcome = `the database it had could not be put back either (${again.message}); it is saved as ${savedName}`;
        }
      }
      const started = await startBoxPilot();
      throw Object.assign(new Error(`${copyName} could not be written in place (${error.message}); ${outcome}. ${startedAgain(started)}`), { rolledBack });
    }
    say(`${copyName} is the database now; starting BoxPilot`);
    const started = await startBoxPilot();
    if (!started.ok) say(`ERROR: BoxPilot would not start on ${copyName} (${started.stderr?.trim() || "systemctl failed"})`);
    if (started.ok && await healthy()) {
      say(`RESTORED: BoxPilot answers on ${copyName}; everyone was signed out; the database before this is ${savedName}`);
      return { restored: copyName, saved: savedName, rolledBack: false };
    }

    say(`ERROR: BoxPilot did not answer on ${copyName}; putting back the database it had`);
    await run("/usr/bin/systemctl", ["stop", "boxpilot.service"]);
    let putBackError = null;
    try {
      await replaceWith(before, database, owner);
    } catch (error) {
      putBackError = error;
      say(`ERROR: could not put it back (${error.message})`);
    }
    const restarted = await startBoxPilot();
    if (putBackError) {
      throw Object.assign(new Error(`BoxPilot did not answer on ${copyName}, and the database it had could not be put back (${putBackError.message}); it is saved as ${savedName}. ${startedAgain(restarted)}`), { rolledBack: false });
    }
    const back = restarted.ok && await healthy();
    throw Object.assign(new Error(`BoxPilot did not answer on ${copyName}, so the database it had was put back${back ? " and BoxPilot answers again" : restarted.ok ? "; BoxPilot does not answer on it either, see the service log" : `; ${startedAgain(restarted)}`}`), { rolledBack: true });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
