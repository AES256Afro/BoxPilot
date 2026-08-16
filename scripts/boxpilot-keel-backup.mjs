#!/usr/local/bin/node
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { promisify } from "node:util";
import { chmod, chown, copyFile, lstat, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { validUuid } from "../server/keel-artifact-spec.mjs";
import { keelBackupIdentity, keelBackupPaths, pathsForKeelBackup } from "../server/keel-backup-spec.mjs";
import { createKeelInstallHelper } from "../server/keel-install-helper.mjs";
import { keelInstallPaths, keelServiceIdentity } from "../server/keel-install-spec.mjs";

const execFile = promisify(execFileCallback);
const fixedBinaries = Object.freeze({ getent: "/usr/bin/getent", node: "/usr/local/bin/node", systemctl: "/usr/bin/systemctl", tar: "/usr/bin/tar" });
const maximumMembers = 100000;
const maximumBytes = 20 * 1024 ** 3;
const requiredTables = ["AppSetting", "Page", "User", "Workspace"];

async function metadata(target) {
  try { return await lstat(target); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function defaultRun(binary, args, { timeout = 180000, uid, gid, cwd, env } = {}) {
  try {
    const result = await execFile(binary, args, {
      timeout,
      maxBuffer: 256 * 1024,
      encoding: "utf8",
      ...(uid === undefined ? {} : { uid }),
      ...(gid === undefined ? {} : { gid }),
      ...(cwd ? { cwd } : {}),
      env: env ?? { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
    });
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    return { ok: false, stdout: String(error.stdout ?? "").trim(), stderr: String(error.stderr ?? "").trim(), code: error.code ?? null };
  }
}

async function inspectServiceAccount(run = defaultRun) {
  const [passwdResult, groupResult] = await Promise.all([
    run(fixedBinaries.getent, ["passwd", keelServiceIdentity.account], { timeout: 5000 }),
    run(fixedBinaries.getent, ["group", keelServiceIdentity.group], { timeout: 5000 }),
  ]);
  if (!passwdResult.ok || !groupResult.ok) return null;
  const passwd = passwdResult.stdout.split(":");
  const group = groupResult.stdout.split(":");
  const uid = Number.parseInt(passwd[2], 10);
  const gid = Number.parseInt(group[2], 10);
  if (passwd.length !== 7 || group.length !== 4 || passwd[0] !== keelServiceIdentity.account || group[0] !== keelServiceIdentity.group
    || !Number.isInteger(uid) || !Number.isInteger(gid) || Number.parseInt(passwd[3], 10) !== gid
    || passwd[5] !== keelInstallPaths.state || !["/usr/sbin/nologin", "/sbin/nologin"].includes(passwd[6])) return null;
  return { uid, gid };
}

async function sha256(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

function parseApproval(raw, now) {
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("The Keel backup approval marker is invalid"); }
  const expectedKeys = ["approvedAt", "backupId", "installId", "releaseCommitSha", "releaseTag", "releaseVersion", "unitName"];
  const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : [];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) throw new Error("The Keel backup approval marker has unexpected fields");
  if (!validUuid(value.backupId) || !validUuid(value.installId) || typeof value.approvedAt !== "string") throw new Error("The Keel backup approval identity is invalid");
  if (value.releaseTag !== keelBackupIdentity.releaseTag || value.releaseCommitSha !== keelBackupIdentity.releaseCommitSha
    || value.releaseVersion !== keelBackupIdentity.releaseVersion || value.unitName !== keelBackupIdentity.unitName) throw new Error("The approved Keel backup identity changed");
  const approvedTime = Date.parse(value.approvedAt);
  const age = now.getTime() - approvedTime;
  if (!Number.isFinite(approvedTime) || age < -30000 || age > 5 * 60 * 1000) throw new Error("The Keel backup approval marker is stale");
  return value;
}

async function hardenTree(root, uid = 0, gid = 0) {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    const value = await lstat(current);
    if (value.isSymbolicLink()) throw new Error("The Keel export contains a symbolic link");
    if (value.isDirectory()) {
      await chown(current, uid, gid);
      await chmod(current, 0o700);
      for (const name of await readdir(current)) stack.push(path.join(current, name));
    } else {
      if (!value.isFile() || value.nlink !== 1) throw new Error("The Keel export contains a non-regular or multiply linked file");
      await chown(current, uid, gid);
      await chmod(current, 0o600);
    }
  }
}

async function inspectTree(root, { excludeManifest = false } = {}) {
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error("The Keel export root is unsafe");
  const stack = [root];
  const files = [];
  let directories = 0;
  let bytes = 0;
  while (stack.length) {
    const current = stack.pop();
    const value = await lstat(current);
    if (value.isSymbolicLink()) throw new Error("The Keel export contains a symbolic link");
    if (value.isDirectory()) {
      directories += 1;
      const names = (await readdir(current)).sort().reverse();
      for (const name of names) stack.push(path.join(current, name));
      continue;
    }
    if (!value.isFile() || value.nlink !== 1) throw new Error("The Keel export contains a non-regular or multiply linked file");
    const relative = path.relative(root, current);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || relative.includes("\\")) throw new Error("The Keel export path is unsafe");
    if (excludeManifest && relative === "manifest.json") continue;
    bytes += value.size;
    files.push({ relative, size: value.size, sha256: await sha256(current) });
    if (files.length + directories > maximumMembers || bytes > maximumBytes) throw new Error("The Keel export exceeded the fixed safety limits");
  }
  const digest = createHash("sha256");
  for (const file of files.sort((left, right) => left.relative.localeCompare(right.relative))) digest.update(`${file.relative}\0${file.size}\0${file.sha256}\n`);
  return { regularFiles: files.length, directories, bytes, digest: digest.digest("hex") };
}

function inspectDatabase(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrityRows = database.prepare("PRAGMA integrity_check").all();
    const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
    const schemaVerified = requiredTables.every((name) => tables.includes(name));
    if (integrityRows.length !== 1 || integrityRows[0].integrity_check !== "ok" || foreignKeys.length !== 0 || !schemaVerified) throw new Error("The exported Keel SQLite database failed integrity or schema verification");
    return { integrityCheck: "ok", foreignKeyIssues: 0, schemaVerified: true };
  } finally {
    database.close();
  }
}

function validateExportLayout(exportRoot) {
  return readdir(exportRoot).then((names) => {
    const allowed = new Set(["keel.db", "keel.db-wal", "keel.db-shm", "keel.db.keel-server-secrets.key", "keel.env", "manifest.json", "keel.db.uploads"]);
    if (!names.includes("keel.db") || !names.includes("keel.env") || names.some((name) => !allowed.has(name))) throw new Error("The Keel export has unexpected top-level entries");
    return names;
  });
}

function validManagedKey(value) {
  const text = String(value ?? "").trim();
  return /^[a-fA-F0-9]{64}$/.test(text) || /^[A-Za-z0-9_-]{43}$/.test(text) || /^[A-Za-z0-9+/]{43}=$/.test(text);
}

async function waitForHealth(requestHealth) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await requestHealth()) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

async function defaultHealthRequest() {
  try {
    const response = await fetch("http://127.0.0.1:3000/api/health", { signal: AbortSignal.timeout(2500) });
    if (!response.ok) return false;
    const value = await response.json();
    return value?.app === "keel" && value?.ok === true;
  } catch { return false; }
}

async function requireAbsent(target, label) {
  if (await metadata(target)) throw new Error(`${label} already exists and will not be overwritten`);
}

export async function backupApprovedKeel({
  paths = keelBackupPaths,
  installPaths = keelInstallPaths,
  loadApproval = () => readFile(paths.approval, "utf8"),
  now = () => new Date(),
  clock = () => Date.now(),
  run = defaultRun,
  requestHealth = defaultHealthRequest,
  installHelper = createKeelInstallHelper({ inspectHealth: defaultHealthRequest }),
  account = null,
  rootUid = 0,
  rootGid = 0,
} = {}) {
  const approval = parseApproval(await loadApproval(), now());
  const targets = pathsForKeelBackup(approval.backupId, paths);
  const before = await installHelper.inspect();
  if (before.state !== "installed" || before.installed !== true || before.healthy !== true || before.installId !== approval.installId || before.releaseVersion !== keelServiceIdentity.releaseVersion) throw new Error("The exact healthy Keel installation changed before backup");
  const serviceAccount = account ?? await inspectServiceAccount(run);
  if (!serviceAccount || !Number.isInteger(serviceAccount.uid) || !Number.isInteger(serviceAccount.gid)) throw new Error("The dedicated Keel service identity is unavailable");
  await mkdir(targets.root, { recursive: true, mode: 0o700 });
  await mkdir(targets.restoreRoot, { recursive: true, mode: 0o700 });
  await chmod(targets.root, 0o700);
  await chmod(targets.restoreRoot, 0o700);
  for (const [target, label] of [[targets.partial, "Keel backup partial"], [targets.archive, "Keel backup artifact"], [targets.archivePartial, "Keel archive partial"], [targets.result, "Keel backup result"], [targets.drill, "Keel restore drill"]]) await requireAbsent(target, label);

  let sourceStopped = false;
  let sourceRestartVerified = false;
  let completed = false;
  let downtimeMs = 0;
  let stoppedAt = 0;
  try {
    await mkdir(targets.exportRoot, { recursive: true, mode: 0o700 });
    await chown(targets.partial, serviceAccount.uid, serviceAccount.gid);
    await chown(targets.exportRoot, serviceAccount.uid, serviceAccount.gid);
    stoppedAt = clock();
    const stop = await run(fixedBinaries.systemctl, ["stop", keelServiceIdentity.unitName], { timeout: 60000 });
    if (!stop.ok) throw new Error("The fixed Keel service could not be stopped cleanly for export");
    sourceStopped = true;
    const inactive = await run(fixedBinaries.systemctl, ["is-active", "--quiet", keelServiceIdentity.unitName]);
    if (inactive.ok) throw new Error("The fixed Keel service remained active after the stop request");

    const exportDatabase = path.join(targets.exportRoot, "keel.db");
    const exported = await run(fixedBinaries.node, [path.join(installPaths.release, "bin", "keel.mjs"), "export", exportDatabase], {
      timeout: 10 * 60 * 1000,
      uid: serviceAccount.uid,
      gid: serviceAccount.gid,
      cwd: installPaths.release,
      env: {
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        LANG: "C.UTF-8", LC_ALL: "C.UTF-8", KEEL_HOME: installPaths.state,
        DATABASE_URL: `file:${installPaths.database}`, KEEL_ENV_FILE: installPaths.environment,
      },
    });
    if (!exported.ok) throw new Error("The fixed upstream Keel export did not complete");
    if (exported.stdout.includes("INCOMPLETE") || exported.stderr.includes("INCOMPLETE")) throw new Error("The fixed upstream Keel export reported incomplete upload coverage");
    await copyFile(installPaths.environment, path.join(targets.exportRoot, "keel.env"));
    await hardenTree(targets.partial, rootUid, rootGid);
    const names = await validateExportLayout(targets.exportRoot);
    const databaseEvidence = inspectDatabase(exportDatabase);
    const managedKeyPresent = names.includes("keel.db.keel-server-secrets.key");
    if (managedKeyPresent && !validManagedKey(await readFile(path.join(targets.exportRoot, "keel.db.keel-server-secrets.key"), "utf8"))) throw new Error("The exported managed-secret companion is invalid");
    const sourceTree = await inspectTree(targets.exportRoot, { excludeManifest: true });
    const exportedAt = now().toISOString();
    const manifest = {
      schemaVersion: 1,
      backupId: approval.backupId,
      installId: approval.installId,
      exportedAt,
      releaseTag: keelBackupIdentity.releaseTag,
      releaseCommitSha: keelBackupIdentity.releaseCommitSha,
      releaseVersion: keelBackupIdentity.releaseVersion,
      treeDigestSha256: sourceTree.digest,
      regularFiles: sourceTree.regularFiles,
      directories: sourceTree.directories,
      logicalBytes: sourceTree.bytes,
      databaseIntegrity: databaseEvidence,
      managedSecretCompanionIncluded: managedKeyPresent,
      environmentIncluded: true,
      uploadsIncluded: names.includes("keel.db.uploads"),
    };
    const manifestPath = path.join(targets.exportRoot, "manifest.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmod(manifestPath, 0o600);
    const manifestChecksumSha256 = await sha256(manifestPath);
    const archived = await run(fixedBinaries.tar, ["--create", "--gzip", "--file", targets.archivePartial, "--directory", targets.partial, "keel-export"], { timeout: 10 * 60 * 1000 });
    if (!archived.ok) throw new Error("The fixed Keel export archive could not be created");
    await chmod(targets.archivePartial, 0o600);
    await chown(targets.archivePartial, rootUid, rootGid);
    await rename(targets.archivePartial, targets.archive);

    const start = await run(fixedBinaries.systemctl, ["start", keelServiceIdentity.unitName], { timeout: 120000 });
    if (!start.ok || !await waitForHealth(requestHealth)) throw new Error("Keel backup completed its export but source restart health verification failed");
    sourceStopped = false;
    sourceRestartVerified = true;
    downtimeMs = clock() - stoppedAt;

    await mkdir(targets.drill, { mode: 0o700 });
    const extracted = await run(fixedBinaries.tar, ["--extract", "--gzip", "--file", targets.archive, "--directory", targets.drill, "--no-same-owner", "--no-same-permissions"], { timeout: 10 * 60 * 1000 });
    if (!extracted.ok) throw new Error("The Keel backup artifact could not be extracted for its isolated drill");
    await validateExportLayout(targets.drillExport);
    const restoredManifestPath = path.join(targets.drillExport, "manifest.json");
    const restoredManifestChecksum = await sha256(restoredManifestPath);
    const restoredManifest = JSON.parse(await readFile(restoredManifestPath, "utf8"));
    const restoredTree = await inspectTree(targets.drillExport, { excludeManifest: true });
    const restoredDatabase = inspectDatabase(path.join(targets.drillExport, "keel.db"));
    if (restoredManifestChecksum !== manifestChecksumSha256 || restoredManifest.backupId !== approval.backupId
      || restoredManifest.treeDigestSha256 !== restoredTree.digest || restoredTree.digest !== sourceTree.digest
      || restoredTree.regularFiles !== sourceTree.regularFiles || restoredTree.directories !== sourceTree.directories || restoredTree.bytes !== sourceTree.bytes
      || restoredDatabase.integrityCheck !== "ok" || restoredDatabase.foreignKeyIssues !== 0 || restoredDatabase.schemaVerified !== true) throw new Error("The isolated Keel restore drill did not match the exported source evidence");
    await rm(targets.drill, { recursive: true, force: false });
    const archiveChecksumSha256 = await sha256(targets.archive);
    const archiveMetadata = await stat(targets.archive);
    const result = {
      schemaVersion: 1,
      backupId: approval.backupId,
      installId: approval.installId,
      applicationId: keelBackupIdentity.applicationId,
      destination: keelBackupIdentity.destination,
      artifactPath: targets.archive,
      checksumSha256: archiveChecksumSha256,
      manifestChecksumSha256,
      sizeBytes: archiveMetadata.size,
      downtimeMs,
      releaseVersion: keelBackupIdentity.releaseVersion,
      sourceRestartVerified: true,
      restoreDrill: {
        passed: true, mode: "isolated-keel-export-open", network: "none", publishedPorts: 0,
        databaseIntegrity: "ok", foreignKeyIssues: 0, schemaVerified: true,
        managedSecretCompanionIncluded: managedKeyPresent, environmentIncluded: true,
        uploadsIncluded: names.includes("keel.db.uploads"), treeDigestMatched: true,
        manifestChecksumSha256, workspaceRemoved: true, applicationStarted: false, productionStateReplaced: false,
      },
      boundary: {
        browserPathAccepted: false, browserCommandAccepted: false, browserTokenAccepted: false,
        databaseOpened: true, secretContentReturned: false, environmentContentReturned: false,
        sourceServiceStopped: true, sourceRestarted: true, networkAccessRequiredForDrill: false,
        productionStateReplaced: false, registrationChanged: false, claimChanged: false,
        tailscaleChanged: false, firewallChanged: false, routerChanged: false,
        independentCopyCreated: false, retentionPerformed: false, prunePerformed: false,
      },
    };
    const handle = await open(targets.result, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(result, null, 2)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
    await chown(targets.result, rootUid, rootGid);
    completed = true;
    return result;
  } finally {
    if (sourceStopped || !sourceRestartVerified) {
      const restart = await run(fixedBinaries.systemctl, ["start", keelServiceIdentity.unitName], { timeout: 120000 });
      if (!restart.ok || !await waitForHealth(requestHealth)) throw new Error("Keel backup did not restore source service health; follow the recovery instructions immediately");
      sourceStopped = false;
      sourceRestartVerified = true;
      if (stoppedAt > 0) downtimeMs = clock() - stoppedAt;
    }
    await rm(targets.partial, { recursive: true, force: true });
    await rm(targets.drill, { recursive: true, force: true });
    await unlink(targets.archivePartial).catch((error) => { if (error.code !== "ENOENT") throw error; });
    if (!completed) {
      await unlink(targets.archive).catch((error) => { if (error.code !== "ENOENT") throw error; });
      await unlink(targets.result).catch((error) => { if (error.code !== "ENOENT") throw error; });
    }
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  if (process.argv.length !== 2) {
    console.error("The fixed Keel backup accepts no arguments");
    process.exitCode = 64;
  } else {
    try {
      const result = await backupApprovedKeel();
      console.log(`Created and restore-verified fixed Keel backup ${result.backupId}`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}

export const keelBackupScriptInternals = { hardenTree, inspectDatabase, inspectServiceAccount, inspectTree, parseApproval, validateExportLayout, validManagedKey, waitForHealth };
