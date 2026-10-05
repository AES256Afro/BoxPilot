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

  // It said "previous tree restored" whether or not the move back worked, and never asked the
  // restarted service anything.
  it("says the old tree is back only once it is, and asks the restarted service before it says how it went", () => {
    const rollback = script.slice(at("rollback() {"), at("HAD_PREVIOUS=0"));
    expect(rollback).toContain('elif ! mv "$PREVIOUS" "$INSTALL_DIR"; then');
    const asked = rollback.indexOf('case "$(curl -fsS --max-time 2 "$HEALTH_URL" 2>/dev/null)" in');
    expect(asked).toBeGreaterThan(rollback.indexOf("systemctl restart boxpilot.service"));
    expect(asked).toBeGreaterThan(rollback.indexOf('if [ "$RESTORED" -ne 1 ]; then'));
    expect(asked).toBeLessThan(rollback.indexOf('fail "upgrade failed; previous tree restored, ${back}'));
    expect(rollback).toMatch(/while \[ -z "\$back" \] && \[ "\$attempt" -lt 10 \]; do/);
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

  // An upgrade stopped during its build, or killed outright, left /opt/boxpilot.staging.<stamp> for good.
  it("clears staging trees earlier runs left once it holds the lock, and its own when stopped while building", () => {
    const cleared = at('for leftover in "${INSTALL_DIR}".staging.*; do');
    expect(cleared).toBeGreaterThan(at("if ! flock -n 9; then"));
    expect(cleared).toBeLessThan(at('mkdir -p "$STAGING"'));
    const armed = at("trap stopped_building HUP INT TERM PIPE");
    expect(armed).toBeLessThan(at('mkdir -p "$STAGING"'));
    expect(armed).toBeLessThan(at("trap 'exit 1' HUP INT TERM PIPE\n"));
    const handler = script.slice(at("stopped_building() {"), armed);
    expect(handler.indexOf("trap '' HUP INT TERM PIPE")).toBeLessThan(handler.indexOf("cleanup_staging"));
  });

  it("rolls back when the new helper does not stay up, not only when the web service fails its check", () => {
    // boxpilot-helper is Type=simple: `systemctl restart` exits 0 once it forks, and /api/v1/health
    // is answered by the web service alone, so a helper failing at start passed as a good upgrade.
    const up = script.slice(at("helper_up() {"), at("rollback() {"));
    expect(up).toContain('systemctl is-active --quiet boxpilot-helper.service && [ -S "$HELPER_SOCKET" ]');
    const web = at('if [ "$HEALTHY" -ne 1 ]; then');
    const helper = at("if ! helper_up 90; then");
    // The last disarm, where the upgrade is judged good (rollback() disarms it too, first).
    const disarmed = script.lastIndexOf("\ntrap - EXIT\n");
    expect(web).toBeLessThan(helper);
    expect(helper).toBeLessThan(disarmed);
    expect(script.slice(helper, disarmed)).toMatch(/if \[ "\$HAD_PREVIOUS" -eq 1 \]; then rollback; else fail "helper unhealthy"; fi/);
  });

  // The web service only Wants= the helper, so it answers with the helper down: a rollback that
  // asked the web service alone said the old version was back while every host operation failed.
  it("asks the helper after a rollback too, and says when it is not up", () => {
    const rollback = script.slice(at("rollback() {"), at("HAD_PREVIOUS=0"));
    expect(rollback).toContain('helper_up 10 || helper_down="boxpilot-helper is not up with its socket at ${HELPER_SOCKET}"');
    expect(rollback.indexOf("helper_up 10")).toBeGreaterThan(rollback.indexOf('curl -fsS --max-time 2 "$HEALTH_URL"'));
  });

  it("keeps saying the new version is live last, which the System page reads", () => {
    expect(script.trimEnd().split("\n").at(-1)).toMatch(/^log "BoxPilot \$\{NEW_VERSION\} \(\$\{REF\}\) is live;/);
  });

  // dash, Ubuntu's sh, runs no EXIT trap for a signal that kills it: an upgrade stopped after the
  // service was (an SSH drop during curl | sh, the update unit stopped) left both services down.
  it("rolls back on HUP, INT, TERM and PIPE as well as on exit, and a second signal cannot stop the rollback", () => {
    const armed = at("trap 'rollback' EXIT");
    expect(at("trap 'exit 1' HUP INT TERM PIPE\n")).toBeGreaterThan(armed);
    expect(at("trap 'exit 1' HUP INT TERM PIPE\n")).toBeLessThan(at("systemctl stop boxpilot.service 2>/dev/null || true\n  mv \"$INSTALL_DIR\" \"$PREVIOUS\""));
    const rollback = script.slice(at("rollback() {"), at("HAD_PREVIOUS=0"));
    // Before its first line is written: a terminal or pipe that has gone cannot end it there.
    const firstLine = rollback.indexOf('log "rolling back to previous tree"');
    for (const shield of ["\n  set +e\n", "\n  trap '' HUP INT TERM PIPE\n"]) {
      expect(rollback.indexOf(shield), shield).toBeGreaterThan(0);
      expect(rollback.indexOf(shield), shield).toBeLessThan(firstLine);
    }
    // Once the upgrade is judged good, a signal is only a signal again.
    expect(script).toContain("\ntrap - EXIT\ntrap - HUP INT TERM PIPE\n");
  });

  // The rollback died on its own first line when nobody read the output any more (SIGPIPE, or a
  // failed printf under set -e), after `trap - EXIT`: both services stopped on the unchecked tree.
  it("writes its output best effort, so a write that fails never ends a step", () => {
    expect(script).toContain("log() { printf '[boxpilot-upgrade] %s\\n' \"$*\" 2>/dev/null || true; }");
    expect(script).toMatch(/fail\(\) \{ printf '\[boxpilot-upgrade\] ERROR: %s\\n' "\$\*" >&2 2>\/dev\/null \|\| true; exit 1; \}/);
    // Other programs' output goes through log(), not a pipeline set -e ends the upgrade on.
    expect(script).not.toMatch(/\| sed 's\/\^\/\[boxpilot-upgrade\] \/'/);
    const relay = script.slice(at("relay() {"), at("ENV_FILE=/etc/boxpilot/boxpilot.env"));
    expect(relay).toContain('do [ -z "$line" ] || log "$line"; done <<RELAY');
  });

  it("knows what to undo of the backup-destination move before it writes anything about it", () => {
    const step = script.slice(at('if moved="$("$NODE_BIN" "${INSTALL_DIR}/scripts/boxpilot-backup-mount-move.mjs" 2>&1)"; then'), at("# 7. Restart and verify"));
    expect(step.indexOf("BACKUP_MOUNT_UNDO=")).toBeGreaterThan(0);
    expect(step.indexOf("BACKUP_MOUNT_UNDO=")).toBeLessThan(step.indexOf('relay "$moved"'));
    // The undo's own output is captured too, not written to wherever stdout went.
    const rollback = script.slice(at("rollback() {"), at("HAD_PREVIOUS=0"));
    expect(rollback).toContain('if undone="$("$NODE_BIN" "${INSTALL_DIR}/scripts/boxpilot-backup-mount-move.mjs" undo "$BACKUP_MOUNT_UNDO" 2>&1)"; then');
  });

  it("health-checks the port and address the service's env file gives, not 8787", () => {
    expect(script).not.toContain("BOXPILOT_HEALTH_URL:-http://127.0.0.1:8787");
    expect(script).toContain('HEALTH_URL="${BOXPILOT_HEALTH_URL:-http://${WEB_HOST}:${WEB_PORT}/api/v1/health}"');
    // With parseInt's reading, as the service takes it: `9000   # moved off 8787` is 9000.
    expect(script).toContain('WEB_PORT="$(port_of "$(env_value BOXPILOT_PORT)")"');
  });

  // The installer and the doctor read the env file with the same parser, so the three agree with
  // each other as well as with systemd (tests/ubuntu/env-file-parity.sh).
  it("reads the env file with the same parser as the installer and the doctor", async () => {
    const body = (text, name) => new RegExp(`^${name}\\(\\) \\{\\n([\\s\\S]*?)\\n\\}$`, "m").exec(text)?.[1];
    const install = (await readFile("scripts/boxpilot-install.sh", "utf8")).replaceAll("\r\n", "\n");
    const doctor = (await readFile("scripts/boxpilot-doctor.sh", "utf8")).replaceAll("\r\n", "\n");
    expect(body(script, "env_file_value")).toContain("awk -v want=");
    expect(body(install, "env_file_value")).toBe(body(script, "env_file_value"));
    expect(body(doctor, "boxpilot_env_file_value")).toBe(body(script, "env_file_value"));
    expect(body(install, "port_of")).toBe(body(script, "port_of"));
    expect(body(doctor, "boxpilot_port_of")).toBe(body(script, "port_of"));
  });
});

// The scripts run for real by sh (dash on Ubuntu), with stub commands and their paths moved under a
// scratch directory: health on the env file's port (read as systemd reads it), rollback on TERM and
// HUP and with nobody reading the output, a re-run installer keeping the port and access, a new
// --port checked and put back, ufw, the backup mount point left alone, and the doctor's port. Also
// under bash, which the scripts are sometimes run with by hand. Needs POSIX sh, perl for a Unix
// socket, mkfifo, and tar: Linux CI runs it; Windows skips it.
describe("the install and upgrade scripts, run with stub commands", () => {
  it.skipIf(onWindows).each(["sh", "bash"])("pass tests/ubuntu/install-upgrade-stubbed.sh under %s", (shell) => {
    const result = spawnSync("bash", ["tests/ubuntu/install-upgrade-stubbed.sh"], { encoding: "utf8", env: { ...process.env, SH: shell }, timeout: 180_000 });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("all checks passed");
  }, 210_000);
});
