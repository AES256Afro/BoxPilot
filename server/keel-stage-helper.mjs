import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createKeelArchiveHelper } from "./keel-archive-helper.mjs";
import { createKeelArtifactHelper } from "./keel-artifact-helper.mjs";
import { keelArtifactPaths, keelArtifactSpec, keelStagePaths, validUuid } from "./keel-artifact-spec.mjs";

const execFile = promisify(execFileCallback);
const defaultTarBinary = "/usr/bin/tar";
const evidenceName = ".boxpilot-stage.json";

function boundary(mutationPerformed) {
  return {
    mutationPerformed,
    networkAccess: false,
    extractionPerformed: mutationPerformed,
    archiveExecuted: false,
    applicationInstalled: false,
    applicationStateCreated: false,
    serviceChanged: false,
    registrationChanged: false,
    listenerChanged: false,
    arbitraryPathAccepted: false,
    browserArchiveAccepted: false,
    memberNamesReturned: false,
    memberContentsReturned: false,
  };
}

async function metadata(target) {
  try { return await lstat(target); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function partialPattern(spec = keelArtifactSpec) {
  return new RegExp(`^\\.${spec.archiveRoot}-[a-f0-9-]{36}\\.partial$`);
}

async function listPartials(paths = keelStagePaths, spec = keelArtifactSpec) {
  const releases = await metadata(paths.releases);
  if (!releases) return [];
  if (!releases.isDirectory() || releases.isSymbolicLink()) throw new Error("The Keel release root is not a real directory");
  if ((releases.mode & 0o7077) !== 0) throw new Error("The Keel release root has unsafe permissions");
  const names = await readdir(paths.releases);
  const partials = [];
  for (const name of names) {
    if (name === path.basename(paths.release)) continue;
    if (!partialPattern(spec).test(name)) throw new Error("The Keel release root contains an unexpected entry");
    const candidate = path.join(paths.releases, name);
    const candidateMetadata = await lstat(candidate);
    if (!candidateMetadata.isDirectory() || candidateMetadata.isSymbolicLink()) throw new Error("A Keel staging partial is not a real directory");
    partials.push(candidate);
  }
  return partials;
}

async function hardenAndScan(root, { evidencePath = null, harden = false } = {}) {
  const counts = { members: 0, regularFiles: 0, directories: 0, managedMetadataFiles: 0 };
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    const currentMetadata = await lstat(current);
    if (currentMetadata.isSymbolicLink()) throw new Error("The staged Keel tree contains a symbolic link");
    const isEvidence = evidencePath !== null && current === evidencePath;
    if (currentMetadata.isDirectory()) {
      if (harden) await chmod(current, 0o700);
      else if ((currentMetadata.mode & 0o7077) !== 0) throw new Error("The staged Keel tree has unsafe directory permissions");
      counts.members += 1;
      counts.directories += 1;
      for (const name of await readdir(current)) stack.push(path.join(current, name));
      continue;
    }
    if (!currentMetadata.isFile() || currentMetadata.nlink !== 1) throw new Error("The staged Keel tree contains a non-regular or multiply linked file");
    const basename = path.basename(current);
    if (!isEvidence && (basename.startsWith(".env") || basename === ".keel-private-patterns" || basename.endsWith(".keel-server-secrets.key") || /\.(?:db|sqlite|sqlite3)$/i.test(basename))) {
      throw new Error("The staged Keel release contains a forbidden state or secret file");
    }
    if (harden) await chmod(current, (currentMetadata.mode & 0o111) !== 0 ? 0o700 : 0o600);
    else if ((currentMetadata.mode & 0o7077) !== 0) throw new Error("The staged Keel tree has unsafe file permissions");
    if (isEvidence) counts.managedMetadataFiles += 1;
    else {
      counts.members += 1;
      counts.regularFiles += 1;
    }
  }
  return counts;
}

async function verifyRequiredFiles(releaseRoot, spec = keelArtifactSpec) {
  const required = ["bin/keel.mjs", "server/server.js", "server/package.json", "server/prisma/schema.sql"];
  for (const relative of required) {
    const file = await metadata(path.join(releaseRoot, relative));
    if (!file) throw new Error("The staged Keel release is missing a required regular file");
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1) throw new Error("The staged Keel release is missing a required regular file");
  }
  const manifest = JSON.parse(await readFile(path.join(releaseRoot, "package.json"), "utf8"));
  if (manifest?.name !== "keel-notes" || manifest?.version !== spec.releaseTag.slice(1)) throw new Error("The staged Keel package identity does not match the fixed release");
}

async function defaultExtractArchive({ archive, destination, tarBinary = defaultTarBinary }) {
  await execFile(tarBinary, ["--extract", "--gzip", "--file", archive, "--directory", destination, "--strip-components=1", "--no-same-owner", "--no-same-permissions", "--delay-directory-restore"], {
    timeout: 15 * 60 * 1000,
    maxBuffer: 256 * 1024,
    encoding: "utf8",
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
  });
}

async function loadEvidence(evidencePath) {
  try { return JSON.parse(await readFile(evidencePath, "utf8")); } catch { return null; }
}

export function createKeelStageHelper({
  paths = keelStagePaths,
  artifactPaths = keelArtifactPaths,
  spec = keelArtifactSpec,
  now = () => new Date(),
  artifactHelper = createKeelArtifactHelper({ paths: artifactPaths, spec }),
  archiveHelper = createKeelArchiveHelper({ paths: artifactPaths, spec }),
  extractArchive = defaultExtractArchive,
} = {}) {
  async function inspect() {
    try {
      const root = await metadata(paths.root);
      if (root && (!root.isDirectory() || root.isSymbolicLink())) throw new Error("The Keel staging root is not a real directory");
      if (root && (root.mode & 0o7077) !== 0) throw new Error("The Keel staging root has unsafe permissions");
      if (!root) {
        return {
          state: "absent", staged: false, readyToStage: true, version: null, sourceMemberCount: 0, regularFiles: 0, directories: 0, partialCount: 0, stagedAt: null, stageId: null,
          detail: "The fixed Keel release has not been staged",
          boundary: boundary(false),
        };
      }
      const rootEntries = await readdir(paths.root);
      if (rootEntries.some((name) => name !== path.basename(paths.releases))) throw new Error("The Keel staging root contains an unexpected entry");
      const [release, partials] = await Promise.all([metadata(paths.release), listPartials(paths, spec)]);
      if (!release) {
        return {
          state: partials.length > 0 ? "partial" : "absent",
          staged: false,
          readyToStage: true,
          version: null,
          sourceMemberCount: 0,
          regularFiles: 0,
          directories: 0,
          partialCount: partials.length,
          stagedAt: null,
          stageId: null,
          detail: partials.length > 0 ? "Interrupted helper-owned Keel staging work can be replaced by a fresh approved plan" : "The fixed Keel release has not been staged",
          boundary: boundary(false),
        };
      }
      if (!release.isDirectory() || release.isSymbolicLink()) throw new Error("The staged Keel release is not a real directory");
      const evidenceMetadata = await metadata(paths.evidence);
      if (!evidenceMetadata || !evidenceMetadata.isFile() || evidenceMetadata.isSymbolicLink() || evidenceMetadata.nlink !== 1) throw new Error("The staged Keel evidence is missing or unsafe");
      const counts = await hardenAndScan(paths.release, { evidencePath: paths.evidence });
      await verifyRequiredFiles(paths.release, spec);
      const evidence = await loadEvidence(paths.evidence);
      const exact = evidence?.schemaVersion === 1
        && validUuid(evidence?.stageId)
        && evidence?.releaseTag === spec.releaseTag
        && evidence?.releaseCommitSha === spec.releaseCommitSha
        && evidence?.artifactDigest === spec.digest
        && evidence?.sourceMemberCount === spec.archiveMembersObservedDuringAdapterReview
        && evidence?.regularFiles === spec.archiveRegularFilesObservedDuringAdapterReview
        && evidence?.directories === spec.archiveDirectoriesObservedDuringAdapterReview
        && typeof evidence?.stagedAt === "string"
        && Number.isFinite(Date.parse(evidence.stagedAt))
        && counts.members === spec.archiveMembersObservedDuringAdapterReview
        && counts.regularFiles === spec.archiveRegularFilesObservedDuringAdapterReview
        && counts.directories === spec.archiveDirectoriesObservedDuringAdapterReview
        && counts.managedMetadataFiles === 1;
      if (!exact || partials.length > 0) throw new Error("The staged Keel tree does not match its fixed evidence");
      return {
        state: "staged",
        staged: true,
        readyToStage: false,
        version: spec.releaseTag.slice(1),
        sourceMemberCount: counts.members,
        regularFiles: counts.regularFiles,
        directories: counts.directories,
        managedMetadataFiles: counts.managedMetadataFiles,
        partialCount: 0,
        stagedAt: evidence.stagedAt,
        stageId: evidence.stageId,
        detail: "The exact Keel release is staged as a root-only inert tree; no service, state, account, listener, or registration setting exists",
        boundary: boundary(false),
      };
    } catch {
      return {
        state: "invalid",
        staged: false,
        readyToStage: false,
        version: null,
        sourceMemberCount: 0,
        regularFiles: 0,
        directories: 0,
        partialCount: 0,
        stagedAt: null,
        stageId: null,
        detail: "The fixed Keel staging location or evidence could not be verified safely and will not be overwritten",
        boundary: boundary(false),
      };
    }
  }

  async function stage(input) {
    const keys = input && typeof input === "object" && !Array.isArray(input) ? Object.keys(input) : [];
    if (keys.length !== 1 || keys[0] !== "stageId" || !validUuid(input.stageId)) throw new Error("Keel staging accepts only one stageId UUID");
    const before = await inspect();
    if (!before.readyToStage || !["absent", "partial"].includes(before.state)) throw new Error("Host state changed: the fixed Keel release is not safely stageable");
    const [artifact, archive] = await Promise.all([artifactHelper.inspect(), archiveHelper.inspect()]);
    if (artifact?.state !== "verified" || artifact?.locallyVerified !== true || artifact?.sha256 !== spec.digest) throw new Error("The exact Keel artifact is not locally verified");
    if (archive?.state !== "safe" || archive?.safeToExtract !== true || archive?.memberCount !== spec.archiveMembersObservedDuringAdapterReview || archive?.risks?.length !== 0) throw new Error("The exact Keel archive did not pass the runtime membership gate");

    await mkdir(path.dirname(paths.root), { recursive: true, mode: 0o700 });
    const existingRoot = await metadata(paths.root);
    if (existingRoot && (!existingRoot.isDirectory() || existingRoot.isSymbolicLink())) throw new Error("The Keel staging root is not a real directory");
    if (!existingRoot) await mkdir(paths.root, { mode: 0o700 });
    const existingReleases = await metadata(paths.releases);
    if (existingReleases && (!existingReleases.isDirectory() || existingReleases.isSymbolicLink())) throw new Error("The Keel release root is not a real directory");
    if (!existingReleases) await mkdir(paths.releases, { mode: 0o700 });
    for (const directory of [paths.root, paths.releases]) {
      const directoryMetadata = await lstat(directory);
      if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) throw new Error("The Keel staging root is not a real directory");
      await chmod(directory, 0o700);
    }
    for (const partial of await listPartials(paths, spec)) await rm(partial, { recursive: true, force: true });
    const partial = path.join(paths.releases, `.${spec.archiveRoot}-${input.stageId}.partial`);
    await mkdir(partial, { mode: 0o700 });
    let published = false;
    try {
      await extractArchive({ archive: artifactPaths.archive, destination: partial });
      const extractedRoot = partial;
      const extractedMetadata = await lstat(extractedRoot);
      if (!extractedMetadata.isDirectory() || extractedMetadata.isSymbolicLink()) throw new Error("The archive did not produce the exact stripped Keel release root");
      await verifyRequiredFiles(extractedRoot, spec);
      const sourceCounts = await hardenAndScan(extractedRoot, { harden: true });
      if (sourceCounts.members !== spec.archiveMembersObservedDuringAdapterReview
        || sourceCounts.regularFiles !== spec.archiveRegularFilesObservedDuringAdapterReview
        || sourceCounts.directories !== spec.archiveDirectoriesObservedDuringAdapterReview) throw new Error("The extracted Keel tree membership changed from the reviewed archive");
      const afterArchive = await archiveHelper.inspect();
      if (afterArchive?.state !== "safe" || afterArchive?.safeToExtract !== true || afterArchive?.memberCount !== spec.archiveMembersObservedDuringAdapterReview || afterArchive?.risks?.length !== 0) throw new Error("The Keel archive changed during staging");
      const evidence = {
        schemaVersion: 1,
        stageId: input.stageId,
        stagedAt: now().toISOString(),
        releaseTag: spec.releaseTag,
        releaseCommitSha: spec.releaseCommitSha,
        artifactDigest: spec.digest,
        sourceMemberCount: sourceCounts.members,
        regularFiles: sourceCounts.regularFiles,
        directories: sourceCounts.directories,
      };
      await writeFile(path.join(extractedRoot, evidenceName), `${JSON.stringify(evidence)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(partial, paths.release);
      published = true;
      const after = await inspect();
      if (!after.staged || after.stageId !== input.stageId || after.version !== spec.releaseTag.slice(1)) throw new Error("The staged Keel release did not produce matching evidence");
      return {
        staged: true,
        stageId: input.stageId,
        version: after.version,
        releaseTag: spec.releaseTag,
        releaseCommitSha: spec.releaseCommitSha,
        artifactDigest: spec.digest,
        sourceMemberCount: after.sourceMemberCount,
        regularFiles: after.regularFiles,
        directories: after.directories,
        managedMetadataFiles: after.managedMetadataFiles,
        boundary: boundary(true),
      };
    } catch (error) {
      await rm(partial, { recursive: true, force: true });
      if (published) await rm(paths.release, { recursive: true, force: true });
      throw error;
    }
  }

  return { inspect, stage };
}

export const keelStageHelperInternals = { boundary, defaultExtractArchive, hardenAndScan, listPartials, partialPattern, verifyRequiredFiles };
