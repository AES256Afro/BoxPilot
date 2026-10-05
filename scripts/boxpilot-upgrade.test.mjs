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
import { onWindows } from "../test/platform.mjs";

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
    expect(script).toMatch(/copied="\$\(cd \/ && umask 077 && \$AS_OWNER "\$NODE_BIN" --no-warnings --input-type=module -e "\$DB_COPY_JS" "\$DATABASE" "\$DB_COPY" 2>&1\)"/);
  });

  it("copies the database as its own user, so root never creates its -wal or -shm files", () => {
    // Root opening the database while the service is stopped could leave those files owned by root,
    // and the service could then not open its own database.
    expect(script).toContain('DB_OWNER="$(stat -c %U "$DATABASE")"');
    expect(script).toContain('AS_OWNER="runuser -u ${DB_OWNER} --"');
  });

  it("names the copy that matches the old code when it rolls back", () => {
    const rollback = script.slice(at("rollback() {"), at("HAD_PREVIOUS=0"));
    expect(rollback).toContain('log "the database as ${OLD_VERSION} left it is ${DB_COPY}"');
  });

  it("never deletes a copy except the one it failed to finish", () => {
    const removals = script.split("\n").filter((line) => /\brm\b/.test(line) && /DB_COPY|rollback-/.test(line));
    expect(removals).toEqual(['      rm -f "$DB_COPY" "${DB_COPY}-journal" "${DB_COPY}-wal" "${DB_COPY}-shm"']);
  });

  // Two upgrades two seconds apart on the owner's server (M36).
  it("takes the upgrade lock before it downloads anything, and refuses a second run naming the first", () => {
    const locked = at('if ! flock -n 9; then');
    expect(at('exec 9>>"$UPGRADE_LOCK"')).toBeLessThan(locked);
    expect(locked).toBeLessThan(at('log "downloading ${REPO}@${REF}"'));
    expect(script).toContain('UPGRADE_LOCK="${BOXPILOT_UPGRADE_LOCK:-/run/boxpilot-upgrade.lock}"');
    expect(script).toMatch(/fail "another BoxPilot update is already running \(\$\{holder:-it holds \$\{UPGRADE_LOCK\}\}\)\. Nothing was changed/);
    // The holder is written only once the lock is held: opened for append, so a refused run never
    // wipes what the holder wrote.
    expect(at("printf 'pid=%s ref=%s started=%s by=%s\\n'")).toBeGreaterThan(locked);
    expect(script).not.toMatch(/exec 9>"\$UPGRADE_LOCK"/);
  });

  it("rolls back when the new helper does not stay up, not only when the web service fails its check", () => {
    // boxpilot-helper is Type=simple: `systemctl restart` exits 0 once it forks, and /api/v1/health
    // is answered by the web service alone, so a helper failing at start passed as a good upgrade.
    const web = at('if [ "$HEALTHY" -ne 1 ]; then');
    const helper = at('HELPER_SOCKET="${BOXPILOT_HELPER_SOCKET:-/run/boxpilot/helper.sock}"');
    // The last disarm, where the upgrade is judged good (rollback() disarms it too, first).
    const disarmed = script.lastIndexOf("\ntrap - EXIT\n");
    expect(web).toBeLessThan(helper);
    expect(helper).toBeLessThan(disarmed);
    const check = script.slice(helper, disarmed);
    expect(check).toContain('systemctl is-active --quiet boxpilot-helper.service && [ -S "$HELPER_SOCKET" ]');
    expect(check).toMatch(/if \[ "\$HAD_PREVIOUS" -eq 1 \]; then rollback; else fail "helper unhealthy"; fi/);
  });

  it("keeps saying the new version is live last, which the System page reads", () => {
    expect(script.trimEnd().split("\n").at(-1)).toMatch(/^log "BoxPilot \$\{NEW_VERSION\} \(\$\{REF\}\) is live;/);
  });

  // dash, Ubuntu's sh, runs no EXIT trap for a signal that kills it: an upgrade stopped after the
  // service was (an SSH drop during curl | sh, the update unit stopped) left both services down.
  it("rolls back on HUP, INT and TERM as well as on exit, and a second signal cannot stop the rollback", () => {
    const armed = at("trap 'rollback' EXIT");
    expect(at("trap 'exit 1' HUP INT TERM")).toBeGreaterThan(armed);
    expect(at("trap 'exit 1' HUP INT TERM")).toBeLessThan(at("systemctl stop boxpilot.service 2>/dev/null || true\n  mv \"$INSTALL_DIR\" \"$PREVIOUS\""));
    const rollback = script.slice(at("rollback() {"), at("HAD_PREVIOUS=0"));
    expect(rollback.split("\n").slice(1, 6).join("\n")).toContain("trap '' HUP INT TERM");
    // Once the upgrade is judged good, a signal is only a signal again.
    expect(script).toContain("\ntrap - EXIT\ntrap - HUP INT TERM\n");
  });

  it("health-checks the port and address the service's env file gives, not 8787", () => {
    expect(script).not.toContain("BOXPILOT_HEALTH_URL:-http://127.0.0.1:8787");
    expect(script).toContain('HEALTH_URL="${BOXPILOT_HEALTH_URL:-http://${WEB_HOST}:${WEB_PORT:-8787}/api/v1/health}"');
    expect(script).toContain('WEB_PORT="$(env_value BOXPILOT_PORT)"');
  });
});

// The scripts run for real by sh (dash on Ubuntu), with stub commands and their paths moved under a
// scratch directory: health on the env file's port, rollback on TERM and HUP, a re-run installer
// keeping the port and access, the backup mount point left alone, and the doctor's port. Needs
// POSIX sh, perl for a Unix socket, and tar: Linux CI runs it; Windows skips it.
describe("the install and upgrade scripts, run under sh with stub commands", () => {
  it.skipIf(onWindows)("pass tests/ubuntu/install-upgrade-stubbed.sh", () => {
    const result = spawnSync("bash", ["tests/ubuntu/install-upgrade-stubbed.sh"], { encoding: "utf8", env: { ...process.env, SH: "sh" }, timeout: 120_000 });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("all checks passed");
  }, 150_000);
});
