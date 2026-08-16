import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { keelArtifactPaths, keelArtifactSpec, validUuid } from "./keel-artifact-spec.mjs";

const execFile = promisify(execFileCallback);
const defaultSystemctl = "/usr/bin/systemctl";

async function fixedRun(binary, args, { timeout = 30000 } = {}) {
  try {
    const result = await execFile(binary, args, { timeout, maxBuffer: 256 * 1024, encoding: "utf8", env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" } });
    return { ok: true, stdout: result.stdout.trim() };
  } catch (error) {
    return { ok: false, stdout: typeof error.stdout === "string" ? error.stdout.trim() : "", code: error.code ?? null };
  }
}

async function fileMetadata(filePath) {
  try { return await lstat(filePath); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function clearApprovalFile() {
  try { await unlink(keelArtifactPaths.approval); } catch (error) { if (error.code !== "ENOENT") throw error; }
}

async function writeApprovalFile(approval) {
  await writeFile(keelArtifactPaths.approval, `${JSON.stringify(approval)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

async function defaultLoadEvidence() {
  try { return JSON.parse(await readFile(keelArtifactPaths.evidence, "utf8")); } catch { return null; }
}

function boundary(mutationPerformed) {
  return {
    mutationPerformed,
    networkAccess: mutationPerformed,
    extractionPerformed: false,
    archiveExecuted: false,
    applicationInstalled: false,
    serviceChanged: false,
    registrationChanged: false,
    arbitraryUrlAccepted: false,
    arbitraryPathAccepted: false,
    browserDigestAccepted: false,
    artifactBytesReturned: false,
  };
}

export function createKeelArtifactHelper({
  paths = keelArtifactPaths,
  spec = keelArtifactSpec,
  now = () => new Date(),
  run = fixedRun,
  systemctlBinary = defaultSystemctl,
  loadEvidence = defaultLoadEvidence,
  clearApproval = clearApprovalFile,
  writeApproval = writeApprovalFile,
} = {}) {
  async function inspect() {
    try {
      const root = await fileMetadata(paths.root);
      if (root && (!root.isDirectory() || root.isSymbolicLink())) throw new Error("Artifact root is not a real directory");
      const [archive, partial, evidenceFile] = await Promise.all([fileMetadata(paths.archive), fileMetadata(paths.partial), fileMetadata(paths.evidence)]);
      for (const [label, metadata] of [["archive", archive], ["partial", partial], ["evidence", evidenceFile]]) {
        if (metadata && (!metadata.isFile() || metadata.isSymbolicLink())) throw new Error(`Keel artifact ${label} is not a real regular file`);
      }
      if (!archive && evidenceFile) throw new Error("Keel artifact evidence exists without the archive");
      if (!archive) {
        return {
          state: partial ? "partial" : "absent",
          readyToAcquire: true,
          artifactPresent: false,
          locallyVerified: false,
          sizeBytes: null,
          sha256: null,
          partialPresent: Boolean(partial),
          acquiredAt: null,
          acquisitionId: null,
          detail: partial ? "An interrupted fixed Keel artifact download can be replaced by a fresh approved acquisition" : "The fixed Keel release archive is not present",
          boundary: boundary(false),
        };
      }
      const sha256 = await sha256File(paths.archive);
      const exact = archive.size === spec.sizeBytes && sha256 === spec.digest.slice("sha256:".length);
      if (!exact || partial) {
        return {
          state: "invalid",
          readyToAcquire: false,
          artifactPresent: true,
          locallyVerified: false,
          sizeBytes: archive.size,
          sha256: null,
          partialPresent: Boolean(partial),
          acquiredAt: null,
          acquisitionId: null,
          detail: "Existing Keel artifact state does not match the fixed release identity and will not be overwritten",
          boundary: boundary(false),
        };
      }
      const evidence = await loadEvidence();
      const evidenceMatched = evidence?.schemaVersion === 1
        && validUuid(evidence?.acquisitionId)
        && evidence?.releaseTag === spec.releaseTag
        && evidence?.releaseCommitSha === spec.releaseCommitSha
        && evidence?.name === spec.name
        && evidence?.sizeBytes === spec.sizeBytes
        && evidence?.sha256 === spec.digest.slice("sha256:".length)
        && typeof evidence?.downloadedAt === "string"
        && Number.isFinite(Date.parse(evidence.downloadedAt));
      return {
        state: "verified",
        readyToAcquire: false,
        artifactPresent: true,
        locallyVerified: true,
        sizeBytes: archive.size,
        sha256: spec.digest,
        partialPresent: false,
        acquiredAt: evidenceMatched ? evidence.downloadedAt : null,
        acquisitionId: evidenceMatched ? evidence.acquisitionId : null,
        evidenceRecorded: evidenceMatched,
        detail: evidenceMatched ? "The fixed Keel release archive matches its complete local byte length and SHA-256 evidence" : "The fixed Keel release archive matches local bytes; acquisition provenance evidence is incomplete",
        boundary: boundary(false),
      };
    } catch {
      return {
        state: "unavailable",
        readyToAcquire: false,
        artifactPresent: false,
        locallyVerified: false,
        sizeBytes: null,
        sha256: null,
        partialPresent: false,
        acquiredAt: null,
        acquisitionId: null,
        detail: "The fixed root-only Keel artifact location could not be verified safely",
        boundary: boundary(false),
      };
    }
  }

  async function acquire(input) {
    const keys = input && typeof input === "object" && !Array.isArray(input) ? Object.keys(input) : [];
    if (keys.length !== 1 || keys[0] !== "acquisitionId" || !validUuid(input.acquisitionId)) throw new Error("Keel artifact acquisition accepts only one acquisitionId UUID");
    const { acquisitionId } = input;
    const before = await inspect();
    if (!before.readyToAcquire || !["absent", "partial"].includes(before.state)) throw new Error("Host state changed: the fixed Keel artifact is not safely acquirable");
    await mkdir(paths.root, { recursive: true, mode: 0o700 });
    const root = await lstat(paths.root);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("The fixed Keel artifact root is not a real directory");
    await chmod(paths.root, 0o700);
    await clearApproval();
    await writeApproval({
      acquisitionId,
      approvedAt: now().toISOString(),
      digest: spec.digest,
      name: spec.name,
      releaseCommitSha: spec.releaseCommitSha,
      releaseTag: spec.releaseTag,
      sizeBytes: spec.sizeBytes,
      sourceUrl: spec.sourceUrl,
    });
    let started;
    try {
      started = await run(systemctlBinary, ["start", "boxpilot-keel-artifact.service"], { timeout: 15 * 60 * 1000 });
    } finally {
      await clearApproval();
    }
    if (!started.ok) throw new Error("The fixed Keel artifact acquisition service failed");
    const after = await inspect();
    if (!after.locallyVerified || after.acquisitionId !== acquisitionId || after.evidenceRecorded !== true) throw new Error("The fixed Keel artifact did not produce matching local verification evidence");
    return {
      acquisitionId,
      acquired: true,
      releaseTag: spec.releaseTag,
      releaseCommitSha: spec.releaseCommitSha,
      name: spec.name,
      sizeBytes: spec.sizeBytes,
      sha256: spec.digest,
      locallyVerified: true,
      evidenceRecorded: true,
      stalePartialRemoved: before.partialPresent,
      boundary: boundary(true),
    };
  }

  return { inspect, acquire };
}

export const keelArtifactHelperInternals = { boundary, defaultSystemctl, fileMetadata, sha256File };
