#!/usr/local/bin/node
import { execFile as execFileCallback } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { chmod, chown, lstat, mkdir, open, readFile, readdir, readlink, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { keelArtifactSpec, validUuid } from "../server/keel-artifact-spec.mjs";
import { createKeelStageHelper } from "../server/keel-stage-helper.mjs";
import {
  keelEnvironmentContent,
  keelEnvironmentSha256,
  keelInstallPaths,
  keelServiceIdentity,
  keelServiceUnitContent,
  keelServiceUnitSha256,
} from "../server/keel-install-spec.mjs";

const execFile = promisify(execFileCallback);
const fixedBinaries = Object.freeze({
  getent: "/usr/bin/getent",
  groupadd: "/usr/sbin/groupadd",
  useradd: "/usr/sbin/useradd",
  systemctl: "/usr/bin/systemctl",
});

async function defaultRun(binary, args, { timeout = 30000 } = {}) {
  try {
    const result = await execFile(binary, args, {
      timeout,
      maxBuffer: 256 * 1024,
      encoding: "utf8",
      env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
    });
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    return { ok: false, stdout: String(error.stdout ?? "").trim(), stderr: String(error.stderr ?? "").trim(), code: error.code ?? null };
  }
}

async function metadata(target) {
  try { return await lstat(target); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function parseApproval(raw, now, paths = keelInstallPaths) {
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("The Keel installation approval marker is invalid"); }
  const expectedKeys = ["approvedAt", "bindAddress", "currentPath", "environmentSha256", "installId", "port", "releaseCommitSha", "releasePath", "releaseTag", "releaseVersion", "statePath", "unitName", "unitSha256"];
  const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : [];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) throw new Error("The Keel installation approval marker has unexpected fields");
  if (!validUuid(value.installId) || typeof value.approvedAt !== "string") throw new Error("The Keel installation approval identity is invalid");
  if (value.releaseTag !== keelArtifactSpec.releaseTag
    || value.releaseCommitSha !== keelArtifactSpec.releaseCommitSha
    || value.releaseVersion !== keelServiceIdentity.releaseVersion
    || value.releasePath !== paths.release
    || value.statePath !== paths.state
    || value.currentPath !== paths.current
    || value.unitName !== keelServiceIdentity.unitName
    || value.unitSha256 !== keelServiceUnitSha256
    || value.environmentSha256 !== keelEnvironmentSha256
    || value.bindAddress !== keelServiceIdentity.bindAddress
    || value.port !== keelServiceIdentity.port) throw new Error("The approved Keel installation identity does not match the fixed contract");
  const approvedTime = Date.parse(value.approvedAt);
  const age = now.getTime() - approvedTime;
  if (!Number.isFinite(approvedTime) || age < -30000 || age > 5 * 60 * 1000) throw new Error("The Keel installation approval marker is stale");
  return value;
}

function parsePasswd(value) {
  const fields = String(value ?? "").trim().split(":");
  if (fields.length !== 7 || fields[0] !== keelServiceIdentity.account) return null;
  const uid = Number.parseInt(fields[2], 10);
  const gid = Number.parseInt(fields[3], 10);
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) return null;
  return { uid, gid, home: fields[5], shell: fields[6] };
}

function parseGroup(value) {
  const fields = String(value ?? "").trim().split(":");
  if (fields.length !== 4 || fields[0] !== keelServiceIdentity.group) return null;
  const gid = Number.parseInt(fields[2], 10);
  return Number.isInteger(gid) ? { gid } : null;
}

async function ensureDedicatedAccount(run = defaultRun) {
  let [passwdResult, groupResult] = await Promise.all([
    run(fixedBinaries.getent, ["passwd", keelServiceIdentity.account]),
    run(fixedBinaries.getent, ["group", keelServiceIdentity.group]),
  ]);
  if (passwdResult.ok !== groupResult.ok) throw new Error("A conflicting Keel user or group already exists");
  if (!passwdResult.ok) {
    const groupCreated = await run(fixedBinaries.groupadd, ["--system", keelServiceIdentity.group]);
    if (!groupCreated.ok) throw new Error("The dedicated Keel system group could not be created");
    const userCreated = await run(fixedBinaries.useradd, [
      "--system", "--gid", keelServiceIdentity.group, "--home-dir", keelInstallPaths.state,
      "--no-create-home", "--shell", "/usr/sbin/nologin", keelServiceIdentity.account,
    ]);
    if (!userCreated.ok) throw new Error("The dedicated Keel system account could not be created");
    [passwdResult, groupResult] = await Promise.all([
      run(fixedBinaries.getent, ["passwd", keelServiceIdentity.account]),
      run(fixedBinaries.getent, ["group", keelServiceIdentity.group]),
    ]);
  }
  const passwd = passwdResult.ok ? parsePasswd(passwdResult.stdout) : null;
  const group = groupResult.ok ? parseGroup(groupResult.stdout) : null;
  if (!passwd || !group || passwd.gid !== group.gid || passwd.home !== keelInstallPaths.state || !["/usr/sbin/nologin", "/sbin/nologin"].includes(passwd.shell)) {
    throw new Error("The dedicated Keel account does not match the fixed non-login identity");
  }
  return { uid: passwd.uid, gid: group.gid };
}

async function writeAtomicRegularFile(target, content, { mode, uid, gid, token }) {
  const partial = path.join(path.dirname(target), `.${path.basename(target)}-${token}.partial`);
  if (await metadata(partial)) throw new Error("A fixed Keel installation partial already exists");
  await writeFile(partial, content, { encoding: "utf8", flag: "wx", mode });
  await chmod(partial, mode);
  await chown(partial, uid, gid);
  const handle = await open(partial, "r");
  try { await handle.sync(); } finally { await handle.close(); }
  await rename(partial, target);
}

async function shareReleaseTree(root, uid, gid) {
  const stack = [root];
  let regularFiles = 0;
  let directories = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    const value = await lstat(current);
    if (value.isSymbolicLink()) throw new Error("The staged Keel release contains a symbolic link");
    if (value.isDirectory()) {
      await chown(current, uid, gid);
      await chmod(current, 0o750);
      directories += 1;
      for (const name of await readdir(current)) stack.push(path.join(current, name));
      continue;
    }
    if (!value.isFile() || value.nlink !== 1) throw new Error("The staged Keel release contains a non-regular or multiply linked file");
    await chown(current, uid, gid);
    await chmod(current, (value.mode & 0o111) !== 0 ? 0o750 : 0o640);
    regularFiles += 1;
  }
  return { regularFiles, directories };
}

async function defaultHealthRequest() {
  return new Promise((resolve) => {
    const request = http.get({ hostname: keelServiceIdentity.bindAddress, port: keelServiceIdentity.port, path: "/api/health", timeout: 2500 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 8192) request.destroy(new Error("Keel health response exceeded the fixed limit"));
      });
      response.on("end", () => {
        try {
          const value = JSON.parse(body);
          resolve(response.statusCode === 200 && value?.app === "keel" && value?.ok === true);
        } catch { resolve(false); }
      });
    });
    request.once("timeout", () => request.destroy());
    request.once("error", () => resolve(false));
  });
}

async function waitForHealth(requestHealth = defaultHealthRequest) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await requestHealth()) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

async function requireAbsent(target, label) {
  if (await metadata(target)) throw new Error(`${label} already exists and will not be overwritten`);
}

async function exactSymlink(target, expected) {
  const value = await metadata(target);
  if (!value?.isSymbolicLink()) return false;
  return path.resolve(path.dirname(target), await readlink(target)) === expected;
}

export async function installApprovedKeel({
  paths = keelInstallPaths,
  loadApproval = () => readFile(paths.approval, "utf8"),
  now = () => new Date(),
  run = defaultRun,
  requestHealth = defaultHealthRequest,
  stageHelper = createKeelStageHelper(),
  ensureAccount = () => ensureDedicatedAccount(run),
  expectedReleaseCounts = {
    regularFiles: keelArtifactSpec.archiveRegularFilesObservedDuringAdapterReview + 1,
    directories: keelArtifactSpec.archiveDirectoriesObservedDuringAdapterReview,
  },
  rootUid = 0,
  rootGid = 0,
} = {}) {
  const approval = parseApproval(await loadApproval(), now(), paths);
  const staged = await stageHelper.inspect();
  if (staged.state !== "staged" || staged.staged !== true || staged.version !== keelServiceIdentity.releaseVersion) throw new Error("The exact Keel release is no longer safely staged");
  for (const [target, label] of [[paths.current, "Keel activation link"], [paths.unit, "Keel systemd unit"], [paths.evidence, "Keel installation evidence"], [paths.environment, "Keel environment file"]]) await requireAbsent(target, label);

  const release = await lstat(paths.release);
  if (!release.isDirectory() || release.isSymbolicLink()) throw new Error("The fixed staged Keel release is not a real directory");
  const account = await ensureAccount();
  await mkdir(paths.state, { recursive: false, mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
  const state = await lstat(paths.state);
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error("The fixed Keel state path is not a real directory");
  await chown(paths.state, account.uid, account.gid);
  await chmod(paths.state, 0o700);
  for (const directory of [paths.uploads, paths.backups]) {
    await mkdir(directory, { mode: 0o700 });
    await chown(directory, account.uid, account.gid);
    await chmod(directory, 0o700);
  }

  let unitPublished = false;
  let activationPublished = false;
  let environmentPublished = false;
  let serviceEnabled = false;
  let serviceStarted = false;
  try {
    const releaseCounts = await shareReleaseTree(paths.release, rootUid, account.gid);
    if (releaseCounts.regularFiles !== expectedReleaseCounts.regularFiles
      || releaseCounts.directories !== expectedReleaseCounts.directories) throw new Error("The staged Keel release membership changed before activation");
    for (const directory of [paths.root, path.dirname(paths.release)]) {
      await chown(directory, rootUid, account.gid);
      await chmod(directory, 0o750);
    }
    await writeAtomicRegularFile(paths.environment, keelEnvironmentContent(), { mode: 0o640, uid: rootUid, gid: account.gid, token: approval.installId });
    environmentPublished = true;
    const activationPartial = path.join(path.dirname(paths.current), `.current-${approval.installId}.partial`);
    await symlink(path.relative(path.dirname(paths.current), paths.release), activationPartial);
    await rename(activationPartial, paths.current);
    activationPublished = true;
    if (!await exactSymlink(paths.current, paths.release)) throw new Error("The Keel activation link does not resolve to the fixed release");
    await writeAtomicRegularFile(paths.unit, keelServiceUnitContent(), { mode: 0o644, uid: rootUid, gid: rootGid, token: approval.installId });
    unitPublished = true;
    const daemonReload = await run(fixedBinaries.systemctl, ["daemon-reload"]);
    if (!daemonReload.ok) throw new Error("systemd could not load the fixed Keel unit");
    const enable = await run(fixedBinaries.systemctl, ["enable", keelServiceIdentity.unitName]);
    if (!enable.ok) throw new Error("The fixed Keel service could not be enabled");
    serviceEnabled = true;
    const start = await run(fixedBinaries.systemctl, ["start", keelServiceIdentity.unitName], { timeout: 2 * 60 * 1000 });
    if (!start.ok) throw new Error("The fixed Keel service could not be started");
    serviceStarted = true;
    if (!await waitForHealth(requestHealth)) throw new Error("Keel did not return the exact loopback health identity before the timeout");
    const database = await lstat(paths.database);
    if (!database.isFile() || database.isSymbolicLink() || database.uid !== account.uid || (database.mode & 0o077) !== 0) throw new Error("Keel did not create its private SQLite database safely");
    const installedAt = now().toISOString();
    await writeAtomicRegularFile(paths.evidence, `${JSON.stringify({
      schemaVersion: 1,
      installId: approval.installId,
      installedAt,
      releaseTag: keelArtifactSpec.releaseTag,
      releaseCommitSha: keelArtifactSpec.releaseCommitSha,
      releaseVersion: keelServiceIdentity.releaseVersion,
      releasePath: paths.release,
      statePath: paths.state,
      unitName: keelServiceIdentity.unitName,
      unitSha256: keelServiceUnitSha256,
      environmentSha256: keelEnvironmentSha256,
      bindAddress: keelServiceIdentity.bindAddress,
      port: keelServiceIdentity.port,
      healthIdentityVerified: true,
      claimRequired: true,
      privateAccessConfigured: false,
    }, null, 2)}\n`, { mode: 0o640, uid: rootUid, gid: account.gid, token: approval.installId });
    return { installId: approval.installId, installedAt, releaseCounts, account, serviceStarted, serviceEnabled };
  } catch (error) {
    if (serviceStarted || serviceEnabled) await run(fixedBinaries.systemctl, ["disable", "--now", keelServiceIdentity.unitName]).catch(() => {});
    if (unitPublished) await unlink(paths.unit).catch(() => {});
    await run(fixedBinaries.systemctl, ["daemon-reload"]).catch(() => {});
    if (activationPublished) await unlink(paths.current).catch(() => {});
    if (environmentPublished) await unlink(paths.environment).catch(() => {});
    await rm(path.join(path.dirname(paths.current), `.current-${approval.installId}.partial`), { force: true }).catch(() => {});
    await rm(path.join(path.dirname(paths.unit), `.${path.basename(paths.unit)}-${approval.installId}.partial`), { force: true }).catch(() => {});
    await rm(path.join(path.dirname(paths.environment), `.${path.basename(paths.environment)}-${approval.installId}.partial`), { force: true }).catch(() => {});
    await rm(path.join(path.dirname(paths.evidence), `.${path.basename(paths.evidence)}-${approval.installId}.partial`), { force: true }).catch(() => {});
    throw error;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  if (process.argv.length !== 2) {
    console.error("The fixed Keel installation accepts no arguments");
    process.exitCode = 64;
  } else {
    try {
      const result = await installApprovedKeel();
      console.log(`Installed fixed Keel ${keelServiceIdentity.releaseVersion} (${result.installId}) on 127.0.0.1:3000`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}

export const keelInstallScriptInternals = {
  ensureDedicatedAccount,
  exactSymlink,
  parseApproval,
  parseGroup,
  parsePasswd,
  shareReleaseTree,
  waitForHealth,
  writeAtomicRegularFile,
};
