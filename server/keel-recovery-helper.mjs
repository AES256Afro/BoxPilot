import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { chmod, chown, copyFile, cp, lstat, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { validUuid } from "./keel-artifact-spec.mjs";
import { keelBackupIdentity, keelBackupPaths, pathsForKeelBackup } from "./keel-backup-spec.mjs";
import { keelRecoveryPaths, pathsForKeelRecovery } from "./keel-recovery-spec.mjs";
import { keelBackupScriptInternals } from "../scripts/boxpilot-keel-backup.mjs";

const execFile = promisify(execFileCallback);
const shaPattern = /^[a-f0-9]{64}$/;
const maximumArchiveBytes = 20 * 1024 ** 3;
const requiredInputKeys = ["backupId", "expectedArtifactChecksumSha256", "expectedManifestChecksumSha256", "expectedSizeBytes", "recoveryId"];

export function validateKeelRecoveryInput(input) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["Keel recovery input must be an object"];
  const keys = Object.keys(input).sort();
  if (keys.length !== requiredInputKeys.length || keys.some((key, index) => key !== requiredInputKeys[index])) errors.push("Keel recovery accepts only the fixed typed backup evidence fields");
  if (!validUuid(input.recoveryId)) errors.push("Recovery id must be a UUID");
  if (!validUuid(input.backupId)) errors.push("Backup id must be a UUID");
  if (!shaPattern.test(input.expectedArtifactChecksumSha256 ?? "")) errors.push("Artifact checksum must be a SHA-256 digest");
  if (!shaPattern.test(input.expectedManifestChecksumSha256 ?? "")) errors.push("Manifest checksum must be a SHA-256 digest");
  if (!Number.isSafeInteger(input.expectedSizeBytes) || input.expectedSizeBytes < 1 || input.expectedSizeBytes > maximumArchiveBytes) errors.push("Artifact size must be between 1 byte and 20 GiB");
  return errors;
}

async function defaultRun(binary, args, { timeout = 10 * 60 * 1000, maxBuffer = 32 * 1024 * 1024 } = {}) {
  try {
    const result = await execFile(binary, args, {
      timeout,
      maxBuffer,
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

function parseJson(raw, label) {
  try { return JSON.parse(raw); } catch { throw new Error(`${label} is invalid JSON`); }
}

function validateArchiveMembers(output) {
  const names = output.split("\n").map((entry) => entry.trim()).filter(Boolean);
  if (names.length < 3 || names.length > 100000) throw new Error("The Keel archive membership count is outside the fixed safety limits");
  const seen = new Set();
  for (const name of names) {
    const normalized = name.replace(/\/$/, "");
    if (normalized !== "keel-export" && !normalized.startsWith("keel-export/")) throw new Error("The Keel archive contains an entry outside its fixed root");
    if (path.isAbsolute(name) || name.includes("\\") || name.split("/").includes("..") || name.includes("\0")) throw new Error("The Keel archive contains an unsafe path");
    if (seen.has(normalized)) throw new Error("The Keel archive contains duplicate members");
    seen.add(normalized);
  }
  return names.length;
}

async function hardenTree(root, uid = 0, gid = 0) {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    const value = await lstat(current);
    if (value.isSymbolicLink()) throw new Error("The Keel recovery contains a symbolic link");
    if (value.isDirectory()) {
      await chown(current, uid, gid);
      await chmod(current, 0o700);
      for (const name of await readdir(current)) stack.push(path.join(current, name));
    } else {
      if (!value.isFile() || value.nlink !== 1) throw new Error("The Keel recovery contains a non-regular or multiply linked file");
      await chown(current, uid, gid);
      await chmod(current, 0o600);
    }
  }
}

function validateManifest(value, input, tree) {
  return value?.schemaVersion === 1
    && value?.backupId === input.backupId
    && validUuid(value?.installId)
    && value?.releaseTag === keelBackupIdentity.releaseTag
    && value?.releaseCommitSha === keelBackupIdentity.releaseCommitSha
    && value?.releaseVersion === keelBackupIdentity.releaseVersion
    && shaPattern.test(value?.treeDigestSha256 ?? "")
    && value.treeDigestSha256 === tree.digest
    && value.regularFiles === tree.regularFiles
    && value.directories === tree.directories
    && value.logicalBytes === tree.bytes
    && value?.databaseIntegrity?.integrityCheck === "ok"
    && value?.databaseIntegrity?.foreignKeyIssues === 0
    && value?.databaseIntegrity?.schemaVerified === true
    && value?.environmentIncluded === true;
}

export function createKeelRecoveryHelper({
  backupPaths = keelBackupPaths,
  recoveryPaths = keelRecoveryPaths,
  run = defaultRun,
  now = () => new Date(),
  tarBinary = "/usr/bin/tar",
  expectedRootUid = 0,
  expectedRootGid = 0,
} = {}) {
  async function verifySource(input) {
    const errors = validateKeelRecoveryInput(input);
    if (errors.length) throw new Error(errors.join(" | "));
    const source = pathsForKeelBackup(input.backupId, backupPaths);
    const [archiveMetadata, resultMetadata] = await Promise.all([metadata(source.archive), metadata(source.result)]);
    if (!archiveMetadata?.isFile() || archiveMetadata.isSymbolicLink() || archiveMetadata.nlink !== 1 || archiveMetadata.uid !== expectedRootUid || archiveMetadata.gid !== expectedRootGid || (archiveMetadata.mode & 0o7777) !== 0o600 || archiveMetadata.size !== input.expectedSizeBytes) throw new Error("The selected Keel backup artifact is missing, unsafe, or changed");
    if (!resultMetadata?.isFile() || resultMetadata.isSymbolicLink() || resultMetadata.nlink !== 1 || resultMetadata.uid !== expectedRootUid || resultMetadata.gid !== expectedRootGid || (resultMetadata.mode & 0o7777) !== 0o600 || resultMetadata.size > 64 * 1024) throw new Error("The selected Keel backup result is missing or unsafe");
    const result = parseJson(await readFile(source.result, "utf8"), "The selected Keel backup result");
    if (result?.backupId !== input.backupId || result?.applicationId !== "keel" || result?.destination !== "local-managed"
      || result?.artifactPath !== source.archive || result?.checksumSha256 !== input.expectedArtifactChecksumSha256
      || result?.manifestChecksumSha256 !== input.expectedManifestChecksumSha256 || result?.sizeBytes !== input.expectedSizeBytes
      || result?.releaseVersion !== keelBackupIdentity.releaseVersion || result?.sourceRestartVerified !== true
      || result?.restoreDrill?.passed !== true || result?.restoreDrill?.manifestChecksumSha256 !== input.expectedManifestChecksumSha256
      || result?.restoreDrill?.treeDigestMatched !== true || result?.restoreDrill?.databaseIntegrity !== "ok"
      || result?.restoreDrill?.foreignKeyIssues !== 0 || result?.restoreDrill?.schemaVerified !== true
      || result?.restoreDrill?.applicationStarted !== false || result?.restoreDrill?.productionStateReplaced !== false
      || result?.boundary?.productionStateReplaced !== false || result?.boundary?.registrationChanged !== false
      || result?.boundary?.claimChanged !== false || result?.boundary?.tailscaleChanged !== false
      || result?.boundary?.firewallChanged !== false || result?.boundary?.routerChanged !== false) throw new Error("The selected Keel backup does not have complete local recovery evidence");
    if (await sha256(source.archive) !== input.expectedArtifactChecksumSha256) throw new Error("The selected Keel backup artifact checksum changed");
    const targets = pathsForKeelRecovery(input.recoveryId, recoveryPaths);
    if (await metadata(targets.final) || await metadata(targets.partial)) throw new Error("The generated Keel recovery target already exists");
    return { source, targets, result };
  }

  async function inspect(input) {
    await verifySource(input);
    return {
      ready: true,
      recoveryId: input.recoveryId,
      backupId: input.backupId,
      destination: "managed-keel-recovery",
      initialState: "stopped",
      network: "none",
      applicationStarted: false,
      productionStateReplaced: false,
      blockers: [],
    };
  }

  async function create(input) {
    const { source, targets } = await verifySource(input);
    await mkdir(targets.root, { recursive: true, mode: 0o700 });
    await chown(targets.root, expectedRootUid, expectedRootGid);
    await chmod(targets.root, 0o700);
    const rootMetadata = await lstat(targets.root);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() || rootMetadata.uid !== expectedRootUid || rootMetadata.gid !== expectedRootGid || (rootMetadata.mode & 0o7777) !== 0o700) throw new Error("The fixed Keel recovery root is unsafe");
    let completed = false;
    try {
      await mkdir(targets.extraction, { recursive: true, mode: 0o700 });
      const listed = await run(tarBinary, ["--list", "--gzip", "--file", source.archive]);
      if (!listed.ok) throw new Error("The selected Keel backup archive could not be listed safely");
      const memberCount = validateArchiveMembers(listed.stdout);
      const extracted = await run(tarBinary, ["--extract", "--gzip", "--file", source.archive, "--directory", targets.extraction, "--no-same-owner", "--no-same-permissions"]);
      if (!extracted.ok) throw new Error("The selected Keel backup archive could not be extracted");
      const names = await keelBackupScriptInternals.validateExportLayout(targets.exportRoot);
      const manifestPath = path.join(targets.exportRoot, "manifest.json");
      if (await sha256(manifestPath) !== input.expectedManifestChecksumSha256) throw new Error("The restored Keel manifest checksum changed");
      const tree = await keelBackupScriptInternals.inspectTree(targets.exportRoot, { excludeManifest: true });
      const database = keelBackupScriptInternals.inspectDatabase(path.join(targets.exportRoot, "keel.db"));
      const manifest = parseJson(await readFile(manifestPath, "utf8"), "The restored Keel manifest");
      if (!validateManifest(manifest, input, tree) || database.integrityCheck !== "ok" || database.foreignKeyIssues !== 0 || database.schemaVerified !== true) throw new Error("The restored Keel state did not match its manifest and database evidence");
      if (names.includes("keel.db.keel-server-secrets.key") && !keelBackupScriptInternals.validManagedKey(await readFile(path.join(targets.exportRoot, "keel.db.keel-server-secrets.key"), "utf8"))) throw new Error("The restored Keel managed-secret companion is invalid");

      await mkdir(targets.state, { mode: 0o700 });
      await copyFile(path.join(targets.exportRoot, "keel.db"), path.join(targets.state, "keel.db"));
      await copyFile(path.join(targets.exportRoot, "keel.env"), path.join(targets.state, ".env"));
      for (const companion of ["keel.db-wal", "keel.db-shm"]) {
        if (names.includes(companion)) await copyFile(path.join(targets.exportRoot, companion), path.join(targets.state, companion));
      }
      if (names.includes("keel.db.keel-server-secrets.key")) await copyFile(path.join(targets.exportRoot, "keel.db.keel-server-secrets.key"), path.join(targets.state, ".keel-server-secrets.key"));
      if (names.includes("keel.db.uploads")) await cp(path.join(targets.exportRoot, "keel.db.uploads"), path.join(targets.state, "uploads"), { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
      await hardenTree(targets.state, expectedRootUid, expectedRootGid);
      const stateTree = await keelBackupScriptInternals.inspectTree(targets.state);
      const clonedDatabase = keelBackupScriptInternals.inspectDatabase(path.join(targets.state, "keel.db"));
      const createdAt = now().toISOString();
      const evidence = {
        schemaVersion: 1,
        recoveryId: input.recoveryId,
        backupId: input.backupId,
        createdAt,
        destination: "managed-keel-recovery",
        statePath: targets.finalState,
        sourceArtifactChecksumSha256: input.expectedArtifactChecksumSha256,
        sourceManifestChecksumSha256: input.expectedManifestChecksumSha256,
        sourceSizeBytes: input.expectedSizeBytes,
        archiveMemberCount: memberCount,
        restoredRegularFiles: stateTree.regularFiles,
        restoredDirectories: stateTree.directories,
        restoredLogicalBytes: stateTree.bytes,
        restoredTreeDigestSha256: stateTree.digest,
        databaseIntegrity: clonedDatabase.integrityCheck,
        foreignKeyIssues: clonedDatabase.foreignKeyIssues,
        schemaVerified: clonedDatabase.schemaVerified,
        managedSecretCompanionIncluded: names.includes("keel.db.keel-server-secrets.key"),
        uploadsIncluded: names.includes("keel.db.uploads"),
        environmentIncluded: true,
        initialState: "stopped",
        network: "none",
        applicationStarted: false,
        productionStateReplaced: false,
        sourceArtifactChanged: false,
        browserPathAccepted: false,
        browserCommandAccepted: false,
        promotionPerformed: false,
      };
      const handle = await open(targets.evidence, "wx", 0o600);
      try { await handle.writeFile(`${JSON.stringify(evidence, null, 2)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
      await hardenTree(targets.partial, expectedRootUid, expectedRootGid);
      await rm(targets.extraction, { recursive: true, force: false });
      await rename(targets.partial, targets.final);
      completed = true;
      const publishedMetadata = await stat(targets.finalState);
      if (!publishedMetadata.isDirectory() || publishedMetadata.uid !== expectedRootUid || publishedMetadata.gid !== expectedRootGid || (publishedMetadata.mode & 0o7777) !== 0o700) throw new Error("The published Keel recovery state is unsafe");
      return { ...evidence, created: true, statePath: targets.finalState, evidencePath: targets.finalEvidence };
    } finally {
      if (!completed) await rm(targets.partial, { recursive: true, force: true });
    }
  }

  return { inspect, create };
}

export const keelRecoveryHelperInternals = { hardenTree, validateArchiveMembers, validateManifest };
