import { execFile as execFileCallback } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { controllerBackupHelperInternals } from "./controller-backup-helper.mjs";
import { summarizeDoctor } from "./controller-doctor.mjs";

const execFile = promisify(execFileCallback);
const databaseDefault = () => process.env.BOXPILOT_CONTROLLER_DATABASE ?? path.join(process.env.BOXPILOT_STATE_DIRECTORY ?? "/var/lib/boxpilot", "boxpilot.sqlite3");
const nextRecovery = "Preserve the database and its journals before recovery. Validate a backup and its release compatibility before replacing anything.";
const unknownReport = (detail, now) => {
  const checks = [{ id: "database-read", title: "Database inspection", status: "unknown", detail, next: nextRecovery }];
  return { checkedAt: now().toISOString(), checks, ...summarizeDoctor(checks) };
};

/** Probe core database structure without returning records, running migrations or checkpointing WAL. */
export async function readControllerDatabaseHealth({ databasePath = databaseDefault(), now = () => new Date() } = {}) {
  const checks = [];
  const add = (id, title, status, detail, next = null) => checks.push({ id, title, status, detail, next });
  const report = () => ({ checkedAt: now().toISOString(), checks, ...summarizeDoctor(checks) });
  let database;
  try {
    const parent = await lstat(path.dirname(databasePath));
    const source = await lstat(databasePath);
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o022) || !source.isFile() || source.isSymbolicLink() || source.uid !== parent.uid || (source.mode & 0o022)) {
      add("database-file", "Database file", "fail", "Unexpected file type, ownership or writable permissions", "Inspect the state directory and database metadata before opening or replacing it.");
      return report();
    }
    add("database-file", "Database file", "pass", `${source.size} bytes; regular file in a protected directory`);
    for (const [suffix, title] of [["-wal", "Write-ahead journal"], ["-shm", "SQLite coordination file"]]) {
      try {
        const info = await lstat(databasePath + suffix);
        if (!info.isFile() || info.isSymbolicLink() || info.uid !== source.uid || (info.mode & 0o022)) {
          add(`database${suffix}`, title, "fail", "Unexpected journal metadata", nextRecovery);
          return report();
        }
        add(`database${suffix}`, title, "pass", `${info.size} bytes; presence alone is normal`);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        add(`database${suffix}`, title, "pass", "Not present; SQLite may not need this file while idle");
      }
    }
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; PRAGMA cache_size = -2048; PRAGMA busy_timeout = 1000; BEGIN;");
    const quick = database.prepare("PRAGMA quick_check(1)").get()?.quick_check === "ok";
    add("database-quick-check", "SQLite quick check", quick ? "pass" : "fail", quick ? "Core database structure passed SQLite quick_check" : "SQLite found a structural problem", quick ? null : nextRecovery);
    const foreignKeys = !database.prepare("PRAGMA foreign_key_check").get();
    add("database-foreign-keys", "Related-record consistency", foreignKeys ? "pass" : "fail", foreignKeys ? "No foreign-key violation found" : "At least one foreign-key violation found", foreignKeys ? null : nextRecovery);
    const required = controllerBackupHelperInternals.requiredTables;
    const tables = new Set(database.prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN (${required.map(() => "?").join(",")})`).all(...required).map((row) => row.name));
    const complete = tables.size === required.length;
    add("database-core-tables", "Core BoxPilot tables", complete ? "pass" : "fail", `${tables.size} of ${required.length} required backup tables present`, complete ? null : "Confirm the installed release and state directory. Do not initialize a replacement database over the original.");
    const owner = tables.has("owners") && Boolean(database.prepare("SELECT 1 AS present FROM owners LIMIT 1").get());
    add("database-owner", "Owner records", owner ? "pass" : "warning", owner ? "At least one account record exists; account values are omitted" : "No account record found; a new installation may still need setup", owner ? null : "Check whether this is a new installation or the wrong state directory before attempting recovery.");
  } catch (error) {
    const corruption = ["SQLITE_CORRUPT", "SQLITE_NOTADB"].includes(error.code) || [11, 26].includes(error.errcode);
    const missing = error.code === "ENOENT";
    add("database-read", "Database inspection", corruption || missing ? "fail" : "unknown", corruption ? "SQLite could not read the database structure" : missing ? "The expected database or state directory is missing" : "The database could not be checked with this account or while it is busy", nextRecovery);
  } finally { try { database?.close(); } catch { /* retain the diagnostic result */ } }
  return report();
}

/** SQLite is synchronous. Isolate this manual scan so it cannot block the helper event loop. */
export async function inspectControllerDatabase({ databasePath = databaseDefault(), run = execFile, timeoutMs = 15_000, now = () => new Date() } = {}) {
  try {
    const source = await lstat(databasePath).catch(() => null);
    // SQLite may create coordination files even for a read-only connection. Root must not
    // leave those owned by root in the web account's state directory.
    const identity = process.getuid?.() === 0 && source?.isFile() && !source.isSymbolicLink() ? { uid: source.uid, gid: source.gid } : {};
    const { stdout } = await run(process.execPath, ["--max-old-space-size=48", fileURLToPath(import.meta.url), "--probe"], {
      encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 32 * 1024,
      ...identity,
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", BOXPILOT_CONTROLLER_DATABASE: databasePath },
    });
    const result = JSON.parse(stdout);
    if (!Array.isArray(result?.checks) || result.checks.length > 12 || !result.counts) throw new Error("Invalid probe response");
    return result;
  } catch (error) {
    const code = ["EACCES", "EPERM", "ENOENT", "ENOMEM", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"].includes(error.code) ? error.code : null;
    const signal = ["SIGKILL", "SIGABRT", "SIGSEGV"].includes(error.signal) ? error.signal : null;
    const reason = code ? `could not start or complete (${code})` : signal ? `was terminated (${signal})` : "did not return a valid result";
    return unknownReport(`The isolated database check ${reason}. Check the installed runtime and helper journal, or use the independent doctor.`, now);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 3 || process.argv[2] !== "--probe") { console.error("Use boxpilot-doctor.sh --control-plane --database for database diagnostics."); process.exitCode = 2; }
  else console.log(JSON.stringify(await readControllerDatabaseHealth()));
}
