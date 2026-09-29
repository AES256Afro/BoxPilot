/**
 * The upgrade script's database copy (M36). The whole script needs root and systemd, so the install
 * smoke test runs it for real (tests/ubuntu/upgrade-db-copy.sh). Here: the Node the script runs to
 * make the copy, against real SQLite files, and the order the script does things in.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

const script = (await readFile("scripts/boxpilot-upgrade.sh", "utf8")).replaceAll("\r\n", "\n");
const copyProgram = /\nDB_COPY_JS='\n([\s\S]*?)\n'\n/.exec(script)?.[1];

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function liveDatabase() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-upgrade-copy-"));
  directories.push(directory);
  const file = path.join(directory, "boxpilot.sqlite3");
  // As the service leaves it: WAL mode, with rows still in the WAL and a writer holding it open.
  const writer = new DatabaseSync(file);
  writer.exec("PRAGMA journal_mode = WAL; CREATE TABLE owners (id TEXT PRIMARY KEY, username TEXT); INSERT INTO owners VALUES ('o1', 'alex');");
  writer.exec("CREATE TABLE jobs (id TEXT); INSERT INTO jobs VALUES ('j1'), ('j2');");
  return { directory, file, writer };
}

/** Run the script's copy program as the script does: `node --no-warnings --input-type=module -e`. */
function copy(source, target) {
  const result = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", copyProgram, source, target], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

describe("the database copy the upgrade takes", () => {
  it("is in the script as one program the script runs", () => {
    expect(copyProgram).toBeTruthy();
    // No single quote inside: it sits in a single-quoted shell string.
    expect(copyProgram).not.toContain("'");
  });

  it("copies a live WAL database whole, checks it, and prints its size", async () => {
    const { directory, file, writer } = await liveDatabase();
    const target = path.join(directory, "boxpilot-rollback-1.138.0-20260929T101500Z.sqlite3");
    const result = copy(file, target);
    writer.close();
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(Number(result.stdout)).toBe((await stat(target)).size);
    const copied = new DatabaseSync(target, { readOnly: true });
    expect(copied.prepare("SELECT username FROM owners").get().username).toBe("alex");
    expect(copied.prepare("SELECT COUNT(*) AS n FROM jobs").get().n).toBe(2);
    expect(Object.values(copied.prepare("PRAGMA integrity_check").get())[0]).toBe("ok");
    copied.close();
  });

  it("fails with one line saying why, and no size, when the copy cannot be written", async () => {
    const { directory, file, writer } = await liveDatabase();
    const result = copy(file, path.join(directory, "no-such-folder", "copy.sqlite3"));
    writer.close();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.split("\n")).toHaveLength(1);
    expect(result.stderr).toMatch(/unable to open|no such file/i);
  });

  it("fails when there is nothing to copy from, rather than making an empty database", async () => {
    const { directory, writer } = await liveDatabase();
    writer.close();
    const target = path.join(directory, "copy.sqlite3");
    const result = copy(path.join(directory, "missing.sqlite3"), target);
    expect(result.status).not.toBe(0);
    await expect(stat(target)).rejects.toThrow();
  });
});

describe("where the copy sits in the upgrade", () => {
  const at = (text) => {
    const index = script.indexOf(text);
    expect(index, text).toBeGreaterThan(0);
    return index;
  };

  it("is taken after the build and before anything is stopped or moved", () => {
    const copied = at('DB_COPY="${DB_COPY_DIR}/boxpilot-rollback-${OLD_VERSION}-${STAMP}.sqlite3"');
    expect(copied).toBeGreaterThan(at("npm run build --silent"));
    expect(copied).toBeLessThan(at("trap 'rollback' EXIT"));
    expect(copied).toBeLessThan(at("systemctl stop boxpilot.service 2>/dev/null || true\n  mv \"$INSTALL_DIR\" \"$PREVIOUS\""));
  });

  it("refuses the upgrade when the copy fails, removing the partial copy and the staging tree", () => {
    const failure = script.slice(at('if [ "$COPY_OK" -ne 1 ]; then'), at('log "database copy: ${DB_COPY}'));
    expect(failure).toContain('rm -f "$DB_COPY"');
    expect(failure).toContain("cleanup_staging");
    expect(failure).toMatch(/fail "could not copy the database to \$\{DB_COPY_DIR\}: \$\{reason:-no reason given\}\. Nothing was changed/);
  });

  it("gives the copy the live database's owner and mode, and makes it private from the start", () => {
    expect(script).toContain('chown --reference="$DATABASE" "$DB_COPY"');
    expect(script).toContain('chmod --reference="$DATABASE" "$DB_COPY"');
    expect(script).toMatch(/copied="\$\(umask 077 && "\$NODE_BIN" --no-warnings --input-type=module -e "\$DB_COPY_JS" "\$DATABASE" "\$DB_COPY" 2>&1\)"/);
  });

  it("names the copy that matches the old code when it rolls back", () => {
    const rollback = script.slice(at("rollback() {"), at("HAD_PREVIOUS=0"));
    expect(rollback).toContain('log "the database as ${OLD_VERSION} left it is ${DB_COPY}"');
  });

  it("never deletes a copy except the one it failed to finish", () => {
    const removals = script.split("\n").filter((line) => /\brm\b/.test(line) && /DB_COPY|rollback-/.test(line));
    expect(removals).toEqual(['      rm -f "$DB_COPY" "${DB_COPY}-journal" "${DB_COPY}-wal" "${DB_COPY}-shm"']);
  });

  it("keeps saying the new version is live last, which the System page reads", () => {
    expect(script.trimEnd().split("\n").at(-1)).toMatch(/^log "BoxPilot \$\{NEW_VERSION\} \(\$\{REF\}\) is live;/);
  });
});
