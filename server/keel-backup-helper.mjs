import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { promisify } from "node:util";
import { chmod, lstat, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { validUuid } from "./keel-artifact-spec.mjs";
import { keelBackupIdentity, keelBackupPaths, pathsForKeelBackup } from "./keel-backup-spec.mjs";
import { createKeelInstallHelper } from "./keel-install-helper.mjs";

const execFile = promisify(execFileCallback);
const systemctlBinaryDefault = "/usr/bin/systemctl";
const shaPattern = /^[a-f0-9]{64}$/;

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

async function sha256(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

function exactResult(result, backupId, installId, targets) {
  return result?.schemaVersion === 1
    && result?.backupId === backupId
    && result?.installId === installId
    && result?.applicationId === keelBackupIdentity.applicationId
    && result?.destination === keelBackupIdentity.destination
    && result?.artifactPath === targets.archive
    && shaPattern.test(result?.checksumSha256 ?? "")
    && shaPattern.test(result?.manifestChecksumSha256 ?? "")
    && Number.isSafeInteger(result?.sizeBytes) && result.sizeBytes > 0
    && Number.isSafeInteger(result?.downtimeMs) && result.downtimeMs >= 0
    && result?.releaseVersion === keelBackupIdentity.releaseVersion
    && result?.sourceRestartVerified === true
    && result?.restoreDrill?.passed === true
    && result?.restoreDrill?.mode === "isolated-keel-export-open"
    && result?.restoreDrill?.network === "none"
    && result?.restoreDrill?.publishedPorts === 0
    && result?.restoreDrill?.databaseIntegrity === "ok"
    && result?.restoreDrill?.foreignKeyIssues === 0
    && result?.restoreDrill?.schemaVerified === true
    && result?.restoreDrill?.environmentIncluded === true
    && result?.restoreDrill?.treeDigestMatched === true
    && result?.restoreDrill?.manifestChecksumSha256 === result.manifestChecksumSha256
    && result?.restoreDrill?.workspaceRemoved === true
    && result?.restoreDrill?.applicationStarted === false
    && result?.restoreDrill?.productionStateReplaced === false
    && result?.boundary?.browserPathAccepted === false
    && result?.boundary?.browserCommandAccepted === false
    && result?.boundary?.browserTokenAccepted === false
    && result?.boundary?.databaseOpened === true
    && result?.boundary?.secretContentReturned === false
    && result?.boundary?.environmentContentReturned === false
    && result?.boundary?.sourceServiceStopped === true
    && result?.boundary?.sourceRestarted === true
    && result?.boundary?.networkAccessRequiredForDrill === false
    && result?.boundary?.productionStateReplaced === false
    && result?.boundary?.registrationChanged === false
    && result?.boundary?.claimChanged === false
    && result?.boundary?.tailscaleChanged === false
    && result?.boundary?.firewallChanged === false
    && result?.boundary?.routerChanged === false
    && result?.boundary?.independentCopyCreated === false
    && result?.boundary?.retentionPerformed === false
    && result?.boundary?.prunePerformed === false;
}

export function createKeelBackupHelper({
  paths = keelBackupPaths,
  now = () => new Date(),
  run = defaultRun,
  systemctlBinary = systemctlBinaryDefault,
  installHelper = createKeelInstallHelper(),
  expectedRootUid = 0,
  expectedRootGid = 0,
} = {}) {
  async function readResult(backupId, installId) {
    const targets = pathsForKeelBackup(backupId, paths);
    const [resultMetadata, archiveMetadata] = await Promise.all([metadata(targets.result), metadata(targets.archive)]);
    if (!resultMetadata?.isFile() || resultMetadata.isSymbolicLink() || resultMetadata.nlink !== 1 || resultMetadata.uid !== expectedRootUid || resultMetadata.gid !== expectedRootGid || (resultMetadata.mode & 0o7777) !== 0o600 || resultMetadata.size > 64 * 1024) throw new Error("The fixed Keel backup result is missing or unsafe");
    if (!archiveMetadata?.isFile() || archiveMetadata.isSymbolicLink() || archiveMetadata.nlink !== 1 || archiveMetadata.uid !== expectedRootUid || archiveMetadata.gid !== expectedRootGid || (archiveMetadata.mode & 0o7777) !== 0o600) throw new Error("The fixed Keel backup artifact is missing or unsafe");
    let result;
    try { result = JSON.parse(await readFile(targets.result, "utf8")); } catch { throw new Error("The fixed Keel backup result is invalid"); }
    if (!exactResult(result, backupId, installId, targets) || result.sizeBytes !== archiveMetadata.size || await sha256(targets.archive) !== result.checksumSha256) throw new Error("The fixed Keel backup result or artifact changed");
    return result;
  }

  async function backup(input) {
    const keys = input && typeof input === "object" && !Array.isArray(input) ? Object.keys(input) : [];
    if (keys.length !== 1 || keys[0] !== "backupId" || !validUuid(input.backupId)) throw new Error("Keel backup accepts only one backupId UUID");
    const before = await installHelper.inspect();
    if (before.installed !== true || before.serviceActive !== true || before.serviceEnabled !== true || !validUuid(before.installId) || before.releaseVersion !== keelBackupIdentity.releaseVersion) throw new Error("Host state changed: the exact managed Keel service is not ready for backup");
    const approval = {
      backupId: input.backupId,
      installId: before.installId,
      approvedAt: now().toISOString(),
      releaseTag: keelBackupIdentity.releaseTag,
      releaseCommitSha: keelBackupIdentity.releaseCommitSha,
      releaseVersion: keelBackupIdentity.releaseVersion,
      unitName: keelBackupIdentity.unitName,
    };
    await writeFile(paths.approval, `${JSON.stringify(approval)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 }).catch((error) => {
      if (error.code === "EEXIST") throw new Error("A previous Keel backup requires helper recovery before another backup can start");
      throw error;
    });
    await chmod(paths.approval, 0o600);
    let started;
    try {
      started = await run(systemctlBinary, ["start", "boxpilot-keel-backup.service"], { timeout: 20 * 60 * 1000 });
    } finally {
      await unlink(paths.approval).catch((error) => { if (error.code !== "ENOENT") throw error; });
    }
    if (!started.ok) throw new Error("The fixed Keel backup service failed; source restart recovery was requested");
    return readResult(input.backupId, before.installId);
  }

  async function recoverInterrupted() {
    const approvalMetadata = await metadata(paths.approval);
    if (!approvalMetadata) return { recovered: false, active: false, sourceRestartRequested: false, generatedPathsRemoved: 0 };
    if (!approvalMetadata.isFile() || approvalMetadata.isSymbolicLink() || approvalMetadata.nlink !== 1 || approvalMetadata.size > 16 * 1024) throw new Error("The Keel backup recovery marker is unsafe");
    let approval;
    try { approval = JSON.parse(await readFile(paths.approval, "utf8")); } catch { throw new Error("The Keel backup recovery marker is invalid"); }
    const expectedKeys = ["approvedAt", "backupId", "installId", "releaseCommitSha", "releaseTag", "releaseVersion", "unitName"];
    const keys = approval && typeof approval === "object" && !Array.isArray(approval) ? Object.keys(approval).sort() : [];
    if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])
      || !validUuid(approval?.backupId) || !validUuid(approval?.installId)
      || approval.releaseTag !== keelBackupIdentity.releaseTag || approval.releaseCommitSha !== keelBackupIdentity.releaseCommitSha
      || approval.releaseVersion !== keelBackupIdentity.releaseVersion || approval.unitName !== keelBackupIdentity.unitName) throw new Error("The Keel backup recovery marker identity is invalid");
    const active = await run(systemctlBinary, ["is-active", "--quiet", "boxpilot-keel-backup.service"]);
    if (active.ok) return { recovered: false, active: true, sourceRestartRequested: false, generatedPathsRemoved: 0 };
    const restart = await run(systemctlBinary, ["start", keelBackupIdentity.unitName], { timeout: 120000 });
    if (!restart.ok) throw new Error("The interrupted Keel backup could not restore the source service; the recovery marker was preserved");
    const targets = pathsForKeelBackup(approval.backupId, paths);
    let generatedPathsRemoved = 0;
    for (const target of [targets.partial, targets.drill]) {
      if (await metadata(target)) { await rm(target, { recursive: true, force: true }); generatedPathsRemoved += 1; }
    }
    for (const target of [targets.archivePartial, targets.archive, targets.result]) {
      if (await metadata(target)) { await unlink(target); generatedPathsRemoved += 1; }
    }
    await unlink(paths.approval);
    return { recovered: true, active: false, sourceRestartRequested: true, generatedPathsRemoved };
  }

  return { backup, readResult, recoverInterrupted };
}

export const keelBackupHelperInternals = { exactResult };
