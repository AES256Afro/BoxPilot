/** Destructive fixture work is confined to an explicitly opted-in disposable Docker container. */
import assert from "node:assert/strict";
import { access, chmod, chown, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { releaseSavedJobLog, savedCompletedOutput } from "../server/job-log-cleanup.mjs";
import { jobLogPath } from "../server/job-log.mjs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fixedRun } from "../server/exec.mjs";
import { inspectPackageHealth, inspectPackageLocks } from "../server/package-health.mjs";
import { aptRepair } from "../server/tasks/apt.mjs";

if (process.env.BOXPILOT_DISPOSABLE_TEST !== "1" || process.platform !== "linux" || process.getuid?.() !== 0 || !await access("/.dockerenv").then(() => true, () => false)) {
  throw new Error("This test requires BOXPILOT_DISPOSABLE_TEST=1 inside a disposable root Docker container. Never run it on an installed server.");
}
const os = await readFile("/etc/os-release", "utf8");
assert.match(os, /^ID=ubuntu$/m);
const name = "boxpilot-recovery-test-fixture";
const directory = await mkdtemp(path.join(tmpdir(), "boxpilot-package-fixture-"));
const allow = path.join(directory, "allow-configuration");
const packageRoot = path.join(directory, "package");
let locker;
try {
  assert.equal((await inspectPackageHealth()).status, "healthy", "disposable image must start healthy");
  await mkdir(path.join(packageRoot, "DEBIAN"), { recursive: true });
  await writeFile(path.join(packageRoot, "DEBIAN/control"), `Package: ${name}\nVersion: 1.0\nArchitecture: all\nMaintainer: BoxPilot Test <test@example.invalid>\nDescription: Disposable interrupted-configuration fixture\n`);
  await writeFile(path.join(packageRoot, "DEBIAN/postinst"), `#!/bin/sh\ntest -f '${allow}'\n`);
  await chmod(path.join(packageRoot, "DEBIAN/postinst"), 0o755);
  const deb = path.join(directory, "fixture.deb");
  assert.equal((await fixedRun("/usr/bin/dpkg-deb", ["--build", packageRoot, deb])).ok, true);
  const install = await fixedRun("/usr/bin/dpkg", ["--install", deb]);
  assert.equal(install.ok, false, "the fixture must stop halfway through configuration");
  const broken = await inspectPackageHealth();
  assert.equal(broken.status, "needs-repair");
  assert.match(broken.audit.detail, new RegExp(name));
  await writeFile(allow, "continue\n");
  const repaired = await aptRepair();
  assert.equal(repaired.verified, true);
  assert.equal(repaired.after.status, "healthy");
  const again = await aptRepair();
  assert.equal(again.changed, false, "repeat repair must be a no-op");
  console.log("PASS: interrupted package detected, repaired, freshly verified and idempotent");

  // A real kernel-held lock must stop the recipe before dpkg or apt mutate anything.
  locker = spawn("/usr/bin/flock", ["/var/lib/dpkg/lock-frontend", "/bin/sh", "-c", "printf 'locked\\n'; read done"], { stdio: ["pipe", "pipe", "inherit"] });
  await new Promise((resolve, reject) => { locker.stdout.once("data", resolve); locker.once("error", reject); locker.once("exit", () => reject(new Error("lock fixture exited before ready"))); });
  const locks = await inspectPackageLocks();
  assert.equal(locks.available, true);
  assert(locks.holders.some((entry) => entry.file === "/var/lib/dpkg/lock-frontend"));
  assert.equal((await inspectPackageHealth()).status, "busy");
  await assert.rejects(aptRepair(), /Another package manager/);
  console.log("PASS: a kernel-held package lock prevents repair");

  // Reproduce the service's real permission split: group-readable output in a root-owned directory.
  const cache = path.join(directory, "logs");
  await chmod(directory, 0o755);
  await mkdir(cache, { mode: 0o750 }); await chown(cache, 0, 1000);
  const savedJob = "11111111-2222-4333-8444-555555555555";
  const cached = jobLogPath(savedJob, cache);
  await writeFile(cached, "saved output\n", { mode: 0o640 }); await chown(cached, 0, 1000);
  const webCheck = spawn(process.execPath, ["--input-type=module", "-e", `import {readFile,unlink} from "node:fs/promises"; const file=${JSON.stringify(cached)}; if(await readFile(file,"utf8")!=="saved output\\n") process.exit(2); try { await unlink(file); process.exit(3); } catch(e) { if(e.code!=="EACCES") process.exit(4); }`], { uid: 1000, gid: 1000, stdio: "inherit" });
  assert.equal(await new Promise((resolve, reject) => { webCheck.once("exit", resolve); webCheck.once("error", reject); }), 0);
  const stateFile = path.join(directory, "cleanup.sqlite3");
  const state = new DatabaseSync(stateFile);
  state.exec("CREATE TABLE jobs(id TEXT PRIMARY KEY,state TEXT); CREATE TABLE job_output(job_id TEXT PRIMARY KEY,output TEXT)");
  state.prepare("INSERT INTO jobs VALUES (?, 'completed')").run(savedJob);
  state.prepare("INSERT INTO job_output VALUES (?,?)").run(savedJob, "saved output\n");
  state.close();
  const released = await releaseSavedJobLog({ jobId: savedJob }, { directory: cache, lookup: (id) => savedCompletedOutput(id, stateFile) });
  assert.equal(released.removed, true);
  console.log("PASS: web can read but cannot unlink; helper releases the fully saved cache");

} finally {
  if (locker && locker.exitCode === null) { const exited = new Promise((resolve) => locker.once("exit", resolve)); locker.stdin.end("done\n"); await exited; }
  await fixedRun("/usr/bin/dpkg", ["--purge", name]);
  await rm(directory, { recursive: true, force: true });
}
assert.equal((await inspectPackageHealth()).status, "healthy", "fixture cleanup must leave package state healthy");
console.log("PASS: cleanup verified on Ubuntu 24.04");
